"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCredits } from "@/lib/hooks/useCredits";
import type { JobStatus } from "@/lib/types";

/**
 * Phase 4 (Half A, REAL): the "Buy Credits" button reflects the signed-in
 * user's actual credit_ledger balance instead of being a purely decorative
 * label. Phase 4 (Half B, gated inert): clicking attempts a real Stripe
 * Checkout session when configured, and surfaces "Stripe is not
 * configured" otherwise — never a silent no-op. See useCredits for the
 * fetch/checkout logic.
 */
export function CreditsPill({ jobStatus }: { jobStatus?: JobStatus | null }) {
  const { balance, isLoading, status, message, buyCredits } = useCredits(jobStatus);

  const buyTooltipText =
    status === "not_configured" || status === "error"
      ? (message ?? "Something went wrong.")
      : "Your current credit balance — click to buy more.";

  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Buy credits"
        onClick={buyCredits}
        disabled={isLoading}
        className="flex h-7 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] bg-yellow-400 px-2.5 text-[0.8rem] font-medium text-yellow-950 transition-colors hover:bg-yellow-300 disabled:pointer-events-none disabled:opacity-50"
      >
        {balance !== null ? `${balance.toLocaleString()} credits` : "Buy Credits"}
      </TooltipTrigger>
      <TooltipContent>{buyTooltipText}</TooltipContent>
    </Tooltip>
  );
}
