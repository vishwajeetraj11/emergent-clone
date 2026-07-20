// ---------------------------------------------------------------------------
// BYOK (bring-your-own-key): a user can paste their own Anthropic/OpenAI API
// key so their builds bill their key instead of the platform's. This module
// is the process-local, in-memory store that carries a key from a job-start
// request into that job's agent loop — see src/server/jobs.ts /
// src/server/sessions.ts (setJobApiKeys, right before runAgentLoop fires),
// src/server/agent.ts (getJobApiKeys per phase, clearJobApiKeys in
// runAgentLoop's finally), and src/server/llm.ts (resolveModel/resolvePlannerModel/
// resolveBuilderModel, which treat a user key as an override — it takes
// precedence over the platform's env key when both exist).
//
// SECURITY CONTRACT: a value stored here must never reach the DB, an
// `appendEvent` payload, `console.*`, or any API response — this store exists
// ONLY so the AI SDK runtime can pick it up while resolving a model for that
// job's own query() calls. It never touches the sandbox VM (no writeFiles,
// no env changes there — the sandbox is out of scope for this feature
// entirely). The map is plain process memory keyed by jobId, nothing more:
// a server restart mid-job silently degrades that job back to platform keys
// (same accepted limitation as the rest of this in-process runtime — see
// src/server/jobs.ts's Phase 1 limitation note) rather than failing it.
// ---------------------------------------------------------------------------

export interface UserApiKeys {
  anthropic?: string;
  openai?: string;
}

const MIN_KEY_LENGTH = 10;
const MAX_KEY_LENGTH = 512;

/**
 * Validates the client-supplied `apiKeys` field of a job-start request body.
 * Anything that isn't a plain object is rejected outright; each of
 * `anthropic`/`openai` is kept only if it's a string that trims to 10-512
 * characters, everything else (wrong type, too short/long, unknown extra
 * fields) is dropped silently. Returns `undefined` when nothing valid was
 * found, so callers can write `if (apiKeys) setJobApiKeys(...)`.
 *
 * NEVER throws, regardless of input shape, and never includes the submitted
 * value in any return value or side effect — this parses untrusted request
 * bodies, and a malformed body degrading to "no BYOK keys for this job" is
 * always the right outcome, not an error that might echo the bad input back.
 */
export function parseUserApiKeys(raw: unknown): UserApiKeys | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const keys: UserApiKeys = {};

  for (const provider of ["anthropic", "openai"] as const) {
    const value = record[provider];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < MIN_KEY_LENGTH || trimmed.length > MAX_KEY_LENGTH) continue;
    keys[provider] = trimmed;
  }

  return keys.anthropic || keys.openai ? keys : undefined;
}

// Keyed by jobId, not sessionId/userId: a job is the unit of "one agent run",
// and the whole point of this store is to ride alongside exactly one such
// run from its start request to its runAgentLoop finally.
const jobApiKeys = new Map<string, UserApiKeys>();

export function setJobApiKeys(jobId: string, keys: UserApiKeys): void {
  jobApiKeys.set(jobId, keys);
}

export function getJobApiKeys(jobId: string): UserApiKeys | undefined {
  return jobApiKeys.get(jobId);
}

export function clearJobApiKeys(jobId: string): void {
  jobApiKeys.delete(jobId);
}
