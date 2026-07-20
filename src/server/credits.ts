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
// else): 1 credit = $0.01 USD. Token costs below are each model's standard
// published per-token pricing (confirmed against
// https://platform.claude.com/docs/en/about-claude/pricing) as of this
// phase. This is a simple, directly-traceable-to-real-pricing model; a
// production system might add markup, but this phase intentionally prices
// at cost.
//
// Orchestration (src/server/agent.ts) now runs the planner on
// claude-opus-4-8 and the builder/reviewer/debugger on claude-sonnet-5 —
// materially different per-token rates, so cost must be computed per the
// actual model used for each call, not one flat rate for every call.
// ---------------------------------------------------------------------------

/** 1 credit = $0.01 USD. The unit the UI and ledger both speak in. */
export const CREDITS_PER_USD = 100;

interface ModelRate {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Cache-read rate. Both vendors price cached input at ~10% of fresh input; absent = 10% of inputPerMillionUsd. */
  cachedInputPerMillionUsd?: number;
}

/** Standard (non-batch) per-token pricing, by model id — keep in sync with src/lib/models.ts's MODEL_CATALOG. */
const MODEL_PRICING: Record<string, ModelRate> = {
  // Claude Sonnet 5 standard pricing: $3.00 / $15.00 per 1,000,000 tokens.
  "claude-sonnet-5": { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
  // Claude Opus 4.8 standard pricing: $5.00 / $25.00 per 1,000,000 tokens.
  "claude-opus-4-8": { inputPerMillionUsd: 5.0, outputPerMillionUsd: 25.0 },
  // GPT-5.6 tiers — verified against OpenAI's pricing page (July 2026):
  // sol $5/$0.50-cached/$30, terra $2.50/$0.25/$15, luna $1/$0.10/$6.
  "gpt-5.6-sol": { inputPerMillionUsd: 5.0, outputPerMillionUsd: 30.0, cachedInputPerMillionUsd: 0.5 },
  "gpt-5.6-terra": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 15.0, cachedInputPerMillionUsd: 0.25 },
  "gpt-5.6-luna": { inputPerMillionUsd: 1.0, outputPerMillionUsd: 6.0, cachedInputPerMillionUsd: 0.1 },
};

/** Falls back to here (with a warning) for any model string not in MODEL_PRICING above — never silently bills $0. */
const FALLBACK_RATE = MODEL_PRICING["claude-sonnet-5"];

function rateForModel(model: string): ModelRate {
  const rate = MODEL_PRICING[model];
  if (!rate) {
    console.warn(
      `[credits] no pricing entry for model "${model}" — billing at claude-sonnet-5's rate as a fallback. Add this model to MODEL_PRICING in src/server/credits.ts.`
    );
    return FALLBACK_RATE;
  }
  return rate;
}

/** Starting balance granted once per new user — $10.00 worth of usage. */
export const SIGNUP_BONUS_CREDITS = 1000;

/**
 * Converts a job's raw token usage into credits, using the given model's
 * rate from MODEL_PRICING above. Always rounds up (ceil) so any nonzero
 * usage debits at least 1 credit — never silently rounds a real cost down
 * to 0.
 */
export function computeCreditsForUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): number {
  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return 0;
  const rate = rateForModel(model);
  // `inputTokens` from the AI SDK includes cached reads; bill the cached
  // portion at the (much cheaper) cache-read rate and only the remainder at
  // the full input rate. Clamp defensively in case a provider ever reports
  // cached > input.
  const cached = Math.min(Math.max(cachedInputTokens, 0), Math.max(inputTokens, 0));
  const freshInput = Math.max(inputTokens - cached, 0);
  const cachedRate = rate.cachedInputPerMillionUsd ?? rate.inputPerMillionUsd * 0.1;
  const usd =
    (freshInput / 1_000_000) * rate.inputPerMillionUsd +
    (cached / 1_000_000) * cachedRate +
    (outputTokens / 1_000_000) * rate.outputPerMillionUsd;
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
 * src/server/agent.ts immediately after it appends a `usage` event (every
 * query() call in the plan/build/review/debug pipeline calls this once
 * each, passing whichever model actually ran that call). Never throws on a
 * missing owner (an orphaned/deleted job) — just does nothing, since there's
 * no one to debit.
 */
export async function debitForJobUsage(
  jobId: string,
  step: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): Promise<void> {
  const credits = computeCreditsForUsage(model, inputTokens, outputTokens, cachedInputTokens);
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
