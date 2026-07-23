import { App, Octokit } from "octokit";
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
// in this codebase (isVercelConfigured in src/server/vercel.ts,
// isStripeConfigured in src/server/stripe.ts — note auth is deliberately NOT
// one of these; see src/lib/auth.ts for why it has no "off" path):
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
 * Gates the OAuth "user-to-server" token path (GITHUB_APP_CLIENT_ID/SECRET) —
 * separate from isGitHubAppConfigured() because this is genuinely optional:
 * without it, personal-account installs simply can't create new repos (see
 * GitHubPersonalAccountRepoCreationError) but everything else still works.
 * Values come from the same GitHub App's settings page, not a separate app.
 */
export function isGitHubOAuthConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET
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

/** The URL to send a user to in order to install the GitHub App for the first time. */
export async function getGitHubInstallUrl(): Promise<string> {
  const app = getApp();
  return app.getInstallationUrl();
}

/**
 * The URL to send an ALREADY-installed user to in order to (re-)grant the
 * user-to-server OAuth token — GitHub's standalone `/login/oauth/authorize`
 * flow, not the install flow. These are genuinely different: "Request user
 * authorization during installation" only fires that OAuth consent screen
 * during a brand-new install; re-visiting the install URL for an account
 * that already has the app installed just shows GitHub's "Configure" page
 * and never re-prompts for the OAuth grant. This is the only way to get (or
 * refresh) that grant for a user who installed before OAuth was enabled, or
 * whose refresh token has expired with nothing left to refresh it.
 */
export function getGitHubOAuthAuthorizeUrl(): string {
  if (!isGitHubOAuthConfigured()) {
    throw new Error("GitHub OAuth is not configured");
  }
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_APP_CLIENT_ID!,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Thrown when saveSessionToGitHub needs to create a brand-new repo, the
 * installation is on a personal GitHub account rather than an organization
 * (installation tokens can't call POST /user/repos — a hard GitHub platform
 * restriction), AND either OAuth isn't configured or the user hasn't granted
 * a user-to-server token yet. See createRepoForPersonalAccount for the path
 * that avoids this error when OAuth *is* set up.
 */
export class GitHubPersonalAccountRepoCreationError extends Error {
  constructor(login: string) {
    const oauthHint = isGitHubOAuthConfigured()
      ? `Reconnect via "Connect GitHub" and accept the authorization prompt this time — that grants a user token this app can use to create the repo on your behalf.`
      : `Install the app on a GitHub organization instead (github.com/settings/installations -> Configure -> or reconnect via "Connect GitHub" and pick an org this time), then try Save again.`;
    super(
      `The GitHub App is installed on your personal account (${login}), which can't create new repositories via the installation token alone — that's a GitHub platform restriction, not something this app can work around. ${oauthHint}`
    );
    this.name = "GitHubPersonalAccountRepoCreationError";
  }
}

interface GitHubOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

/**
 * Exchanges the OAuth `code` GitHub appends to the install callback (when the
 * App has "Request user authorization (OAuth) during installation" enabled)
 * for a user-to-server access token — distinct from the installation token,
 * and the only token type GitHub allows for POST /user/repos.
 */
export async function exchangeGitHubOAuthCode(
  code: string
): Promise<GitHubOAuthTokens> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_APP_CLIENT_ID,
      client_secret: process.env.GITHUB_APP_CLIENT_SECRET,
      code,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(
      `GitHub OAuth code exchange failed: ${data.error_description ?? data.error ?? res.status}`
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:
      typeof data.expires_in === "number"
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
  };
}

async function refreshGitHubUserAccessToken(
  refreshToken: string
): Promise<GitHubOAuthTokens> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_APP_CLIENT_ID,
      client_secret: process.env.GITHUB_APP_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(
      `GitHub OAuth token refresh failed: ${data.error_description ?? data.error ?? res.status}`
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:
      typeof data.expires_in === "number"
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
  };
}

/** Persists tokens from exchangeGitHubOAuthCode onto the user's row. */
export async function storeGitHubUserOAuthTokens(
  userId: string,
  tokens: GitHubOAuthTokens
): Promise<void> {
  const db = getDb();
  await db
    .update(users)
    .set({
      githubUserAccessToken: tokens.accessToken,
      githubUserRefreshToken: tokens.refreshToken ?? null,
      githubUserTokenExpiresAt: tokens.expiresAt ?? null,
    })
    .where(eq(users.id, userId));
}

/**
 * Returns a live user-to-server access token for this user, refreshing it
 * first if it's expired (or about to expire) and a refresh token is on
 * hand — or null if OAuth isn't configured, the user never granted one, or
 * it's expired with nothing left to refresh it with. Apps with "expire user
 * authorization tokens" turned off never populate githubUserTokenExpiresAt,
 * so those tokens are returned as-is indefinitely.
 */
export async function getValidGitHubUserAccessToken(
  userId: string
): Promise<string | null> {
  if (!isGitHubOAuthConfigured()) return null;

  const db = getDb();
  const [row] = await db
    .select({
      token: users.githubUserAccessToken,
      refreshToken: users.githubUserRefreshToken,
      expiresAt: users.githubUserTokenExpiresAt,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!row?.token) return null;
  if (!row.expiresAt) return row.token;
  if (row.expiresAt.getTime() > Date.now() + 60_000) return row.token;
  if (!row.refreshToken) return null;

  const refreshed = await refreshGitHubUserAccessToken(row.refreshToken);
  await storeGitHubUserOAuthTokens(userId, refreshed);
  return refreshed.accessToken;
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

  let account: { login: string; type: string };
  try {
    account = await getInstallationAccount(installationId);
  } catch (err) {
    // 404 = installation no longer exists (user removed the app from their
    // GitHub account/org); 401 = the installation's credentials were
    // revoked. Either way the stored githubInstallationId is stale — clear
    // it and surface the same "not connected" state the first-time flow
    // uses, so the frontend's existing "Connect GitHub" prompt lets the
    // user reinstall instead of hitting an opaque 500.
    const status = statusOf(err);
    if (status === 404 || status === 401) {
      await db.update(users).set({ githubInstallationId: null }).where(eq(users.id, currentUser.id));
      throw new GitHubNotConnectedError();
    }
    throw err;
  }
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
    // published OpenAPI description. This is a hard platform restriction on
    // installation tokens specifically, not a bug: a user-to-server OAuth
    // token (see getValidGitHubUserAccessToken) CAN call POST /user/repos, so
    // that's the fallback for personal accounts rather than an immediate
    // failure. Everything else (reading/writing files in an existing repo)
    // works the same regardless of account type or which token created it.
    if (account.type === "Organization") {
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
    } else {
      const userAccessToken = await getValidGitHubUserAccessToken(currentUser.id);
      if (!userAccessToken) {
        throw new GitHubPersonalAccountRepoCreationError(account.login);
      }
      const userOctokit = new Octokit({ auth: userAccessToken });
      try {
        const { data: repo } = await userOctokit.rest.repos.createForAuthenticatedUser({
          name: repoName,
          private: true,
          description: `Generated by Emergent clone — project ${row.project.slug}`,
        });
        repoUrl = repo.html_url;
      } catch (err) {
        if (statusOf(err) === 422) {
          const { data: repo } = await octokit.rest.repos.get({ owner, repo: repoName });
          repoUrl = repo.html_url;
        } else {
          throw err;
        }
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
