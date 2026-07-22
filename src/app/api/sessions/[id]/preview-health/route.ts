import { NextResponse } from "next/server";
import { assertSessionOwnership } from "@/lib/authz";
import { sandboxProvider } from "@/server/sandbox";
import { cancelScheduledStop } from "@/server/preview-stop-scheduler";

/**
 * Background health check for the preview iframe: the iframe is cross-origin
 * (a different localhost port, or a different sb-*.vercel.run domain), so
 * the client can never tell "the sandbox's runtime died" (e.g. a Vercel VM
 * hitting its max timeout) apart from the sandbox loading normally — only a
 * server-side probe (sandboxProvider.checkPreviewHealth) can. Polled by
 * useAgentSession to decide when to swap the stale iframe for a "Preview
 * stopped" restart card.
 *
 * Also this feature's cancel point for a *deferred* stop-preview timer (see
 * preview-stop-scheduler.ts) — and the important one: useAgentSession's
 * health-poll effect hits this every 45s for as long as a tab has the
 * preview open, while a deferred stop only fires after 180s of nobody
 * cancelling it. So the only way that 180s timer ever actually reaches zero
 * is if no open tab is polling this route at all — closing the exact race
 * where an old tab's pagehide beacon (queued on refresh or backgrounding)
 * lands AFTER a new tab's restore has already brought the sandbox back up.
 * Cancelled unconditionally, on every poll, regardless of the health result
 * below — even a probe that reports "dead" still proves a tab is watching.
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

  cancelScheduledStop(sessionId);

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
