import { NextResponse } from "next/server";
import { assertJobOwnership } from "@/lib/authz";
import { runAgentLoop } from "@/server/agent";
import { appendEvent } from "@/server/events";
import { getJob, setJobStatus } from "@/server/jobs";
import type { AnswerItem } from "@/lib/types";

interface MessagesRequestBody {
  toolUseId?: unknown;
  answers?: unknown;
}

function normalizeAnswers(raw: unknown): AnswerItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (a): a is { id?: unknown; question?: unknown; answer?: unknown } =>
        typeof a === "object" && a !== null
    )
    .map((a, i) => ({
      id: typeof a.id === "string" ? a.id : `q${i + 1}`,
      question: typeof a.question === "string" ? a.question : "",
      answer: typeof a.answer === "string" ? a.answer.trim() : "",
    }))
    .filter((a) => a.answer.length > 0);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await params;

  try {
    await assertJobOwnership(jobId);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: MessagesRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const toolUseId = typeof body.toolUseId === "string" ? body.toolUseId : "";
  const answers = normalizeAnswers(body.answers);

  if (!toolUseId || answers.length === 0) {
    return NextResponse.json(
      { error: "toolUseId and a non-empty answers array are required" },
      { status: 400 }
    );
  }

  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.status === "done" || job.status === "stopped" || job.status === "failed") {
    return NextResponse.json(
      { error: `Job is ${job.status}; cannot accept more messages` },
      { status: 409 }
    );
  }

  await appendEvent(jobId, "user", "answer", { toolUseId, answers });
  await setJobStatus(jobId, "running");

  // Fire-and-forget resume — see the durability note in src/server/jobs.ts.
  runAgentLoop(jobId).catch((err) => {
    console.error(`[agent] job ${jobId} loop crashed on resume`, err);
  });

  return NextResponse.json({ ok: true });
}
