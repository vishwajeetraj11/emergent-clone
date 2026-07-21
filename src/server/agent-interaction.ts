import { appendEvent, getAllEvents, type EventRow } from "@/server/events";
import { setJobStatus } from "@/server/jobs";
import { buildAskUserTool } from "@/server/agent-tools";
import { ANSWER_POLL_INTERVAL_MS, isStopped, sleep } from "@/server/agent";
import type { AnswerItem, Question } from "@/lib/types";

// ---------------------------------------------------------------------------
// The ask_user machinery — split out of agent.ts, no behavior change. The
// `ask_user` tool is a custom in-process SDK MCP tool: when the model calls
// it, the handler appends the tool_call + question events, flips the job to
// waiting_on_user, and then BLOCKS — polling the events table for an
// `answer` event — until the user responds via POST /messages. That call
// only lives in this process, so if the dev server restarts mid-run the job
// orphans — an accepted limitation (documented in src/server/jobs.ts).
// ---------------------------------------------------------------------------

export function normalizeQuestions(raw: unknown): Question[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.slice(0, 5).map((q, i) => {
    const record = q as { question?: unknown; options?: unknown };
    const question =
      typeof record.question === "string" ? record.question : `Question ${i + 1}`;
    const options = Array.isArray(record.options)
      ? record.options.filter((o): o is string => typeof o === "string").slice(0, 6)
      : [];
    return { id: `q${i + 1}`, question, options };
  });
}

export function formatAnswersAsToolResult(answers: AnswerItem[]): string {
  return answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
}

export function countUnansweredQuestions(allEvents: EventRow[]): number {
  const answeredIds = new Set(
    allEvents
      .filter((e) => e.type === "answer")
      .map((e) => (e.payload as { toolUseId?: string }).toolUseId)
      .filter((id): id is string => Boolean(id))
  );
  return allEvents.filter(
    (e) =>
      e.type === "question" &&
      !answeredIds.has((e.payload as { toolUseId?: string }).toolUseId ?? "")
  ).length;
}

/**
 * Polls the events table (same ~800ms polling style as the SSE route) until
 * an `answer` event for this toolUseId appears, or the job is stopped out
 * from under us. Runs *inside* the ask_user tool handler, so the SDK's
 * query() call — and the underlying `claude` CLI process — stays alive for
 * the whole wait.
 */
export async function waitForAnswer(
  jobId: string,
  toolUseId: string
): Promise<AnswerItem[] | null> {
  while (true) {
    if (await isStopped(jobId)) return null;

    const allEvents = await getAllEvents(jobId);
    const answerEvent = allEvents.find(
      (e) =>
        e.type === "answer" &&
        (e.payload as { toolUseId?: string }).toolUseId === toolUseId
    );
    if (answerEvent) {
      return (answerEvent.payload as { answers?: AnswerItem[] }).answers ?? [];
    }

    await sleep(ANSWER_POLL_INTERVAL_MS);
  }
}

/** The blocking ask_user tool, wired to this module's event/poll helpers — see buildAskUserTool in agent-tools.ts for why deps are injected. */
export function askUserToolFor(jobId: string) {
  return buildAskUserTool({
    jobId,
    appendEvent,
    setJobStatus,
    waitForAnswer,
    normalizeQuestions,
    formatAnswersAsToolResult,
  });
}
