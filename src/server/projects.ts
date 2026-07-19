import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, projects, sessions, users } from "@/db/schema";
import type { JobRow, ProjectRow, SessionRow } from "@/server/jobs";

// ---------------------------------------------------------------------------
// Phase 3: read-side helper for the persistence route (GET /api/projects/[id])
// — loads a project plus its most recent session and that session's most
// recent job, so a real bookmarkable/reloadable URL (/p/[projectId]) can
// rebuild client state from Postgres alone. A fork creates a new session
// under the same project (see src/server/sessions.ts), so "most recent
// session" also happens to be how the UI naturally lands on a fork after a
// reload — no separate session-picker UI needed for this phase.
// ---------------------------------------------------------------------------

export interface ProjectDetail {
  project: ProjectRow;
  session: SessionRow | null;
  job: JobRow | null;
}

/** Every project owned by a user, most recent first — backs GET /api/projects (dashboard list). */
export async function listProjectsForUser(userId: string): Promise<ProjectRow[]> {
  const db = getDb();
  return db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.createdAt));
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetail | null> {
  const db = getDb();

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return null;

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  if (!session) return { project, session: null, job: null };

  const [job] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.sessionId, session.id))
    .orderBy(desc(jobs.createdAt))
    .limit(1);

  return { project, session, job: job ?? null };
}

export interface ProjectSessionSummary {
  id: string;
  parentSessionId: string | null;
  createdAt: Date;
  job: { id: string; status: JobRow["status"] } | null;
}

/**
 * Every session under a project (the original plus every fork —
 * forkSession in src/server/sessions.ts always sets parentSessionId to the
 * session it was forked from, all under the same projectId), most recent
 * first, each with its own latest job — backs GET
 * /api/projects/[id]/sessions, the session-switcher dropdown. Without this,
 * getProjectDetail's "most recent session only" behavior means forks are
 * permanently unreachable through the UI once a newer session exists.
 */
export async function listSessionsForProject(
  projectId: string
): Promise<ProjectSessionSummary[]> {
  const db = getDb();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .orderBy(desc(sessions.createdAt));

  const results: ProjectSessionSummary[] = [];
  for (const s of sessionRows) {
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.sessionId, s.id))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    results.push({
      id: s.id,
      parentSessionId: s.parentSessionId,
      createdAt: s.createdAt,
      job: job ? { id: job.id, status: job.status } : null,
    });
  }
  return results;
}

/** Max length for a user-supplied project name — generous but bounded, matches the `varchar(255)` column. */
const MAX_PROJECT_NAME_LENGTH = 255;

/**
 * Renames a project's display name — `slug` (the GitHub repo name and route
 * identifier, see src/server/github-app.ts) is deliberately untouched, so
 * renaming never breaks an already-created GitHub repo or any existing
 * `/p/[projectId]` link.
 */
export async function renameProject(
  projectId: string,
  name: string
): Promise<ProjectRow | null> {
  const trimmed = name.trim().slice(0, MAX_PROJECT_NAME_LENGTH);
  if (!trimmed) {
    throw new Error("Project name must not be empty");
  }

  const db = getDb();
  const [project] = await db
    .update(projects)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning();
  return project ?? null;
}

export interface ProjectAgentContext {
  projectName: string;
  projectSlug: string;
  githubConnected: boolean;
  githubRepoUrl: string | null;
  vercelDeploymentUrl: string | null;
  creditBalance: number;
}

/**
 * Everything about this project/account the build agent has no other way to
 * know (it only has Bash/Read/Write/Edit/Glob/Grep scoped to the sandbox
 * directory — no visibility into Postgres or any app-layer state). Fetched
 * fresh at the start of each build/continuation job and folded into that
 * job's prompt (see src/server/agent.ts's runBuildPhase) so the agent can
 * actually answer "is my GitHub connected?"-style questions instead of
 * guessing from sandbox files that don't contain that answer.
 */
export async function getProjectAgentContext(
  sessionId: string
): Promise<ProjectAgentContext | null> {
  const db = getDb();

  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return null;

  const [project] = await db.select().from(projects).where(eq(projects.id, session.projectId));
  if (!project) return null;

  const [user] = await db.select().from(users).where(eq(users.id, project.userId));

  const { getUserCreditBalance } = await import("@/server/credits");
  const creditBalance = user ? await getUserCreditBalance(user.id) : 0;

  return {
    projectName: project.name,
    projectSlug: project.slug,
    githubConnected: Boolean(user?.githubInstallationId),
    githubRepoUrl: session.githubRepoUrl,
    vercelDeploymentUrl: session.vercelDeploymentUrl,
    creditBalance,
  };
}
