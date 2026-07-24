import { createHmac, timingSafeEqual } from "node:crypto";

// Razorpay billing — "Buy Credits".
//
// Uses Payment Links rather than the Checkout.js modal: a link is created
// server-side and the browser is redirected to its short_url, so no publishable
// key reaches the client and no Razorpay script is loaded. The webhook is the
// only path that ever grants credits.
//
// Raw fetch rather than the razorpay SDK, matching the neonFetch / vercel.ts
// pattern already used for REST integrations here. The two calls this needs
// (create a link, verify an HMAC) are small enough that a dependency would cost
// more than it saves.

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

/** Fixed rupee price for one credit pack, in paise (Razorpay's subunit). */
export const CREDIT_PACK_PRICE_INR_PAISE = 90_000;

/**
 * Credits granted per pack. Deliberately independent of the INR price above:
 * credits are denominated in USD internally (1 credit = $0.01, see
 * src/server/credits.ts) because model rates are published in USD. The rupee
 * price is a sticker price, so the effective margin moves with the exchange
 * rate — revisit CREDIT_PACK_PRICE_INR_PAISE if that drifts too far.
 */
export const CREDIT_PACK_CREDITS = 1000;

export function isRazorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function isRazorpayWebhookConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);
}

function authHeader(): string {
  const token = Buffer.from(
    `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
  ).toString("base64");
  return `Basic ${token}`;
}

/**
 * Creates a Payment Link for one credit pack and returns its short_url for the
 * client to redirect to.
 *
 * `notes` is Razorpay's metadata field (max 15 pairs, 256 chars each). The
 * webhook reads userId and credits back out of it, so the amount and recipient
 * are never taken from anything the client could set.
 *
 * callback_method must be "get" whenever callback_url is passed — Razorpay
 * rejects the request otherwise. The callback is cosmetic: it returns the user
 * to the app, and grants nothing. Only the webhook grants credits.
 */
export async function createCreditCheckoutSession(
  userId: string,
  origin: string
): Promise<{ url: string }> {
  if (!isRazorpayConfigured()) {
    throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured");
  }

  const res = await fetch(`${RAZORPAY_API_BASE}/payment_links`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: CREDIT_PACK_PRICE_INR_PAISE,
      currency: "INR",
      description: `${CREDIT_PACK_CREDITS.toLocaleString()} agent usage credits`,
      notes: {
        userId,
        credits: String(CREDIT_PACK_CREDITS),
      },
      callback_url: `${origin}/?checkout=success`,
      callback_method: "get",
      reminder_enable: false,
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.short_url) {
    const detail = data?.error?.description ?? `HTTP ${res.status}`;
    throw new Error(`Razorpay did not return a payment link: ${detail}`);
  }

  return { url: data.short_url as string };
}

/**
 * Verifies the X-Razorpay-Signature header against the raw request body.
 *
 * HMAC-SHA256 over the RAW body with the webhook secret as key — the body must
 * not be parsed and re-serialised first, since that changes the bytes the
 * signature was computed over.
 *
 * Compared with timingSafeEqual rather than ===, so the comparison can't leak
 * how many leading bytes matched. Length is checked first because
 * timingSafeEqual throws on a length mismatch.
 */
export function verifyRazorpayWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment_link?: {
      entity?: {
        status?: string;
        notes?: Record<string, string> | null;
      };
    };
  };
}

/**
 * Pulls the credit grant out of a VERIFIED webhook payload, or null when this
 * delivery isn't a completed credit-pack purchase.
 *
 * `eventId` comes from the x-razorpay-event-id header rather than the body:
 * Razorpay documents it as unique per event and intends it for exactly this
 * deduplication, and it is covered by the signature since the caller only
 * reaches here after verification.
 */
export function extractCreditGrant(
  body: unknown,
  eventId: string
): { userId: string; credits: number; eventId: string } | null {
  const payload = body as RazorpayWebhookPayload;
  if (payload?.event !== "payment_link.paid") return null;

  const entity = payload.payload?.payment_link?.entity;
  if (entity?.status !== "paid") return null;

  const userId = entity.notes?.userId;
  const creditsRaw = entity.notes?.credits;
  if (!userId || !creditsRaw || !eventId) return null;

  const credits = Number.parseInt(creditsRaw, 10);
  if (!Number.isFinite(credits) || credits <= 0) return null;

  return { userId, credits, eventId };
}
