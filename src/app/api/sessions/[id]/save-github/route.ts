import { NextResponse } from "next/server";
import { isGitHubConfigured, saveSessionToGitHub } from "@/server/github";

/**
 * Phase 3 (Half B, gated inert): the Save button's endpoint. Unconfigured
 * (default, no GITHUB_TOKEN — always the case in this environment):
 * responds 200 with `configured: false` so the client can surface a clear
 * "GitHub not configured" state instead of a silent no-op or a 500. Never
 * live-verified beyond this OFF path — no real token here.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  if (!isGitHubConfigured()) {
    return NextResponse.json({
      configured: false,
      error: "GitHub is not configured in this environment. Set GITHUB_TOKEN to enable Save.",
    });
  }

  try {
    const { url } = await saveSessionToGitHub(sessionId);
    return NextResponse.json({ configured: true, url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/sessions/${sessionId}/save-github] failed`, err);
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}
