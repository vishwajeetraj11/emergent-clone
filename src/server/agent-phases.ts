// ---------------------------------------------------------------------------
// Build / review / debug phases — split out of agent.ts, no behavior change.
// agent.ts's entry points call into runBuildPhase, the only export below.
// ---------------------------------------------------------------------------

import type { Sandbox } from "@vercel/sandbox";
import { appendEvent, getSessionIntent } from "@/server/events";
import { setJobStatus } from "@/server/jobs";
import { runAgentQuery } from "@/server/llm";
import { buildFileTools, buildReportReviewTool, type ReviewResult } from "@/server/agent-tools";
import {
  BUILD_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  DEBUG_SYSTEM_PROMPT,
  BUILD_DB_NOTE,
  REVIEW_DB_NOTE,
  dbAware,
} from "@/server/agent-prompts";
import { askUserToolFor } from "@/server/agent-interaction";
import { isStopped, recordUsage } from "@/server/agent-core";
import { sandboxProvider } from "@/server/sandbox";
import { getLiveSandbox } from "@/server/sandbox-vercel";
import { cancelScheduledStop } from "@/server/preview-stop-scheduler";
import { snapshotSessionFiles } from "@/server/files";
import { getProjectAgentContext } from "@/server/projects";
import { getJobApiKeys } from "@/server/user-keys";

// Build phase gets a much larger iteration budget than planning — it's
// actually writing/editing files and running commands, not just asking a
// handful of questions or reading over what's already there.
const BUILD_MAX_ITERATIONS = 60;
const REVIEW_MAX_ITERATIONS = 20;
const DEBUG_MAX_ITERATIONS = 40;

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

// ---------------------------------------------------------------------------
// Build phase — real sandbox + real Bash/Read/Write/Edit/Glob/Grep
// ---------------------------------------------------------------------------

/**
 * The build agent call: real Bash/Read/Write/Edit/Glob/Grep tools, all
 * executing inside the session's sandbox VM (src/server/agent-tools.ts).
 * `ask_user` stays registered (not required) in case the model genuinely needs
 * to ask something planning didn't cover.
 */
