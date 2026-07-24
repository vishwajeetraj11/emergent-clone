/**
 * Environment-aware user-facing copy. Some strings name this platform's own
 * internal machinery (sandbox, snapshot, VM, …) — useful while developing
 * Emergent itself, but implementation detail a real end user of a deployed
 * instance has no business seeing. Rather than inlining a NODE_ENV check at
 * every call site, define the dev/prod pair once here and export the
 * resolved constant.
 *
 * `process.env.NODE_ENV` (unlike arbitrary env vars) is safe to read from
 * client components too — Next.js inlines it as a build-time literal into
 * both server and client bundles rather than reading a live env var at
 * request time, so this file needs no "use client"/"use server" split.
 */
function devProdMessage(devMessage: string, prodMessage: string): string {
  return process.env.NODE_ENV === "production" ? prodMessage : devMessage;
}

/**
 * Shown while attemptRestorePreview (src/lib/hooks/useAgentSession.ts) is
 * bringing a session's sandbox back up from its `files` snapshot. The dev
 * string names the actual mechanism for people developing Emergent itself;
 * the prod string is what an end user of a deployed instance sees instead.
 */
export const RESTORING_PREVIEW_MESSAGE = devProdMessage(
  "Restoring the sandbox from its last saved snapshot…",
  "Starting application…"
);

/**
 * Shown by PreviewPanel's dead-preview card once useAgentSession's health
 * poll confirms the sandbox is down — whether from hitting its timeout or
 * from the eager /api/sessions/[id]/stop-preview call on navigate-away. The
 * dev strings name the actual mechanism for people developing Emergent
 * itself; the prod strings are what an end user of a deployed instance sees
 * instead.
 */
export const PAUSED_PREVIEW_TITLE = "Preview paused";
export const PAUSED_PREVIEW_BODY = devProdMessage(
  "The sandbox was shut down. Your code is saved — restarting rebuilds it in about a minute.",
  "The sandbox was put to sleep. Your code is saved — resuming brings it back in a few seconds."
);
export const PAUSED_PREVIEW_BUTTON = devProdMessage("Restart preview", "Resume preview");
