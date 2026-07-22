import { NextResponse } from "next/server";
import { assertSessionOwnership } from "@/lib/authz";
import { getSessionFiles } from "@/server/files";
import { sandboxProvider } from "@/server/sandbox";
import { cancelScheduledStop } from "@/server/preview-stop-scheduler";

/**
 * Phase 3 persistence: brings a session's sandbox back up from its `files`
 * table snapshot — the real fix for the Phase 1/2 "orphaned sandbox"
 * limitation (dev-server restart kills the in-memory registry, but the
 * files were always durable in Postgres). Idempotent: if the sandbox is
 * already running (never orphaned, or already restored earlier in this
 * process), returns its existing URL straight away with no reinstall.
 *
 * Also what a freshly forked session uses to get its own, independent
 * sandbox running for the first time (see /api/sessions/[id]/fork).
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

  const files = await getSessionFiles(sessionId);
  if (files.length === 0) {
    return NextResponse.json(
      { error: "No file snapshot to restore this session's sandbox from yet" },
      { status: 404 }
    );
  }

  // A restore is the clearest possible evidence this session is being
  // watched again — cancel any stop-preview timer a previous tab's pagehide
  // beacon queued (see preview-stop-scheduler.ts) before it can race this
  // restore and stop the very sandbox we're about to bring/keep up.
  cancelScheduledStop(sessionId);

  try {
    const { url } = await sandboxProvider.restoreFromSnapshot(sessionId, files);
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/sessions/${sessionId}/restore] failed`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
