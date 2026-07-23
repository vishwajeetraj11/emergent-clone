// Env gate, API credentials, and lifecycle constants for the Vercel sandbox
// provider — split out of sandbox-vercel.ts.
//
// LIFECYCLE: a sandbox is stopped eagerly rather than left billing until it
// times out. stop() snapshots the filesystem, and the next getOrCreate resumes
// that snapshot in seconds — a VM boot plus dev server, not a from-scratch npm
// install. Snapshot storage is bounded (keepLastSnapshots {count: 1} +
// SNAPSHOT_EXPIRATION_MS) so an abandoned project can't bill forever; past that
// window getOrCreate finds the snapshot gone and creates fresh, and this
// provider's own file seeding rebuilds from the `files` snapshot.

export function isVercelSandboxConfigured(): boolean {
  return Boolean(
    process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
  );
}

/**
 * Bounds each session's lifetime, but per-session rather than one-shot: every
 * getOrCreate resume starts a fresh clock.
 *
 * 45 minutes is the Hobby-plan maximum and deliberately not lower. At 15
 * minutes the sandbox expired *mid-build* on the first real run — the build
 * agent's own npm-install/build check can take 10+ minutes on a slow network —
 * leaving the preview dead until the next restore. An idle sandbox bills almost
 * no Active CPU, so the longer window costs only provisioned-memory GB-hours.
 */
export const SANDBOX_TIMEOUT_MS = 45 * 60_000;

/** How long a stopped sandbox's filesystem snapshot is retained. */
export const SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60_000;

/** The one port the generated app's dev server listens on. */
export const APP_PORT = 3000;

interface VercelCredentials {
  token: string;
  projectId: string;
  teamId: string;
}

/**
 * Throws rather than returning undefined-shaped fields. Unreachable in practice
 * — sandbox.ts's factory checks isVercelSandboxConfigured() first — but a throw
 * is a much louder failure than sending "undefined" to the Vercel API if a
 * future call site constructs this class directly.
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
