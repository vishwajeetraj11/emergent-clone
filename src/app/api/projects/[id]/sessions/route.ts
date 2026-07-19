import { NextResponse } from "next/server";
import { assertProjectOwnership } from "@/lib/authz";
import { listSessionsForProject } from "@/server/projects";

/**
 * Every session under this project (original + every fork), for the
 * session-switcher dropdown — see listSessionsForProject in
 * src/server/projects.ts for why this exists: GET /api/projects/[id] alone
 * only ever surfaces the most recent session, leaving older forks
 * unreachable.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  try {
    await assertProjectOwnership(projectId);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sessions = await listSessionsForProject(projectId);
  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      parentSessionId: s.parentSessionId,
      createdAt: s.createdAt,
      job: s.job,
    })),
  });
}
