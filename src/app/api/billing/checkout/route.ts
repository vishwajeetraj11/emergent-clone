import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createCreditCheckoutSession, isRazorpayConfigured } from "@/server/razorpay";

/**
 * The "Buy Credits" button's endpoint.
 * Unconfigured (default, no STRIPE_SECRET_KEY — always the case in this
 * environment): responds 200 with `configured: false` so the client can
 * surface a clear "not configured" state, same pattern as
 * POST /api/sessions/[id]/save-github. Never live-verified beyond this OFF
 * path — no real Razorpay key here.
 */
export async function POST(request: Request) {
  if (!isRazorpayConfigured()) {
    return NextResponse.json({
      configured: false,
      error:
        "Payments are not configured in this environment. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable purchases.",
    });
  }

  try {
    const userId = (await getCurrentUser()).id;
    const origin = new URL(request.url).origin;
    const { url } = await createCreditCheckoutSession(userId, origin);
    return NextResponse.json({ configured: true, url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/billing/checkout] failed", err);
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}
