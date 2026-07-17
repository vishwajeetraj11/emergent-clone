import { NextResponse } from "next/server";
import { assertSessionOwnership } from "@/lib/authz";
import { getSessionEvents } from "@/server/events";

/**
 * Full chronological event history for a session, across every job it has
 * ever run (initial build + each "continue chatting" job) — used by
 * loadProject to repopulate the timeline on page load/reload instead of only
 * showing the most recent job's events.
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

  const rows = await getSessionEvents(sessionId);
  return NextResponse.json({
    events: rows.map((e) => ({
      seq: e.seq,
      jobId: e.jobId,
      role: e.role,
      type: e.type,
      payload: e.payload,
      createdAt: e.createdAt,
    })),
  });
}
