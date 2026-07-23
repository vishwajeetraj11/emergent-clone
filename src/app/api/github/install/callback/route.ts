import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { exchangeGitHubOAuthCode, storeGitHubUserOAuthTokens } from "@/server/github-app";

/**
 * GitHub App "Setup URL" — this exact path (/api/github/install/callback) is
 * registered as the App's Setup URL on GitHub's side, so it MUST live here.
 * GitHub redirects here after a user installs (or updates) the app, with
 * `installation_id` and `setup_action` (typically "install" or "update") as
 * query params. Resolves the current user the same way as everywhere else in
 * this app (getCurrentUser()) and stores the installation id on that user's
 * row, then redirects back to the app.
 *
 * If the App also has "Request user authorization (OAuth) during
 * installation" enabled (and this same URL is set as its Authorization
 * callback URL), GitHub appends a `code` param alongside installation_id on
 * a fresh install — exchanged here for a user-to-server token (see
 * exchangeGitHubOAuthCode) and stored so saveSessionToGitHub can create
 * repos on personal accounts, which the installation token alone can't do.
 *
 * This same URL is ALSO the Authorization callback URL for the standalone
 * reauth flow (see getGitHubOAuthAuthorizeUrl / GET /api/github/reauthorize)
 * used to (re-)grant that token for an account that's already installed —
 * GitHub only fires the OAuth consent screen during a brand-new install, so
 * re-visiting the install URL for an existing installation never re-prompts
 * for it. That flow redirects back here with `code` but no
 * `installation_id`, which is handled as a separate branch below.
 */
export async function GET(request: NextRequest) {
  const installationId = request.nextUrl.searchParams.get("installation_id");
  const setupAction = request.nextUrl.searchParams.get("setup_action");
  const code = request.nextUrl.searchParams.get("code");

  console.log(
    `[api/github/install/callback] installation_id=${installationId} setup_action=${setupAction} code=${code ? "present" : "absent"}`
  );

  if (!installationId && !code) {
    return NextResponse.redirect(
      new URL("/?github=error", request.url)
    );
  }

  // getCurrentUser() provisions the `users` row if this is the user's first
  // authenticated request, so the UPDATE below can never silently affect zero
  // rows and lose the installation id.
  const currentUser = await getCurrentUser();

  if (installationId) {
    const db = getDb();
    await db
      .update(users)
      .set({ githubInstallationId: installationId })
      .where(eq(users.id, currentUser.id));
  }

  if (code) {
    try {
      const tokens = await exchangeGitHubOAuthCode(code);
      await storeGitHubUserOAuthTokens(currentUser.id, tokens);
    } catch (err) {
      // Don't fail the whole request over this. For a fresh install,
      // installationId above is already saved, so org-based repo creation
      // and all file read/write still work regardless. For the standalone
      // reauth flow (no installationId), this failure means the user is
      // back where they started — GitHubPersonalAccountRepoCreationError
      // will fire again on the next Save with a clear "reconnect" message.
      console.error("[api/github/install/callback] OAuth code exchange failed", err);
    }
  }

  return NextResponse.redirect(new URL("/?github=connected", request.url));
}
