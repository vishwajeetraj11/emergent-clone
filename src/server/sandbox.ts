import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
// NOTE: this creates a (safe) circular import — sandbox-vercel.ts imports
// TEMPLATE_DIR and the types above back from this file. Safe because: (1)
// the type imports it uses are erased at compile time, and (2) the one
// value import it uses (TEMPLATE_DIR) is only ever read from inside a
// method body, never at that module's own top level, so it's never touched
// before this module has finished initializing it. See sandbox-vercel.ts's
// own imports for the other half of this.
import { isVercelSandboxConfigured, VercelSandboxProvider } from "./sandbox-vercel";

// ---------------------------------------------------------------------------
// Phase 2 sandbox: SandboxProvider interface + LocalProcessSandboxProvider.
//
// Neither Vercel Sandbox (no VERCEL_TOKEN) nor a Docker daemon were available
// when this phase was built (see PLAN.md's "Code execution / preview" row),
// so the only implementation is a real local child process: `npm install`
// then `npm run dev -- -p <port>` against a real per-session directory on
// this machine. The interface is kept generic enough that a future
// VercelSandboxProvider could implement it without touching call sites in
// src/server/agent.ts.
// ---------------------------------------------------------------------------

export interface SandboxStartResult {
  /**
   * Full URL the preview iframe should point at. The local provider mints
   * `http://localhost:<port>` itself (see LocalProcessSandboxProvider
   * below); a remote provider (VercelSandboxProvider, src/server/
   * sandbox-vercel.ts) returns its own public HTTPS domain instead — its
   * VM's internal port isn't reachable (or meaningful) from a browser on a
   * different machine, so the interface deals in URLs, not ports. The two
   * places this gets threaded out to the client: agent.ts's runBuildPhase
   * (preview_ready event) and the restore route.
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
  stop(sessionId: string): Promise<void>;
  getStatus(sessionId: string): SandboxStatus;
  /**
   * Phase 3 persistence/fork primitive: writes a `files`-table snapshot back
   * onto disk for `sessionId` (creating its sandbox directory if needed —
   * "possibly new", e.g. a session that never had a live process in this
   * server instance, or a freshly forked session), then starts it exactly
   * like `start()`. If the session already has a live sandbox running,
   * returns its existing URL without touching anything on disk. This is
   * what turns the Phase 1/2 "orphaned sandbox" limitation into something
   * recoverable: the `files` table (already durable in Postgres) is enough
   * to bring a dev server back up in a brand new process, no agent rebuild
   * required.
   */
  restoreFromSnapshot(
    sessionId: string,
    files: SnapshotFile[],
    options?: SandboxStartOptions
  ): Promise<SandboxStartResult>;
  /**
   * Optional: pushes already-changed files into a *live* sandbox without a
   * full restart. The local provider omits this entirely — its dev server's
   * cwd IS the same directory the build/debug agent's Bash/Write/Edit tools
   * edit directly (see seedSandboxTemplate/getSandboxDir below), so Next's
   * own file watcher already picks up every change for free, nothing to
   * "sync". A remote provider (VercelSandboxProvider) has no such shared
   * filesystem — its copy of the files only ever moves via an explicit
   * write call — so it implements this to push each build/debug pass's
   * changed files (see src/server/agent.ts's runBuildPhase /
   * runReviewAndDebugTail, right after each snapshotSessionFiles call) into
   * the running VM, where its own `npm run dev` hot-reloads them same as
   * local. Every call site optional-chains this (`sandboxProvider.syncFiles?.(...)`)
   * for exactly this reason — it may simply not exist.
   */
  syncFiles?(sessionId: string, files: SnapshotFile[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Session directory + template seeding
// ---------------------------------------------------------------------------

/**
 * Real, persistent-for-the-session-lifetime directory on this machine — NOT
 * inside this repo's own source tree. If it lived under the repo, the main
 * app's own `next dev`/Turbopack watcher would start picking up the
 * generated app's files (and its node_modules) as if they belonged to this
 * project. Defaults to ~/.emergent-sandboxes/<sessionId>, overridable via
 * SANDBOX_DATA_DIR for anyone who wants sandboxes to live elsewhere.
 */
const SANDBOX_ROOT =
  process.env.SANDBOX_DATA_DIR || path.join(os.homedir(), ".emergent-sandboxes");

/**
 * The checked-in template lives at src/server/sandbox-template relative to
 * the repo root. This assumes process.cwd() is the repo root, which is true
 * for `next dev`/`next start` (and for `next build`, which never calls this
 * function). Good enough for the dev-mode single-user tool this phase ships.
 *
 * Exported so src/server/sandbox-vercel.ts can seed a *remote* sandbox's
 * filesystem from the same template (it has no shared disk with this
 * process, so it can't reuse seedSandboxTemplate's cpSync — it reads these
 * files' contents and pushes them over the wire instead).
 */
export const TEMPLATE_DIR = path.join(process.cwd(), "src", "server", "sandbox-template");

export function getSandboxDir(sessionId: string): string {
  return path.join(SANDBOX_ROOT, sessionId);
}

/**
 * Writes a `files`-table snapshot onto disk under `dir`, creating parent
 * directories as needed. Used by both session restore (persistence) and
 * fork (copying the parent session's files onto the new session's own
 * sandbox path) — see SandboxProvider.restoreFromSnapshot and
 * src/server/sessions.ts's forkSession.
 *
 * `path.join(dir, relPath)` alone would let a malicious/malformed relative
 * path (e.g. containing `..`) escape `dir`; every resolved path is checked
 * to still be inside `dir` before writing, same defense-in-depth spirit as
 * the build query's cwd note in src/server/agent.ts.
 */
export function writeSnapshotFiles(dir: string, files: SnapshotFile[]): void {
  mkdirSync(dir, { recursive: true });
  const root = path.resolve(dir);
  for (const file of files) {
    const fullPath = path.resolve(root, file.path);
    if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
      continue; // would escape the sandbox directory — skip
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, "utf8");
  }
}

/**
 * Copies the pre-built minimal Next.js + Tailwind template into the
 * session's sandbox directory, once. This is a real `fs.cpSync` copy (not a
 * symlink) so the agent's subsequent edits never touch the checked-in
 * template. Safe to call repeatedly for the same session — if the directory
 * already has a package.json (i.e. already seeded, possibly already edited
 * by the agent), it's left alone.
 */
export function seedSandboxTemplate(sessionId: string): string {
  const dir = getSandboxDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, "package.json");
  if (!existsSync(marker)) {
    cpSync(TEMPLATE_DIR, dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

const PORT_RANGE_START = 4100;
const PORT_RANGE_SIZE = 400;

/**
 * Checks whether anything is actually listening on 127.0.0.1:port, by trying
 * to *connect* to it rather than bind to it.
 *
 * A bind-based check (`net.createServer().listen(port, "127.0.0.1")`) is
 * NOT reliable here: Next's dev server listens on the IPv6 wildcard address
 * ("::"), which is dual-stack on macOS and happily serves IPv4 loopback
 * clients — but Node's SO_REUSEADDR-by-default sockets can still let a
 * *second* bind test succeed against 127.0.0.1 specifically, since it's a
 * different address family/scope than the "::" wildcard already held. That
 * false "free" reading was caught by this phase's concurrent-session
 * verification: two sessions' sandboxes both got told port 4100 was free,
 * and the second session's `waitForServerReady` was fooled into reporting
 * success because *something* (the first session's server) answered on
 * that port — see the child-exit guard in waitForServerReady below for the
 * second half of the fix. A connect attempt tests actual reachability
 * instead of bind privilege, so it isn't fooled by that mismatch.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (free: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(false)); // something answered -> not free
    socket.once("timeout", () => finish(true));
    socket.once("error", () => finish(true)); // ECONNREFUSED etc. -> free
    socket.connect(port, "127.0.0.1");
  });
}

async function findFreePort(): Promise<number> {
  for (let i = 0; i < PORT_RANGE_SIZE; i++) {
    const port = PORT_RANGE_START + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `No free TCP port found in range ${PORT_RANGE_START}-${PORT_RANGE_START + PORT_RANGE_SIZE}`
  );
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

const MAX_LOG_TAIL_CHARS = 4000;

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_LOG_TAIL_CHARS ? next.slice(-MAX_LOG_TAIL_CHARS) : next;
}

interface RegistryEntry {
  port: number;
  child: ChildProcess | null;
  state: SandboxStatus["state"];
  message?: string;
  devLogTail: string;
}

/**
 * In-process, in-memory registry only — same accepted tradeoff as the
 * Phase 1 in-process job state (src/server/jobs.ts): it doesn't survive a
 * dev-server restart. A sandbox child process spawned by a since-restarted
 * harness process becomes orphaned (still running, but untracked) — same
 * shape of limitation, not a new one introduced here.
 */
const registry = new Map<string, RegistryEntry>();

/** Guards concurrent start() calls for the same session against double-spawning. */
const startingPromises = new Map<string, Promise<SandboxStartResult>>();

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onOutput?: (chunk: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let tail = "";

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      tail = appendTail(tail, text);
      onOutput?.(text);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      tail = appendTail(tail, text);
      onOutput?.(text);
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code}.\n${tail.trim().slice(-1500)}`
          )
        );
      }
    });
  });
}

function spawnDevServer(dir: string, port: number): ChildProcess {
  // detached: true makes this child the leader of its own process group on
  // POSIX, so killProcessTree can signal the whole tree (npm -> next dev's
  // own child processes) via a single negative-PID kill instead of just the
  // `npm` wrapper.
  const child = spawn("npm", ["run", "dev", "--", "-p", String(port)], {
    cwd: dir,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

/**
 * Polls until the dev server responds 200, but also fails fast if `child`
 * itself has already exited (e.g. EADDRINUSE because something else beat us
 * to the port despite the isPortFree check above). Without this guard, a
 * 200 from a *different* process already bound to the same port would be
 * mistaken for this session's own server coming up — belt-and-suspenders
 * alongside the connect-based isPortFree check, since a bind-time race
 * between the check and the actual spawn can never be fully eliminated.
 */
async function waitForServerReady(
  port: number,
  timeoutMs: number,
  child: ChildProcess
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/`;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Dev server process exited early (code ${child.exitCode}, signal ${child.signalCode}) before it came up — port ${port} was likely already in use by something else.`
      );
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) return;
    } catch {
      // Not up yet — connection refused, timed out, or still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  throw new Error(
    `Dev server on port ${port} did not respond with a 200 within ${Math.round(timeoutMs / 1000)}s.`
  );
}

/**
 * A truly orphaned sandbox child (see the RegistryEntry doc comment above —
 * `detached: true` means it outlives this harness process) is exactly what
 * a Phase 3 restore has to cope with: after a harness restart, the
 * in-memory registry has no record of it, so a naive restore always tries
 * to spawn a brand new dev server for the session's directory. Next.js
 * itself refuses that — it detects another instance already running
 * against the same project directory (regardless of the port we asked for)
 * and exits immediately, printing the port the *existing* instance is on.
 * Detected here so restore can reuse that still-alive server instead of
 * failing outright.
 */
const ALREADY_RUNNING_PORT_RE =
  /Another next dev server is already running[\s\S]*?(?:Local:\s*)?https?:\/\/localhost:(\d+)/i;

function parseAlreadyRunningPort(tail: string): number | null {
  const match = ALREADY_RUNNING_PORT_RE.exec(tail);
  if (!match) return null;
  const port = Number.parseInt(match[1], 10);
  return Number.isFinite(port) ? port : null;
}

/** Like waitForServerReady, but for a process we don't own (no ChildProcess
 * handle to check exitCode against) — just polls for a 200. */
async function pollUntilReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/`;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid == null) return;

  const trySignal = (signal: NodeJS.Signals) => {
    try {
      // Negative PID targets the whole process group created by
      // `detached: true` above, covering npm's own child (`next dev`).
      process.kill(-child.pid!, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };

  trySignal("SIGTERM");
  const exited = await waitForExit(child, 5000);
  if (!exited) {
    trySignal("SIGKILL");
    await waitForExit(child, 2000);
  }
}

// ---------------------------------------------------------------------------
// LocalProcessSandboxProvider
// ---------------------------------------------------------------------------

export class LocalProcessSandboxProvider implements SandboxProvider {
  async start(
    sessionId: string,
    options?: SandboxStartOptions
  ): Promise<SandboxStartResult> {
    const existing = registry.get(sessionId);
    if (existing && existing.state === "running" && existing.child && existing.child.exitCode === null) {
      return { url: `http://localhost:${existing.port}` };
    }

    const inFlight = startingPromises.get(sessionId);
    if (inFlight) return inFlight;

    const promise = this.doStart(sessionId, options);
    startingPromises.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      startingPromises.delete(sessionId);
    }
  }

  private async doStart(
    sessionId: string,
    options?: SandboxStartOptions
  ): Promise<SandboxStartResult> {
    const dir = getSandboxDir(sessionId);
    registry.set(sessionId, {
      port: 0,
      child: null,
      state: "starting",
      devLogTail: "",
    });

    options?.onStatus?.("Installing dependencies…");
    try {
      await runCommand("npm", ["install"], dir);
    } catch (err) {
      registry.set(sessionId, {
        port: 0,
        child: null,
        state: "error",
        message: err instanceof Error ? err.message : String(err),
        devLogTail: "",
      });
      throw new Error(
        `npm install failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const port = await findFreePort();
    options?.onStatus?.("Starting the dev server…");
    const child = spawnDevServer(dir, port);

    const entry: RegistryEntry = { port, child, state: "starting", devLogTail: "" };
    registry.set(sessionId, entry);

    child.stdout?.on("data", (data: Buffer) => {
      entry.devLogTail = appendTail(entry.devLogTail, data.toString("utf8"));
    });
    child.stderr?.on("data", (data: Buffer) => {
      entry.devLogTail = appendTail(entry.devLogTail, data.toString("utf8"));
    });
    child.once("exit", (code) => {
      const current = registry.get(sessionId);
      if (current && current.child === child && current.state !== "stopped") {
        current.state = "error";
        current.message = `Dev server exited early (code ${code}).`;
      }
    });

    try {
      await waitForServerReady(port, 60_000, child);
    } catch (err) {
      const tail = entry.devLogTail;

      // This session's directory may already have a live, still-running dev
      // server from before a harness restart (a genuinely orphaned but
      // healthy child — see parseAlreadyRunningPort's doc comment). Next.js
      // refused our spawn because of it; reuse that existing server instead
      // of treating this as a real failure.
      const existingPort = parseAlreadyRunningPort(tail);
      if (existingPort) {
        await killProcessTree(child).catch(() => {});
        const reachable = await pollUntilReady(existingPort, 15_000);
        if (reachable) {
          registry.set(sessionId, {
            port: existingPort,
            child: null, // we don't own this process — same as a stop()'d entry
            state: "running",
            devLogTail: "",
          });
          return { url: `http://localhost:${existingPort}` };
        }
      }

      const trimmedTail = tail.trim().slice(-1500);
      await killProcessTree(child);
      registry.set(sessionId, {
        port,
        child: null,
        state: "error",
        message: `${err instanceof Error ? err.message : String(err)}${trimmedTail ? `\n${trimmedTail}` : ""}`,
        devLogTail: "",
      });
      throw new Error(
        `Dev server never came up: ${err instanceof Error ? err.message : String(err)}${
          trimmedTail ? `\n${trimmedTail}` : ""
        }`
      );
    }

    entry.state = "running";
    return { url: `http://localhost:${port}` };
  }

  async restoreFromSnapshot(
    sessionId: string,
    files: SnapshotFile[],
    options?: SandboxStartOptions
  ): Promise<SandboxStartResult> {
    const status = this.getStatus(sessionId);
    if (status.state === "running" && status.port) {
      // A "running" entry with no owned child process (see the reuse path
      // in doStart above, adopted from a still-alive orphan) is only ever a
      // best-effort record — that process can die silently later without
      // this registry finding out. Re-probe before trusting it, so a
      // restore call always reflects real reachability instead of a
      // possibly-stale cached status.
      const stillAlive = await pollUntilReady(status.port, 2000);
      if (stillAlive) return { url: `http://localhost:${status.port}` };
    }
    writeSnapshotFiles(getSandboxDir(sessionId), files);
    return this.start(sessionId, options);
  }

  async stop(sessionId: string): Promise<void> {
    const entry = registry.get(sessionId);
    if (!entry) return;
    if (entry.child) {
      await killProcessTree(entry.child);
    }
    registry.set(sessionId, { ...entry, child: null, state: "stopped" });
  }

  getStatus(sessionId: string): SandboxStatus {
    const entry = registry.get(sessionId);
    if (!entry) return { state: "stopped" };
    return { state: entry.state, port: entry.port || undefined, message: entry.message };
  }
}

// ---------------------------------------------------------------------------
// Provider selection
//
// Same isXConfigured() gating idiom as isClerkConfigured (src/lib/auth.ts)
// and isVercelConfigured (src/server/vercel.ts — a DIFFERENT gate: that one
// guards the one-shot "Deploy Your Application" REST call, this one guards
// the long-lived preview sandbox): unconfigured degrades to "acts like the
// feature doesn't exist" rather than throwing at import time or at request
// time. Concretely: SANDBOX_PROVIDER must be set to exactly "vercel" AND all
// three of VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID must be present
// (isVercelSandboxConfigured, src/server/sandbox-vercel.ts) for anything to
// change from today's behavior — any other value, or a missing/partial
// credential set, silently falls back to LocalProcessSandboxProvider. This
// keeps the zero-isolation local default opt-OUT-proof by accident: you
// can't half-configure your way into thinking you got microVM isolation.
//
// Resolved once, at module load — see sandbox-vercel.ts's module doc comment
// for why a remote provider is even worth having (Firecracker isolation for
// the generated app's `npm install` + dev server, which today run directly
// on this host with a full copy of this process's own environment).
// ---------------------------------------------------------------------------
export const sandboxProvider: SandboxProvider =
  process.env.SANDBOX_PROVIDER === "vercel" && isVercelSandboxConfigured()
    ? new VercelSandboxProvider()
    : new LocalProcessSandboxProvider();
