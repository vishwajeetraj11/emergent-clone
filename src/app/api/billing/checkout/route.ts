import { NextResponse } from "next/server";
import { getCurrentUser, isClerkConfigured } from "@/lib/auth";
import { DEV_USER } from "@/lib/dev-user";
import { createCreditOrder, isRazorpayConfigured } from "@/server/razorpay";

/**
 * The "Buy Credits" button's endpoint. Creates a Razorpay Order and returns
 * what the browser needs to open Checkout — never a payment URL, since this
 * flow opens Checkout client-side with a callback_url rather than redirecting.
 *
 * Unconfigured: responds 200 with `configured: false` so the client can surface
 * a clear message, same pattern as POST /api/sessions/[id]/save-github.
 */
export async function POST() {
  if (!isRazorpayConfigured()) {
    return NextResponse.json({
      configured: false,
      error:
        "Payments are not configured in this environment. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable purchases.",
    });
  }

  try {
    const userId = isClerkConfigured() ? (await getCurrentUser()).id : DEV_USER.id;
    const order = await createCreditOrder(userId);
    return NextResponse.json({ configured: true, ...order });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/billing/checkout] failed", err);
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}
