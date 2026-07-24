"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCredits } from "@/lib/hooks/useCredits";
import type { JobStatus } from "@/lib/types";

/**
 * The "Buy Credits" button reflects the signed-in
 * user's actual credit_ledger balance instead of being a purely decorative
 * label. Clicking attempts a real Razorpay
 * payment link when configured, and surfaces "not
 * configured" otherwise — never a silent no-op. See useCredits for the
 * fetch/checkout logic.
 */
export function CreditsPill({ jobStatus }: { jobStatus?: JobStatus | null }) {
  const { balance, isBalanceLoading, isLoading, status, message, buyCredits } =
    useCredits(jobStatus);

  const buyTooltipText =
    status === "not_configured" || status === "error"
      ? (message ?? "Something went wrong.")
      : isBalanceLoading
        ? "Loading your credit balance…"
        : "Your current credit balance — click to buy more.";

  return (
    <Tooltip>
      {/* aria-label overrides the button's text content, so the flat "Buy
          credits" was actively hiding the balance the pill exists to show —
          a screen-reader user could never hear how many credits they had.
          The name now carries it. */}
      <TooltipTrigger
        aria-label={
          isBalanceLoading
            ? "Buy credits — loading your balance"
            : balance !== null
              ? `Buy credits — you have ${balance.toLocaleString()} credits`
              : "Buy credits"
        }
        onClick={buyCredits}
        disabled={isLoading}
        className="flex h-7 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] bg-yellow-400 px-2.5 text-[0.8rem] font-medium text-yellow-950 transition-colors hover:bg-yellow-300 disabled:pointer-events-none disabled:opacity-50"
      >
        {/* While the balance is still in flight this used to render the
            literal text "Buy Credits" — not a loading state but a confidently
            wrong one, shown for as long as GET /api/credits takes. A pulsing
            placeholder says "a number is coming" instead. */}
        {/* w-[68px] is not arbitrary: the loaded pill measures 88px and has
            20px of horizontal padding, so 68px of content keeps the pill
            exactly the same width in both states — no nudge of the bell and
            avatar beside it. rounded-full, not rounded-sm, because the pill
            itself is 28px tall with a 12px radius (nearly pill-shaped), and a
            sharp-cornered bar inside it reads as the shape changing on load. */}
        {/* aria-label on a bare <span> is not reliably exposed (no role, no
            content) — several screen readers ignore it outright. Real
            sr-only text says the same thing and always reaches the user;
            the pulsing bar itself is decoration and is hidden. */}
        {isBalanceLoading ? (
          <>
            <span className="sr-only">Loading credit balance</span>
            <span
              aria-hidden
              className="inline-block h-3 w-17 animate-pulse rounded-full bg-yellow-950/20"
            />
          </>
        ) : balance !== null ? (
          `${balance.toLocaleString()} credits`
        ) : (
          "Buy Credits"
        )}
      </TooltipTrigger>
      <TooltipContent>{buyTooltipText}</TooltipContent>
    </Tooltip>
  );
}
