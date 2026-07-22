// ---------------------------------------------------------------------------
// Shared leaf primitives for the agent pipeline — split out of agent.ts, no
// behavior change. This module must never import from agent.ts, agent-phases,
// agent-mock, or agent-interaction: it exists to break that import cycle.
// ---------------------------------------------------------------------------

import { appendEvent } from "@/server/events";
import { getJob } from "@/server/jobs";
import { debitForJobUsage } from "@/server/credits";
import { getJobApiKeys } from "@/server/user-keys";
import { getModelInfo } from "@/lib/models";

// Exported: shared with agent-interaction.ts's waitForAnswer, which polls
// this same events table on the same cadence as waitForPlanDecision below.
export const ANSWER_POLL_INTERVAL_MS = 800;

/** Exported: agent-mock.ts and agent-interaction.ts both poll on this same trivial timer. */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exported: agent-mock.ts's runMockLoop and agent-interaction.ts's waitForAnswer both need the same "has this job been stopped/finished" check this file's own phase functions poll throughout. */
export async function isStopped(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  return !job || job.status === "stopped" || job.status === "done" || job.status === "failed";
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
export async function recordUsage(
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
