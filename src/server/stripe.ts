import Stripe from "stripe";

// ---------------------------------------------------------------------------
// Phase 4 (Half B, gated inert): Stripe billing — "Buy Credits". Same
// pattern as Clerk (src/lib/auth.ts) and GitHub (src/server/github-app.ts):
// isStripeConfigured() gates everything else in this file, real Stripe SDK
// usage underneath, inert/clear-error behavior when unconfigured.
//
// No STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PUBLISHABLE_KEY exist
// in this environment. This is code-complete against Stripe's current
// documented Checkout Sessions + webhook-verification APIs but NOT
// live-verified — no real keys were available when this phase was built.
//
// PRICE MODEL (documented once, here): one credit pack costs $10.00 USD and
// grants 1,000 credits — the same $0.01-per-credit rate as the internal cost
// model in src/server/credits.ts (CREDITS_PER_USD), i.e. no markup. A real
// production deploy would likely price with margin; this phase prices at
// cost since there's no real payment flow to tune against yet.
// ---------------------------------------------------------------------------

/** $10.00, in cents — Stripe's `unit_amount` is always the smallest currency unit. */
export const CREDIT_PACK_PRICE_USD_CENTS = 1000;

/** Credits granted per successful credit-pack purchase — see the price-model note above. */
export const CREDIT_PACK_CREDITS = 1000;

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function isStripeWebhookConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

function getStripeClient(): Stripe {
  // Never log this value — getStripeClient() is only ever called from
  // behind an isStripeConfigured() check, so process.env.STRIPE_SECRET_KEY
  // is known to be set here.
  return new Stripe(process.env.STRIPE_SECRET_KEY as string);
}

/**
 * Creates a real Stripe Checkout Session for one credit pack. `origin` is
 * the caller's own request origin (e.g. `https://myapp.example.com`),
 * passed in by the route handler rather than hardcoded, so this works in
 * both dev and any real deploy without an extra env var. `userId` is
 * embedded in `metadata` — the ONLY place the eventual webhook handler reads
 * "which user to credit" from, and it comes from the session's metadata on
 * a Stripe-signed event, never from anything the client can set directly.
 */
export async function createCreditCheckoutSession(
  userId: string,
  origin: string
): Promise<{ url: string }> {
  if (!isStripeConfigured()) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `${CREDIT_PACK_CREDITS.toLocaleString()} credits`,
            description: "Emergent clone — agent usage credits",
          },
          unit_amount: CREDIT_PACK_PRICE_USD_CENTS,
        },
        quantity: 1,
      },
    ],
    metadata: {
      userId,
      credits: String(CREDIT_PACK_CREDITS),
    },
    success_url: `${origin}/?checkout=success`,
    cancel_url: `${origin}/?checkout=cancelled`,
  });

  if (!session.url) {
    throw new Error("Stripe did not return a Checkout Session URL");
  }
  return { url: session.url };
}

/**
 * Verifies a webhook delivery's signature using Stripe's own SDK helper
 * (never hand-rolled) and returns the parsed event. Throws on a bad/missing
 * signature — callers must treat that as a 400, never process the payload.
 */
export function constructStripeWebhookEvent(
  rawBody: string,
  signature: string
): Stripe.Event {
  if (!isStripeWebhookConfigured()) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  }
  const stripe = getStripeClient();
  // stripe.webhooks.constructEvent is Stripe's own signature-verification
  // helper (HMAC over the raw body + timestamp) — this is the "don't skip
  // verification, don't hand-roll it" requirement satisfied.
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET as string
  );
}

/**
 * Extracts (userId, credits) from a verified `checkout.session.completed`
 * event's metadata — the only inputs the webhook handler trusts for "who
 * gets credited how much". Returns null if the event isn't a completed
 * credit-pack checkout, or is missing the metadata this flow always sets.
 */
export function extractCreditGrantFromEvent(
  event: Stripe.Event
): { userId: string; credits: number; eventId: string } | null {
  if (event.type !== "checkout.session.completed") return null;
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") return null;

  const userId = session.metadata?.userId;
  const creditsRaw = session.metadata?.credits;
  if (!userId || !creditsRaw) return null;

  const credits = Number.parseInt(creditsRaw, 10);
  if (!Number.isFinite(credits) || credits <= 0) return null;

  return { userId, credits, eventId: event.id };
}
