import { NextResponse } from "next/server";
import { assertSessionOwnership } from "@/lib/authz";
import { scheduleStopPreview } from "@/server/preview-stop-scheduler";

/**
 * Deferred sandbox teardown: the client fires this on navigate-away/tab-close
 * (see useAgentSession's `pagehide` wiring — sent via `navigator.sendBeacon`,
 * which survives page unload where a plain fetch may be dropped, with a
 * `keepalive` fetch fallback) so a v2 sandbox stops burning its 45-minute
 * session once nobody's looking at the preview, instead of idling until
 * SANDBOX_TIMEOUT_MS. `pagehide` fires identically on a real tab-close AND on
 * a plain page refresh, so this route no longer stops anything itself — it
 * schedules the stop a few minutes out (see preview-stop-scheduler.ts) and
 * returns immediately. A refresh's own follow-up load hits /restore or
 * /preview-health almost immediately after, which cancels the pending stop
 * before it ever fires; a real tab-close produces neither, so its timer just
 * runs. sandbox.stop() itself still snapshots the filesystem when it does
 * run; the next getOrCreate (restore/switchSession/fork) resumes it in
 * seconds rather than a from-scratch npm install.
 *
 * Distinct from /api/jobs/[id]/stop, which stops the agent's build job, not
 * the sandbox VM — the two are independent, and this route never touches
 * job state. No body to parse: a `sendBeacon` POST carries none, so
 * ownership (cookie auth) is all this needs from the request itself.
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

  // Scheduling itself can't fail (it's just a setTimeout) — no try/catch
  // needed around it. The actual stop's own failure is handled (logged, not
  // thrown) inside the scheduler when the timer fires, since by then there's
  // no request left to report it to.
  scheduleStopPreview(sessionId);
  return NextResponse.json({ ok: true });
}
