import { NextResponse } from "next/server";
import { assertSessionOwnership } from "@/lib/authz";
import { deploySessionToVercel, isVercelConfigured } from "@/server/vercel";

/**
 * Phase 4 (Half B, gated inert): the Deploy button's endpoint. Unconfigured
 * (default, no VERCEL_TOKEN — always the case in this environment):
 * responds 200 with `configured: false` so the client can surface a clear
 * "Vercel deploy is not configured" state, same pattern as
 * POST /api/sessions/[id]/save-github. Never live-verified beyond this OFF
 * path — no real token here.
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

  if (!isVercelConfigured()) {
    return NextResponse.json({
      configured: false,
      error: "Vercel deploy is not configured in this environment. Set VERCEL_TOKEN to enable Deploy.",
    });
  }

  try {
    const { url } = await deploySessionToVercel(sessionId);
    return NextResponse.json({ configured: true, url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/sessions/${sessionId}/deploy-vercel] failed`, err);
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}
