import { NextResponse } from "next/server";
import { assertJobOwnership } from "@/lib/authz";
import { runAgentLoop } from "@/server/agent";
import { appendEvent } from "@/server/events";
import { getJob, setJobStatus } from "@/server/jobs";

interface PlanDecisionRequestBody {
  planEventId?: unknown;
  action?: unknown;
  feedback?: unknown;
}

/**
 * The user's response to a `plan` event — approve it as-is, or ask for
 * changes. Mirrors POST /api/jobs/[id]/messages's shape (ownership check,
 * terminal-job guard, fire-and-forget resume), but for
 * src/server/agent.ts's runPlanningPhase/waitForPlanDecision instead of
 * ask_user's waitForAnswer.
 */
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

  let body: PlanDecisionRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const planEventId = typeof body.planEventId === "string" ? body.planEventId : "";
  const action = body.action === "approve" || body.action === "revise" ? body.action : null;
  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : undefined;

  if (!planEventId || !action) {
    return NextResponse.json(
      { error: "planEventId and action ('approve' | 'revise') are required" },
      { status: 400 }
    );
  }
  if (action === "revise" && !feedback) {
    return NextResponse.json(
      { error: "feedback is required when action is 'revise'" },
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

  await appendEvent(jobId, "user", "plan_decision", { planEventId, action, feedback });
  await setJobStatus(jobId, "running");

  // Fire-and-forget resume — see the durability note in
  // src/server/jobs.ts. Normally a no-op (runAgentLoop's in-process
  // runningJobs guard) since the original call is still parked inside
  // waitForPlanDecision; only matters for the orphaned-process case.
  runAgentLoop(jobId).catch((err) => {
    console.error(`[agent] job ${jobId} loop crashed on resume`, err);
  });

  return NextResponse.json({ ok: true });
}
