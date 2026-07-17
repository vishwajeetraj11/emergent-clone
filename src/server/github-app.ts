import { App } from "octokit";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects, sessions, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getSessionFiles } from "@/server/files";

// ---------------------------------------------------------------------------
// Real GitHub App + installation-token flow, replacing the old
// personal-access-token approach (formerly src/server/github.ts, deleted).
//
// Same "off by default, gated inert" pattern as every other isXConfigured()
// in this codebase (isClerkConfigured in src/lib/auth.ts, isVercelConfigured
// in src/server/vercel.ts, isStripeConfigured in src/server/stripe.ts):
// isGitHubAppConfigured() gates everything else in this file. Unlike the
// Clerk/Vercel/Stripe integrations, this one IS live-configured and
// live-verified in this environment — GITHUB_APP_ID and
// GITHUB_APP_PRIVATE_KEY_BASE64 are real (see .env.example for setup notes).
//
// Auth model: this app authenticates as the GitHub App itself (JWT, via
// app.octokit) only for app-level lookups (resolving an installation's
// owner). All repo reads/writes use an installation-scoped Octokit
// (app.getInstallationOctokit), which auto-refreshes its token — never a
// static, indefinitely-lived credential.
// ---------------------------------------------------------------------------

export function isGitHubAppConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY_BASE64
  );
}

/**
 * Thrown by saveSessionToGitHub when the app itself is configured but the
 * current user hasn't completed the "Install GitHub App" flow yet (no
 * githubInstallationId on their `users` row) — distinct from "not configured
 * at all" and from a real API failure, so the API route/frontend can tell
 * the three apart and show the right UI for each.
 */
export class GitHubNotConnectedError extends Error {
  constructor() {
    super("GitHub is not connected yet");
    this.name = "GitHubNotConnectedError";
  }
}

let cachedApp: App | null = null;

/**
 * Lazily-constructed singleton App instance — built only the first time it's
 * actually needed, never at module-import time, in case env vars aren't set
 * yet in some code path (mirrors getDb()'s lazy-init pattern in src/db/
 * index.ts). Throws a clear error if called while unconfigured; callers
 * should check isGitHubAppConfigured() first.
 */
function getApp(): App {
  if (cachedApp) return cachedApp;

  if (!isGitHubAppConfigured()) {
    throw new Error("GitHub App is not configured");
  }

  const privateKey = Buffer.from(
    process.env.GITHUB_APP_PRIVATE_KEY_BASE64!,
    "base64"
  ).toString("utf8");

  cachedApp = new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey,
  });
  return cachedApp;
}

/** The URL to send a user to in order to install (or re-authorize) the GitHub App. */
export async function getGitHubInstallUrl(): Promise<string> {
  const app = getApp();
  return app.getInstallationUrl();
}

/**
 * Thrown when saveSessionToGitHub needs to create a brand-new repo but the
 * installation is on a personal GitHub account rather than an organization —
 * see the long comment on createRepoForInstallation below for why this is a
 * hard GitHub platform restriction, not a bug.
 */
export class GitHubPersonalAccountRepoCreationError extends Error {
  constructor(login: string) {
    super(
      `The GitHub App is installed on your personal account (${login}), which can't create new repositories via the API — that's a GitHub platform restriction, not something this app can work around. Install the app on a GitHub organization instead (github.com/settings/installations -> Configure -> or reconnect via "Connect GitHub" and pick an org this time), then try Save again.`
    );
    this.name = "GitHubPersonalAccountRepoCreationError";
  }
}

/**
 * Resolves which GitHub account (user or org) an installation belongs to,
 * via the app-level (JWT-authenticated) octokit's GET
 * /app/installations/{installation_id} endpoint — installation tokens can't
 * call users.getAuthenticated() (they represent the app+installation, not a
 * user), so this is how `owner` gets resolved instead of the old PAT flow's
 * octokit.rest.users.getAuthenticated(). Also returns `type` ("User" vs
 * "Organization") since repo creation behaves differently for each — see
 * createRepoForInstallation.
 */
