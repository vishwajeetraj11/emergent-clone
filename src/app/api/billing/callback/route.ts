import { NextResponse } from "next/server";
import { verifyCheckoutCallback } from "@/server/razorpay";
import { grantCreditPurchase } from "@/server/credits";

// Razorpay Checkout posts here after payment (form-encoded, because
// `callback_url` was passed instead of a client-side handler).
//
// This grants credits, and so does the webhook. That is deliberate: both key
// their ledger row on the razorpay payment id, so whichever arrives first wins
// and the other atomically no-ops. The callback gives the user their balance
// immediately; the webhook guarantees the grant happens even if the browser
// never comes back.
//
// The redirect target carries no authority — it only decides which banner the
// user sees. Nothing downstream trusts it.

export async function POST(request: Request) {
  const origin = new URL(request.url).origin;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.redirect(`${origin}/?checkout=failed`, { status: 303 });
  }

  const orderId = String(form.get("razorpay_order_id") ?? "");
  const paymentId = String(form.get("razorpay_payment_id") ?? "");
  const signature = String(form.get("razorpay_signature") ?? "");

  const grant = await verifyCheckoutCallback(orderId, paymentId, signature);
  if (!grant) {
    // Bad signature, or an order we never created. Never say which.
    return NextResponse.redirect(`${origin}/?checkout=failed`, { status: 303 });
  }

  try {
    await grantCreditPurchase(grant.userId, grant.credits, grant.paymentId);
  } catch (err) {
    // The payment is real and verified, so don't tell the user it failed — the
    // webhook will grant it on its own schedule.
    console.error("[api/billing/callback] failed to grant credits", err);
  }

  // 303 so the browser follows with GET rather than replaying this POST.
  return NextResponse.redirect(`${origin}/dashboard?checkout=success`, { status: 303 });
}
