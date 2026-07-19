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
import { sandboxProvider, seedSandboxTemplate } from "@/server/sandbox";
import { getSessionFiles, snapshotSessionFiles } from "@/server/files";
import { debitForJobUsage } from "@/server/credits";
import { getProjectAgentContext } from "@/server/projects";
import type { AnswerItem, Question } from "@/lib/types";

// ---------------------------------------------------------------------------
// Multi-agent orchestration: Plan (Opus) -> user approves/revises -> Build
// (Sonnet) -> Review (Sonnet) -> Debug (Sonnet, only if review found issues).
//
// PLANNING: the planner (claude-opus-4-8) asks clarifying questions via the
// same ask_user tool as before, then writes a build plan. Instead of
// silently continuing to build, the harness now appends a `plan` event and
// pauses the job (status "waiting_on_plan") until the user approves or
// requests changes (POST /api/jobs/[id]/plan) — same "block inside a
// long-lived harness loop, poll the events table" shape as ask_user's
// waitForAnswer, just driven by the harness (runPlanningPhase) rather than
// from inside a tool handler, since writing a plan isn't itself a tool call.
// A "revise" decision loops back into another planner call with the user's
// feedback folded in, capped at MAX_PLAN_REVISIONS.
//
// BUILD: unchanged mechanically from before — the builder (claude-sonnet-5)
// gets real Bash/Read/Write/Edit/Glob/Grep, `cwd`'d into the session's
// sandbox.
//
// REVIEW + DEBUG (new): once the builder finishes, a review pass (also
// claude-sonnet-5 — Opus is reserved for planning only, confirmed) reads the
// resulting code (Read/Grep/Glob/Bash, no writes) and reports structured
// findings via a custom `report_review` tool (same pattern as ask_user).
// Only if it found real issues does a debug pass run (same tools as build)
// to fix them, then the sandbox gets re-snapshotted. A clean review skips
// the debug pass entirely — no wasted call on a build with nothing wrong.
//
// This whole pipeline is FORCED on a brand-new project's first build (as
// scoping always was). For a follow-up message on an already-built session,
// the default stays today's direct-to-build edit (CONTINUATION_PLAN_TEXT,
// no planning gate) — but the user can opt a specific message into the full
// Plan -> Approve -> Build pipeline via a `planMode` flag riding on that
// job's `user_message` event payload (no new DB column — same "derive from
// existing state" philosophy as the existingFiles.length check below that
// already distinguishes fresh builds from continuations). Either way, once
// a build happens, the new Review(+Debug) tail always runs.
//
// REAL RUNTIME: the "real" (non-mock) path runs on the Claude Agent SDK
// (`@anthropic-ai/claude-agent-sdk`), which wraps the local `claude` CLI and
// authenticates with whatever the CLI is already logged in as (Claude Code
// subscription auth) — no ANTHROPIC_API_KEY needed for local dev.
//
// The `ask_user` tool is a custom in-process SDK MCP tool: when the model
// calls it, the handler appends the tool_call + question events, flips the
// job to waiting_on_user, and then BLOCKS — polling the events table for an
// `answer` event — until the user responds via POST /messages. That call
// only lives in this process, so if the dev server restarts mid-run the job
// orphans — an accepted limitation (documented in src/server/jobs.ts), and
// the same applies to a job parked in waitForPlanDecision.
//
// KNOWN RESIDUAL RISK (build/review/debug, accepted — not solved here): the
// query's `cwd` scopes where its Bash tool *starts*, not a hard filesystem
// jail. The model could `cd` or use an absolute path to touch things outside
// the sandbox directory. This is a single-user local dev tool, not a
// multi-tenant production sandbox, so a real jail (container/chroot) is out
// of scope for this phase.
//
// MOCK MODE: if MOCK_AGENT=1, we run a scripted trajectory with identical
// event shapes (including a scripted plan step) so the whole system is
// verifiable without any model calls at all. The mock loop stops once the
// scripted plan is approved — it does not simulate a real build.
// ---------------------------------------------------------------------------

const PLANNER_MODEL = "claude-opus-4-8";
const BUILDER_MODEL = "claude-sonnet-5"; // build, review, and debug — always

const MAX_ITERATIONS = 15;
const MAX_PLAN_REVISIONS = 5;
const ANSWER_POLL_INTERVAL_MS = 800;

// Build phase gets a much larger iteration budget than planning — it's
// actually writing/editing files and running commands, not just asking a
// handful of questions or reading over what's already there.
const BUILD_MAX_ITERATIONS = 60;
const REVIEW_MAX_ITERATIONS = 20;
const DEBUG_MAX_ITERATIONS = 40;

