"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/api";
import type { JobStatus } from "@/lib/types";

type BuyStatus = "idle" | "loading" | "not_configured" | "error";

/**
 * Phase 4 (Half A, REAL): the "Buy Credits" pill's actual credit_ledger
 * balance (GET /api/credits) instead of being a purely decorative label.
 * Refetched whenever the active job's status changes, since a
 * running/just-finished job is exactly when new `usage` events (and their
 * matching ledger debits) land.
 *
 * Phase 4 (Half B, gated inert): buyCredits() attempts a real Stripe
 * Checkout session (src/server/stripe.ts) when configured, and surfaces
 * "Stripe is not configured" otherwise — never a silent no-op.
 */
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
    fetchJson<{ balance?: number }>("/api/credits")
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
        url?: string;
        error?: string;
      }>("/api/billing/checkout", { method: "POST" });
      if (data.configured === false) {
        setStatus("not_configured");
        setMessage(data.error ?? "Stripe is not configured in this environment.");
        return;
      }
      if (data.error || !data.url) {
        setStatus("error");
        setMessage(data.error ?? "Something went wrong.");
        return;
      }
      setStatus("idle");
      window.location.href = data.url;
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
