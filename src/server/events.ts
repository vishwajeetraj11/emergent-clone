import { and, asc, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { events, jobs } from "@/db/schema";
import { isUniqueViolation } from "@/server/db-utils";
import type { EventRole, TimelineEventType } from "@/lib/types";

/** Row shape as returned by drizzle for the events table. */
export type EventRow = typeof events.$inferSelect;

const MAX_APPEND_RETRIES = 5;

/**
 * Appends an event to a job's append-only log, allocating the next `seq`
 * atomically. Under concurrent writers, two transactions can read the same
 * max(seq) and race to insert — the unique (job_id, seq) index turns the
 * loser into a 23505, which we retry against a freshly-read max.
 */
export async function appendEvent(
  jobId: string,
  role: EventRole,
  type: TimelineEventType,
  payload: Record<string, unknown>
): Promise<EventRow> {
  const db = getDb();

  for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        // Serialize appends per job: the select-max + insert below is a
        // read-then-write race under concurrent appenders (an onStatus
        // callback firing alongside the main flow's own append was observed
        // live exhausting all retries and silently dropping the losing
        // event). A transaction-scoped advisory lock keyed on the job id
        // makes concurrent appends for the SAME job queue instead of
        // collide — released automatically at commit/rollback, and appends
        // for different jobs don't contend at all. The unique-violation
        // retry loop stays as a belt for lock-free writers elsewhere.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${jobId}))`);
        const [row] = await tx
          .select({ maxSeq: sql<number>`coalesce(max(${events.seq}), -1)` })
          .from(events)
          .where(eq(events.jobId, jobId));
        const nextSeq = (row?.maxSeq ?? -1) + 1;

        const [inserted] = await tx
          .insert(events)
          .values({ jobId, seq: nextSeq, role, type, payload })
          .returning();
        return inserted;
      });
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_APPEND_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `appendEvent: exhausted retries allocating seq for job ${jobId}`
  );
}

/** All events for a job with seq > afterSeq, ordered ascending. */
export async function getEventsSince(
  jobId: string,
  afterSeq: number
): Promise<EventRow[]> {
  const db = getDb();
  return db
    .select()
    .from(events)
    .where(and(eq(events.jobId, jobId), gt(events.seq, afterSeq)))
    .orderBy(asc(events.seq));
}

/** All events for a job, oldest first. Convenience wrapper over getEventsSince. */
export async function getAllEvents(jobId: string): Promise<EventRow[]> {
  return getEventsSince(jobId, -1);
}

/**
 * All events across every job belonging to a session, ordered chronologically
 * (by created_at, ascending). `seq` is only unique within a single job — a
 * session can span many jobs over its lifetime (the initial build plus one
 * new job per "continue chatting" message) — so this joins events -> jobs to
 * scope by session and orders by wall-clock time instead of the per-job seq,
 * since job N's events always happen strictly after job N-1's.
 */
export async function getSessionEvents(
  sessionId: string
): Promise<(EventRow & { jobId: string })[]> {
  const db = getDb();
  return db
    .select({
      id: events.id,
      jobId: events.jobId,
      seq: events.seq,
      role: events.role,
      type: events.type,
      payload: events.payload,
      createdAt: events.createdAt,
    })
    .from(events)
    .innerJoin(jobs, eq(events.jobId, jobs.id))
    .where(eq(jobs.sessionId, sessionId))
    .orderBy(asc(events.createdAt));
}
