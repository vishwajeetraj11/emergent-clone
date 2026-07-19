import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { deployments, sessions } from "@/db/schema";
import { getSessionFiles } from "@/server/files";

// ---------------------------------------------------------------------------
// Phase 4 (Half B, gated inert): Vercel deploy ("Deploy Your Application" —
// the onboarding carousel slide in src/components/shell/PreviewPanel.tsx).
// Same pattern as Clerk (src/lib/auth.ts) and GitHub (src/server/github-app.ts):
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
 * New projects inherit the team/account's default Deployment Protection —
 * for most accounts that's Vercel Authentication on every deployment
 * without a custom domain, which is exactly every `*.vercel.app` URL this
 * app hands back to a user. Left on, "Deploy" produces a link that dead-ends
 * at a Vercel login wall instead of the live app, defeating the whole
 * point. Best-effort and non-fatal: the deployment itself already succeeded
 * by the time this runs, so a failure here (e.g. a token without project
 * write scope) logs and gets swallowed rather than failing the deploy the
 * user is currently waiting on.
 */
async function disableDeploymentProtection(projectName: string): Promise<void> {
  try {
    const res = await fetch(vercelApiUrl(`/v9/projects/${projectName}`), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ssoProtection: null }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message =
        (body as { error?: { message?: string } })?.error?.message ??
        `status ${res.status}`;
      console.error(`[vercel] failed to disable deployment protection for ${projectName}: ${message}`);
    }
  } catch (err) {
    console.error(`[vercel] failed to disable deployment protection for ${projectName}`, err);
  }
}

/**
 * Makes the session's own Postgres DATABASE_URL (sessions.databaseUrl —
 * see src/server/project-db.ts) available to the deployed app. The `files`
 * snapshot a deploy is built from deliberately excludes `.env.local`
 * (src/server/files.ts), so without this a DB-backed app deploys fine and
 * then dies on its first query. Two steps, both required BEFORE the
 * deployment is created (env vars are baked into a deployment's build and
 * runtime at creation time, and only an existing project can hold env vars
 * — today the project is otherwise only auto-created BY the first deploy,
 * too late for that deploy's own build):
 *
 *   1. POST /v11/projects — create the project if it doesn't exist yet. An
 *      "already exists" conflict is the normal steady-state and treated as
 *      success.
 *   2. POST /v10/projects/{name}/env?upsert=true — upsert DATABASE_URL.
 *      `type: "encrypted"` (not "sensitive") so the user can still read
 *      their own connection string in the Vercel dashboard; upsert keeps it
 *      current on every redeploy.
 *
 * Best-effort and non-fatal, same contract as disableDeploymentProtection
 * below: a failure here logs and falls through to a plain deploy — an app
 * deployed without its env var is no worse than the pre-feature behavior,
 * and strictly better than failing the deploy the user is waiting on.
 */
async function ensureProjectDatabaseEnv(
  projectName: string,
  databaseUrl: string
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
    "Content-Type": "application/json",
  };

  try {
    const createRes = await fetch(vercelApiUrl("/v11/projects"), {
      method: "POST",
      headers,
      body: JSON.stringify({ name: projectName }),
    });
    if (!createRes.ok) {
      const body = await createRes.json().catch(() => ({}));
      const message =
        (body as { error?: { message?: string; code?: string } })?.error?.message ?? "";
      const alreadyExists =
        createRes.status === 409 || /already exists|conflict/i.test(message);
      if (!alreadyExists) {
        console.error(
          `[vercel] failed to pre-create project ${projectName} for env wiring: ${
            message || `status ${createRes.status}`
          }`
        );
        return; // no project -> no point attempting the env upsert
      }
    }

    const envBase = vercelApiUrl(`/v10/projects/${projectName}/env`);
    const envRes = await fetch(
      `${envBase}${envBase.includes("?") ? "&" : "?"}upsert=true`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          key: "DATABASE_URL",
          value: databaseUrl,
          type: "encrypted",
          target: ["production", "preview", "development"],
        }),
      }
    );
    if (!envRes.ok) {
      const body = await envRes.json().catch(() => ({}));
      const message =
        (body as { error?: { message?: string } })?.error?.message ??
        `status ${envRes.status}`;
      console.error(
        `[vercel] failed to upsert DATABASE_URL env var on ${projectName}: ${message}`
      );
    }
  } catch (err) {
    console.error(`[vercel] failed to wire DATABASE_URL for ${projectName}`, err);
  }
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

  // Must happen before the deployment is created — see this helper's doc
  // comment. Skipped entirely for sessions without their own database.
  if (session.databaseUrl) {
    await ensureProjectDatabaseEnv(projectName, session.databaseUrl);
  }

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

  await disableDeploymentProtection(projectName);

  const db = getDb();
  await db.update(sessions).set({ vercelDeploymentUrl: url }).where(eq(sessions.id, sessionId));
  await db.insert(deployments).values({ sessionId, url });

  return { url };
}

export interface DeploymentSummary {
  id: string;
  url: string;
  createdAt: Date;
}

/**
 * Full deploy history for a session, newest first — backs the Deployments
 * dropdown (view any past deploy, no new deploy needed) as distinct from
 * the Deploy button (always creates a new one). See the `deployments` table
 * comment in src/db/schema.ts for why this exists alongside
 * sessions.vercelDeploymentUrl, which only ever holds the latest.
 */
export async function listDeploymentsForSession(
  sessionId: string
): Promise<DeploymentSummary[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.sessionId, sessionId))
    .orderBy(desc(deployments.createdAt));
  return rows.map((r) => ({ id: r.id, url: r.url, createdAt: r.createdAt }));
}
