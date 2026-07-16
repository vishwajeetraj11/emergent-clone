import { NextResponse } from "next/server";
import { getCurrentUser, isClerkConfigured } from "@/lib/auth";
import { DEV_USER } from "@/lib/dev-user";
import { createCreditCheckoutSession, isStripeConfigured } from "@/server/stripe";

/**
 * Phase 4 (Half B, gated inert): the "Buy Credits" button's endpoint.
 * Unconfigured (default, no STRIPE_SECRET_KEY — always the case in this
 * environment): responds 200 with `configured: false` so the client can
 * surface a clear "Stripe is not configured" state, same pattern as
 * POST /api/sessions/[id]/save-github. Never live-verified beyond this OFF
 * path — no real Stripe key here.
 */
export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({
      configured: false,
      error: "Stripe is not configured in this environment. Set STRIPE_SECRET_KEY to enable purchases.",
    });
  }

  try {
    const userId = isClerkConfigured() ? (await getCurrentUser()).id : DEV_USER.id;
    const origin = new URL(request.url).origin;
    const { url } = await createCreditCheckoutSession(userId, origin);
    return NextResponse.json({ configured: true, url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/billing/checkout] failed", err);
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}
