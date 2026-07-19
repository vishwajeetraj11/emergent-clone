import { NextResponse } from "next/server";
import { assertSessionOwnership } from "@/lib/authz";
import { sandboxProvider } from "@/server/sandbox";

/**
 * Background health check for the preview iframe: the iframe is cross-origin
 * (a different localhost port, or a different sb-*.vercel.run domain), so
 * the client can never tell "the sandbox's runtime died" (e.g. a Vercel VM
 * hitting its max timeout) apart from the sandbox loading normally — only a
 * server-side probe (sandboxProvider.checkPreviewHealth) can. Polled by
 * useAgentSession to decide when to swap the stale iframe for a "Preview
 * stopped" restart card.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  try {
    await assertSessionOwnership(sessionId);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const alive = (await sandboxProvider.checkPreviewHealth?.(sessionId)) ?? true;
    return NextResponse.json({ alive });
  } catch (err) {
    // A health-check infrastructure error must not nuke a working preview —
    // default to "alive" so the client leaves the iframe alone.
    console.error(`[api/sessions/${sessionId}/preview-health] failed`, err);
    return NextResponse.json({ alive: true });
  }
}
