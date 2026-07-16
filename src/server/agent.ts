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
import { snapshotSessionFiles } from "@/server/files";
import { debitForJobUsage } from "@/server/credits";
import type { AnswerItem, Question } from "@/lib/types";

// ---------------------------------------------------------------------------
// Phase 1 (scoping) + Phase 2 (build) agent loop.
//
// First turn: the model is instructed (and given exactly one tool) to call
// `ask_user` with 3-5 clarifying questions. Once the user answers, the model
// writes a short build plan as text; the harness (not the model) then emits
// a few whimsical status lines and a closing summary. Phase 2 extends this:
// instead of stopping there, the harness starts a real local sandbox
// (src/server/sandbox.ts) for the job's session and runs a second query()
// call with real Bash/Read/Write/Edit/Glob/Grep tools, `cwd`'d into that
// sandbox directory, to actually build the app. See runBuildPhase below.
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
// The same `ask_user` tool stays registered (but not required) during the
// Phase 2 build query, in case the model genuinely needs to ask something
// the scoping answers didn't cover.
//
// KNOWN RESIDUAL RISK (Phase 2, accepted — not solved here): the build
// query's `cwd` scopes where its Bash tool *starts*, not a hard filesystem
// jail. The model could `cd` or use an absolute path to touch things outside
// the sandbox directory. This is a single-user local dev tool, not a
// multi-tenant production sandbox, so a real jail (container/chroot) is out
// of scope for this phase.
//
// MOCK MODE: if MOCK_AGENT=1, we run a scripted trajectory with identical
// event shapes so the whole system is verifiable without any model calls at
// all. The mock loop stops at "scoping done" (Phase 1 behavior) — it does
// not simulate a build phase.
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-5";
const MAX_ITERATIONS = 15;
const ANSWER_POLL_INTERVAL_MS = 800;

// Build phase gets a much larger iteration budget than scoping — it's
// actually writing/editing files and running commands, not just asking a
// handful of questions.
const BUILD_MAX_ITERATIONS = 60;

// Explicit allowlist (checked against node_modules/@anthropic-ai/claude-agent-sdk
// sdk.d.ts's `Options.tools` — `string[] | { type: 'preset'; preset: 'claude_code' }`)
// rather than the `claude_code` preset, so the build phase gets exactly the
// file/shell tools it needs and nothing else (no WebFetch/WebSearch/Task/...).
const BUILD_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];

const BUILD_SYSTEM_PROMPT = `You are the build agent inside an Emergent-style AI app builder. You already scoped this app with the user in an earlier turn — you have their answers and you already wrote a build plan. You do not need to ask them anything else; build directly.

Your working directory already contains a minimal Next.js (App Router) + Tailwind starter template — package.json, app/layout.tsx, app/page.tsx, tailwind/postcss config. A real \`npm run dev\` dev server for this directory is already running and being live-previewed, so:
- Edit the existing files and add new ones to build the actual app described in the plan and the user's answers.
- Keep \`npm run dev\` working — don't leave the app in a state that fails to compile. Feel free to use Bash to sanity-check (e.g. \`npm run build\`) if you're unsure.
- If you need an additional npm package, install it yourself via Bash (\`npm install <package>\`).
- Keep changes scoped to what was actually asked for — don't build unrelated features.
- Do not run any command or read/write any file outside this working directory.

Never reference the identity, email address, or account details of whoever is authenticated on the underlying CLI session.`;

