import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions } from "@/db/schema";
import { getSessionFiles } from "@/server/files";

// ---------------------------------------------------------------------------
// Phase 4 (Half B, gated inert): Vercel deploy ("Deploy Your Application" —
// the onboarding carousel slide in src/components/shell/PreviewPanel.tsx).
// Same pattern as Clerk (src/lib/auth.ts) and GitHub (src/server/github.ts):
// isVercelConfigured() gates everything else in this file, real Vercel REST
// API usage underneath (POST /v13/deployments — verified against Vercel's
// current documented API, not guessed), inert/clear-error behavior when
// unconfigured.
//
// No VERCEL_TOKEN exists in this environment. Code-complete against
// Vercel's current documented REST API, NOT live-verified — no real token
// here.
// ---------------------------------------------------------------------------

export function isVercelConfigured(): boolean {
  return Boolean(process.env.VERCEL_TOKEN);
}

interface VercelDeploymentResponse {
  id: string;
  url: string;
  readyState?: string;
}

function vercelApiUrl(path: string): string {
  const base = `https://api.vercel.com${path}`;
  // Optional: a token scoped to a Vercel team must say which team it's
  // acting on behalf of. Personal-account tokens don't need this.
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `${base}?teamId=${encodeURIComponent(teamId)}` : base;
}

async function getSessionWithProject(sessionId: string) {
  const db = getDb();
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  return row ?? null;
}

/**
 * Deploys a session's current `files` snapshot to Vercel via a single
 * POST /v13/deployments call — files are inlined directly in the request
 * body (`{file, data}` per Vercel's documented shape) since the `files`
 * table only ever stores text content (see src/server/files.ts's binary
 * exclusion list), so there's never a need for the separate chunked file
 * upload API. Passing a stable `name` (derived from the session id) lets
 * Vercel create-or-reuse the same underlying project across repeated
 * deploys of the same session, without this app having to track a
 * VERCEL_PROJECT_ID itself.
 */
export async function deploySessionToVercel(sessionId: string): Promise<{ url: string }> {
  if (!isVercelConfigured()) {
    throw new Error("VERCEL_TOKEN is not configured");
  }

  const session = await getSessionWithProject(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  const files = await getSessionFiles(sessionId);
  if (files.length === 0) {
    throw new Error("Nothing to deploy yet — no files have been built for this session");
  }

  const projectName = `emergent-${sessionId.replace(/-/g, "").slice(0, 24)}`;

  const res = await fetch(vercelApiUrl("/v13/deployments"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: projectName,
      target: "production",
      projectSettings: { framework: "nextjs" },
      files: files.map((f) => ({ file: f.path, data: f.content })),
    }),
  });

  if (!res.ok) {
    // Never include response headers/body verbatim if they could carry the
    // token back — Vercel error bodies don't echo the Authorization header,
    // but keep this defensive: only surface `error.message`.
    const body = await res.json().catch(() => ({}));
    const message =
      (body as { error?: { message?: string } })?.error?.message ??
      `Vercel API request failed (${res.status})`;
    throw new Error(message);
  }

  const data = (await res.json()) as VercelDeploymentResponse;
  const url = `https://${data.url}`;

  const db = getDb();
  await db.update(sessions).set({ vercelDeploymentUrl: url }).where(eq(sessions.id, sessionId));

  return { url };
}
