import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { paymentOrders } from "@/db/schema";

// Razorpay billing — "Buy Credits".
//
// Razorpay's standard web flow: create an Order server-side, open Checkout in
// the browser with that order_id, and verify the signature Razorpay returns.
// Passing `callback_url` (rather than a client `handler`) makes Checkout POST
// the result back to our server, so verification happens server-side.
//
// Raw fetch rather than the razorpay SDK, matching the neonFetch / vercel.ts
// pattern used for the other REST integrations here.

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

/** Fixed rupee price for one credit pack, in paise (Razorpay's subunit). */
export const CREDIT_PACK_PRICE_INR_PAISE = 90_000;

/**
 * Credits granted per pack. Deliberately independent of the INR price above:
 * credits are USD-denominated internally (1 credit = $0.01, see credits.ts)
 * because model rates are published in USD. The rupee price is a sticker
 * price, so the effective margin moves with the exchange rate.
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

/** Constant-time compare of two hex digests. */
function signatureMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  // timingSafeEqual throws on a length mismatch, so check that first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CheckoutOrder {
  orderId: string;
  keyId: string;
  amount: number;
  currency: "INR";
  credits: number;
}

/**
 * Creates a Razorpay Order for one credit pack and records it, returning what
 * the browser needs to open Checkout.
 *
 * The row in `payment_orders` is the point of this: both the callback and the
 * webhook resolve userId and credits from it rather than from anything the
 * client sends or from the payment's `notes`.
 */
export async function createCreditOrder(userId: string): Promise<CheckoutOrder> {
  if (!isRazorpayConfigured()) {
    throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured");
  }

  const res = await fetch(`${RAZORPAY_API_BASE}/orders`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: CREDIT_PACK_PRICE_INR_PAISE,
      currency: "INR",
      // Max 40 chars. Random rather than derived from userId so the receipt
      // can't be guessed from a known user id.
      receipt: `credits_${crypto.randomUUID().slice(0, 24)}`,
      notes: { userId, credits: String(CREDIT_PACK_CREDITS) },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.id) {
    const detail = data?.error?.description ?? `HTTP ${res.status}`;
    throw new Error(`Razorpay did not create an order: ${detail}`);
  }

  const db = getDb();
  await db.insert(paymentOrders).values({
    razorpayOrderId: data.id as string,
    userId,
    credits: CREDIT_PACK_CREDITS,
    amountPaise: CREDIT_PACK_PRICE_INR_PAISE,
  });

  return {
    orderId: data.id as string,
    keyId: process.env.RAZORPAY_KEY_ID!,
    amount: CREDIT_PACK_PRICE_INR_PAISE,
    currency: "INR",
    credits: CREDIT_PACK_CREDITS,
  };
}

/**
 * Verifies a Checkout callback and resolves what to grant.
 *
 * The signature is HMAC-SHA256 of `order_id|payment_id` keyed with the API
 * secret. Because that digest cannot be produced without the secret, a match
 * proves both ids are authentic — but the amount and recipient are still read
 * from our own `payment_orders` row, never from the request.
 *
 * Returns null when the signature fails or the order is unknown.
 */
export async function verifyCheckoutCallback(
  orderId: string,
  paymentId: string,
  signature: string
): Promise<{ userId: string; credits: number; paymentId: string } | null> {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || !signature) return null;

  const expected = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  if (!signatureMatches(expected, signature)) return null;

  const db = getDb();
  const [row] = await db
    .select({ userId: paymentOrders.userId, credits: paymentOrders.credits })
    .from(paymentOrders)
    .where(eq(paymentOrders.razorpayOrderId, orderId));
  if (!row) return null;

  return { userId: row.userId, credits: row.credits, paymentId };
}

/**
 * Verifies the X-Razorpay-Signature header against the RAW webhook body.
 *
 * The body must not be parsed and re-serialised first — that changes the bytes
 * the signature was computed over.
 */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return signatureMatches(expected, signature);
}

interface WebhookBody {
  event?: string;
  payload?: { payment?: { entity?: { id?: string; order_id?: string } } };
}

/**
 * Resolves a grant from a VERIFIED webhook body, or null when the delivery
 * isn't a captured credit-pack payment.
 *
 * Subscribed event is `payment.captured`. Like the callback path, userId and
 * credits come from our own row, keyed by the order id in the payload.
 */
export async function resolveWebhookGrant(
  body: unknown
): Promise<{ userId: string; credits: number; paymentId: string } | null> {
  const parsed = body as WebhookBody;
  if (parsed?.event !== "payment.captured") return null;

  const entity = parsed.payload?.payment?.entity;
  const paymentId = entity?.id;
  const orderId = entity?.order_id;
  if (!paymentId || !orderId) return null;

  const db = getDb();
  const [row] = await db
    .select({ userId: paymentOrders.userId, credits: paymentOrders.credits })
    .from(paymentOrders)
    .where(eq(paymentOrders.razorpayOrderId, orderId));
  if (!row) return null;

  return { userId: row.userId, credits: row.credits, paymentId };
}
