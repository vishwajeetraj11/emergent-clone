// ---------------------------------------------------------------------------
// Build / review / debug phases — split out of agent.ts, no behavior change.
// agent.ts's entry points call into runBuildPhase, the only export below.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendEvent } from "@/server/events";
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
import { sandboxProvider, seedSandboxTemplate, type SnapshotFile } from "@/server/sandbox";
import { cancelScheduledStop } from "@/server/preview-stop-scheduler";
import { snapshotSessionFiles } from "@/server/files";
import { getProjectAgentContext } from "@/server/projects";
import { writeSandboxEnvFile } from "@/server/project-db";
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
export async function runBuildPhase(
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