const SYSTEM_PROMPT = `You are the build agent inside an Emergent-style AI app builder. A user just described an app they want built in a chat box.

Your job in this phase is ONLY to scope the work — you do not write or run any code yet (that capability arrives in a later phase). You have exactly one tool available, named ask_user; you have no filesystem, shell, or web access.

Never reference the identity, email address, or account details of whoever is authenticated on the underlying CLI session — you are building an app for an end user you know nothing about, not for the operator of this environment. Do not suggest "use my email X" or similar as an answer option.

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

// ---------------------------------------------------------------------------
// Phase 4 (Half A, REAL): production credential swap point.
//
// Returns `undefined` when ANTHROPIC_API_KEY is not set in the server's own
// process environment — the SDK's `query()` then omits `options.env`
// entirely, so the subprocess inherits this process's shell environment and
// falls through to the local `claude` CLI's own login (Claude Code
// subscription auth). This is the default, always-tested path in this
// environment and MUST behave identically to Phase 1-3: no ANTHROPIC_API_KEY
// is set here, so every call site below passes `env: getAgentEnv()` ===
// `env: undefined`, which is exactly what those call sites did before this
// function existed (they simply didn't set `env` at all).
//
// Returns `{ ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }`
// only once a real, centrally-held key is configured for a production
// deploy — see PLAN.md's Phase 4 section. No other code changes are needed
// to swap credential sources: this is the one function a production
// deployment's ops config needs to make true.
// ---------------------------------------------------------------------------
function getAgentEnv(): Record<string, string | undefined> | undefined {
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  return { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
}

/**
 * Appends a `usage` event (unchanged shape from Phase 1) and, right after,
 * debits the job owner's credit ledger for that usage — see
 * src/server/credits.ts for the cost model. Centralizes the three call
 * sites below so scoping/summary/build queries can't drift out of sync with
 * each other.
 */
async function recordUsage(
  jobId: string,
  step: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  await appendEvent(jobId, "system", "usage", {
    model: MODEL,
    inputTokens,
    outputTokens,
    step,
  });
  await debitForJobUsage(jobId, step, inputTokens, outputTokens);
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
      env: getAgentEnv(),
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
  // Accumulates the plan text the model writes after the user answers, so
  // the Phase 2 build query below has a concrete plan to work from instead
  // of just the raw prompt.
  const planTextParts: string[] = [];

  for await (const message of q) {
    if (await isStopped(jobId)) {
      q.close();
      return;
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
        "scoping_query",
        message.usage.input_tokens,
        message.usage.output_tokens
      );

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

  // Whimsical status effects are scripted by the harness (not the model).
  for (const line of WHIMSICAL_STATUS_LINES) {
    if (await isStopped(jobId)) return;
    await appendEvent(jobId, "assistant", "status", { text: line });
    await sleep(700);
  }

  if (await isStopped(jobId)) return;

  await runSummaryQuery(jobId, cwd);
  if (await isStopped(jobId)) return;

  const job = await getJob(jobId);
  if (!job) return;

  await runBuildPhase(jobId, job.sessionId, prompt, planTextParts.join("\n\n"));
}

/**
 * Second, short query() call for the closing (scoping -> build transition)
 * summary — same tool-restricted, filesystem-isolated configuration as the
 * scoping query, but with no tools at all (not even ask_user). Does not set
 * job status; the build phase that follows owns the terminal status.
 */
async function runSummaryQuery(jobId: string, cwd: string): Promise<void> {
  const q = query({
    prompt:
      "The scoping phase is complete. Write a brief (2-3 sentence) closing summary for the user of what you'll build next. Plain text only — no code, no tool calls.",
    options: {
      model: MODEL,
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
        message.usage.input_tokens,
        message.usage.output_tokens
      );
      if (message.subtype !== "success") {
        throw new Error(describeResultError(message));
      }
    }
  }

  if (await isStopped(jobId)) return;

  await appendEvent(jobId, "assistant", "assistant_message", {
    text: summaryText.trim() || "Scoping complete — starting the build now.",
  });
}

// ---------------------------------------------------------------------------
// Phase 2: build phase — real sandbox + real Bash/Read/Write/Edit/Glob/Grep
// ---------------------------------------------------------------------------

/**
 * Starts the session's sandbox (template seed + npm install + `npm run dev`,
 * see src/server/sandbox.ts), runs the real build query() against it, then
 * snapshots the sandbox directory into the `files` table. Owns the job's
 * terminal status (done/failed) from this point on.
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

  const buildPrompt = `Build the app now in this working directory, based on the plan below and the original request.

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

  await appendEvent(jobId, "assistant", "assistant_message", {
    text: "Your app is built and running in the live preview. Keep chatting to iterate on it.",
  });

  // Deliberately NOT stopping the sandbox here — the preview iframe should
  // keep serving the running dev server after the job finishes.
  await setJobStatus(jobId, "done");
}

/**
 * The build query() call: real Bash/Read/Write/Edit/Glob/Grep tools, `cwd`'d
 * into the real sandbox directory (not the Phase 1 throwaway scratch dir).
 * `ask_user` stays registered (not required) in case the model genuinely
 * needs to ask something scoping didn't cover — see the residual-risk note
 * at the top of this file re: `cwd` not being a hard filesystem jail.
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
      model: MODEL,
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
        message.usage.input_tokens,
        message.usage.output_tokens
      );

      if (message.subtype !== "success") {
        throw new Error(describeResultError(message));
      }
    }
  }

  if (sessionId) await setAgentSessionId(jobId, sessionId);
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
