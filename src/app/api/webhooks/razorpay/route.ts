import { NextResponse } from "next/server";
import {
  extractCreditGrant,
  isRazorpayWebhookConfigured,
  verifyRazorpayWebhookSignature,
} from "@/server/razorpay";
import { grantCreditPurchase } from "@/server/credits";

// Razorpay webhook — the ONLY path that ever grants purchased credits.
//
// The signature is verified against the raw body before the payload is parsed
// at all; an unsigned or mis-signed request is rejected with 400 and never
// reaches the ledger. The granted amount and recipient are read from the
// verified payload's `notes`, which were set server-side when the payment link
// was created — nothing is ever taken from a client-supplied value.

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

  // Unique per event, and Razorpay's documented mechanism for deduplicating
  // redelivered webhooks — folded into the ledger's idempotency key below.
  const eventId = request.headers.get("x-razorpay-event-id");
  if (!eventId) {
    return NextResponse.json({ error: "Missing x-razorpay-event-id header" }, { status: 400 });
  }

  // Raw text, not request.json() — parsing and re-serialising would change the
  // exact bytes the signature was computed over.
  const rawBody = await request.text();

  if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
    // Never echo verification detail back — it leaks information about the
    // signing secret's validation internals.
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const grant = extractCreditGrant(body, eventId);
  if (!grant) {
    // Not an event type or payload shape this flow cares about — 200 so
    // Razorpay doesn't retry a delivery we intentionally ignore.
    return NextResponse.json({ received: true });
  }

  try {
    // Idempotent on the event id — a retried delivery never double-grants.
    await grantCreditPurchase(grant.userId, grant.credits, grant.eventId);
  } catch (err) {
    console.error("[api/webhooks/razorpay] failed to grant credits", err);
    return NextResponse.json({ error: "Failed to record credit grant" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