// Explicit allowlist (checked against node_modules/@anthropic-ai/claude-agent-sdk
// sdk.d.ts's `Options.tools` — `string[] | { type: 'preset'; preset: 'claude_code' }`)
// rather than the `claude_code` preset, so each phase gets exactly the tools
// it needs and nothing else (no WebFetch/WebSearch/Task/...).
const BUILD_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];
// Review is read-only by design (plus Bash, so it can run a real compile
// check like `npm run build` rather than guessing from source alone) — no
// Write/Edit, since reviewing and fixing are deliberately separate passes.
const REVIEW_TOOLS = ["Bash", "Read", "Glob", "Grep"];

const BUILD_SYSTEM_PROMPT = `You are the build agent inside an Emergent-style AI app builder. You already scoped this app with the user in an earlier turn — you have their answers and you already wrote a build plan. You do not need to ask them anything else; build directly.

Your working directory already contains a minimal Next.js (App Router) + Tailwind starter template — package.json, app/layout.tsx, app/page.tsx, tailwind/postcss config. A real \`npm run dev\` dev server for this directory is already running and being live-previewed, so:
- Edit the existing files and add new ones to build the actual app described in the plan and the user's answers.
- Keep \`npm run dev\` working — don't leave the app in a state that fails to compile. Feel free to use Bash to sanity-check (e.g. \`npm run build\`) if you're unsure. Known false positive: this template's \`npm run build\` can fail to statically prerender a \`/_global-error\` route even when the app is completely fine — that's a pre-existing quirk of the starter template, not something you caused; don't spend time chasing it if you see it.
- If you need an additional npm package, install it yourself via Bash (\`npm install <package>\`).
- Keep changes scoped to what was actually asked for — don't build unrelated features.
- Do not run any command or read/write any file outside this working directory.

The user's message may be a build/edit instruction, a plain question about the project (e.g. "is my GitHub connected?", "has this been deployed?", "how many credits do I have left?"), or both. Your prompt includes a "Project context" block with the real, current answers to exactly that kind of question — use it to answer directly instead of guessing from sandbox files (they don't contain account/connector state) or claiming you have no way to know. Only touch files when the message actually asks for a build/edit.

Never reference the identity, email address, or account details of whoever is authenticated on the underlying CLI session.`;

const SYSTEM_PROMPT = `You are the planning agent inside an Emergent-style AI app builder. A user just described an app they want built in a chat box.

Your job in this phase is ONLY to scope the work and write a plan — a separate builder agent writes the actual code in a later phase. You have exactly one tool available, named ask_user; you have no filesystem, shell, or web access.

Never reference the identity, email address, or account details of whoever is authenticated on the underlying CLI session — you are building an app for an end user you know nothing about, not for the operator of this environment. Do not suggest "use my email X" or similar as an answer option.

On your very first turn you MUST call the ask_user tool with 3-5 short clarifying questions about the app (e.g. target platform, data model, auth, must-have features, design style). Give each question 2-6 concrete suggested options.

After the user answers, write a short build plan (4-8 concise bullet points, plain text, no code) summarizing what you will build, directly informed by their answers. The user will review this plan and may ask you to change it before anything gets built.`;

/**
 * Used for every revision pass (fresh-build or continuation), regardless of
 * which system prompt produced the original plan — the ask_user tool stays
 * registered but the model is told to use it sparingly, since the point of
 * a revision is usually just "apply this feedback", not re-scope from zero.
 */
const PLAN_REVISION_SYSTEM_PROMPT = `You are the planning agent inside an Emergent-style AI app builder. You already wrote a build plan and the user has asked for changes to it.

You have exactly one tool available, ask_user — only use it if the requested change is genuinely ambiguous in a way that risks doing the wrong thing; most revision requests can be applied directly without asking anything.

Write a revised build plan (4-8 concise bullet points, plain text, no code) that actually incorporates the requested changes — don't just repeat the previous plan.`;

/**
 * Continuation ("keep chatting") planning, only used when the user opts a
 * follow-up message into Plan mode — adapts CONTINUATION_PLAN_TEXT's "this
 * is an edit, not a fresh build" framing into a planning-phase prompt.
 */
const CONTINUATION_PLANNING_SYSTEM_PROMPT = `You are the planning agent inside an Emergent-style AI app builder. This is a follow-up request against an app that already exists and is running in a working directory you don't have access to yet — it is NOT a fresh build.

You have exactly one tool available, ask_user — only use it if the request is genuinely ambiguous in a way that risks doing the wrong thing; for a straightforward request, don't ask anything and go straight to writing the plan.

Write a short edit plan (2-6 concise bullet points, plain text, no code) describing exactly what you will change, directly informed by the user's request. The user will review this plan and may ask you to change it before anything gets built.`;

