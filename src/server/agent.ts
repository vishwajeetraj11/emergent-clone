import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKResultError,
} from "@anthropic-ai/claude-agent-sdk";
import { appendEvent, getAllEvents, type EventRow } from "@/server/events";
import { getJob, setAgentSessionId, setJobStatus } from "@/server/jobs";
import type { AnswerItem, Question } from "@/lib/types";

// ---------------------------------------------------------------------------
// Phase 1 agent loop.
//
// First turn: the model is instructed (and given exactly one tool) to call
// `ask_user` with 3-5 clarifying questions. Once the user answers, the model
// writes a short build plan as text; the harness (not the model) then emits
// a few whimsical status lines and a closing summary, and marks the job
// done.
//
// Real code-gen tools (write_file/run_command/sandbox) are out of scope for
// Phase 1 — see PLAN.md Phase 2.
//
// REAL RUNTIME: the "real" (non-mock) path runs on the Claude Agent SDK
// (`@anthropic-ai/claude-agent-sdk`), which wraps the local `claude` CLI and
// authenticates with whatever the CLI is already logged in as (Claude Code
// subscription auth) — no ANTHROPIC_API_KEY needed for local dev. Deploying
// this to a hosted environment later needs its own auth story for the CLI;
// that's out of scope here.
//
// The `ask_user` tool is a custom in-process SDK MCP tool: when the model
// calls it, the handler appends the tool_call + question events, flips the
// job to waiting_on_user, and then BLOCKS — polling the events table for an
// `answer` event — until the user responds via POST /messages. This means
// the entire scoping conversation (ask_user -> plan text) happens inside one
// long-lived query() call per job, spanning the human's wait. That call
// only lives in this process, so if the dev server restarts mid-run the job
// orphans — same accepted Phase 1 limitation documented in src/server/jobs.ts.
//
// MOCK MODE: if MOCK_AGENT=1, we run a scripted trajectory with identical
// event shapes so the whole system is verifiable without any model calls at
// all.
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-5";
const MAX_ITERATIONS = 15;
const ANSWER_POLL_INTERVAL_MS = 800;

const SYSTEM_PROMPT = `You are the build agent inside an Emergent-style AI app builder. A user just described an app they want built in a chat box.

Your job in this phase is ONLY to scope the work — you do not write or run any code yet (that capability arrives in a later phase). You have exactly one tool available, named ask_user; you have no filesystem, shell, or web access.

On your very first turn you MUST call the ask_user tool with 3-5 short clarifying questions about the app (e.g. target platform, data model, auth, must-have features, design style). Give each question 2-6 concrete suggested options.

After the user answers, write a short build plan (4-8 concise bullet points, plain text, no code) summarizing what you will build, directly informed by their answers.`;

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
  return process.env.MOCK_AGENT === "1";
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
// Real trajectory (Claude Agent SDK, local `claude` CLI auth)
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

