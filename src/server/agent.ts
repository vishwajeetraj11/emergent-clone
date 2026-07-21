import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendEvent, getAllEvents } from "@/server/events";
import { getJob, setJobStatus } from "@/server/jobs";
import {
  runAgentQuery,
  resolvePlannerModel,
  resolveBuilderModel,
} from "@/server/llm";
import { buildFileTools, buildReportReviewTool, type ReviewResult } from "@/server/agent-tools";
import {
  BUILD_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  PLAN_REVISION_SYSTEM_PROMPT,
  CONTINUATION_PLANNING_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  DEBUG_SYSTEM_PROMPT,
  PLANNER_DB_NOTE,
  BUILD_DB_NOTE,
  REVIEW_DB_NOTE,
  dbAware,
} from "@/server/agent-prompts";
import { isMockMode, runMockLoop } from "@/server/agent-mock";
import { askUserToolFor } from "@/server/agent-interaction";
import { sandboxProvider, seedSandboxTemplate, type SnapshotFile } from "@/server/sandbox";
import { getSessionFiles, snapshotSessionFiles } from "@/server/files";
import { debitForJobUsage } from "@/server/credits";
import { getProjectAgentContext } from "@/server/projects";
import { writeSandboxEnvFile } from "@/server/project-db";
import { getJobApiKeys, clearJobApiKeys } from "@/server/user-keys";
import { getModelInfo } from "@/lib/models";

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

// Model selection lives in src/server/llm.ts now: the planner is
// resolvePlannerModel() (Opus when Anthropic is configured, else the
// flagship OpenAI model — never user-selected), and the builder model comes
// from the job's user_message payload via resolveBuilderModel() (the user's
// per-message picker choice; runs that job's build + review + debug).

const MAX_ITERATIONS = 15;
const MAX_PLAN_REVISIONS = 5;
// Exported: shared with agent-interaction.ts's waitForAnswer, which polls
// this same events table on the same cadence as waitForPlanDecision below.
export const ANSWER_POLL_INTERVAL_MS = 800;

// Build phase gets a much larger iteration budget than planning — it's
// actually writing/editing files and running commands, not just asking a
// handful of questions or reading over what's already there.
const BUILD_MAX_ITERATIONS = 60;
const REVIEW_MAX_ITERATIONS = 20;
const DEBUG_MAX_ITERATIONS = 40;

/** Exported: agent-mock.ts and agent-interaction.ts both poll on this same trivial timer. */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Appends a `usage` event and, right after, debits the job owner's credit
 * ledger for that usage — see src/server/credits.ts for the cost model.
 * Centralizes every call site so they can't drift out of sync with each
 * other. Takes the actual model used for this call (planner vs builder use
 * different, differently-priced models) rather than assuming one flat rate.
 * `cachedInputTokens` (a subset of inputTokens served from prompt cache) is
 * billed at the model's much cheaper cache-read rate.
 *
 * BYOK (see src/server/user-keys.ts): when THIS call's model provider was
 * satisfied by the job's own user-supplied key rather than the platform's,
 * the usage event is tagged `billing: "byok"` (a marker string only — never
 * key material) and debitForJobUsage is skipped entirely — the user already
 * paid via their own key, so platform credits must not double-charge. The
 * provider is derived from THIS call's model id, not the job's overall
 * builder model: the planner and builder can be keyed differently (e.g. an
 * Anthropic-only platform with a user-supplied OpenAI key still runs the
 * planner on the platform's Claude key while the builder runs on the user's
 * GPT key), so billing is decided per call, not per job.
 */
async function recordUsage(
  jobId: string,
  step: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): Promise<void> {
  const provider = getModelInfo(model)?.provider;
  const isByok = provider ? Boolean(getJobApiKeys(jobId)?.[provider]) : false;

  await appendEvent(jobId, "system", "usage", {
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    step,
    ...(isByok ? { billing: "byok" } : {}),
  });

  if (isByok) return;
  await debitForJobUsage(jobId, step, model, inputTokens, outputTokens, cachedInputTokens);
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
    // BYOK: wipe this job's stored user key(s), if any, the moment its run
    // ends — success, failure, or stop — so nothing outlives the job that
    // needed it (see src/server/user-keys.ts). A no-op when this job never
    // had any keys stashed (setJobApiKeys was never called for it).
    clearJobApiKeys(jobId);
  }
}

