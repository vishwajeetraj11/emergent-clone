"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/api";
import type { JobStatus } from "@/lib/types";
import { apiRoutes } from "@/lib/constants/api-routes";

type BuyStatus = "idle" | "loading" | "not_configured" | "error";

/**
 * The "Buy Credits" pill's actual credit_ledger
 * balance (GET /api/credits) instead of being a purely decorative label.
 * Refetched whenever the active job's status changes, since a
 * running/just-finished job is exactly when new `usage` events (and their
 * matching ledger debits) land.
 *
 * BuyCredits() attempts a real Razorpay payment link
 * (src/server/razorpay.ts) when configured, and surfaces a clear
 * "not configured" message otherwise — never a silent no-op.
 */
type RazorpayCtor = new (options: Record<string, unknown>) => { open: () => void };

const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

/**
 * Loads Razorpay Checkout on first use rather than in the document head — the
 * overwhelming majority of sessions never open it, and it is a third-party
 * script on every page otherwise. Resolves immediately once already present.
 */
function loadRazorpayCheckout(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as { Razorpay?: unknown }).Razorpay) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${RAZORPAY_CHECKOUT_SRC}"]`
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Razorpay Checkout failed to load")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay Checkout failed to load"));
    document.body.appendChild(script);
  });
}

export function useCredits(jobStatus?: JobStatus | null) {
  const [balance, setBalance] = useState<number | null>(null);
  /**
   * True until the very first GET /api/credits settles. Never reset when the
   * effect below reruns (it refetches on every jobStatus change) — a refetch
   * should update the number in place, not flash a placeholder over a balance
   * we already have. That's also why nothing sets this back to true in the
   * effect body: doing so would be a synchronous setState inside an effect,
   * which cascades renders (react-hooks/set-state-in-effect).
   */
  const [isFirstBalanceLoadPending, setIsFirstBalanceLoadPending] = useState(true);
  const [status, setStatus] = useState<BuyStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ balance?: number }>(apiRoutes.credits)
      .then((data) => {
        if (!cancelled && typeof data.balance === "number") {
          setBalance(data.balance);
        }
      })
      .catch(() => {
        // Balance display is best-effort — no DB configured yet, etc.
      })
      .finally(() => {
        if (!cancelled) setIsFirstBalanceLoadPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobStatus]);

  async function buyCredits() {
    setStatus("loading");
    setMessage(null);
    try {
      const data = await fetchJson<{
        configured?: boolean;
        orderId?: string;
        keyId?: string;
        amount?: number;
        currency?: string;
        error?: string;
      }>(apiRoutes.billingCheckout, { method: "POST" });

      if (data.configured === false) {
        setStatus("not_configured");
        setMessage(data.error ?? "Payments are not configured in this environment.");
        return;
      }
      if (data.error || !data.orderId || !data.keyId) {
        setStatus("error");
        setMessage(data.error ?? "Something went wrong.");
        return;
      }

      await loadRazorpayCheckout();

      // callback_url rather than a handler: Razorpay POSTs the result to our
      // own route, so the signature is verified server-side and credits are
      // granted even if this tab goes away mid-payment.
      const RazorpayCheckout = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
      if (!RazorpayCheckout) throw new Error("Razorpay Checkout failed to load");

      setStatus("idle");
      new RazorpayCheckout({
        key: data.keyId,
        order_id: data.orderId,
        amount: data.amount,
        currency: data.currency,
        name: "Emergent Clone",
        description: "Agent usage credits",
        callback_url: `${window.location.origin}${apiRoutes.billingCallback}`,
      }).open();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to start checkout");
    }
  }

  return {
    balance,
    isBalanceLoading: isFirstBalanceLoadPending && balance === null,
    isLoading: status === "loading",
    status,
    message,
    buyCredits,
  };
}
