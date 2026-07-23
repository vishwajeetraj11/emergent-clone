import { sandboxProvider } from "@/server/sandbox";

// Deferred preview-sandbox stop.
//
// /api/sessions/[id]/stop-preview fires on the client's `pagehide`, which
// cannot distinguish a tab closing from a plain refresh — identical event,
// identical moment. Stopping immediately punished a refresh as hard as a real
// close: the page would reload and call /restore, cold-resuming the VM it had
// just stopped. Measured ~9.5s to stop plus ~20.3s to resume, for nothing.
//
// So stop-preview schedules a stop instead of performing one, and anything that
// is real evidence the session is still watched (a restore, a health poll, a
// build starting its own sandbox) cancels the timer. A genuine tab-close
// produces no such evidence, so its timer fires. Nothing bills longer than
// before either way — SANDBOX_TIMEOUT_MS (45 min) is still the backstop.
//
// State is in-process only, same tradeoff as the sandbox registry and job
// state. A server restart loses pending timers; the sandbox then idles until
// SANDBOX_TIMEOUT_MS, which is the backstop this sits on top of anyway.

/** How long a stop-preview request is deferred before it actually runs. */
export const DEFAULT_STOP_DELAY_MS = 180_000;

const pendingStops = new Map<string, NodeJS.Timeout>();

/**
 * Defers sessionId's sandbox stop by `delayMs`, replacing any timer already
 * pending for it rather than stacking — only one stop per session in flight.
 */
export function scheduleStopPreview(sessionId: string, delayMs = DEFAULT_STOP_DELAY_MS): void {
  cancelScheduledStop(sessionId);
  const timer = setTimeout(() => {
    pendingStops.delete(sessionId);
    // Never throw out of a timer callback — Node has nowhere to send it.
    sandboxProvider.stop(sessionId).catch((err) => {
      console.error(`[preview-stop-scheduler] deferred stop failed for session ${sessionId}`, err);
    });
  }, delayMs);
  pendingStops.set(sessionId, timer);
}

/**
 * Cancels sessionId's pending stop — the signal that the session is still (or
 * newly) being watched. Safe to call when nothing is pending.
 */
export function cancelScheduledStop(sessionId: string): void {
  const timer = pendingStops.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingStops.delete(sessionId);
}