/** Per-job scratch directory used as the query's `cwd` — never the real project root. */
function ensureJobScratchDir(jobId: string): string {
  const dir = join(tmpdir(), "emergent-agent-jobs", jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Polls the events table (same ~800ms polling style as the SSE route) until
 * an `answer` event for this toolUseId appears, or the job is stopped out
 * from under us. Runs *inside* the ask_user tool handler, so the SDK's
 * query() call — and the underlying `claude` CLI process — stays alive for
 * the whole wait.
 */
async function waitForAnswer(
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

function buildAskUserTool(jobId: string) {
  return tool(
    "ask_user",
    "Ask the user 3-5 clarifying questions about the app they want built, each with 2-6 short suggested options. Call this exactly once, on your first turn, before writing any plan or doing anything else.",
    {
      questions: z
        .array(
          z.object({
            question: z.string().min(1),
            options: z.array(z.string().min(1)).min(2).max(6),
          })
        )
        .min(3)
        .max(5)
        .describe("3-5 clarifying questions, each with 2-6 short suggested options"),
    },
    async (args) => {
      const toolUseId = randomUUID();
      const questions = normalizeQuestions(args.questions);

      await appendEvent(jobId, "assistant", "tool_call", {
        id: toolUseId,
        name: "ask_user",
        input: { questions },
      });
      await appendEvent(jobId, "assistant", "question", {
        toolUseId,
        questions,
      });
      await setJobStatus(jobId, "waiting_on_user");

      const answers = await waitForAnswer(jobId, toolUseId);

      if (answers === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: "The job was stopped before the user answered.",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text" as const, text: formatAnswersAsToolResult(answers) },
        ],
      };
    }
  );
}

function describeResultError(message: SDKResultError): string {
  if (message.subtype === "error_max_turns") {
    return `Reached the maximum of ${MAX_ITERATIONS} agent iterations for this job.`;
  }
  if (message.subtype === "error_max_budget_usd") {
    return "Reached the maximum budget for this job.";
  }
  if (message.errors.length > 0) {
    return message.errors.join("; ");
  }
  return `Agent run failed (${message.subtype}).`;
}

/**
 * The whole scoping conversation — ask_user, the block-until-answered wait,
 * and the resulting plan text — happens inside this single query() call.
 * Only the `ask_user` MCP tool is exposed; every built-in tool
 * (Bash/Read/Write/Edit/WebFetch/…) is disabled via `tools: []`, and `cwd`
 * points at a throwaway scratch directory as defense in depth.
 */
async function runScopingQuery(jobId: string, prompt: string): Promise<void> {
  const cwd = ensureJobScratchDir(jobId);
  const emergentServer = createSdkMcpServer({
    name: "emergent",
    version: "1.0.0",
    tools: [buildAskUserTool(jobId)],
  });

  const q = query({
    prompt,
    options: {
      model: MODEL,
      cwd,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: MAX_ITERATIONS,
      tools: [], // no built-in tools at all (no Bash/Read/Write/Edit/WebFetch/...)
      mcpServers: { emergent: emergentServer },
      allowedTools: ["mcp__emergent__ask_user"], // the ONLY tool the model can use
      strictMcpConfig: true, // ignore project .mcp.json / other MCP config
      settingSources: [], // ignore filesystem settings (user/project/local)
      permissionMode: "default",
    },
  });

  let askUserCalled = false;
  let sessionId: string | undefined;

  for await (const message of q) {
    if (await isStopped(jobId)) {
      q.close();
      return;
    }

    if (message.type === "assistant") {
      let blockIndex = 0;
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          await appendEvent(jobId, "assistant", "assistant_message", {
            text: block.text,
            stepId: message.uuid,
            blockIndex: blockIndex++,
          });
        } else if (block.type === "tool_use") {
          // The ask_user tool_call/question events are appended by the tool
          // handler itself (buildAskUserTool) — nothing to do here besides
          // note that the model did in fact call it.
          askUserCalled = true;
          blockIndex++;
        }
      }
      continue;
    }

    if (message.type === "result") {
      sessionId = message.session_id;
      await appendEvent(jobId, "system", "usage", {
        model: MODEL,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        step: "scoping_query",
      });

      if (message.subtype !== "success") {
        await appendEvent(jobId, "system", "error", {
          message: describeResultError(message),
        });
        await setJobStatus(jobId, "failed");
        if (sessionId) await setAgentSessionId(jobId, sessionId);
        return;
      }
    }
  }

  if (sessionId) await setAgentSessionId(jobId, sessionId);
  if (await isStopped(jobId)) return;

  if (!askUserCalled) {
    await appendEvent(jobId, "system", "error", {
      message: "Agent did not call ask_user during the scoping turn.",
    });
    await setJobStatus(jobId, "failed");
    return;
  }

  // Whimsical status effects are scripted by the harness (not the model) —
  // Phase 2 will replace these with real build/status events.
  for (const line of WHIMSICAL_STATUS_LINES) {
    if (await isStopped(jobId)) return;
    await appendEvent(jobId, "assistant", "status", { text: line });
    await sleep(700);
  }

  if (await isStopped(jobId)) return;

  await runSummaryQuery(jobId, cwd);
}

/**
 * Second, short query() call for the closing summary — same tool-restricted,
 * filesystem-isolated configuration as the scoping query, but with no tools
 * at all (not even ask_user).
 */
async function runSummaryQuery(jobId: string, cwd: string): Promise<void> {
  const q = query({
    prompt:
      "The scoping phase is complete. Write a brief (2-3 sentence) closing summary for the user of what you'll build next. Plain text only — no code, no tool calls.",
    options: {
      model: MODEL,
      cwd,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 1,
      tools: [],
      mcpServers: {},
      allowedTools: [],
      strictMcpConfig: true,
      settingSources: [],
      permissionMode: "default",
    },
  });

  let summaryText = "";

  for await (const message of q) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          summaryText += (summaryText ? "\n" : "") + block.text;
        }
      }
      continue;
    }

    if (message.type === "result") {
      await appendEvent(jobId, "system", "usage", {
        model: MODEL,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        step: "summary_query",
      });
      if (message.subtype !== "success") {
        throw new Error(describeResultError(message));
      }
    }
  }

  if (await isStopped(jobId)) return;

  await appendEvent(jobId, "assistant", "assistant_message", {
    text: summaryText.trim() || "Scoping complete — ready for the next phase.",
  });

  await setJobStatus(jobId, "done");
}

async function runRealLoop(jobId: string): Promise<void> {
  try {
    if (await isStopped(jobId)) return;

    const allEvents = await getAllEvents(jobId);

    // The scoping phase runs start-to-finish inside one long-lived query()
    // call (see runScopingQuery) — the ask_user tool blocks *inside that
    // call* until answered, so a second invocation of runAgentLoop for the
    // same job (e.g. the resume POST from /messages while the first call is
    // still parked in the tool handler) is naturally a no-op: the
    // in-process `runningJobs` guard in runAgentLoop already prevents real
    // re-entrancy. This check instead guards the orphan case — dev server
    // restarted mid-run, so `runningJobs` is empty in the new process too —
    // where a prior ask_user tool_call is already on the log. Resuming the
    // underlying CLI session across a process restart is out of scope for
    // this phase (see the Phase 1 limitation note in src/server/jobs.ts).
    const alreadyStartedScoping = allEvents.some(
      (e) => e.type === "tool_call" && (e.payload as { name?: string }).name === "ask_user"
    );
    if (alreadyStartedScoping) return;

    const userMessageEvent = allEvents.find((e) => e.type === "user_message");
    const prompt = (userMessageEvent?.payload as { text?: string } | undefined)?.text;
    if (!prompt) {
      throw new Error("Job has no initial user message to build a prompt from.");
    }

    await runScopingQuery(jobId, prompt);
  } catch (err) {
    await handleAgentError(jobId, err);
  }
}
