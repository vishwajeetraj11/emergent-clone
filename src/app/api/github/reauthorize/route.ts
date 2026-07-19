import { NextResponse } from "next/server";
import { getGitHubOAuthAuthorizeUrl, isGitHubOAuthConfigured } from "@/server/github-app";

/**
 * Sends an already-installed user through GitHub's standalone OAuth
 * authorize flow to (re-)grant a user-to-server token — distinct from
 * GET /api/github/connect (src/app/api/github/connect/route.ts), which
 * sends brand-new users through the install flow instead. Needed because
 * GitHub only shows the OAuth consent screen during a fresh install;
 * re-visiting the install URL for an account that already has the app
 * installed just shows GitHub's "Configure" page and never re-prompts for
 * the OAuth grant. The frontend links here when saveState is
 * "needs_reauth" (see useAgentSession.ts / ChatPanel.tsx).
 */
export async function GET() {
  if (!isGitHubOAuthConfigured()) {
    return NextResponse.json(
      { error: "GitHub OAuth is not configured in this environment." },
      { status: 503 }
    );
  }

  return NextResponse.redirect(getGitHubOAuthAuthorizeUrl());
}
