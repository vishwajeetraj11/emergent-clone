import { and, asc, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
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
