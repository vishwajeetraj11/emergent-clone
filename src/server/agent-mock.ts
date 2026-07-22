import { appendEvent, getAllEvents } from "@/server/events";
import { setJobStatus } from "@/server/jobs";
import { WHIMSICAL_STATUS_LINES } from "@/server/agent-prompts";
import { countUnansweredQuestions } from "@/server/agent-interaction";
import { isStopped, sleep } from "@/server/agent-core";
import type { Question } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mock trajectory — split out of agent.ts, no behavior change. If
// MOCK_AGENT=1, we run this scripted trajectory with identical event shapes
// (including a scripted plan step) so the whole system is verifiable without
// any model calls at all. The mock loop stops once the scripted plan is
// approved — it does not simulate a real build.
// ---------------------------------------------------------------------------

export function isMockMode(): boolean {
  return process.env.MOCK_AGENT === "1";
}

const MOCK_QUESTIONS: Question[] = [
  {
    id: "q1",
    question: "What kind of app should I build?",
    options: ["Quiz builder", "Task tracker", "Recipe organizer", "Something else"],
  },
  {
    id: "q2",
    question: "Which authentication method do you want?",
    options: [
      "Email + password",
      "Magic link",
      "No auth (single user)",
      "Social login",
    ],
  },
  {
    id: "q3",
    question: "Any must-have features for v1?",
    options: [
      "Dark mode",
      "Real-time collaboration",
      "Export to PDF",
      "Keep it minimal",
    ],
  },
];

const MOCK_PLAN_TEXT = `Here's the plan:
- Set up a Next.js + Tailwind frontend with a clean, minimal layout
- Model the core entities based on your answers
- Wire up the auth method you picked
- Build the primary flow end-to-end before adding extras
- Add the must-have feature you called out
- Leave room to iterate once you see the first working version`;

const MOCK_SUMMARY_TEXT =
  "Scoping is complete — I have what I need to start building. Real code generation lands in a later phase; for now this job is done.";

export async function runMockLoop(jobId: string): Promise<void> {
  const allEvents = await getAllEvents(jobId);
  if (await isStopped(jobId)) return;

  const hasQuestion = allEvents.some((e) => e.type === "question");
  if (!hasQuestion) {
    const toolUseId = "mock-ask-user-1";
    await appendEvent(jobId, "assistant", "tool_call", {
      id: toolUseId,
      name: "ask_user",
      input: { questions: MOCK_QUESTIONS },
    });
    await appendEvent(jobId, "assistant", "question", {
      toolUseId,
      questions: MOCK_QUESTIONS,
    });
    await setJobStatus(jobId, "waiting_on_user");
    return;
  }

  if (countUnansweredQuestions(allEvents) > 0) return; // still waiting

  const hasPlan = allEvents.some((e) => e.type === "plan");
  if (!hasPlan) {
    const planEventId = "mock-plan-1";
    await appendEvent(jobId, "assistant", "assistant_message", {
      text: MOCK_PLAN_TEXT,
    });

    for (const line of WHIMSICAL_STATUS_LINES) {
      if (await isStopped(jobId)) return;
      await appendEvent(jobId, "assistant", "status", { text: line });
      await sleep(900);
    }

    if (await isStopped(jobId)) return;
    await appendEvent(jobId, "assistant", "plan", {
      id: planEventId,
      text: MOCK_PLAN_TEXT,
      revision: 0,
    });
    await setJobStatus(jobId, "waiting_on_plan");
    return;
  }

  const latestPlan = [...allEvents].reverse().find((e) => e.type === "plan");
  const planEventId = (latestPlan?.payload as { id?: string } | undefined)?.id;
  const decision = allEvents.find(
    (e) =>
      e.type === "plan_decision" &&
      (e.payload as { planEventId?: string }).planEventId === planEventId
  );
  if (!decision) return; // still waiting on the plan decision

  await appendEvent(jobId, "assistant", "assistant_message", {
    text: MOCK_SUMMARY_TEXT,
  });
  await setJobStatus(jobId, "done");
}