export async function getInstallationAccount(
  installationId: string
): Promise<{ login: string; type: string }> {
  const app = getApp();
  const { data } = await app.octokit.request(
    "GET /app/installations/{installation_id}",
    { installation_id: Number(installationId) }
  );
  const account = data.account;
  if (!account || !("login" in account) || !account.login) {
    throw new Error("Could not resolve the GitHub account for this installation");
  }
  return { login: account.login, type: "type" in account ? String(account.type) : "User" };
}

async function getSessionWithProject(sessionId: string) {
  const db = getDb();
  const [row] = await db
    .select({ session: sessions, project: projects })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(eq(sessions.id, sessionId));
  return row ?? null;
}

function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err
    ? (err as { status?: number }).status
    : undefined;
}

/**
 * Pushes a session's current `files` snapshot to a GitHub repo via an
 * installation-scoped Octokit — creates the repo (named after the project
 * slug) on first save, reuses it (by the session's stored `githubRepoUrl`,
 * or by looking the name up again if that repo already existed) on
 * subsequent saves. One createOrUpdateFileContents call per file — same
 * structure as the old PAT-based implementation, just authenticated
 * differently.
 */
export async function saveSessionToGitHub(sessionId: string): Promise<{ url: string }> {
  if (!isGitHubAppConfigured()) {
    throw new Error("GitHub App is not configured");
  }

  const currentUser = await getCurrentUser();

  const db = getDb();
  const [userRow] = await db
    .select({ githubInstallationId: users.githubInstallationId })
    .from(users)
    .where(eq(users.id, currentUser.id));

  const installationId = userRow?.githubInstallationId;
  if (!installationId) {
    throw new GitHubNotConnectedError();
  }

  const row = await getSessionWithProject(sessionId);
  if (!row) {
    throw new Error("Session not found");
  }

  const files = await getSessionFiles(sessionId);
  if (files.length === 0) {
    throw new Error("Nothing to save yet — no files have been built for this session");
  }

  const app = getApp();
  const octokit = await app.getInstallationOctokit(Number(installationId));
  const account = await getInstallationAccount(installationId);
  const owner = account.login;
  const repoName = row.project.slug;

  let repoUrl: string;
  if (row.session.githubRepoUrl) {
    repoUrl = row.session.githubRepoUrl;
  } else {
    // Creating a NEW repo via a GitHub App installation token only works for
    // organization installations (POST /orgs/{org}/repos is
    // enabledForGitHubApps: true) — POST /user/repos, the personal-account
    // equivalent, is explicitly enabledForGitHubApps: false on GitHub's own
    // published OpenAPI description. This is a hard platform restriction,
    // not something this app can work around, so a personal-account
    // installation fails clearly here rather than hitting a confusing 403
    // from the API. Everything else (reading/writing files in an existing
    // repo) works the same regardless of account type.
    if (account.type !== "Organization") {
      throw new GitHubPersonalAccountRepoCreationError(account.login);
    }
    try {
      const { data: repo } = await octokit.rest.repos.createInOrg({
        org: account.login,
        name: repoName,
        private: true,
        description: `Generated by Emergent clone — project ${row.project.slug}`,
      });
      repoUrl = repo.html_url;
    } catch (err) {
      // 422 = a repo with this name already exists under this account —
      // reuse it rather than failing the save.
      if (statusOf(err) === 422) {
        const { data: repo } = await octokit.rest.repos.get({ owner, repo: repoName });
        repoUrl = repo.html_url;
      } else {
        throw err;
      }
    }
  }

  for (const file of files) {
    let sha: string | undefined;
    try {
      const { data: existing } = await octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path: file.path,
      });
      if (!Array.isArray(existing) && existing.type === "file") {
        sha = existing.sha;
      }
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }

    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo: repoName,
      path: file.path,
      message: sha ? `Update ${file.path}` : `Add ${file.path}`,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      sha,
    });
  }

  await db.update(sessions).set({ githubRepoUrl: repoUrl }).where(eq(sessions.id, sessionId));

  return { url: repoUrl };
}
