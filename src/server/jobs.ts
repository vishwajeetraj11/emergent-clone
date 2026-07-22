import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, projects, sessions, users } from "@/db/schema";
import { DEV_USER } from "@/lib/dev-user";
import { getCurrentUser, isClerkConfigured } from "@/lib/auth";
import type { JobStatus } from "@/lib/types";
import { appendEvent } from "@/server/events";
import { ensureSignupBonus } from "@/server/credits";
import { isUniqueViolation } from "@/server/db-utils";
import { makeProjectSlug } from "@/server/slug";
import { runAgentLoop } from "@/server/agent";
import { setJobApiKeys, type UserApiKeys } from "@/server/user-keys";

export type ProjectRow = typeof projects.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

const MAX_SLUG_ATTEMPTS = 5;

/**
 * Single-user dev mode (Phase 0-2, see src/lib/dev-user.ts): make sure the
 * fixed dev user row exists before we FK anything to it. Idempotent — safe
 * to call on every request. Phase 3: only runs when Clerk isn't configured;
 * when it is, getCurrentUser() below already provisions the real user's row
 * (just-in-time, on that user's first authenticated request).
 */
async function ensureDevUser() {
  const db = getDb();
  await db
    .insert(users)
    .values({ id: DEV_USER.id, email: DEV_USER.email, name: DEV_USER.name })
    .onConflictDoNothing({ target: users.id });
}

/**
 * Creates a project + session + job for a fresh prompt, seeds event seq 0
 * with the user's message, and kicks off the agent loop.
 *
 * PHASE 1 LIMITATION: the agent loop is started as a detached promise inside
 * this Node process (see runAgentLoop / src/server/agent.ts). It is not
 * durable — if the dev server restarts (hot reload, crash, redeploy) while a
 * job is running or waiting_on_user, that job is orphaned: its status stays
 * whatever it last was in the DB, but nothing will ever resume it. This is
 * acceptable for Phase 1; a durable queue/worker is out of scope until a
 * later phase.
 */
export async function createProjectAndJob(prompt: string, model?: string, apiKeys?: UserApiKeys) {
  const db = getDb();

  // Phase 3: isClerkConfigured() gates which user this project is owned by.
  // Unconfigured (default, always-tested): ensureDevUser + DEV_USER.id,
  // unchanged from Phase 0-2. Configured: getCurrentUser() resolves the real
  // signed-in Clerk user's row instead, provisioning it if this is their very
  // first authenticated request — unverified, no real keys in this
  // environment.
  let owner: { id: string };
  if (isClerkConfigured()) {
    owner = await getCurrentUser();
  } else {
    await ensureDevUser();
    owner = DEV_USER;
  }
  // Phase 4: idempotent — only actually grants credits the first time this
  // user is seen (see src/server/credits.ts's ensureSignupBonus).
  await ensureSignupBonus(owner.id);

  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Prompt must not be empty");
  }

  let project: ProjectRow | undefined;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = makeProjectSlug(trimmed);
    try {
      [project] = await db
        .insert(projects)
        .values({ userId: owner.id, name: slug, slug })
        .returning();
      break;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_SLUG_ATTEMPTS - 1) {
        continue;
      }
      throw err;
    }
  }
  if (!project) {
    throw new Error("Failed to allocate a unique project slug");
  }

  const [session] = await db
    .insert(sessions)
    .values({ projectId: project.id })
    .returning();

  const [job] = await db
    .insert(jobs)
    .values({ sessionId: session.id, status: "running" })
    .returning();

  // `model` rides the user_message payload exactly like planMode does on the
  // continuation path (src/server/sessions.ts) — runRealLoop reads it back
  // and validates it against the catalog (resolveBuilderModel).
  await appendEvent(job.id, "user", "user_message", {
    text: trimmed,
    ...(model ? { model } : {}),
  });

  // BYOK: stash the user's own provider key(s) (see src/server/user-keys.ts)
  // in the process-local store keyed by this job's id — deliberately NOT on
  // the event payload above, which is persisted to the DB and streamed to
  // the client. Must happen AFTER the job row exists (needs job.id) and
  // BEFORE runAgentLoop fires below, since the loop reads this store back
  // while resolving models for this job.
  if (apiKeys) setJobApiKeys(job.id, apiKeys);

  // Fire-and-forget: intentionally not awaited. See the Phase 1 limitation
  // note above.
  runAgentLoop(job.id).catch((err) => {
    console.error(`[agent] job ${job.id} loop crashed`, err);
  });

  return { project, session, job };
}

export async function getJob(jobId: string): Promise<JobRow | null> {
  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  return job ?? null;
}

export async function setJobStatus(
  jobId: string,
  status: JobStatus
): Promise<JobRow | null> {
  const db = getDb();
  const [job] = await db
    .update(jobs)
    .set({ status, updatedAt: new Date() })
    .where(eq(jobs.id, jobId))
    .returning();
  return job ?? null;
}

/**
 * Persists the Claude Agent SDK session id for a job's main (scoping) query
 * so a later phase can resume it. Phase 1 only stores this — it does not
 * implement resuming a query() from a new process.
 */
export async function setAgentSessionId(
  jobId: string,
  agentSessionId: string
): Promise<JobRow | null> {
  const db = getDb();
  const [job] = await db
    .update(jobs)
    .set({ agentSessionId, updatedAt: new Date() })
    .where(eq(jobs.id, jobId))
    .returning();
  return job ?? null;
}
