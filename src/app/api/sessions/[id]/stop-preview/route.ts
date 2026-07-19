import { NextResponse } from "next/server";
import { assertSessionOwnership } from "@/lib/authz";
import { sandboxProvider } from "@/server/sandbox";

/**
 * Eager sandbox teardown: the client fires this on navigate-away/tab-close
 * (see useAgentSession's `pagehide` wiring — sent via `navigator.sendBeacon`,
 * which survives page unload where a plain fetch may be dropped, with a
 * `keepalive` fetch fallback) so a v2 sandbox stops burning its 45-minute
 * session the moment nobody's looking at the preview, instead of idling
 * until SANDBOX_TIMEOUT_MS. sandbox.stop() snapshots the filesystem; the
 * next getOrCreate (restore/switchSession/fork) resumes it in seconds
 * rather than a from-scratch npm install.
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

  try {
    await sandboxProvider.stop(sessionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/sessions/${sessionId}/stop-preview] failed`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
