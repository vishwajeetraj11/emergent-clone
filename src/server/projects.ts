import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, projects, sessions } from "@/db/schema";
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
