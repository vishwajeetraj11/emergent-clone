import { NextResponse } from "next/server";
import { getGitHubInstallUrl, isGitHubAppConfigured } from "@/server/github-app";

/**
 * Kicks off the GitHub App installation flow — redirects the browser to
 * GitHub's own install/consent screen. Doesn't require a NEW auth check:
 * getCurrentUser() (via getGitHubInstallUrl()'s callers) already follows the
 * existing Clerk-configured-vs-DEV_USER pattern everywhere else in this app,
 * so this route just needs to exist and redirect — the callback route is
 * what actually associates the resulting installation with a user.
 */
export async function GET() {
  if (!isGitHubAppConfigured()) {
    return NextResponse.json(
      { error: "GitHub App is not configured in this environment." },
      { status: 503 }
    );
  }

  const url = await getGitHubInstallUrl();
  return NextResponse.redirect(url);
}
