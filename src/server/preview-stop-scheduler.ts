import { sandboxProvider } from "@/server/sandbox";

// ---------------------------------------------------------------------------
// Deferred preview-sandbox stop.
//
// THE PROBLEM: /api/sessions/[id]/stop-preview fires on the client's
// `pagehide` event (see useAgentSession's pagehide effect), which cannot
// distinguish a tab actually closing from a plain page refresh — both fire
// the exact same event at the exact same moment. Stopping the sandbox
// immediately therefore punishes a refresh exactly as hard as a real
// tab-close: the very next thing that happens on a refresh is the page
// reloading and calling /api/sessions/[id]/restore, which cold-resumes the
// VM it just told to stop. Measured cost of that round trip: ~9.5s to stop
// plus ~20.3s to resume, ~20-30s of dead time for nothing.
//
// THE FIX (this module): stop-preview no longer stops anything itself — it
// schedules a stop DEFAULT_STOP_DELAY_MS in the future and returns
// immediately. Anything that's real evidence the session is still being
// watched (a restore, a health poll, or a fresh build about to start its own
// sandbox) cancels the pending timer instead of racing it. A genuine
// tab-close never produces any of that evidence, so its timer just fires
// and the sandbox stops — a few minutes later than before, but still well
// inside SANDBOX_TIMEOUT_MS (45 min, src/server/sandbox-vercel-config.ts),
// so nothing bills any longer than it used to.
//
// STATE: in-process, in-memory only — same accepted tradeoff as the sandbox
// registry (src/server/sandbox.ts) and the job state (src/server/jobs.ts).
// If the main server process restarts while a stop is pending, the timer is
// lost with it: the sandbox is simply never told to stop early, and it idles
// along until SANDBOX_TIMEOUT_MS takes over. That's the pre-existing
// backstop this whole feature sits on top of, not a new failure mode this
// module introduces.
// ---------------------------------------------------------------------------

/** How long a stop-preview request is deferred before it actually runs. */
export const DEFAULT_STOP_DELAY_MS = 180_000;

const pendingStops = new Map<string, NodeJS.Timeout>();

/**
 * Defers sessionId's sandbox stop by `delayMs`. Replaces any timer already
 * pending for this session (e.g. a second pagehide beacon, or a refresh
 * that itself pagehides again before the first timer fires) rather than
 * stacking them — only ever one stop per session should be in flight.
 */
export function scheduleStopPreview(sessionId: string, delayMs = DEFAULT_STOP_DELAY_MS): void {
  cancelScheduledStop(sessionId);
  const timer = setTimeout(() => {
    pendingStops.delete(sessionId);
    // A timer callback must never throw — Node has nowhere useful to send
    // an uncaught exception from inside a setTimeout, so any failure here
    // is logged, not propagated. Worst case the sandbox idles until its own
    // SANDBOX_TIMEOUT_MS backstop, same as the restart-loses-the-timer case
    // documented above.
    sandboxProvider.stop(sessionId).catch((err) => {
      console.error(`[preview-stop-scheduler] deferred stop failed for session ${sessionId}`, err);
    });
  }, delayMs);
  pendingStops.set(sessionId, timer);
}

/**
 * Cancels sessionId's pending deferred stop, if any — the signal that the
 * session is still (or newly) being watched. Safe to call unconditionally,
 * including when nothing is actually pending.
 */
export function cancelScheduledStop(sessionId: string): void {
  const timer = pendingStops.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingStops.delete(sessionId);
}
