import { NextResponse, type NextRequest } from "next/server";
import { assertJobOwnership } from "@/lib/authz";
import { getEventsSince, type EventRow } from "@/server/events";
import { getJob } from "@/server/jobs";

// SSE must never be statically optimized/cached.
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 800;
const HEARTBEAT_INTERVAL_MS = 15000;
const TERMINAL_STATUSES = new Set(["done", "stopped", "failed"]);

function formatEventMessage(event: EventRow): string {
  const data = JSON.stringify({
    seq: event.seq,
    jobId: event.jobId,
    role: event.role,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
  });
  // `id:` is what makes EventSource remember Last-Event-ID across reconnects;
  // `event:` lets the client add a typed listener per event.type.
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

function formatJobStatusMessage(status: string): string {
  return `event: job_status\ndata: ${JSON.stringify({ status })}\n\n`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await params;

  try {
    await assertJobOwnership(jobId);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const lastEventIdHeader = request.headers.get("last-event-id");
  const afterParam = request.nextUrl.searchParams.get("after");
  const parsedCursor = Number.parseInt(lastEventIdHeader ?? afterParam ?? "-1", 10);
  let cursor = Number.isFinite(parsedCursor) ? parsedCursor : -1;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      function safeEnqueue(chunk: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      }

      let lastHeartbeatAt = Date.now();
      let lastSentStatus: string | null = null;

      try {
        while (!closed) {
          const job = await getJob(jobId);
          if (!job) {
            safeEnqueue(formatJobStatusMessage("not_found"));
            break;
          }

          const newEvents = await getEventsSince(jobId, cursor);
          for (const event of newEvents) {
            safeEnqueue(formatEventMessage(event));
            cursor = event.seq;
          }

          // Emit job_status on every transition (running -> waiting_on_user
          // -> running -> done/...), not just the terminal one, so the
          // client's status strip stays in sync.
          if (job.status !== lastSentStatus) {
            safeEnqueue(formatJobStatusMessage(job.status));
            lastSentStatus = job.status;
          }

          if (TERMINAL_STATUSES.has(job.status)) {
            break;
          }

          if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
            safeEnqueue(": heartbeat\n\n");
            lastHeartbeatAt = Date.now();
          }

          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      } catch (err) {
        console.error(`[sse] job ${jobId} stream error`, err);
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
