import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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
  port: number;
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

export interface SandboxProvider {
  /** Idempotent: calling twice for a session already running just returns its port. */
  start(sessionId: string, options?: SandboxStartOptions): Promise<SandboxStartResult>;
  stop(sessionId: string): Promise<void>;
  getStatus(sessionId: string): SandboxStatus;
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
 */
const TEMPLATE_DIR = path.join(process.cwd(), "src", "server", "sandbox-template");

export function getSandboxDir(sessionId: string): string {
  return path.join(SANDBOX_ROOT, sessionId);
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
      return { port: existing.port };
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
      const tail = entry.devLogTail.trim().slice(-1500);
      await killProcessTree(child);
      registry.set(sessionId, {
        port,
        child: null,
        state: "error",
        message: `${err instanceof Error ? err.message : String(err)}${tail ? `\n${tail}` : ""}`,
        devLogTail: "",
      });
      throw new Error(
        `Dev server never came up: ${err instanceof Error ? err.message : String(err)}${
          tail ? `\n${tail}` : ""
        }`
      );
    }

    entry.state = "running";
    return { port };
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

export const sandboxProvider: SandboxProvider = new LocalProcessSandboxProvider();
