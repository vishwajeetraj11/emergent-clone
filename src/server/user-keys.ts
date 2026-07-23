// BYOK (bring-your-own-key): the process-local, in-memory store carrying a
// user's own API key from a job-start request into that job's agent loop. A
// user key overrides the platform env key when both exist (src/server/llm.ts).
//
// SECURITY CONTRACT: a value stored here must never reach the DB, an
// appendEvent payload, console.*, or any API response. It exists only so the
// AI SDK can pick it up while resolving a model, and never touches the sandbox
// VM. A server restart mid-job silently degrades that job back to platform keys
// rather than failing it (see jobs.ts's durability note).

export interface UserApiKeys {
  anthropic?: string;
  openai?: string;
}

const MIN_KEY_LENGTH = 10;
const MAX_KEY_LENGTH = 512;

/**
 * Validates the client-supplied `apiKeys` field of a job-start request body.
 * Returns undefined when nothing valid was found, so callers can write
 * `if (apiKeys) setJobApiKeys(...)`.
 *
 * NEVER throws and never echoes the submitted value: this parses untrusted
 * bodies, and degrading to "no BYOK keys for this job" is always the right
 * outcome rather than an error that might reflect the bad input back.
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
// which is exactly the lifetime this store needs to span.
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
