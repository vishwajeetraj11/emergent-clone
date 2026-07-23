import { mkdirSync } from "node:fs";
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
import {
  SYSTEM_PROMPT,
  PLAN_REVISION_SYSTEM_PROMPT,
  CONTINUATION_PLANNING_SYSTEM_PROMPT,
  PLANNER_DB_NOTE,
  dbAware,
} from "@/server/agent-prompts";
import { isMockMode, runMockLoop } from "@/server/agent-mock";
import { askUserToolFor } from "@/server/agent-interaction";
import { ANSWER_POLL_INTERVAL_MS, isStopped, recordUsage, sleep } from "@/server/agent-core";
import { runBuildPhase } from "@/server/agent-phases";
import { getSessionFiles } from "@/server/files";
import { getJobApiKeys, clearJobApiKeys } from "@/server/user-keys";

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
// REAL RUNTIME: the "real" (non-mock) path runs on the Vercel AI SDK
// (src/server/llm.ts) with a metered provider key; the agent's file/shell
// tools execute inside the session's Vercel sandbox (src/server/agent-tools.ts).
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
 * stopped or failed (both of which already recorded their own error/status;
 * the caller should just return). Hitting the revision cap
 * (MAX_PLAN_REVISIONS) no longer fails the job: the last allowed plan is
 * flagged final and re-presented for an approve-or-stop decision.
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

    // Once the revision budget is spent this plan is the final one: past the
    // cap we no longer regenerate, we re-present the same plan for a last
    // approve-or-stop decision rather than failing the whole job.
    const isFinal = revision >= MAX_PLAN_REVISIONS;

    // Inner loop: present this plan and act on the user's decision. A
    // non-final plan breaks out to regenerate a revision; a final plan stays
    // here, re-showing the same text on any stray "revise" (the UI hides that
    // action on a final plan, so this only guards an out-of-band decision).
    while (true) {
      const planEventId = randomUUID();
      await appendEvent(jobId, "assistant", "plan", {
        id: planEventId,
        text: result.planText,
        revision,
        isFinal,
      });
      await setJobStatus(jobId, "waiting_on_plan");

      const decision = await waitForPlanDecision(jobId, planEventId);
      if (decision === null) return null; // stopped

      if (decision.action === "approve") {
        return result.planText;
      }

      if (isFinal) {
        await appendEvent(jobId, "system", "assistant_message", {
          text: `You've reached the maximum of ${MAX_PLAN_REVISIONS} plan revisions. This is the final plan — approve it to start building, or stop here.`,
        });
        if (await isStopped(jobId)) return null;
        continue; // re-present the same final plan; do not regenerate
      }

      revision += 1;
      if (await isStopped(jobId)) return null;
      await setJobStatus(jobId, "running");

      systemPrompt = PLAN_REVISION_SYSTEM_PROMPT;
      userPrompt = `Original request: ${initialUserPrompt}

Previous plan:
${result.planText}

The user asked for these changes: ${decision.feedback?.trim() || "(no specific feedback given — use your best judgement about what to change)"}

Write a revised plan.`;
      break; // regenerate at the outer loop
    }
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
