import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { appendEvent, getAllEvents, type EventRow } from "@/server/events";
import { getJob, setJobStatus } from "@/server/jobs";
import type { AnswerItem, Question } from "@/lib/types";

// ---------------------------------------------------------------------------
// Phase 1 agent loop.
//
// First turn: force the model to call `ask_user` with 3-5 clarifying
// questions. Once the user answers, the model writes a short build plan as
// text; the harness (not the model) then emits a few whimsical status lines
// and a closing summary, and marks the job done.
//
// Real code-gen tools (write_file/run_command/sandbox) are out of scope for
// Phase 1 — see PLAN.md Phase 2.
//
// MOCK MODE: if ANTHROPIC_API_KEY is unset, or MOCK_AGENT=1, we run a
// scripted trajectory with identical event shapes so the whole system is
// verifiable without an API key.
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-5";
const MAX_ITERATIONS = 15;

const SYSTEM_PROMPT = `You are the build agent inside an Emergent-style AI app builder. A user just described an app they want built in a chat box.

Your job in this phase is ONLY to scope the work — you do not write or run any code yet (that capability arrives in a later phase).

On your very first turn you MUST call the ask_user tool with 3-5 short clarifying questions about the app (e.g. target platform, data model, auth, must-have features, design style). Give each question 2-5 concrete suggested options.

After the user answers, write a short build plan (4-8 concise bullet points, plain text, no code) summarizing what you will build, directly informed by their answers.`;

