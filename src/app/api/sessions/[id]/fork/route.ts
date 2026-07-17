import { NextResponse } from "next/server";
import { assertSessionOwnership, ForbiddenError } from "@/lib/authz";
import { forkSession } from "@/server/sessions";

/**
 * "Manage Agent Context With Forks": creates a new session under the same
 * project (parentSessionId = this one), copies this session's files (DB +
 * on-disk sandbox snapshot) into it, and seeds a short synthetic history
 * event. Does not start the forked sandbox or run the agent — the client
 * switches to the returned session/job and calls /restore (or sends a new
 * message) next.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  try {
    await assertSessionOwnership(sessionId);
    const { session, job, fileCount } = await forkSession(sessionId);
    return NextResponse.json({
      session: { id: session.id, parentSessionId: session.parentSessionId },
      job: { id: job.id, status: job.status },
      fileCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/sessions/${sessionId}/fork] failed`, err);
    const status =
      message === "Session not found" || err instanceof ForbiddenError ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
