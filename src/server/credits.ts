import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { creditLedger, jobs, projects, sessions, users } from "@/db/schema";

// ---------------------------------------------------------------------------
// Phase 4 (Half A, REAL): credit ledger accounting.
//
// The `credit_ledger` table has existed since Phase 0 (userId, delta, reason,
// jobId) but nothing ever wrote real rows into it — this file is what turns
// it into an actual accounting system. Every `usage` event appended by the
// agent loop (src/server/agent.ts, logged since Phase 1) now produces a
// matching negative ledger row via debitForJobUsage, called right after each
// `appendEvent(jobId, "system", "usage", ...)`. Debiting happens
// incrementally, per usage event, not via a full-history recompute — cheap
// and correct as long as every usage event is debited exactly once (true
// here: each call site calls this exactly once per usage event it emits).
//
// COST MODEL (the only place these constants live — change here, nowhere
// else): 1 credit = $0.01 USD. Token costs below are Claude Sonnet 5's
// standard published per-token pricing (see PLAN.md's MODEL = "claude-sonnet-5"
// in src/server/agent.ts) as of this phase — $3/MTok input, $15/MTok output.
// This is a simple, directly-traceable-to-real-pricing model; a production
// system might add markup, but this phase intentionally prices at cost.
// ---------------------------------------------------------------------------

/** 1 credit = $0.01 USD. The unit the UI and ledger both speak in. */
export const CREDITS_PER_USD = 100;

/** Claude Sonnet 5 standard input pricing: $3.00 per 1,000,000 tokens. */
export const INPUT_COST_PER_MILLION_TOKENS_USD = 3.0;

/** Claude Sonnet 5 standard output pricing: $15.00 per 1,000,000 tokens. */
export const OUTPUT_COST_PER_MILLION_TOKENS_USD = 15.0;

/** Starting balance granted once per new user — $10.00 worth of usage. */
export const SIGNUP_BONUS_CREDITS = 1000;

/**
 * Converts a job's raw token usage into credits, using the constants above.
 * Always rounds up (ceil) so any nonzero usage debits at least 1 credit —
 * never silently rounds a real cost down to 0.
 */
export function computeCreditsForUsage(
  inputTokens: number,
  outputTokens: number
): number {
  if (inputTokens <= 0 && outputTokens <= 0) return 0;
  const usd =
    (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION_TOKENS_USD +
    (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION_TOKENS_USD;
  return Math.ceil(usd * CREDITS_PER_USD);
}

/** Resolves the owning user id for a job via jobs -> sessions -> projects. */
async function getJobOwnerUserId(jobId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ userId: projects.userId })
    .from(jobs)
    .innerJoin(sessions, eq(jobs.sessionId, sessions.id))
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(eq(jobs.id, jobId));
  return row?.userId ?? null;
}

/**
 * Debits a job's owner for one usage event's token cost — called from
 * src/server/agent.ts immediately after it appends a `usage` event (scoping,
 * summary, and build queries all call this once each). Never throws on a
 * missing owner (an orphaned/deleted job) — just does nothing, since there's
 * no one to debit.
 */
export async function debitForJobUsage(
  jobId: string,
  step: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  const credits = computeCreditsForUsage(inputTokens, outputTokens);
  if (credits <= 0) return;

  const userId = await getJobOwnerUserId(jobId);
  if (!userId) return;

  const db = getDb();
  await db.insert(creditLedger).values({
    userId,
    delta: -credits,
    reason: `usage:${step}`,
    jobId,
  });
}

/** Sums all ledger rows for a user — the real, live credit balance. */
export async function getUserCreditBalance(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return Number(row?.total ?? 0);
}

const SIGNUP_BONUS_REASON = "signup_bonus";

/**
 * Grants the one-time starting balance the first time a user is seen —
 * idempotent via a unique index on `creditLedger.idempotencyKey` (see
 * src/db/schema.ts), not a check-then-insert: two concurrent calls for the
 * same brand-new user (e.g. two near-simultaneous GET /api/credits requests)
 * both attempt the insert, and Postgres's unique constraint atomically
 * rejects the second one via onConflictDoNothing — a plain SELECT-then-INSERT
 * can't be made atomic this way even inside a transaction under read
 * committed. Safe to call on every request rather than only "on user
 * creation". Called from src/server/jobs.ts (project creation, both
 * DEV_USER and Clerk owner branches) and from GET /api/credits (so the
 * balance is non-zero even before the user's first project).
 */
export async function ensureSignupBonus(userId: string): Promise<void> {
  const db = getDb();
  await db
    .insert(creditLedger)
    .values({
      userId,
      delta: SIGNUP_BONUS_CREDITS,
      reason: SIGNUP_BONUS_REASON,
      idempotencyKey: `signup_bonus:${userId}`,
    })
    .onConflictDoNothing({ target: creditLedger.idempotencyKey });
}

/**
 * Grants a credit-pack purchase from a verified Stripe webhook event — see
 * src/server/stripe.ts. `stripeEventId` is folded into `idempotencyKey`
 * (unique-indexed, see src/db/schema.ts) so a retried or duplicate-delivered
 * webhook (Stripe retries on non-2xx, and may also deliver the same event
 * more than once, including near-simultaneously) atomically no-ops via
 * onConflictDoNothing rather than racing a SELECT-then-INSERT check.
 */
export async function grantStripePurchase(
  userId: string,
  credits: number,
  stripeEventId: string
): Promise<void> {
  const db = getDb();
  const reason = `stripe_purchase:${stripeEventId}`;

  await db
    .insert(creditLedger)
    .values({
      userId,
      delta: credits,
      reason,
      idempotencyKey: reason,
    })
    .onConflictDoNothing({ target: creditLedger.idempotencyKey });
}

/** Row shape for a user, used by the small dev-user upsert below. */
type UsersInsert = typeof users.$inferInsert;

/**
 * Ensures a `users` row exists for `userId` (idempotent upsert) — used only
 * by the DEV_USER bootstrap path so GET /api/credits works even before any
 * project has ever been created in this environment.
 */
export async function ensureUserRow(row: UsersInsert): Promise<void> {
  const db = getDb();
  await db.insert(users).values(row).onConflictDoNothing({ target: users.id });
}