const REVIEW_SYSTEM_PROMPT = `You are the code review agent inside an Emergent-style AI app builder. Another agent just built or edited the app in this working directory.

Inspect the actual code — read the files that were touched, check they're internally consistent. Look for real, concrete problems: broken imports, mismatched types, obviously wrong logic, a component referencing a file that doesn't exist. Do not nitpick style or invent hypothetical issues — only report things that would actually break or visibly misbehave.

Known false positive, do not chase this: this template's \`npm run build\` can fail to statically prerender a \`/_global-error\` route even when the app itself is completely fine — that is a pre-existing quirk of this starter template, not something caused by the edit you're reviewing. If you see it, ignore it; it is not a reportable issue. Checking that the actual page(s) touched by the edit render correctly (one curl/fetch against the already-running dev server is enough) is far more informative here than a full \`npm run build\`.

Be decisive and efficient — you are not debugging, you are forming a verdict. A couple of Read/Grep calls plus at most one quick check against the running dev server is normally enough. Do not spin up additional dev servers on other ports, do not repeatedly rerun the same check, and do not keep digging once you have a reasonably confident answer. Call report_review as soon as you're confident either way — a review that runs out of turns without calling it is a worse outcome than a slightly less thorough one that does.

You have Bash/Read/Glob/Grep tools. You have exactly one other tool, report_review — call it exactly once, at the end, with your findings. Do not edit any files; you are reviewing, not fixing.`;

const DEBUG_SYSTEM_PROMPT = `You are the debugging agent inside an Emergent-style AI app builder. A code review just found issues in this working directory that need fixing.

Fix each issue listed in your prompt. Read whatever files you need to understand the problem before changing anything. Keep \`npm run dev\` working — sanity-check with \`npm run build\` via Bash if you're unsure. Keep changes scoped to fixing the reported issues; do not refactor or add unrelated features.`;

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
  "Scoping is complete — I have what I need to start building. Real code generation lands in a later phase; for now this job is done.";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMockMode(): boolean {
  return process.env.MOCK_AGENT === "1";
}

