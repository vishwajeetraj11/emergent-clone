import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects, sessions } from "@/db/schema";

// ---------------------------------------------------------------------------
// Per-app Postgres, backed by Neon (https://neon.com).
//
// Layout: one Neon PROJECT per emergent project (projects.neonProjectId), one
// Neon BRANCH per session (sessions.neonBranchId + sessions.databaseUrl).
// Branches are copy-on-write snapshots of their parent, which makes a session
// fork's database behave exactly like its files already do: an independent
// copy from the moment of the fork, cheap to create, diverging freely.
//
// The connection string reaches the generated app as a `.env.local` file in
// its sandbox directory (writeSandboxEnvFile below, called from the sandbox
// provider's start path) — `next dev` loads it natively, so no env plumbing
// through the spawn sites is needed. `.env.local` is excluded from file
// snapshots (src/server/files.ts) precisely so the secret never lands in the
// `files` table, GitHub exports, forks' copied files, or Vercel deploys.
//
// Same isXConfigured() gating idiom as the GitHub App / Vercel integrations:
// no NEON_API_KEY -> every helper here silently no-ops and the platform
// behaves exactly as it did before this feature existed.
// ---------------------------------------------------------------------------

const NEON_API_BASE = "https://console.neon.tech/api/v2";

// Node's Happy-Eyeballs connection race (autoSelectFamily, default since
// Node 20) uses a 250ms per-address-family attempt timeout — verified too
// short for console.neon.tech's Cloudflare edge on at least some networks
// (every attempt times out; plain curl and a single un-raced connect both
// succeed). Raising the per-attempt budget keeps the dual-stack fallback
// behavior while giving each attempt a realistic RTT allowance.
setDefaultAutoSelectFamilyAttemptTimeout(1500);

/** Default region for new Neon projects — override via NEON_REGION. */
const DEFAULT_REGION = "aws-ap-southeast-1";

export function isNeonConfigured(): boolean {
  return Boolean(process.env.NEON_API_KEY);
}

