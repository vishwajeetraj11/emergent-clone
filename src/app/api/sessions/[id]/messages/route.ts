import { NextResponse } from "next/server";
import { continueSessionWithPrompt } from "@/server/sessions";

/**
 * Session-scoped "send a new top-level message" — distinct from
 * /api/jobs/[id]/messages (which answers a specific job's clarifying
 * questions). Creates a new job under this session and runs the agent loop
 * against it. Used to keep chatting once a session's previous job reached a
 * terminal status, notably right after a fork.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  let body: { prompt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  try {
    const { job } = await continueSessionWithPrompt(sessionId, prompt);
    return NextResponse.json({ job: { id: job.id, status: job.status } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/sessions/${sessionId}/messages] failed`, err);
    const status = message === "Session not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
