import path from "node:path";
// NOTE: this creates a (safe) circular import — sandbox-vercel.ts imports
// TEMPLATE_DIR and the types below back from this file. Safe because: (1) the
// type imports it uses are erased at compile time, and (2) the one value
// import it uses (TEMPLATE_DIR) is only ever read from inside a method body,
// never at that module's own top level, so it's never touched before this
// module has finished initializing it.
import { VercelSandboxProvider } from "./sandbox-vercel";

// ---------------------------------------------------------------------------
// Sandbox provider interface + the Vercel sandbox factory.
//
// Builds run remotely inside a Vercel Sandbox (Firecracker microVM): the
// agent's tools + snapshot execute in the VM (src/server/agent-tools.ts,
// src/server/files.ts), which also serves the preview. There is no local
// build runtime on this branch — the free local `claude` CLI + local-dir
// version lives on the `local-claude-cli` branch.
// ---------------------------------------------------------------------------

export interface SandboxStartResult {
  /**
   * Full URL the preview iframe should point at — VercelSandboxProvider's own
   * public HTTPS domain (its VM's internal port isn't reachable from a browser
   * on a different machine, so the interface deals in URLs, not ports).
   * Threaded to the client via runBuildPhase's preview_ready event + the
   * restore route.
   */
  url: string;
}

export interface SandboxStatus {
  state: "starting" | "running" | "stopped" | "error";
  port?: number;
  message?: string;
}

export interface SandboxStartOptions {
  /** Called with human-readable progress text ("Installing dependencies…"). */
  onStatus?: (text: string) => void;
}

export interface SnapshotFile {
  path: string;
  content: string;
}

export interface SandboxProvider {
  /** Idempotent: calling twice for a session already running just returns its URL. */
  start(sessionId: string, options?: SandboxStartOptions): Promise<SandboxStartResult>;
  /**
   * Tears down sessionId's sandbox. Under VercelSandboxProvider (v2) this is a
   * pause, not a deletion: stop() snapshots the filesystem, and the next
   * start()/restoreFromSnapshot() (via Sandbox.getOrCreate) resumes it in
   * seconds rather than reinstalling from scratch. Called from runBuildPhase's
   * failure paths and eagerly from /api/sessions/[id]/stop-preview on
   * navigate-away/tab-close.
   */
  stop(sessionId: string): Promise<void>;
  /**
   * PERMANENT teardown for project deletion — distinct from stop()'s resumable
   * pause. VercelSandboxProvider implements this as Sandbox.delete() (the VM
   * becomes inert). Optional-chained at call sites.
   */
  destroy?(sessionId: string): Promise<void>;
  getStatus(sessionId: string): SandboxStatus;
  /**
   * Persistence/fork primitive: brings a session's sandbox back up, seeding the
   * VM from the passed `files` snapshot (the durable R2-backed index — see
   * getSessionFiles). If the session already has a live sandbox running,
   * returns its existing URL. This is what makes an orphaned/expired sandbox
   * recoverable without an agent rebuild.
   */
  restoreFromSnapshot(
    sessionId: string,
    files: SnapshotFile[],
    options?: SandboxStartOptions
  ): Promise<SandboxStartResult>;
  /**
   * Optional: pushes already-changed files into a *live* sandbox without a full
   * restart. Retained on the interface for future callers; the build phase no
   * longer needs it (the agent edits the VM directly, so its changes are
   * already live).
   */
  syncFiles?(sessionId: string, files: SnapshotFile[]): Promise<void>;
  /**
   * Optional: reports whether sessionId's sandbox runtime is still alive.
   * Returns false ONLY when it's known-dead (e.g. a Vercel VM hit its max
   * timeout mid-session). Every other case — healthy, booting, or
   * indeterminate — returns true (callers use false to swap the preview iframe
   * for a "Preview stopped" restart card, so a false positive is worse than a
   * false negative).
   */
  checkPreviewHealth?(sessionId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// The checked-in app template lives at src/server/sandbox-template relative to
// the repo root (process.cwd() is the repo root for `next dev`/`next start`).
// Exported so sandbox-vercel-template.ts's readTemplateFilesRecursive() can
// read the files and seed a fresh remote sandbox's filesystem over the wire.
// ---------------------------------------------------------------------------
export const TEMPLATE_DIR = path.join(process.cwd(), "src", "server", "sandbox-template");

// Builds are remote-only: always the Vercel sandbox. VercelSandboxProvider
// resolves credentials lazily (per-call, not at construction), so this is safe
// to build unconditionally — a missing/partial VERCEL_* credential set surfaces
// as a clear error the first time a sandbox is actually started, not at import.
export const sandboxProvider: SandboxProvider = new VercelSandboxProvider();