async function neonFetch<T>(
  method: "GET" | "POST" | "DELETE",
  apiPath: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${NEON_API_BASE}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NEON_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Neon API ${method} ${apiPath} failed (${res.status}): ${text.slice(0, 500)}`
    );
  }
  return (await res.json()) as T;
}

interface NeonConnectionDetails {
  connection_uri: string;
}

/**
 * Neon requires an org_id on project creation for org-scoped accounts (the
 * default for new signups). Discovered once per process via
 * GET /users/me/organizations — the first org the key belongs to — and
 * overridable via NEON_ORG_ID for keys spanning multiple orgs.
 */
let cachedOrgId: string | null | undefined;
async function getNeonOrgId(): Promise<string | null> {
  if (process.env.NEON_ORG_ID) return process.env.NEON_ORG_ID;
  if (cachedOrgId !== undefined) return cachedOrgId;
  const res = await neonFetch<{ organizations: Array<{ id: string }> }>(
    "GET",
    "/users/me/organizations"
  );
  cachedOrgId = res.organizations[0]?.id ?? null;
  return cachedOrgId;
}

interface NeonCreatedProject {
  project: { id: string };
  branch: { id: string };
  connection_uris: NeonConnectionDetails[];
}

interface NeonCreatedBranch {
  branch: { id: string };
  // "When creating a branch from a parent with more than one role or
  // database, the response body does not include a connection URI." Our
  // projects only ever have the default role/database, so it's present in
  // practice — but typed optional to match the API contract.
  connection_uris?: NeonConnectionDetails[];
}

/**
 * Ensures `sessionId` has its own Postgres database (Neon branch),
 * provisioning the Neon project and/or branch on first need. Idempotent and
 * safe to call on every sandbox start:
 *  - not configured -> null (feature off, no error)
 *  - already provisioned -> stored URL, no API calls
 *  - project exists but this session has no branch (e.g. a fork, or a second
 *    session) -> new branch, parented on the parent session's branch when the
 *    fork lineage is known so the fork starts with a copy of the parent's data.
 * Returns the session's DATABASE_URL, or null when Neon isn't configured.
 */
export async function ensureSessionDatabase(sessionId: string): Promise<string | null> {
  if (!isNeonConfigured()) return null;

  const db = getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return null;
  if (session.databaseUrl) return session.databaseUrl;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, session.projectId));
  if (!project) return null;

  // No Neon project yet: create one, and hand its default branch to THIS
  // session (the common case — the project's very first session).
  if (!project.neonProjectId) {
    const orgId = await getNeonOrgId();
    const created = await neonFetch<NeonCreatedProject>("POST", "/projects", {
      project: {
        // Neon project names are display-only; slug keeps it recognizable in
        // their console.
        name: `emergent-${project.slug}`.slice(0, 60),
        region_id: process.env.NEON_REGION || DEFAULT_REGION,
        ...(orgId ? { org_id: orgId } : {}),
      },
    });
    const url = created.connection_uris[0]?.connection_uri;
    if (!url) throw new Error("Neon project created but no connection URI returned");
    await db
      .update(projects)
      .set({ neonProjectId: created.project.id, updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    await db
      .update(sessions)
      .set({ neonBranchId: created.branch.id, databaseUrl: url })
      .where(eq(sessions.id, session.id));
    return url;
  }

  // Neon project exists but this session has no branch of its own: create
  // one. Parent it on the forked-from session's branch when that lineage
  // exists (copy-on-write of the parent's data at this moment); otherwise
  // branch off the project's default branch.
  let parentBranchId: string | undefined;
  if (session.parentSessionId) {
    const [parent] = await db
      .select({ neonBranchId: sessions.neonBranchId })
      .from(sessions)
      .where(eq(sessions.id, session.parentSessionId));
    parentBranchId = parent?.neonBranchId ?? undefined;
  }

  const created = await neonFetch<NeonCreatedBranch>(
    "POST",
    `/projects/${project.neonProjectId}/branches`,
    {
      endpoints: [{ type: "read_write" }],
      branch: {
        name: `session-${session.id.slice(0, 8)}`,
        ...(parentBranchId ? { parent_id: parentBranchId } : {}),
      },
    }
  );
  const url = created.connection_uris?.[0]?.connection_uri;
  if (!url) throw new Error("Neon branch created but no connection URI returned");
  await db
    .update(sessions)
    .set({ neonBranchId: created.branch.id, databaseUrl: url })
    .where(eq(sessions.id, session.id));
  return url;
}

/**
 * Ensures `sessionId` has its own auth signing secret, generating + persisting
 * one on first need. Same shape/gating as ensureSessionDatabase: no Neon means
 * no DB-backed auth, so no secret is needed and this returns null. Idempotent
 * and safe to call on every sandbox start — a stored secret short-circuits.
 *
 * The secret is 32 random bytes (crypto.randomBytes, never Math.random),
 * base64url-encoded (URL/header-safe, ≥43 chars). It reaches the generated app
 * as BETTER_AUTH_SECRET in `.env.local` (buildSandboxEnvContent below) and must
 * stay STABLE across resumes — better-auth signs session cookies with it, so a
 * rotation would silently log everyone out. Returns the session's secret, or
 * null when Neon isn't configured.
 */
export async function ensureSessionAuthSecret(sessionId: string): Promise<string | null> {
  if (!isNeonConfigured()) return null;

  const db = getDb();
  const [session] = await db
    .select({ authSecret: sessions.authSecret })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!session) return null;
  if (session.authSecret) return session.authSecret;

  const secret = randomBytes(32).toString("base64url");
  await db.update(sessions).set({ authSecret: secret }).where(eq(sessions.id, sessionId));
  return secret;
}

/**
 * Builds the full `.env.local` body injected into the sandbox — the single
 * source of truth for that file so its lines can never drift between the three
 * writers that emit it (writeSandboxEnvFile here, plus the onCreate and
 * resume-refresh paths in src/server/sandbox-vercel.ts). Returns null when the
 * session has no provisioned database (Neon unconfigured, or provisioning
 * failed), which is exactly the "don't write a file" signal every caller wants.
 *
 * Emits DATABASE_URL, plus the auth signing secret under BOTH BETTER_AUTH_SECRET
 * (the name better-auth reads) and AUTH_SECRET (a harmless alias that
 * future-proofs a hand-roll or an Auth.js fallback without touching this
 * helper). Both carry the same value from ensureSessionAuthSecret.
 */
export async function buildSandboxEnvContent(sessionId: string): Promise<string | null> {
  const url = await ensureSessionDatabase(sessionId);
  if (!url) return null;
  const secret = await ensureSessionAuthSecret(sessionId);
  const lines = [
    "# Auto-generated — this app's own Postgres database + auth secret. Not snapshotted or exported.",
    `DATABASE_URL=${url}`,
  ];
  if (secret) {
    lines.push(`BETTER_AUTH_SECRET=${secret}`, `AUTH_SECRET=${secret}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Writes the session's `.env.local` (DATABASE_URL + auth secret, see
 * buildSandboxEnvContent) into `<dir>` so the generated app's `next dev` picks
 * it up natively. No-op (and no file written) when Neon isn't configured or
 * provisioning fails — a database problem must never block a sandbox from
 * starting, since most generated apps don't use one at all. Errors are logged,
 * not thrown.
 */
export async function writeSandboxEnvFile(sessionId: string, dir: string): Promise<void> {
  if (!isNeonConfigured()) return;
  try {
    const content = await buildSandboxEnvContent(sessionId);
    if (!content) return;
    writeFileSync(path.join(dir, ".env.local"), content, "utf8");
  } catch (err) {
    console.error(`[project-db] provisioning database for session ${sessionId} failed`, err);
  }
}

/**
 * Deletes the project's entire Neon project (all session branches with it).
 * Best-effort — called when an emergent project is deleted, if ever wired.
 */
export async function dropProjectDatabase(neonProjectId: string): Promise<void> {
  if (!isNeonConfigured()) return;
  await neonFetch("DELETE", `/projects/${neonProjectId}`);
}
