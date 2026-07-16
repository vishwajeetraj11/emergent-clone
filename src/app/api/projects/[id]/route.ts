import { NextResponse } from "next/server";
import { getProjectDetail } from "@/server/projects";

/**
 * Phase 3 persistence: backs the /p/[projectId] route. Returns the project
 * plus its most recent session/job so the client can rebuild its timeline
 * (replaying that job's events from cursor -1 over SSE, same mechanism
 * Phase 1 already uses) and know the job's actual current status.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  const detail = await getProjectDetail(projectId);
  if (!detail) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({
    project: {
      id: detail.project.id,
      name: detail.project.name,
      slug: detail.project.slug,
      status: detail.project.status,
    },
    session: detail.session ? { id: detail.session.id } : null,
    job: detail.job ? { id: detail.job.id, status: detail.job.status } : null,
  });
}