/** Exported: agent-mock.ts's runMockLoop and agent-interaction.ts's waitForAnswer both need the same "has this job been stopped/finished" check this file's own phase functions poll throughout. */
export async function isStopped(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  return !job || job.status === "stopped" || job.status === "done" || job.status === "failed";
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
// Real trajectory (Claude Agent SDK, local `claude` CLI auth)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Planning phase (claude-opus-4-8): ask_user Q&A (first pass only, unless
// the caller says otherwise) -> plan text -> user approve/revise gate.
// ---------------------------------------------------------------------------

interface PlanQueryResult {
  planText: string;
  askUserCalled: boolean;
}

/** One planner run — either the initial scoping pass or a single revision pass. The ask_user tool is the ONLY tool available. */
async function runPlanQuery(
  jobId: string,
  _cwd: string,
  systemPrompt: string,
  userPrompt: string
): Promise<PlanQueryResult> {
  const apiKeys = getJobApiKeys(jobId);
  const plannerModel = resolvePlannerModel(apiKeys);
  let askUserCalled = false;
  const planTextParts: string[] = [];

  try {
    const result = await runAgentQuery({
      modelId: plannerModel,
      system: dbAware(systemPrompt, PLANNER_DB_NOTE),
      prompt: userPrompt,
      tools: { ask_user: askUserToolFor(jobId) },
      maxSteps: MAX_ITERATIONS,
      apiKeys,
      onText: async (text, stepId) => {
        planTextParts.push(text);
        await appendEvent(jobId, "assistant", "assistant_message", { text, stepId });
      },
      onToolCall: async (call) => {
        // ask_user's tool_call/question events are appended by its own
        // execute handler (agent-tools.ts) — only note that it was called.
        if (call.name === "ask_user") askUserCalled = true;
      },
      shouldAbort: () => isStopped(jobId),
    });

    await recordUsage(
      jobId,
      "plan_query",
      plannerModel,
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.cachedInputTokens
    );
    if (result.aborted) return { planText: "", askUserCalled };
  } catch (err) {
    await appendEvent(jobId, "system", "error", {
      message: `Planning failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    await setJobStatus(jobId, "failed");
    return { planText: "", askUserCalled };
  }

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
async function runSummaryQuery(jobId: string): Promise<void> {
  const apiKeys = getJobApiKeys(jobId);
  const plannerModel = resolvePlannerModel(apiKeys);
  const result = await runAgentQuery({
    modelId: plannerModel,
    system: SYSTEM_PROMPT,
    prompt:
      "The plan has been approved. Write a brief (2-3 sentence) closing summary for the user of what you'll build next. Plain text only — no code, no tool calls.",
    maxSteps: 1,
    apiKeys,
    shouldAbort: () => isStopped(jobId),
  });

  await recordUsage(
    jobId,
    "summary_query",
    plannerModel,
    result.usage.inputTokens,
    result.usage.outputTokens,
    result.usage.cachedInputTokens
  );

  if (result.aborted || (await isStopped(jobId))) return;

  await appendEvent(jobId, "assistant", "assistant_message", {
    text: result.text.trim() || "Plan approved — starting the build now.",
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
async function runBuildQuery(
  jobId: string,
  cwd: string,
  prompt: string,
  builderModel: string
): Promise<void> {
  const result = await runAgentQuery({
    modelId: builderModel,
    system: dbAware(BUILD_SYSTEM_PROMPT, BUILD_DB_NOTE),
    prompt,
    cwd,
    tools: { ...buildFileTools(cwd), ask_user: askUserToolFor(jobId) },
    maxSteps: BUILD_MAX_ITERATIONS,
    apiKeys: getJobApiKeys(jobId),
    onText: async (text, stepId) => {
      await appendEvent(jobId, "assistant", "assistant_message", { text, stepId });
    },
    onToolCall: async (call) => {
      // ask_user appends its own tool_call/question events (agent-tools.ts).
      if (call.name === "ask_user") return;
      await appendEvent(jobId, "assistant", "tool_call", {
        id: call.id,
        name: call.name,
        input: call.input,
      });
    },
    shouldAbort: () => isStopped(jobId),
  });

  await recordUsage(
    jobId,
    "build_query",
    builderModel,
    result.usage.inputTokens,
    result.usage.outputTokens,
    result.usage.cachedInputTokens
  );
}

// ---------------------------------------------------------------------------
// Review + Debug tail (claude-sonnet-5, always — Opus is reserved for
// planning only) — runs after every successful build, whichever path got it
// there (fresh build, continuation with Plan mode, or a direct continuation
// edit).
// ---------------------------------------------------------------------------

async function runReviewPhase(
  jobId: string,
  cwd: string,
  builderModel: string,
  originalPrompt: string,
  planText: string
): Promise<ReviewResult> {
  const resultRef: { value: ReviewResult | null } = { value: null };
  // Read-only toolset by construction: no write/edit in the review belt.
  const { bash, read, glob, grep } = buildFileTools(cwd);

  // The reviewer runs in a FRESH context — it never saw the planning or
  // build conversations. Without the request + plan below it could only
  // judge generic code quality (and would flag deliberate plan decisions as
  // defects, the classic lossy-handoff failure); with them, "doesn't do
  // what was asked" becomes a reportable finding and plan choices read as
  // intentional.
  const result = await runAgentQuery({
    modelId: builderModel,
    system: dbAware(REVIEW_SYSTEM_PROMPT, REVIEW_DB_NOTE),
    prompt: `Review the app that was just built or edited in this working directory. Report your findings via report_review.

The app exists to satisfy the request below — review it against that intent, not just generic code quality. A mismatch with the request is itself a reportable finding; a choice the plan makes deliberately is not.

Original request: ${originalPrompt}
${planText ? `\nApproved plan:\n${planText}` : ""}`,
    cwd,
    tools: { bash, read, glob, grep, report_review: buildReportReviewTool(resultRef) },
    maxSteps: REVIEW_MAX_ITERATIONS,
    apiKeys: getJobApiKeys(jobId),
    // The loop ends the moment the verdict lands — no burning further steps.
    stopOnToolCall: "report_review",
    onToolCall: async (call) => {
      if (call.name === "report_review") return;
      await appendEvent(jobId, "assistant", "tool_call", {
        id: call.id,
        name: call.name,
        input: call.input,
      });
    },
    shouldAbort: () => isStopped(jobId),
  });

  await recordUsage(
    jobId,
    "review_query",
    builderModel,
    result.usage.inputTokens,
    result.usage.outputTokens,
    result.usage.cachedInputTokens
  );

  // The model is instructed to always call report_review, but if it somehow
  // finished without doing so (e.g. hit the step cap first), treat that as
  // "nothing conclusively found" rather than crashing the whole job over a
  // review pass — the build itself already succeeded.
  const review = resultRef.value ?? {
    issuesFound: false,
    summary: "Review completed without a structured report.",
    findings: [],
  };

  await appendEvent(jobId, "assistant", "review", { ...review });
  await appendEvent(jobId, "assistant", "assistant_message", { text: review.summary });

  return review;
}

async function runDebugPhase(
  jobId: string,
  cwd: string,
  review: ReviewResult,
  builderModel: string,
  originalPrompt: string
): Promise<void> {
  const findingsList =
    review.findings.length > 0
      ? review.findings.map((finding, i) => `${i + 1}. ${finding}`).join("\n")
      : review.summary;

  // Same fresh-context problem as runReviewPhase above: a debugger that
  // only sees finding strings will happily "fix" its way past the user's
  // intent. The original request anchors every fix to what the app is for.
  const result = await runAgentQuery({
    modelId: builderModel,
    system: dbAware(DEBUG_SYSTEM_PROMPT, BUILD_DB_NOTE),
    prompt: `The app in this working directory was built for this request — keep every fix consistent with it:

Original request: ${originalPrompt}

Fix the following issues found in code review:

${findingsList}`,
    cwd,
    tools: buildFileTools(cwd),
    maxSteps: DEBUG_MAX_ITERATIONS,
    apiKeys: getJobApiKeys(jobId),
    onText: async (text, stepId) => {
      await appendEvent(jobId, "assistant", "assistant_message", { text, stepId });
    },
    onToolCall: async (call) => {
      await appendEvent(jobId, "assistant", "tool_call", {
        id: call.id,
        name: call.name,
        input: call.input,
      });
    },
    shouldAbort: () => isStopped(jobId),
  });

  await recordUsage(
    jobId,
    "debug_query",
    builderModel,
    result.usage.inputTokens,
    result.usage.outputTokens,
    result.usage.cachedInputTokens
  );
}

/**
 * Pushes freshly-changed files (as reported by snapshotSessionFiles's return
 * value) into a *live* remote sandbox, right after each build/debug pass —
 * see SandboxProvider.syncFiles's doc comment in src/server/sandbox.ts for
 * why the local provider needs none of this at all (its dev server already
 * watches the same directory the agent just edited; there's nothing to
 * push). Optional-chained because syncFiles only exists on a remote
 * provider, and wrapped in try/catch because a live preview staying in sync
 * mid-session is a nice-to-have, never something allowed to fail the build
 * job itself — worst case, the session's next restore rebuilds the sandbox
 * from this same `files` table snapshot anyway (see restore/route.ts).
 *
 * Reads each changed file back off `dir` rather than threading file
 * contents through from the caller — snapshotSessionFiles already filtered
 * out binaries/oversized files when it wrote the DB snapshot, so re-reading
 * here (utf8, same as that snapshot) never risks pulling in something the
 * sync path can't handle either.
 */
async function syncChangedFilesToSandbox(
  jobId: string,
  sessionId: string,
  dir: string,
  changedPaths: string[]
): Promise<void> {
  if (changedPaths.length === 0 || !sandboxProvider.syncFiles) return;

  try {
    const files: SnapshotFile[] = await Promise.all(
      changedPaths.map(async (relPath) => ({
        path: relPath,
        content: await readFile(join(dir, relPath), "utf8"),
      }))
    );
    // Optional-chained here too (not just in the early-return guard above):
    // TS's property-narrowing from that guard isn't guaranteed to survive
    // across the `await` above, and `?.()` is a correct, zero-cost call
    // either way — same call-site convention documented on
    // SandboxProvider.syncFiles itself (src/server/sandbox.ts).
    await sandboxProvider.syncFiles?.(sessionId, files);
  } catch (err) {
    console.error(`[agent] job ${jobId} failed to sync changed files to the sandbox`, err);
  }
}

/**
 * Review, then debug-only-if-the-review-found-something, then re-snapshot
 * if the debug pass actually changed anything. Shared tail for every build
 * path (fresh build, continuation-with-plan, direct continuation edit).
 */
async function runReviewAndDebugTail(
  jobId: string,
  sessionId: string,
  cwd: string,
  builderModel: string,
  originalPrompt: string,
  planText: string
): Promise<void> {
  const review = await runReviewPhase(jobId, cwd, builderModel, originalPrompt, planText);
  if (await isStopped(jobId)) return;

  if (!review.issuesFound) return;

  await runDebugPhase(jobId, cwd, review, builderModel, originalPrompt);
  if (await isStopped(jobId)) return;

  const changed = await snapshotSessionFiles(sessionId, cwd);
  if (changed.length > 0) {
    await appendEvent(jobId, "system", "files_changed", { paths: changed });
  }
  await syncChangedFilesToSandbox(jobId, sessionId, cwd, changed);
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
  planText: string,
  builderModel: string
): Promise<void> {
  if (await isStopped(jobId)) return;

  const sandboxDir = seedSandboxTemplate(sessionId);

  // The build/debug agents work in this LOCAL directory regardless of which
  // preview provider is active, so its .env.local (the app's own
  // DATABASE_URL — see project-db.ts) has to be written here explicitly:
  // under the local provider doStart also writes it (harmless duplicate),
  // but under the Vercel provider only the remote VM would otherwise get
  // one, and the agent's own `next dev`-free checks (and the BUILD_DB_NOTE
  // prompt's ".env.local should already be there" claim) would find nothing.
  // Internally best-effort/no-op when Neon isn't configured.
  await writeSandboxEnvFile(sessionId, sandboxDir);

  let previewUrl: string;
  try {
    const result = await sandboxProvider.start(sessionId, {
      onStatus: (text) => {
        appendEvent(jobId, "system", "status", { text }).catch((err) => {
          console.error(`[agent] job ${jobId} failed to append status event`, err);
        });
      },
    });
    previewUrl = result.url;
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
    url: previewUrl,
  });

  const projectContext = await getProjectAgentContext(sessionId);

  const buildPrompt = `Build the app now in this working directory, based on the plan below and the original request.

${formatProjectContextBlock(projectContext)}

Original request: ${originalPrompt}

Plan:
${planText || "(no additional plan text was captured — use the original request directly)"}`;

  try {
    await runBuildQuery(jobId, sandboxDir, buildPrompt, builderModel);
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
  await syncChangedFilesToSandbox(jobId, sessionId, sandboxDir, changed);

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
    await runReviewAndDebugTail(jobId, sessionId, sandboxDir, builderModel, originalPrompt, planText);
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

/** A brand-new project's first job: always plans (planner model), always requires ask_user on the first pass. */
async function runInitialBuildFlow(
  jobId: string,
  prompt: string,
  builderModel: string
): Promise<void> {
  const cwd = ensureJobScratchDir(jobId);
  const planText = await runPlanningPhase(jobId, cwd, SYSTEM_PROMPT, prompt, true);
  if (planText === null) return;
  if (await isStopped(jobId)) return;

  await runSummaryQuery(jobId);
  if (await isStopped(jobId)) return;

  const job = await getJob(jobId);
  if (!job) return;

  await runBuildPhase(jobId, job.sessionId, prompt, planText, builderModel);
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
  planMode: boolean,
  builderModel: string
): Promise<void> {
  if (!planMode) {
    await appendEvent(jobId, "assistant", "assistant_message", {
      text: "Got it — let me take a look at the app and make that change.",
    });
    await runBuildPhase(jobId, sessionId, prompt, CONTINUATION_PLAN_TEXT, builderModel);
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

  await runBuildPhase(jobId, sessionId, prompt, planText, builderModel);
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
      | { text?: string; planMode?: boolean; model?: string }
      | undefined;
    const prompt = userMessagePayload?.text;
    if (!prompt) {
      throw new Error("Job has no initial user message to build a prompt from.");
    }
    const planMode = userMessagePayload?.planMode === true;
    // The composer's per-message model choice — validated against the
    // catalog + configured/BYOK-keyed providers; anything invalid/unavailable
    // silently becomes the default builder (see resolveBuilderModel in
    // llm.ts). getJobApiKeys(jobId) is this job's stashed BYOK key(s), if
    // any (see src/server/user-keys.ts / src/server/jobs.ts /
    // src/server/sessions.ts for where they're set before this loop starts).
    const builderModel = resolveBuilderModel(userMessagePayload?.model, getJobApiKeys(jobId));

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
      await runContinuationFlow(jobId, job.sessionId, prompt, planMode, builderModel);
      return;
    }

    await runInitialBuildFlow(jobId, prompt, builderModel);
  } catch (err) {
    await handleAgentError(jobId, err);
  }
}
