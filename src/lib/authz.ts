import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, projects, sessions } from "@/db/schema";
import { getCurrentUser, isClerkConfigured } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Ownership checks for session/project/job-scoped API routes.
//
// Unconfigured (default, always-tested path): DEV_USER owns every row and
// there is no real multi-tenancy, so every assert*Ownership call below is a
// no-op that returns immediately — same "gated inert" pattern already used
// throughout this codebase (isGitHubConfigured in src/server/github.ts,
// isVercelConfigured in src/server/vercel.ts, isStripeConfigured). This MUST
// NOT change any behavior in the unconfigured path.
//
// Configured: resolves the real signed-in Clerk user (getCurrentUser) and
// compares it against the resource's owning userId, joined through
// sessions/projects/jobs — same join shape as src/server/credits.ts's
// getJobOwnerUserId. Code-complete against the documented schema, NOT
// live-verified end-to-end — no real Clerk keys exist in this environment.
// ---------------------------------------------------------------------------

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
  if (!isClerkConfigured()) return;

  const currentUser = await getCurrentUser();
  const ownerUserId = await getOwnerUserId();
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