// ---------------------------------------------------------------------------
// Production credential swap point.
//
// Returns `undefined` when ANTHROPIC_API_KEY is not set in the server's own
// process environment — the SDK's `query()` then omits `options.env`
// entirely, so the subprocess inherits this process's shell environment and
// falls through to the local `claude` CLI's own login (Claude Code
// subscription auth). This is the default, always-tested path in this
// environment: no ANTHROPIC_API_KEY is set here, so every call site below
// passes `env: getAgentEnv()` === `env: undefined`, which is exactly what
// those call sites did before this function existed (they simply didn't set
// `env` at all).
//
// Returns `{ ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }`
// only once a real, centrally-held key is configured for a production
// deploy. No other code changes are needed to swap credential sources: this
// is the one function a production deployment's ops config needs to make
// true.
// ---------------------------------------------------------------------------
function getAgentEnv(): Record<string, string | undefined> | undefined {
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  return { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
}

/**
 * Appends a `usage` event and, right after, debits the job owner's credit
 * ledger for that usage — see src/server/credits.ts for the cost model.
 * Centralizes every call site so they can't drift out of sync with each
 * other. Takes the actual model used for this call (planner vs builder use
 * different, differently-priced models) rather than assuming one flat rate.
 */
async function recordUsage(
  jobId: string,
  step: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  await appendEvent(jobId, "system", "usage", {
    model,
    inputTokens,
    outputTokens,
    step,
  });
  await debitForJobUsage(jobId, step, model, inputTokens, outputTokens);
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

/**
 * Renders the DB-backed facts a chat message might ask about (GitHub
 * connection, last deploy, credit balance) as plain text for the build
 * prompt — see getProjectAgentContext in src/server/projects.ts for where
 * this data actually comes from. `null` (session/project vanished between
 * the job starting and this lookup) degrades to an explicit "unavailable"
 * line rather than silently omitting the block.
 */
function formatProjectContextBlock(
  context: Awaited<ReturnType<typeof getProjectAgentContext>>
): string {
  if (!context) {
    return "Project context: unavailable for this session.";
  }
  return `Project context (answers to meta-questions about this project/account — not build instructions):
- Project: ${context.projectName} (${context.projectSlug})
- GitHub: ${context.githubConnected ? "connected" : "not connected"}
- Last saved to GitHub: ${context.githubRepoUrl ?? "never saved"}
- Last deployed (Vercel): ${context.vercelDeploymentUrl ?? "never deployed"}
- Credit balance: ${context.creditBalance} credits`;
}

/** Per-job scratch directory used as the planning query's `cwd` — never the real project root. */
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

function describeResultError(message: SDKResultError, maxTurns: number): string {
  if (message.subtype === "error_max_turns") {
    return `Reached the maximum of ${maxTurns} agent iterations for this job.`;
  }
  if (message.subtype === "error_max_budget_usd") {
    return "Reached the maximum budget for this job.";
  }
  if (message.errors.length > 0) {
    return message.errors.join("; ");
  }
  return `Agent run failed (${message.subtype}).`;
}

// ---------------------------------------------------------------------------
// Planning phase (claude-opus-4-8): ask_user Q&A (first pass only, unless
// the caller says otherwise) -> plan text -> user approve/revise gate.
// ---------------------------------------------------------------------------

interface PlanQueryResult {
  planText: string;
  askUserCalled: boolean;
}

/** One planner query() call — either the initial scoping pass or a single revision pass. */
async function runPlanQuery(
  jobId: string,
  cwd: string,
  systemPrompt: string,
  userPrompt: string
): Promise<PlanQueryResult> {
  const emergentServer = createSdkMcpServer({
    name: "emergent",
    version: "1.0.0",
    tools: [buildAskUserTool(jobId)],
  });

  const q = query({
    prompt: userPrompt,
    options: {
      model: PLANNER_MODEL,
      cwd,
      env: getAgentEnv(),
      systemPrompt,
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
  const planTextParts: string[] = [];

  for await (const message of q) {
    if (await isStopped(jobId)) {
      q.close();
      return { planText: "", askUserCalled };
    }

    if (message.type === "assistant") {
      let blockIndex = 0;
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          planTextParts.push(block.text);
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
      await recordUsage(
        jobId,
        "plan_query",
        PLANNER_MODEL,
        message.usage.input_tokens,
        message.usage.output_tokens
      );

      if (message.subtype !== "success") {
        await appendEvent(jobId, "system", "error", {
          message: describeResultError(message, MAX_ITERATIONS),
        });
        await setJobStatus(jobId, "failed");
        if (sessionId) await setAgentSessionId(jobId, sessionId);
        return { planText: "", askUserCalled };
      }
    }
  }

  if (sessionId) await setAgentSessionId(jobId, sessionId);
  return { planText: planTextParts.join("\n\n"), askUserCalled };
}

/**
 * Polls for the `plan_decision` event matching a specific `plan` event's id
 * — same ~800ms poll shape as waitForAnswer, but called directly from the
 * harness loop (runPlanningPhase) rather than from inside a tool handler,
 * since writing a plan isn't itself a tool call the way ask_user is.
 */
async function waitForPlanDecision(
  jobId: string,
  planEventId: string
): Promise<{ action: "approve" | "revise"; feedback?: string } | null> {
  while (true) {
    if (await isStopped(jobId)) return null;

    const allEvents = await getAllEvents(jobId);
    const decisionEvent = allEvents.find(
      (e) =>
        e.type === "plan_decision" &&
        (e.payload as { planEventId?: string }).planEventId === planEventId
    );
    if (decisionEvent) {
      return decisionEvent.payload as { action: "approve" | "revise"; feedback?: string };
    }

    await sleep(ANSWER_POLL_INTERVAL_MS);
  }
}

/**
 * Runs the planner (possibly several revision rounds) until the user
 * approves a plan, and returns that plan's text — or null if the job was
 * stopped, failed, or hit the revision cap (all of which already recorded
 * their own error/status; the caller should just return).
 */
async function runPlanningPhase(
  jobId: string,
  cwd: string,
  initialSystemPrompt: string,
  initialUserPrompt: string,
  requireAskUserFirstPass: boolean
): Promise<string | null> {
  let systemPrompt = initialSystemPrompt;
  let userPrompt = initialUserPrompt;
  let revision = 0;
  let requireAskUser = requireAskUserFirstPass;

  while (true) {
    const result = await runPlanQuery(jobId, cwd, systemPrompt, userPrompt);
    if (await isStopped(jobId)) return null;
    if (!result.planText) return null; // failure already recorded by runPlanQuery

    if (requireAskUser && !result.askUserCalled) {
      await appendEvent(jobId, "system", "error", {
        message: "Agent did not call ask_user during the planning turn.",
      });
      await setJobStatus(jobId, "failed");
      return null;
    }
    requireAskUser = false; // only enforced on the very first planning pass

    const planEventId = randomUUID();
    await appendEvent(jobId, "assistant", "plan", {
      id: planEventId,
      text: result.planText,
      revision,
    });
    await setJobStatus(jobId, "waiting_on_plan");

    const decision = await waitForPlanDecision(jobId, planEventId);
    if (decision === null) return null; // stopped

    if (decision.action === "approve") {
      return result.planText;
    }

    revision += 1;
    if (revision > MAX_PLAN_REVISIONS) {
      await appendEvent(jobId, "system", "error", {
        message: `Reached the maximum of ${MAX_PLAN_REVISIONS} plan revisions for this job.`,
      });
      await setJobStatus(jobId, "failed");
      return null;
    }

    if (await isStopped(jobId)) return null;
    await setJobStatus(jobId, "running");

    systemPrompt = PLAN_REVISION_SYSTEM_PROMPT;
    userPrompt = `Original request: ${initialUserPrompt}

Previous plan:
${result.planText}

The user asked for these changes: ${decision.feedback?.trim() || "(no specific feedback given — use your best judgement about what to change)"}

Write a revised plan.`;
  }
}

/**
 * Second, short query() call for the closing (plan -> build transition)
 * summary — same tool-restricted, filesystem-isolated configuration as the
 * planning query, but with no tools at all (not even ask_user). Runs on the
 * planner model since it's narrating the plan, not writing code. Does not
 * set job status; the build phase that follows owns the terminal status.
 */
async function runSummaryQuery(jobId: string, cwd: string): Promise<void> {
  const q = query({
    prompt:
      "The plan has been approved. Write a brief (2-3 sentence) closing summary for the user of what you'll build next. Plain text only — no code, no tool calls.",
    options: {
      model: PLANNER_MODEL,
      cwd,
      env: getAgentEnv(),
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
      await recordUsage(
        jobId,
        "summary_query",
        PLANNER_MODEL,
        message.usage.input_tokens,
        message.usage.output_tokens
      );
      if (message.subtype !== "success") {
        throw new Error(describeResultError(message, 1));
      }
    }
  }

  if (await isStopped(jobId)) return;

  await appendEvent(jobId, "assistant", "assistant_message", {
    text: summaryText.trim() || "Plan approved — starting the build now.",
  });
}

// ---------------------------------------------------------------------------
// Build phase — real sandbox + real Bash/Read/Write/Edit/Glob/Grep
// ---------------------------------------------------------------------------

/**
 * The build query() call: real Bash/Read/Write/Edit/Glob/Grep tools, `cwd`'d
 * into the real sandbox directory (not the planning phase's throwaway
 * scratch dir). `ask_user` stays registered (not required) in case the
 * model genuinely needs to ask something planning didn't cover — see the
 * residual-risk note at the top of this file re: `cwd` not being a hard
 * filesystem jail.
 */
async function runBuildQuery(jobId: string, cwd: string, prompt: string): Promise<void> {
  const emergentServer = createSdkMcpServer({
    name: "emergent",
    version: "1.0.0",
    tools: [buildAskUserTool(jobId)],
  });

  const q = query({
    prompt,
    options: {
      model: BUILDER_MODEL,
      cwd,
      env: getAgentEnv(),
      systemPrompt: BUILD_SYSTEM_PROMPT,
      maxTurns: BUILD_MAX_ITERATIONS,
      tools: BUILD_TOOLS,
      mcpServers: { emergent: emergentServer },
      allowedTools: [...BUILD_TOOLS, "mcp__emergent__ask_user"],
      strictMcpConfig: true,
      settingSources: [],
      // Fully autonomous: there is no interactive TTY/canUseTool callback in
      // this server process to answer a permission prompt, and this phase
      // genuinely needs Bash/Write/Edit to run unattended against the
      // sandbox directory. Single-user local dev tool, not multi-tenant
      // production — see the residual-risk note at the top of this file.
      //
      // The SDK requires allowDangerouslySkipPermissions: true alongside
      // permissionMode: "bypassPermissions" (checked against
      // node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs — without it the
      // underlying CLI does not actually enter bypass mode). The real safety
      // boundary either way is the explicit `tools`/`allowedTools` allowlist
      // above, not this flag — it only controls whether individual calls to
      // those six already-allowed tools additionally need interactive
      // confirmation, which nothing here can answer.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

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
          if (block.name === "mcp__emergent__ask_user") {
            // tool_call/question events for ask_user are appended by the
            // tool handler itself (buildAskUserTool).
          } else {
            await appendEvent(jobId, "assistant", "tool_call", {
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
          blockIndex++;
        }
      }
      continue;
    }

    if (message.type === "result") {
      sessionId = message.session_id;
      await recordUsage(
        jobId,
        "build_query",
        BUILDER_MODEL,
        message.usage.input_tokens,
        message.usage.output_tokens
      );

      if (message.subtype !== "success") {
        throw new Error(describeResultError(message, BUILD_MAX_ITERATIONS));
      }
    }
  }

  if (sessionId) await setAgentSessionId(jobId, sessionId);
}

// ---------------------------------------------------------------------------
// Review + Debug tail (claude-sonnet-5, always — Opus is reserved for
// planning only) — runs after every successful build, whichever path got it
// there (fresh build, continuation with Plan mode, or a direct continuation
// edit).
// ---------------------------------------------------------------------------

interface ReviewResult {
  issuesFound: boolean;
  summary: string;
  findings: string[];
}

/**
 * Forces the review query to report structured findings instead of the
 * harness having to parse free text — same "custom SDK MCP tool the model
 * must call" pattern as buildAskUserTool, just reporting instead of asking.
 */
function buildReportReviewTool(resultRef: { value: ReviewResult | null }) {
  return tool(
    "report_review",
    "Report your code review findings. Call this exactly once, after inspecting the code, whether or not you found anything wrong.",
    {
      issuesFound: z
        .boolean()
        .describe("true if you found any real bugs, broken functionality, or issues worth fixing"),
      summary: z.string().min(1).describe("1-3 sentence summary of the review, for the user"),
      findings: z
        .array(z.string().min(1))
        .max(10)
        .default([])
        .describe("Specific issues found, each as its own concise item — empty if issuesFound is false"),
    },
    async (args) => {
      resultRef.value = {
        issuesFound: args.issuesFound,
        summary: args.summary,
        findings: args.findings,
      };
      return {
        content: [{ type: "text" as const, text: "Review recorded." }],
      };
    }
  );
}

async function runReviewPhase(jobId: string, cwd: string): Promise<ReviewResult> {
  const resultRef: { value: ReviewResult | null } = { value: null };
  const emergentServer = createSdkMcpServer({
    name: "emergent",
    version: "1.0.0",
    tools: [buildReportReviewTool(resultRef)],
  });

  const q = query({
    prompt:
      "Review the app that was just built or edited in this working directory. Report your findings via report_review.",
    options: {
      model: BUILDER_MODEL,
      cwd,
      env: getAgentEnv(),
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      maxTurns: REVIEW_MAX_ITERATIONS,
      tools: REVIEW_TOOLS,
      mcpServers: { emergent: emergentServer },
      allowedTools: [...REVIEW_TOOLS, "mcp__emergent__report_review"],
      strictMcpConfig: true,
      settingSources: [],
      // Same rationale as runBuildQuery — fully autonomous, no interactive
      // permission prompt available. Review is read-only by tool allowlist
      // (REVIEW_TOOLS has no Write/Edit), so this doesn't grant it any
      // write access.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

  let sessionId: string | undefined;

  for await (const message of q) {
    if (await isStopped(jobId)) {
      q.close();
      break;
    }

    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && block.name !== "mcp__emergent__report_review") {
          await appendEvent(jobId, "assistant", "tool_call", {
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
      continue;
    }

    if (message.type === "result") {
      sessionId = message.session_id;
      await recordUsage(
        jobId,
        "review_query",
        BUILDER_MODEL,
        message.usage.input_tokens,
        message.usage.output_tokens
      );
      if (message.subtype !== "success") {
        throw new Error(describeResultError(message, REVIEW_MAX_ITERATIONS));
      }
    }
  }

  if (sessionId) await setAgentSessionId(jobId, sessionId);

  // The model is instructed to always call report_review, but if it somehow
  // finished without doing so (e.g. hit the turn cap first), treat that as
  // "nothing conclusively found" rather than crashing the whole job over a
  // review pass — the build itself already succeeded.
  const result = resultRef.value ?? {
    issuesFound: false,
    summary: "Review completed without a structured report.",
    findings: [],
  };

  await appendEvent(jobId, "assistant", "review", { ...result });
  await appendEvent(jobId, "assistant", "assistant_message", { text: result.summary });

  return result;
}

async function runDebugPhase(jobId: string, cwd: string, review: ReviewResult): Promise<void> {
  const findingsList =
    review.findings.length > 0
      ? review.findings.map((finding, i) => `${i + 1}. ${finding}`).join("\n")
      : review.summary;

  const q = query({
    prompt: `Fix the following issues found in code review:\n\n${findingsList}`,
    options: {
      model: BUILDER_MODEL,
      cwd,
      env: getAgentEnv(),
      systemPrompt: DEBUG_SYSTEM_PROMPT,
      maxTurns: DEBUG_MAX_ITERATIONS,
      tools: BUILD_TOOLS,
      mcpServers: {},
      allowedTools: BUILD_TOOLS,
      strictMcpConfig: true,
      settingSources: [],
      // Same rationale as runBuildQuery.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

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
          await appendEvent(jobId, "assistant", "tool_call", {
            id: block.id,
            name: block.name,
            input: block.input,
          });
          blockIndex++;
        }
      }
      continue;
    }

    if (message.type === "result") {
      sessionId = message.session_id;
      await recordUsage(
        jobId,
        "debug_query",
        BUILDER_MODEL,
        message.usage.input_tokens,
        message.usage.output_tokens
      );
      if (message.subtype !== "success") {
        throw new Error(describeResultError(message, DEBUG_MAX_ITERATIONS));
      }
    }
  }

  if (sessionId) await setAgentSessionId(jobId, sessionId);
}

/**
 * Review, then debug-only-if-the-review-found-something, then re-snapshot
 * if the debug pass actually changed anything. Shared tail for every build
 * path (fresh build, continuation-with-plan, direct continuation edit).
 */
async function runReviewAndDebugTail(
  jobId: string,
  sessionId: string,
  cwd: string
): Promise<void> {
  const review = await runReviewPhase(jobId, cwd);
  if (await isStopped(jobId)) return;

  if (!review.issuesFound) return;

  await runDebugPhase(jobId, cwd, review);
  if (await isStopped(jobId)) return;

  const changed = await snapshotSessionFiles(sessionId, cwd);
  if (changed.length > 0) {
    await appendEvent(jobId, "system", "files_changed", { paths: changed });
  }
}

/**
 * Starts the session's sandbox (template seed + npm install + `npm run dev`,
 * see src/server/sandbox.ts), runs the real build query() against it, runs
 * the review(+debug) tail, then snapshots the sandbox directory into the
 * `files` table. Owns the job's terminal status (done/failed) from this
 * point on.
 */
async function runBuildPhase(
  jobId: string,
  sessionId: string,
  originalPrompt: string,
  planText: string
): Promise<void> {
  if (await isStopped(jobId)) return;

  const sandboxDir = seedSandboxTemplate(sessionId);

  let port: number;
  try {
    const result = await sandboxProvider.start(sessionId, {
      onStatus: (text) => {
        appendEvent(jobId, "system", "status", { text }).catch((err) => {
          console.error(`[agent] job ${jobId} failed to append status event`, err);
        });
      },
    });
    port = result.port;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendEvent(jobId, "system", "error", {
      message: `Failed to start the sandbox: ${message}`,
    });
    await setJobStatus(jobId, "failed");
    await sandboxProvider.stop(sessionId).catch(() => {});
    return;
  }

  if (await isStopped(jobId)) {
    await sandboxProvider.stop(sessionId).catch(() => {});
    return;
  }

  await appendEvent(jobId, "system", "preview_ready", {
    url: `http://localhost:${port}`,
  });

  const projectContext = await getProjectAgentContext(sessionId);

  const buildPrompt = `Build the app now in this working directory, based on the plan below and the original request.

${formatProjectContextBlock(projectContext)}

Original request: ${originalPrompt}

Plan:
${planText || "(no additional plan text was captured — use the original request directly)"}`;

  try {
    await runBuildQuery(jobId, sandboxDir, buildPrompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendEvent(jobId, "system", "error", { message: `Build failed: ${message}` });
    await setJobStatus(jobId, "failed");
    await sandboxProvider.stop(sessionId).catch(() => {});
    return;
  }

  if (await isStopped(jobId)) {
    await sandboxProvider.stop(sessionId).catch(() => {});
    return;
  }

  const changed = await snapshotSessionFiles(sessionId, sandboxDir);
  if (changed.length > 0) {
    await appendEvent(jobId, "system", "files_changed", { paths: changed });
  }

  if (await isStopped(jobId)) {
    await sandboxProvider.stop(sessionId).catch(() => {});
    return;
  }

  // The build itself already succeeded and is safely snapshotted above — a
  // review/debug failure (e.g. the review pass hitting its turn cap without
  // reaching a conclusion) is a lesser problem than that and must NOT undo a
  // good build. Log it and still finish normally (done, sandbox left
  // running) rather than failing the whole job and tearing down a working
  // live preview over a review pass that merely couldn't complete.
  try {
    await runReviewAndDebugTail(jobId, sessionId, sandboxDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendEvent(jobId, "system", "error", {
      message: `Review/debug pass didn't complete (${message}) — your build itself succeeded and is unaffected.`,
    });
  }

  if (await isStopped(jobId)) {
    await sandboxProvider.stop(sessionId).catch(() => {});
    return;
  }

  await appendEvent(jobId, "assistant", "assistant_message", {
    text: "Your app is built and running in the live preview. Keep chatting to iterate on it.",
  });

  // Deliberately NOT stopping the sandbox here — the preview iframe should
  // keep serving the running dev server after the job finishes.
  await setJobStatus(jobId, "done");
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

// Continuing an already-built session used to run through the exact same
// from-scratch scoping flow as a brand-new project — ask_user firing a
// generic "what are you building" style questionnaire with zero awareness
// that a real app, with real existing files, already sits in this session's
// sandbox. Bad UX: a request like "change some colors" got asked "is this
// an existing app or a new one?" Real coding-agent UX for a follow-up edit
// is to just make the change (using judgment for anything ambiguous) rather
// than block on a multiple-choice form — this plan text tells the build
// query to behave that way. Only used on the direct-edit path (Plan mode
// off); Plan mode on uses CONTINUATION_PLANNING_SYSTEM_PROMPT instead.
const CONTINUATION_PLAN_TEXT = `This is a continuation of an app that is already built and running in this working directory — it is NOT a fresh build, so do not scaffold from scratch or assume an empty project.

First inspect the existing files (list the directory, then read whatever's relevant to the request) to understand the current implementation and its conventions, then make the requested change directly.

Only stop to ask a clarifying question if the request is genuinely ambiguous in a way that risks doing the wrong thing. For a straightforward iterative request, make a reasonable choice consistent with the existing app and note what you chose in your closing summary — don't block on a multiple-choice questionnaire for a small change.`;

/** A brand-new project's first job: always plans (Opus), always requires ask_user on the first pass. */
async function runInitialBuildFlow(jobId: string, prompt: string): Promise<void> {
  const cwd = ensureJobScratchDir(jobId);
  const planText = await runPlanningPhase(jobId, cwd, SYSTEM_PROMPT, prompt, true);
  if (planText === null) return;
  if (await isStopped(jobId)) return;

  await runSummaryQuery(jobId, cwd);
  if (await isStopped(jobId)) return;

  const job = await getJob(jobId);
  if (!job) return;

  await runBuildPhase(jobId, job.sessionId, prompt, planText);
}

/**
 * A follow-up message on an already-built session. `planMode` (from that
 * job's `user_message` event payload — see runRealLoop) picks direct-edit
 * (today's default) vs the full Opus-plan -> approve -> Sonnet-build
 * pipeline. Either way, runBuildPhase's review(+debug) tail always runs.
 */
async function runContinuationFlow(
  jobId: string,
  sessionId: string,
  prompt: string,
  planMode: boolean
): Promise<void> {
  if (!planMode) {
    await appendEvent(jobId, "assistant", "assistant_message", {
      text: "Got it — let me take a look at the app and make that change.",
    });
    await runBuildPhase(jobId, sessionId, prompt, CONTINUATION_PLAN_TEXT);
    return;
  }

  const cwd = ensureJobScratchDir(jobId);
  const planText = await runPlanningPhase(
    jobId,
    cwd,
    CONTINUATION_PLANNING_SYSTEM_PROMPT,
    prompt,
    false
  );
  if (planText === null) return;
  if (await isStopped(jobId)) return;

  await runBuildPhase(jobId, sessionId, prompt, planText);
}

async function runRealLoop(jobId: string): Promise<void> {
  try {
    if (await isStopped(jobId)) return;

    const allEvents = await getAllEvents(jobId);

    // Guards the orphan case (dev server restarted mid-run, so the
    // in-process `runningJobs` guard in runAgentLoop is empty in the new
    // process too) — a job that already progressed into planning (an
    // ask_user tool_call, or a `plan` event once ask_user isn't required)
    // just no-ops here rather than restarting planning from zero. Resuming
    // the underlying CLI session / plan-decision wait across a process
    // restart is out of scope (same accepted limitation as ask_user's
    // waitForAnswer — see src/server/jobs.ts).
    const alreadyStartedPlanning = allEvents.some(
      (e) =>
        (e.type === "tool_call" && (e.payload as { name?: string }).name === "ask_user") ||
        e.type === "plan"
    );
    if (alreadyStartedPlanning) return;

    const userMessageEvent = allEvents.find((e) => e.type === "user_message");
    const userMessagePayload = userMessageEvent?.payload as
      | { text?: string; planMode?: boolean }
      | undefined;
    const prompt = userMessagePayload?.text;
    if (!prompt) {
      throw new Error("Job has no initial user message to build a prompt from.");
    }
    const planMode = userMessagePayload?.planMode === true;

    const job = await getJob(jobId);
    if (!job) return;

    // The real signal for "is this a continuation" is the session's own
    // state, not which route created the job — a brand-new project's first
    // job always has zero files at this point (nothing's been built yet),
    // and any later job in the same session only reaches here once a build
    // has actually produced files. No flag needs to be threaded through
    // createProjectAndJob/continueSessionWithPrompt for this to be correct.
    const existingFiles = await getSessionFiles(job.sessionId);
    if (existingFiles.length > 0) {
      await runContinuationFlow(jobId, job.sessionId, prompt, planMode);
      return;
    }

    await runInitialBuildFlow(jobId, prompt);
  } catch (err) {
    await handleAgentError(jobId, err);
  }
}
