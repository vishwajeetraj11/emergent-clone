// ---------------------------------------------------------------------------
// Env gate, API credentials, and lifecycle constants for the Vercel sandbox
// provider — split out of sandbox-vercel.ts, no behavior change.
// ---------------------------------------------------------------------------

export function isVercelSandboxConfigured(): boolean {
  return Boolean(
    process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
  );
}

// LIFECYCLE: a sandbox is stopped eagerly rather than left to bill until it
// times out — /api/sessions/[id]/stop-preview fires on navigate-away/
// tab-close (see useAgentSession's pagehide wiring), and agent.ts's
// runBuildPhase failure paths call stop() too. v2's stop() snapshots the
// filesystem (persistent: true); the next getOrCreate resumes that snapshot
// in seconds — a VM boot and re-running the dev server, NOT a from-scratch
// npm install (node_modules is already on disk). `timeout`
// (SANDBOX_TIMEOUT_MS, still 45 minutes) is a per-SESSION window, not a
// cumulative one: every resume starts a fresh clock. Snapshot storage is
// bounded so an abandoned project doesn't bill forever: keepLastSnapshots
// {count: 1} plus SNAPSHOT_EXPIRATION_MS (7 days) — past that window
// getOrCreate's name lookup finds the snapshot already gone and creates
// fresh instead of resuming, and this provider's own file seeding (the
// `files` table snapshot) rebuilds it from there, same shape as a stale v1
// sandbox rebuilding from scratch.

/**
 * The sandbox's `timeout` bounds each session's lifetime — see the module
 * doc comment above on why that's a per-session window now (every
 * getOrCreate resume starts a fresh clock) rather than a one-shot,
 * disappears-forever TTL. Still 45 minutes, the Hobby-plan maximum, and NOT
 * lower on purpose: the first real run with a 15-minute timeout had the
 * sandbox expire *mid-build* (the build agent's own local npm-install/build
 * sanity check can easily take 10+ minutes on a slow network), so the
 * end-of-build syncFiles push landed on a dead VM and the preview 410'd
 * until the next restore. An idle sandbox bills almost zero Active CPU —
 * the cost of the longer window is just provisioned-memory GB-hours, well
 * inside the free allotment.
 */
export const SANDBOX_TIMEOUT_MS = 45 * 60_000;

/**
 * Bounds how long a stopped sandbox's filesystem snapshot is retained,
 * paired with `keepLastSnapshots: { count: 1 }` on every getOrCreate call
 * (see bootSandbox) to cap billed snapshot storage — see this file's module
 * doc comment's LIFECYCLE paragraph. A session untouched for longer than
 * this doesn't resume at all: getOrCreate's name lookup finds the snapshot
 * already expired, deletes it, and creates fresh instead — this provider's
 * own file seeding (the `files` table snapshot) rebuilds it from there,
 * same shape as any other fresh create.
 */
export const SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60_000;

/** The one port the generated app's dev server listens on, both at `Sandbox.getOrCreate({ ports })` time and every later `sandbox.domain(3000)` call. */
export const APP_PORT = 3000;

interface VercelCredentials {
  token: string;
  projectId: string;
  teamId: string;
}

/**
 * Reads the three auth env vars this provider needs. Throws rather than
 * returning `undefined`-shaped fields — this should be unreachable in
 * practice, since src/server/sandbox.ts's factory only ever constructs a
 * VercelSandboxProvider once isVercelSandboxConfigured() has already
 * confirmed all three are set, but a throw here is a much louder failure
 * mode than silently sending "undefined" to the Vercel API if that
 * invariant is ever violated (e.g. a future call site constructing this
 * class directly).
 */
export function resolveCredentials(): VercelCredentials {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) {
    throw new Error(
      "VercelSandboxProvider used without VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID " +
        "all configured — this should be unreachable (see isVercelSandboxConfigured)."
    );
  }
  return { token, teamId, projectId };
}
