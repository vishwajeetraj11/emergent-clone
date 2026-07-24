import { NextResponse } from "next/server";
import {
  isRazorpayWebhookConfigured,
  resolveWebhookGrant,
  verifyWebhookSignature,
} from "@/server/razorpay";
import { grantCreditPurchase } from "@/server/credits";

// Razorpay webhook — the reliable path for granting purchased credits.
//
// The checkout callback also grants, and both key their ledger row on the
// razorpay payment id, so whichever lands first wins and the other no-ops. The
// webhook is what makes the grant survive a browser that never came back.
//
// Signature is verified against the RAW body before the payload is parsed at
// all. The amount and recipient come from our own payment_orders row, keyed by
// the order id in the verified payload — never from the request itself.
//
// Subscribe this endpoint to `payment.captured` in the Razorpay dashboard.

export async function POST(request: Request) {
  if (!isRazorpayWebhookConfigured()) {
    return NextResponse.json(
      { error: "Razorpay webhooks are not configured in this environment." },
      { status: 501 }
    );
  }

  const signature = request.headers.get("x-razorpay-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing x-razorpay-signature header" }, { status: 400 });
  }

  // Raw text, not request.json() — parsing and re-serialising would change the
  // exact bytes the signature was computed over.
  const rawBody = await request.text();

  if (!verifyWebhookSignature(rawBody, signature)) {
    // Never echo verification detail — it leaks how the check failed.
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const grant = await resolveWebhookGrant(body);
  if (!grant) {
    // Not an event or order this flow cares about — 200 so Razorpay doesn't
    // retry a delivery we intentionally ignore.
    return NextResponse.json({ received: true });
  }

  try {
    await grantCreditPurchase(grant.userId, grant.credits, grant.paymentId);
  } catch (err) {
    console.error("[api/webhooks/razorpay] failed to grant credits", err);
    return NextResponse.json({ error: "Failed to record credit grant" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
