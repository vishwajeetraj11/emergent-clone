import { NextResponse } from "next/server";
import {
  constructStripeWebhookEvent,
  extractCreditGrantFromEvent,
  isStripeWebhookConfigured,
} from "@/server/stripe";
import { grantStripePurchase } from "@/server/credits";

// ---------------------------------------------------------------------------
// Stripe webhook — the ONLY path that ever
// grants purchased credits. Verifies the signature via Stripe's own SDK
// helper (constructStripeWebhookEvent -> stripe.webhooks.constructEvent)
// before touching the payload at all; an unsigned/mis-signed request is
// rejected with 400 and never reaches the ledger. Credits granted here are
// read entirely from the verified event's metadata (set server-side when
// the Checkout Session was created — see src/server/stripe.ts) — nothing
// about the amount or recipient is ever taken from a client-supplied value.
//
// Not live-verified beyond "is unconfigured -> reject cleanly" — no real
// STRIPE_WEBHOOK_SECRET exists in this environment, so the signature
// verification path itself has never run against a real Stripe delivery.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  if (!isStripeWebhookConfigured()) {
    // Not configured: reject cleanly rather than pretending to accept
    // webhook deliveries nothing will ever verify.
    return NextResponse.json(
      { error: "Stripe webhooks are not configured in this environment." },
      { status: 501 }
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  // Raw body text is required for signature verification — parsing to JSON
  // first would change the exact bytes the signature was computed over.
  const rawBody = await request.text();

  let event;
  try {
    event = constructStripeWebhookEvent(rawBody, signature);
  } catch {
    // Never echo the verification error detail back to the client — it can
    // leak information about the signing secret's validation internals.
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const grant = extractCreditGrantFromEvent(event);
  if (!grant) {
    // Not an event type / payload shape this flow cares about — 200 so
    // Stripe doesn't retry a delivery we intentionally ignore.
    return NextResponse.json({ received: true });
  }

  try {
    // grantStripePurchase is itself idempotent on (event id) — a retried
    // delivery of the same event never double-grants.
    await grantStripePurchase(grant.userId, grant.credits, grant.eventId);
  } catch (err) {
    console.error("[api/webhooks/stripe] failed to grant credits", err);
    return NextResponse.json({ error: "Failed to record credit grant" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
