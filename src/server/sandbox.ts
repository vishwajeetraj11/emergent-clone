import path from "node:path";
// Circular import, and safe: sandbox-vercel.ts imports TEMPLATE_DIR and the
// types below back from here. The types erase at compile time, and TEMPLATE_DIR
// is only ever read inside a method body, never at that module's top level.
import { VercelSandboxProvider } from "./sandbox-vercel";

// Builds run remotely inside a Vercel Sandbox (Firecracker microVM): the
// agent's tools and snapshot execute in the VM (src/server/agent-tools.ts,
// src/server/files.ts), which also serves the preview. There is no local build
// runtime on this branch — that version lives on `local-claude-cli`.

export interface SandboxStartResult {
  /**
   * Full URL for the preview iframe. The interface deals in URLs, not ports:
   * the VM's internal port isn't reachable from a browser on another machine.
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
   * A pause, not a deletion: stop() snapshots the filesystem and the next
   * start()/restoreFromSnapshot() resumes it in seconds rather than
   * reinstalling. Called from runBuildPhase's failure paths and eagerly from
   * /api/sessions/[id]/stop-preview on navigate-away/tab-close.
   */
  stop(sessionId: string): Promise<void>;
  /** PERMANENT teardown for project deletion — unlike stop(), not resumable. */
  destroy?(sessionId: string): Promise<void>;
  getStatus(sessionId: string): SandboxStatus;
  /**
   * Brings a session's sandbox back up, seeding the VM from the passed `files`
   * snapshot. Returns the existing URL if one is already running. This is what
   * makes an orphaned/expired sandbox recoverable without an agent rebuild.
   */
  restoreFromSnapshot(
    sessionId: string,
    files: SnapshotFile[],
    options?: SandboxStartOptions
  ): Promise<SandboxStartResult>;
  /**
   * Unused by the build phase (the agent edits the VM directly, so its changes
   * are already live). Retained for future callers.
   */
  syncFiles?(sessionId: string, files: SnapshotFile[]): Promise<void>;
  /**
   * Returns false ONLY when the runtime is known-dead. Healthy, booting, and
   * indeterminate all return true — callers swap the preview for a "Preview
   * stopped" card on false, so a false positive is worse than a false negative.
   */
  checkPreviewHealth?(sessionId: string): Promise<boolean>;
}

// process.cwd() is the repo root under `next dev`/`next start`. Exported so
// readTemplateFilesRecursive() can seed a fresh remote sandbox over the wire.
export const TEMPLATE_DIR = path.join(process.cwd(), "src", "server", "sandbox-template");

// Safe to construct unconditionally: VercelSandboxProvider resolves credentials
// per-call, so a missing VERCEL_* set surfaces on first start, not at import.
export const sandboxProvider: SandboxProvider = new VercelSandboxProvider();