const ASK_USER_TOOL: Tool = {
  name: "ask_user",
  description:
    "Ask the user 3-5 clarifying questions about the app they want built, each with a few suggested options. Call this exactly once, on your first turn, before doing anything else.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: {
              type: "array",
              items: { type: "string" },
              description: "2-5 short suggested answers",
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

const WHIMSICAL_STATUS_LINES = [
  "Making things click…",
  "Brewing something nice…",
  "Sketching the blueprint…",
  "Tidying up the loose ends…",
];

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
  "Scoping is complete — I have what I need to start building. Real code generation lands in the next phase; for now this job is done.";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMockMode(): boolean {
  return !process.env.ANTHROPIC_API_KEY || process.env.MOCK_AGENT === "1";
}

// Prevents a duplicate concurrent run of the same job within this process
// (e.g. a resume request arriving while the initial fire-and-forget promise
// is still finishing up).
const runningJobs = new Set<string>();

export async function runAgentLoop(jobId: string): Promise<void> {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  try {
    if (isMockMode()) {
      await runMockLoop(jobId);
    } else {
      await runRealLoop(jobId);
    }
  } finally {
    runningJobs.delete(jobId);
  }
}

async function isStopped(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  return !job || job.status === "stopped" || job.status === "done" || job.status === "failed";
}

function countUnansweredQuestions(allEvents: EventRow[]): number {
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

function countModelSteps(allEvents: EventRow[]): number {
  const stepIds = new Set<string>();
  for (const ev of allEvents) {
    if (ev.type === "assistant_message" || ev.type === "tool_call") {
      const stepId = (ev.payload as { stepId?: string }).stepId;
      if (stepId) stepIds.add(stepId);
    }
  }
  return stepIds.size;
}

async function guardIterationCap(
  jobId: string,
  allEvents: EventRow[]
): Promise<boolean> {
  if (countModelSteps(allEvents) >= MAX_ITERATIONS) {
    await appendEvent(jobId, "system", "error", {
      message: `Reached the maximum of ${MAX_ITERATIONS} agent iterations for this job.`,
    });
    await setJobStatus(jobId, "failed");
    return true;
  }
  return false;
}

async function handleAgentError(jobId: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[agent] job ${jobId} error:`, err);
  try {
    await appendEvent(jobId, "system", "error", { message });
    await setJobStatus(jobId, "failed");
  } catch (innerErr) {
    console.error(`[agent] job ${jobId} failed to record error event`, innerErr);
  }
}

// ---------------------------------------------------------------------------
// Mock trajectory
// ---------------------------------------------------------------------------

async function runMockLoop(jobId: string): Promise<void> {
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

  const hasPlan = allEvents.some((e) => e.type === "assistant_message");
  if (hasPlan) return; // already progressed past planning

  await appendEvent(jobId, "assistant", "assistant_message", {
    text: MOCK_PLAN_TEXT,
  });

  for (const line of WHIMSICAL_STATUS_LINES) {
    if (await isStopped(jobId)) return;
    await appendEvent(jobId, "assistant", "status", { text: line });
    await sleep(900);
  }

  if (await isStopped(jobId)) return;
  await appendEvent(jobId, "assistant", "assistant_message", {
    text: MOCK_SUMMARY_TEXT,
  });
  await setJobStatus(jobId, "done");
}

// ---------------------------------------------------------------------------
// Real trajectory (Anthropic API)
// ---------------------------------------------------------------------------

function normalizeQuestions(raw: unknown): Question[] {
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

function formatAnswersAsToolResult(answers: AnswerItem[]): string {
  return answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
}

/**
 * Reconstructs the Anthropic message history from the job's event log so the
 * conversation can be resumed after a suspend (waiting_on_user) even if this
 * process restarted in between. assistant_message/tool_call events sharing a
 * stepId are grouped back into the single assistant turn they came from.
 */
function buildMessagesFromEvents(allEvents: EventRow[]): MessageParam[] {
  const messages: MessageParam[] = [];
  let currentStepId: string | null = null;
  let currentBlocks: ContentBlockParam[] = [];

  function flush() {
    if (currentBlocks.length) {
      messages.push({ role: "assistant", content: currentBlocks });
    }
    currentStepId = null;
    currentBlocks = [];
  }

  for (const ev of allEvents) {
    if (ev.type === "user_message") {
      flush();
      messages.push({
        role: "user",
        content: (ev.payload as { text?: string }).text ?? "",
      });
      continue;
    }

    if (ev.type === "answer") {
      flush();
      const payload = ev.payload as { toolUseId?: string; answers?: AnswerItem[] };
      if (!payload.toolUseId) continue;
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: payload.toolUseId,
            content: formatAnswersAsToolResult(payload.answers ?? []),
          },
        ],
      });
      continue;
    }

    if (ev.type === "assistant_message" || ev.type === "tool_call") {
      const stepId = (ev.payload as { stepId?: string }).stepId ?? `solo-${ev.seq}`;
      if (stepId !== currentStepId) {
        flush();
        currentStepId = stepId;
      }
      if (ev.type === "assistant_message") {
        currentBlocks.push({
          type: "text",
          text: (ev.payload as { text?: string }).text ?? "",
        });
      } else {
        const payload = ev.payload as { id?: string; name?: string; input?: unknown };
        if (payload.id && payload.name) {
          currentBlocks.push({
            type: "tool_use",
            id: payload.id,
            name: payload.name,
            input: (payload.input as Record<string, unknown>) ?? {},
          });
        }
      }
      continue;
    }
    // status / usage / error events are cosmetic and not part of the model conversation.
  }

  flush();
  return messages;
}

async function logUsage(jobId: string, response: Anthropic.Message, step: string) {
  await appendEvent(jobId, "system", "usage", {
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    step,
  });
}

async function askUserTurn(client: Anthropic, jobId: string, allEvents: EventRow[]) {
  const messages = buildMessagesFromEvents(allEvents);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    thinking: { type: "disabled" },
    tools: [ASK_USER_TOOL],
    tool_choice: { type: "tool", name: "ask_user" },
    messages,
  });
  await logUsage(jobId, response, "ask_user_turn");

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "ask_user") {
    await appendEvent(jobId, "system", "error", {
      message: "Agent did not call ask_user on its first turn.",
    });
    await setJobStatus(jobId, "failed");
    return;
  }

  const stepId = response.id;
  await appendEvent(jobId, "assistant", "tool_call", {
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input,
    stepId,
    blockIndex: 0,
  });

  const questions = normalizeQuestions(
    (toolUse.input as { questions?: unknown }).questions
  );
  await appendEvent(jobId, "assistant", "question", {
    toolUseId: toolUse.id,
    questions,
  });

  await setJobStatus(jobId, "waiting_on_user");
}

async function planAndFinish(client: Anthropic, jobId: string) {
  if (await isStopped(jobId)) return;

  const messages = buildMessagesFromEvents(await getAllEvents(jobId));

  const planResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    thinking: { type: "disabled" },
    tools: [ASK_USER_TOOL],
    messages,
  });
  await logUsage(jobId, planResponse, "plan_turn");

  const planStepId = planResponse.id;
  let blockIndex = 0;
  let sawText = false;

  for (const block of planResponse.content) {
    if (block.type === "text") {
      sawText = true;
      await appendEvent(jobId, "assistant", "assistant_message", {
        text: block.text,
        stepId: planStepId,
        blockIndex: blockIndex++,
      });
    } else if (block.type === "tool_use") {
      // Model asked another clarifying round instead of planning — handle it
      // like a second ask_user turn rather than failing the job.
      await appendEvent(jobId, "assistant", "tool_call", {
        id: block.id,
        name: block.name,
        input: block.input,
        stepId: planStepId,
        blockIndex: blockIndex++,
      });
      if (block.name === "ask_user") {
        const questions = normalizeQuestions(
          (block.input as { questions?: unknown }).questions
        );
        await appendEvent(jobId, "assistant", "question", {
          toolUseId: block.id,
          questions,
        });
        await setJobStatus(jobId, "waiting_on_user");
        return;
      }
    }
  }

  if (!sawText) {
    await appendEvent(jobId, "system", "error", {
      message: "Agent produced no plan text.",
    });
  }

  // Whimsical status effects are scripted by the harness (not the model) —
  // Phase 2 will replace these with real build/status events.
  for (const line of WHIMSICAL_STATUS_LINES) {
    if (await isStopped(jobId)) return;
    await appendEvent(jobId, "assistant", "status", { text: line });
    await sleep(700);
  }

  if (await isStopped(jobId)) return;

  const summaryMessages: MessageParam[] = [
    ...buildMessagesFromEvents(await getAllEvents(jobId)),
    {
      role: "user",
      content:
        "The scoping phase is complete. Write a brief (2-3 sentence) closing summary for the user of what you'll build next.",
    },
  ];

  const summaryResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    thinking: { type: "disabled" },
    messages: summaryMessages,
  });
  await logUsage(jobId, summaryResponse, "summary_turn");

  const summaryText = summaryResponse.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();

  await appendEvent(jobId, "assistant", "assistant_message", {
    text: summaryText || "Scoping complete — ready for the next phase.",
    stepId: summaryResponse.id,
    blockIndex: 0,
  });

  await setJobStatus(jobId, "done");
}

async function runRealLoop(jobId: string): Promise<void> {
  try {
    const client = new Anthropic();
    const allEvents = await getAllEvents(jobId);

    if (await guardIterationCap(jobId, allEvents)) return;
    if (await isStopped(jobId)) return;

    const hasAskUserCall = allEvents.some(
      (e) =>
        e.type === "tool_call" &&
        (e.payload as { name?: string }).name === "ask_user"
    );

    if (!hasAskUserCall) {
      await askUserTurn(client, jobId, allEvents);
      return;
    }

    if (countUnansweredQuestions(allEvents) > 0) return; // still waiting

    const hasPlan = allEvents.some((e) => e.type === "assistant_message");
    if (hasPlan) return; // plan (and likely everything else) already produced

    await planAndFinish(client, jobId);
  } catch (err) {
    await handleAgentError(jobId, err);
  }
}
