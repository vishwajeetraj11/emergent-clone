import { NextResponse } from "next/server";
import { assertSessionOwnership } from "@/lib/authz";
import {
  GitHubNotConnectedError,
  GitHubPersonalAccountRepoCreationError,
  isGitHubAppConfigured,
  isGitHubOAuthConfigured,
  saveSessionToGitHub,
} from "@/server/github-app";

/**
 * The Save button's endpoint, now backed by a real GitHub App +
 * installation-token flow (src/server/github-app.ts) instead of a static
 * PAT. Four distinguishable response shapes for the frontend:
 *  - not configured at all (no GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_BASE64):
 *    `{ configured: false, error }`.
 *  - configured, but this user hasn't installed the app yet:
 *    `{ configured: true, connected: false }` — frontend should show a
 *    "Connect GitHub" prompt rather than a generic error.
 *  - configured and connected, but this is a personal-account install that
 *    needs a brand-new repo and OAuth *is* set up server-side, just not yet
 *    granted by this user: `{ configured: true, needsReauth: true }` —
 *    clicking "Connect GitHub" again actually fixes this (GitHub's install
 *    flow re-prompts for the OAuth grant), so the frontend shows the same
 *    "Connect GitHub" affordance rather than a dead-end error. When OAuth
 *    ISN'T configured server-side, reconnecting can't help (there's no OAuth
 *    step to grant) — that case falls through to the generic error below.
 *  - configured and connected, but the save itself failed:
 *    `{ configured: true, error }`, 500.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  try {
    await assertSessionOwnership(sessionId);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!isGitHubAppConfigured()) {
    return NextResponse.json({
      configured: false,
      error:
        "GitHub is not configured in this environment. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_BASE64 to enable Save.",
    });
  }

  try {
    const { url } = await saveSessionToGitHub(sessionId);
    return NextResponse.json({ configured: true, url });
  } catch (err) {
    if (err instanceof GitHubNotConnectedError) {
      return NextResponse.json({ configured: true, connected: false });
    }
    if (err instanceof GitHubPersonalAccountRepoCreationError && isGitHubOAuthConfigured()) {
      return NextResponse.json({ configured: true, needsReauth: true });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/sessions/${sessionId}/save-github] failed`, err);
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}
