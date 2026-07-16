import { NextResponse } from "next/server";
import { createProjectAndJob } from "@/server/jobs";

export async function POST(request: Request) {
  let body: { prompt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  try {
    const { project, session, job } = await createProjectAndJob(prompt);
    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        status: project.status,
      },
      session: { id: session.id },
      job: { id: job.id, status: job.status },
    });
  } catch (err) {
    console.error("[api/projects] failed to create project", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
