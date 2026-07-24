import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, projects, sessions } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";

// Ownership checks for session/project/job-scoped API routes: resolves the
// signed-in user and compares against the resource's owning userId, joined
// through sessions/projects/jobs — same join shape as src/server/credits.ts's
// getJobOwnerUserId. Unconditional by design; see src/lib/auth.ts.

/**
 * Thrown by assert*Ownership when a resource doesn't exist OR exists but is
 * owned by a different user. Deliberately indistinguishable between the two
 * cases (same message, no extra detail) — route handlers must map this to a
 * generic 404, never a 403, so a request can't be used to probe/enumerate
 * other users' resource ids.
 */
export class ForbiddenError extends Error {
  constructor() {
    super("Not found");
    this.name = "ForbiddenError";
  }
}

async function getSessionOwnerUserId(sessionId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ userId: projects.userId })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(eq(sessions.id, sessionId));
  return row?.userId ?? null;
}

async function getProjectOwnerUserId(projectId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row?.userId ?? null;
}

/** Resolves the owning user id for a job via jobs -> sessions -> projects (mirrors src/server/credits.ts's getJobOwnerUserId). */
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
 * The actual "is this allowed" decision, isolated as a plain, dependency-free
 * function so it's directly unit-testable without a DB connection or real
 * Clerk credentials. `ownerUserId` is null when the resource doesn't exist.
 */
export function ownershipMatches(
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  return ownerUserId !== null && ownerUserId === currentUserId;
}

async function assertOwnership(
  getOwnerUserId: () => Promise<string | null>
): Promise<void> {
  // Independent lookups — getOwnerUserId() queries by resource id and never
  // consults the current user — so they run concurrently rather than paying
  // two serialized round trips to a remote DB. Promise.all rejects on the
  // first failure, same as the sequential awaits did.
  const [currentUser, ownerUserId] = await Promise.all([
    getCurrentUser(),
    getOwnerUserId(),
  ]);
  if (!ownershipMatches(ownerUserId, currentUser.id)) {
    throw new ForbiddenError();
  }
}

/** No-op when Clerk is unconfigured. Otherwise throws ForbiddenError unless the current user owns the project that owns this session. */
export async function assertSessionOwnership(sessionId: string): Promise<void> {
  await assertOwnership(() => getSessionOwnerUserId(sessionId));
}

/** No-op when Clerk is unconfigured. Otherwise throws ForbiddenError unless the current user owns this project. */
export async function assertProjectOwnership(projectId: string): Promise<void> {
  await assertOwnership(() => getProjectOwnerUserId(projectId));
}

/** No-op when Clerk is unconfigured. Otherwise throws ForbiddenError unless the current user owns the project that (via its session) owns this job. */
export async function assertJobOwnership(jobId: string): Promise<void> {
  await assertOwnership(() => getJobOwnerUserId(jobId));
}
