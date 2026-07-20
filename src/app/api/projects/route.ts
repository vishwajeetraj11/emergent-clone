import { NextResponse } from "next/server";
import { getCurrentUser, isClerkConfigured } from "@/lib/auth";
import { DEV_USER } from "@/lib/dev-user";
import { createProjectAndJob } from "@/server/jobs";
import { listProjectsForUser } from "@/server/projects";
import { parseUserApiKeys } from "@/server/user-keys";

/**
 * The dashboard's project list. Unconfigured (default): DEV_USER's projects.
 * Configured but signed out: an empty list, not a 500 — there's no "current
 * user" to resolve, and a fresh visitor has nothing to see yet either way.
 */
export async function GET() {
  let userId: string;
  if (isClerkConfigured()) {
    try {
      userId = (await getCurrentUser()).id;
    } catch {
      return NextResponse.json({ projects: [] });
    }
  } else {
    userId = DEV_USER.id;
  }

  const rows = await listProjectsForUser(userId);
  return NextResponse.json({
    projects: rows.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      status: p.status,
      createdAt: p.createdAt,
    })),
  });
}

export async function POST(request: Request) {
  let body: { prompt?: unknown; model?: unknown; apiKeys?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  // Validated later against the model catalog (resolveBuilderModel) — an
  // unknown/unavailable id just falls back to the default, never errors.
  const model = typeof body.model === "string" ? body.model : undefined;
  // BYOK (see src/server/user-keys.ts): malformed input is dropped silently,
  // never surfaced as an error — never logged or echoed back either way.
  const apiKeys = parseUserApiKeys(body.apiKeys);

  try {
    const { project, session, job } = await createProjectAndJob(prompt, model, apiKeys);
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
