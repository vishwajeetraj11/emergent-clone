import { NextResponse } from "next/server";
import { assertProjectOwnership } from "@/lib/authz";
import { deleteProject, getProjectDetail, renameProject } from "@/server/projects";

/**
 * Backs the /p/[projectId] route. Returns the project
 * plus its most recent session/job so the client can rebuild its timeline
 * (replaying that job's events from cursor -1 over SSE, same mechanism
 * the timeline already uses) and know the job's actual current status.
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

/** Renames a project — see renameProject in src/server/projects.ts for why `slug` is untouched. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  try {
    await assertProjectOwnership(projectId);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { name?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const project = await renameProject(projectId, body.name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      status: project.status,
    },
  });
}

/** Deletes a project — see deleteProject in src/server/projects.ts for the sandbox/Neon teardown it does first. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  try {
    await assertProjectOwnership(projectId);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const deleted = await deleteProject(projectId);
  if (!deleted) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