async function runBuildQuery(
  jobId: string,
  sandbox: Sandbox,
  prompt: string,
  builderModel: string
): Promise<void> {
  const result = await runAgentQuery({
    modelId: builderModel,
    system: dbAware(BUILD_SYSTEM_PROMPT, BUILD_DB_NOTE),
    prompt,
    tools: { ...buildFileTools(sandbox), ask_user: askUserToolFor(jobId) },
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
  sandbox: Sandbox,
  builderModel: string,
  originalPrompt: string,
  planText: string
): Promise<ReviewResult> {
  const resultRef: { value: ReviewResult | null } = { value: null };
  // Read-only toolset by construction: no write/edit in the review belt.
  const { bash, read, glob, grep } = buildFileTools(sandbox);

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

Current request: ${originalPrompt}
${planText ? `\nApproved plan:\n${planText}` : ""}`,
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
  sandbox: Sandbox,
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

Current request: ${originalPrompt}

Fix the following issues found in code review:

${findingsList}`,
    tools: buildFileTools(sandbox),
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
 * Review, then debug-only-if-the-review-found-something, then re-snapshot
 * if the debug pass actually changed anything. Shared tail for every build
 * path (fresh build, continuation-with-plan, direct continuation edit). The
 * agent edits the VM directly, so the debug pass's changes are already live
 * in the preview — no sync step; snapshotSessionFiles just captures them to R2.
 */
async function runReviewAndDebugTail(
  jobId: string,
  sessionId: string,
  sandbox: Sandbox,
  builderModel: string,
  originalPrompt: string,
  planText: string
): Promise<void> {
  const review = await runReviewPhase(jobId, sandbox, builderModel, originalPrompt, planText);
  if (await isStopped(jobId)) return;

  if (!review.issuesFound) return;

  await runDebugPhase(jobId, sandbox, review, builderModel, originalPrompt);
  if (await isStopped(jobId)) return;

  const changed = await snapshotSessionFiles(sessionId, sandbox);
  if (changed.length > 0) {
    await appendEvent(jobId, "system", "files_changed", { paths: changed });
  }
}

/**
 * Starts the session's sandbox (template seed + npm install + `npm run dev`,
 * see src/server/sandbox-vercel.ts), runs the real build against it, runs
 * the review(+debug) tail, then snapshots the sandbox directory into the
 * `files` table. Owns the job's terminal status (done/failed) from this
 * point on.
 */
export async function runBuildPhase(
  jobId: string,
  sessionId: string,
  originalPrompt: string,
  planText: string,
  builderModel: string
): Promise<void> {
  if (await isStopped(jobId)) return;

  // The agent builds INSIDE the Vercel sandbox (see agent-tools.ts), so there
  // is no local dir to seed and no local .env.local to write — the provider's
  // onCreate seeds the VM (template + R2 files) and injects .env.local there.

  // A brand-new build is exactly as strong a "this session is alive" signal
  // as a restore or a health poll — cancel any stop-preview timer an old
  // tab's pagehide beacon queued (see preview-stop-scheduler.ts) so it can't
  // land mid-build and kill the very sandbox this call is about to start.
  cancelScheduledStop(sessionId);

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

  // The live VM handle the agent's tools + snapshot run against. start()
  // returned "running", so it should be present; a null here means the
  // provider isn't the Vercel sandbox (the AI-SDK build runtime requires it).
  const sandbox = getLiveSandbox(sessionId);
  if (!sandbox) {
    await appendEvent(jobId, "system", "error", {
      message:
        "No live sandbox after start — the build runtime requires SANDBOX_PROVIDER=vercel.",
    });
    await setJobStatus(jobId, "failed");
    await sandboxProvider.stop(sessionId).catch(() => {});
    return;
  }

  const projectContext = await getProjectAgentContext(sessionId);

  // A continuation job starts with a fresh model context, so the only things
  // that survive from earlier turns are the files on disk and this block. The
  // files record WHAT was built; they cannot record why — a constraint stated
  // once in chat, or an approach considered and rejected. Without that, the
  // agent can cheerfully re-introduce exactly what the user ruled out.
  const intent = await getSessionIntent(sessionId);
  const priorIntent =
    intent.originalRequest && intent.originalRequest !== originalPrompt
      ? `\nThis session's original request (earlier turn, for context — the current request above takes precedence):\n${intent.originalRequest}\n${
          intent.latestPlan ? `\nMost recently approved plan:\n${intent.latestPlan}\n` : ""
        }`
      : "";

  const buildPrompt = `Build the app now in this working directory, based on the plan below and the current request.

${formatProjectContextBlock(projectContext)}

Current request: ${originalPrompt}
${priorIntent}
Plan:
${planText || "(no additional plan text was captured — use the current request directly)"}`;

  try {
    await runBuildQuery(jobId, sandbox, buildPrompt, builderModel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendEvent(jobId, "system", "error", { message: `Build failed: ${message}` });
    // Persist whatever the build managed to write BEFORE giving up. A build
    // that throws (hitting the iteration cap, or any error) otherwise leaves
    // the `files` table empty, so /restore finds no snapshot and "Restart
    // preview" 404s — the partial app is stranded. Snapshotting here keeps it
    // restorable and continuable via chat. Best-effort: a snapshot failure
    // must not mask the original build error. Runs before stop() so the VM is
    // still alive when we read it.
    const changed = await snapshotSessionFiles(sessionId, sandbox).catch((e) => {
      console.error(`[agent] job ${jobId} failed to snapshot after build failure`, e);
      return [] as string[];
    });
    if (changed.length > 0) {
      await appendEvent(jobId, "system", "files_changed", { paths: changed });
    }
    await setJobStatus(jobId, "failed");
    await sandboxProvider.stop(sessionId).catch(() => {});
    return;
  }

  if (await isStopped(jobId)) {
    await sandboxProvider.stop(sessionId).catch(() => {});
    return;
  }

  const changed = await snapshotSessionFiles(sessionId, sandbox);
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
    await runReviewAndDebugTail(jobId, sessionId, sandbox, builderModel, originalPrompt, planText);
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
