import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Sandbox } from "@vercel/sandbox";
import { getDb } from "@/db";
import { sessions } from "@/db/schema";
import { getSessionFiles } from "@/server/files";
import {
  TEMPLATE_DIR,
  type SandboxProvider,
  type SandboxStartOptions,
  type SandboxStartResult,
  type SandboxStatus,
  type SnapshotFile,
} from "@/server/sandbox";

// ---------------------------------------------------------------------------
// VercelSandboxProvider: runs the generated app's `npm install` + dev server
// inside a real Vercel Sandbox (Firecracker microVM) instead of directly on
// this host — see src/server/sandbox.ts's LocalProcessSandboxProvider,
// whose top-of-file comment explains why that's the default and what it
// costs: zero isolation, and the generated app's dev server inherits this
// process's FULL environment (ANTHROPIC_API_KEY, DATABASE_URL, Clerk/GitHub/
// Stripe/Vercel secrets, ...). This provider is the fix, gated behind
// SANDBOX_PROVIDER=vercel + isVercelSandboxConfigured() (see sandbox.ts's
// factory export) so the zero-isolation local behavior stays the default.
//
// PACKAGE VERSION: this repo pins @vercel/sandbox@^1.9.2 (npm resolved
// 1.10.2 at install time) — the STABLE v1 line, deliberately NOT the v2 API
// (persistent-by-default sandboxes, `name` identity, `getOrCreate`,
// auto-resume) which as of this writing is still 2.0.0-beta.11, i.e. not
// something to build production behavior on. Phase 2 (documented in the
// implementation plan, not built here) swaps to v2 once it's GA, which
// would let restore skip the npm-reinstall-from-scratch path below entirely.
//
// EPHEMERAL SEMANTICS (v1): a sandbox is NOT a long-lived resource with a
// stable identity you can casually look up later — it's created with a
// `timeout` and is simply gone (VM + filesystem) once that elapses. `Sandbox.
// list()` exists, but v1's create params have no `name`/tag/metadata field
// to filter by (that's a v2 addition) — there's no "list my sandboxes and
// find the one for session X" query, only `Sandbox.get({ sandboxId })` using
// an id YOU persisted somewhere durable yourself. That's what sessions.vercelSandboxId
// (src/db/schema.ts) is for: this provider's own in-memory `registry` below
// has the exact same "dies on harness restart" limitation as
// LocalProcessSandboxProvider's registry (see that file's comment on it),
// but unlike a local child process, an abandoned Vercel sandbox keeps
// running (and billing) until ITS timeout, and a naive "just start a new one
// every time" restore would also multiply sandboxes against the Hobby
// plan's 10-concurrent cap. Reattach-by-id is the fix; see tryReattach.
//
// LIFECYCLE: created with a 15-minute timeout (SANDBOX_TIMEOUT_MS) — that
// IS the TTL, there is no separate sweeper. On expiry the VM disappears
// silently; the next time the session is opened, the restore flow rebuilds
// it from the `files` table snapshot (writeFiles + npm install, ~60-90s,
// same "Restoring the sandbox…" UX as a local-provider restore). The six
// `sandboxProvider.stop()` calls already present in agent.ts's
// runBuildPhase failure paths now actually stop billing promptly instead of
// just killing a local process for free.
//
// COST (Hobby free allotment, as documented for @vercel/sandbox 1.x): 5
// Active-CPU hr/mo, 420 GB-hr memory/mo, 5,000 creations/mo, 10 concurrent
// sandboxes. Active-CPU billing ignores idle/I/O-wait time, so a
// 15-minute-timeout sandbox that's mostly sitting there serving a preview
// costs a small fraction of that — comfortably inside the free tier for
// this app's verification/demo usage; a sustained multi-user deployment
// would want to watch the concurrent-sandbox count against the cap.
//
// ENV HYGIENE: nothing from this process's own `process.env` is ever passed
// into a sandbox — not on Sandbox.create, not on runCommand. The only
// "environment" a sandbox VM gets is whatever its base image ships with.
// Auth (VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID) is a control-plane
// concern — it authenticates the API calls THIS process makes to create/
// manage the sandbox, it is never injected into the VM itself.
// ---------------------------------------------------------------------------

export function isVercelSandboxConfigured(): boolean {
  return Boolean(
    process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
  );
}

/**
 * The sandbox's `timeout` IS its TTL — see the module doc comment above.
 * 45 minutes, the Hobby-plan maximum, and NOT lower on purpose: the first
 * real run with a 15-minute TTL had the sandbox expire *mid-build* (the
 * build agent's own local npm-install/build sanity check can easily take
 * 10+ minutes on a slow network), so the end-of-build syncFiles push landed
 * on a dead VM and the preview 410'd until the next restore. An idle
 * sandbox bills almost zero Active CPU — the cost of the longer window is
 * just provisioned-memory GB-hours, well inside the free allotment.
 */
const SANDBOX_TIMEOUT_MS = 45 * 60_000;

/** The one port the generated app's dev server listens on, both at `Sandbox.create({ ports })` time and every later `sandbox.domain(3000)` call. */
const APP_PORT = 3000;

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
function resolveCredentials(): VercelCredentials {
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

// ---------------------------------------------------------------------------
// URL readiness probing — the remote-sandbox analog of src/server/sandbox.ts's
// pollUntilReady, just fetching a public https:// domain instead of
// 127.0.0.1:<port>.
// ---------------------------------------------------------------------------

/**
 * Single bounded fetch attempt. Deliberately checks `res.ok` (2xx) only, the
 * same bar src/server/sandbox.ts's pollUntilReady/waitForServerReady use —
 * NOT "any response" — because the sandbox's public domain is served
 * through a Vercel-operated edge proxy: before the dev server inside the VM
 * is actually listening on port 3000, that proxy can itself answer with a
 * 502/503/504 (a real HTTP response, not a connection failure). Accepting
 * "any response below 500" would risk nothing here since a proxy error IS
 * >=500, but accepting >=500 too would risk mistaking "no upstream yet" for
 * "app is up" — so this stays strictly 2xx, matching local's own bar.
 */
async function probeUrl(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false; // connection refused, DNS not ready yet, timed out, ...
  }
}

/** Loops probeUrl until `deadlineMs` elapses — used only while waiting for a freshly-started dev server to come up for the first time. */
async function waitForUrlReady(url: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probeUrl(url, 2000)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Template reading
//
// Mirrors src/server/files.ts's `walk` almost exactly, but reading straight
// off local disk into memory (for writeFiles) rather than snapshotting a
// directory into the `files` table — this provider has no on-disk sandbox
// directory of its own to snapshot from. Scoped to just this file rather
// than shared with files.ts/sandbox.ts, since it's small and the exclusion
// list only needs to match what actually exists under TEMPLATE_DIR.
// ---------------------------------------------------------------------------

const TEMPLATE_EXCLUDED_DIRS = new Set(["node_modules", ".git", ".next"]);

function readTemplateFilesRecursive(): SnapshotFile[] {
  const out: SnapshotFile[] = [];

  function walk(dir: string): void {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (TEMPLATE_EXCLUDED_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        out.push({
          path: path.relative(TEMPLATE_DIR, fullPath),
          content: readFileSync(fullPath, "utf8"),
        });
      }
    }
  }

  walk(TEMPLATE_DIR);
  return out;
}

// ---------------------------------------------------------------------------
// Registry — mirrors src/server/sandbox.ts's `registry`/`startingPromises`
// pattern (see that file's RegistryEntry doc comment): in-process, in-memory
// only, so it does not survive a dev-server restart. The difference from
// local: an entry surviving in memory is a *cache*, never the source of
// truth for "is this sandbox still alive" — every read through it gets
// re-probed (see probeRegistryEntry) because, unlike a ChildProcess handle,
// there's no free/synchronous "is it still running" check for a remote VM.
// ---------------------------------------------------------------------------

interface VercelRegistryEntry {
  sandbox: Sandbox | null;
  url: string;
  state: SandboxStatus["state"];
  message?: string;
}

const registry = new Map<string, VercelRegistryEntry>();

/** Guards concurrent create-or-reattach calls for the same session — same purpose as sandbox.ts's startingPromises. */
const startingPromises = new Map<string, Promise<SandboxStartResult>>();

/**
 * Attempts to adopt a specific sandboxId as this session's live sandbox:
 * fetches it, checks it's actually running, and confirms its domain
 * actually answers. Returns null for ANY reason it isn't usable (deleted,
 * expired, wrong status, no route on APP_PORT, nothing answering) — the
 * caller's job is just "fall through to a fresh create" either way, so the
 * specific failure reason doesn't need to propagate.
 */
async function probeExistingSandbox(
  sandboxId: string
): Promise<{ sandbox: Sandbox; url: string } | null> {
  try {
    const sandbox = await Sandbox.get({ sandboxId, ...resolveCredentials() });
    if (sandbox.status !== "running") return null;
    const url = sandbox.domain(APP_PORT);
    if (!(await probeUrl(url, 2000))) return null;
    return { sandbox, url };
  } catch {
    return null;
  }
}

export class VercelSandboxProvider implements SandboxProvider {
  async start(sessionId: string, options?: SandboxStartOptions): Promise<SandboxStartResult> {
    const viaRegistry = await this.probeRegistryEntry(sessionId);
    if (viaRegistry) return viaRegistry;

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

  async restoreFromSnapshot(
    sessionId: string,
    files: SnapshotFile[],
    options?: SandboxStartOptions
  ): Promise<SandboxStartResult> {
    // Same "trust but re-verify" order as start(): a live registry entry or
    // a reattachable DB id both mean "don't touch the files, it's already
    // running exactly what it should be" — matching local
    // restoreFromSnapshot's early-return semantics (sandbox.ts).
    const viaRegistry = await this.probeRegistryEntry(sessionId);
    if (viaRegistry) return viaRegistry;

    const reattached = await this.tryReattach(sessionId);
    if (reattached) return reattached;

    const inFlight = startingPromises.get(sessionId);
    if (inFlight) return inFlight;

    // Seeded from `files` (the caller's DB snapshot), NOT buildInitialFileList
    // — snapshotSessionFiles already walked the whole sandbox directory when
    // it wrote that snapshot, so it already contains the full tree including
    // whatever came from the template. Re-reading the template here would
    // only risk *reverting* agent edits to template files with the
    // never-edited original.
    const promise = this.createFresh(sessionId, files, options);
    startingPromises.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      startingPromises.delete(sessionId);
    }
  }

  async stop(sessionId: string): Promise<void> {
    const entry = registry.get(sessionId);
    const db = getDb();

    let sandboxId = entry?.sandbox?.sandboxId;
    if (!sandboxId) {
      // No live entry in THIS process (e.g. the harness restarted between
      // start() and this stop() call) — fall back to the DB-persisted id so
      // stop() still actually tears the VM down instead of quietly no-op'ing
      // and leaving it running (and billing) until its own timeout.
      const [row] = await db
        .select({ vercelSandboxId: sessions.vercelSandboxId })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      sandboxId = row?.vercelSandboxId ?? undefined;
    }

    if (!entry && !sandboxId) return; // nothing to stop, in this process or in the DB.

    if (sandboxId) {
      try {
        const sandbox = entry?.sandbox ?? (await Sandbox.get({ sandboxId, ...resolveCredentials() }));
        await sandbox.stop();
      } catch (err) {
        // Best-effort, same spirit as src/server/vercel.ts's
        // disableDeploymentProtection: the caller (agent.ts's runBuildPhase
        // failure paths) is already mid-failure-handling and must not be
        // blocked further by a stop() that couldn't reach the API — worst
        // case the sandbox just lives out its 15-minute timeout instead of
        // dying right now.
        console.error(
          `[sandbox-vercel] failed to stop sandbox ${sandboxId} for session ${sessionId}`,
          err
        );
      }

      try {
        await db.update(sessions).set({ vercelSandboxId: null }).where(eq(sessions.id, sessionId));
      } catch (err) {
        console.error(
          `[sandbox-vercel] failed to clear vercelSandboxId for session ${sessionId}`,
          err
        );
      }
    }

    registry.set(sessionId, { sandbox: null, url: "", state: "stopped" });
  }

  getStatus(sessionId: string): SandboxStatus {
    const entry = registry.get(sessionId);
    if (!entry) return { state: "stopped" };
    // No `port` here — a remote sandbox's internal port isn't meaningful to
    // whatever's reading this status (see SandboxStartResult's doc comment
    // in sandbox.ts for the same url-not-port reasoning).
    return { state: entry.state, message: entry.message };
  }

  async syncFiles(sessionId: string, files: SnapshotFile[]): Promise<void> {
    if (files.length === 0) return;
    const entry = registry.get(sessionId);
    if (!entry || entry.state !== "running" || !entry.sandbox) {
      // Nothing live to push into — the next restore rebuilds from the DB
      // `files` snapshot anyway (see the SandboxProvider.syncFiles doc
      // comment in sandbox.ts), so this is silently a no-op rather than an
      // error. Errors from an actually-live writeFiles call below, on the
      // other hand, are left to propagate — see the call site in
      // src/server/agent.ts, which already wraps this in a try/catch
      // specifically so a sync hiccup can never fail the build job.
      return;
    }
    await entry.sandbox.writeFiles(
      files.map((f) => ({ path: f.path, content: Buffer.from(f.content, "utf8") }))
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Registry hit + live re-probe — shared fast path for start() and restoreFromSnapshot(). */
  private async probeRegistryEntry(sessionId: string): Promise<SandboxStartResult | null> {
    const entry = registry.get(sessionId);
    if (!entry || entry.state !== "running" || !entry.sandbox) return null;
    // A "running" registry entry is only ever a best-effort cache (see the
    // registry doc comment above) — always re-probe before trusting it, so
    // a since-expired-or-stopped sandbox doesn't get handed back as if it
    // were still live.
    if (await probeUrl(entry.url, 2000)) return { url: entry.url };
    return null;
  }

  /**
   * DB-id reattach: looks up sessions.vercelSandboxId, and if set, tries to
   * adopt that specific sandbox. Clears the column on ANY failure (deleted/
   * expired sandbox, wrong status, nothing answering) so a later call for
   * this session doesn't keep re-attempting a dead reference — see the
   * schema.ts comment on this column for why it exists at all.
   */
  private async tryReattach(sessionId: string): Promise<SandboxStartResult | null> {
    const db = getDb();
    const [row] = await db
      .select({ vercelSandboxId: sessions.vercelSandboxId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const sandboxId = row?.vercelSandboxId;
    if (!sandboxId) return null; // never had one — nothing stale to clear either.

    const found = await probeExistingSandbox(sandboxId);
    if (found) {
      registry.set(sessionId, { sandbox: found.sandbox, url: found.url, state: "running" });
      return { url: found.url };
    }

    try {
      await db.update(sessions).set({ vercelSandboxId: null }).where(eq(sessions.id, sessionId));
    } catch (err) {
      console.error(
        `[sandbox-vercel] failed to clear stale vercelSandboxId for session ${sessionId}`,
        err
      );
    }
    return null;
  }

  /** Fresh-create path used only by start() — reads the template off disk plus whatever's already in the `files` table (DB rows win on path collision: they're the newer, possibly agent-edited version). restoreFromSnapshot seeds createFresh from its own `files` param instead, since that snapshot already contains the full tree. */
  private async buildInitialFileList(sessionId: string): Promise<SnapshotFile[]> {
    const templateFiles = readTemplateFilesRecursive();
    const dbFiles = await getSessionFiles(sessionId);

    const merged = new Map<string, string>();
    for (const f of templateFiles) merged.set(f.path, f.content);
    for (const f of dbFiles) merged.set(f.path, f.content);

    return Array.from(merged, ([filePath, content]) => ({ path: filePath, content }));
  }

  private async doStart(
    sessionId: string,
    options?: SandboxStartOptions
  ): Promise<SandboxStartResult> {
    const reattached = await this.tryReattach(sessionId);
    if (reattached) return reattached;

    const fileList = await this.buildInitialFileList(sessionId);
    return this.createFresh(sessionId, fileList, options);
  }

  /**
   * Creates a brand new sandbox and brings its dev server up — the Vercel
   * analog of LocalProcessSandboxProvider.doStart (src/server/sandbox.ts).
   * `fileList` is already resolved by the caller (buildInitialFileList for
   * start(), the `files` param directly for restoreFromSnapshot) since the
   * two callers seed it differently — see their doc comments.
   *
   * Error-state registry entries below deliberately KEEP the `sandbox`
   * reference (when one was actually created) rather than nulling it out.
   * This matters: every call site in src/server/agent.ts that calls
   * sandboxProvider.start() already calls sandboxProvider.stop(sessionId)
   * on failure (its six `.catch(() => {})`'d stop() calls). Keeping the
   * reference here means THAT stop() call finds a real sandbox to tear
   * down instead of leaking a half-initialized, still-billing VM whose id
   * never made it anywhere else once writeFiles/npm-install/dev-server
   * fails partway through.
   */
  private async createFresh(
    sessionId: string,
    fileList: SnapshotFile[],
    options?: SandboxStartOptions
  ): Promise<SandboxStartResult> {
    registry.set(sessionId, { sandbox: null, url: "", state: "starting" });

    options?.onStatus?.("Creating the sandbox…");
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.create({
        ...resolveCredentials(),
        runtime: "node24",
        ports: [APP_PORT],
        timeout: SANDBOX_TIMEOUT_MS,
        // No `env` — see this module's doc comment on env hygiene. Nothing
        // from this process's own environment (ANTHROPIC_API_KEY,
        // DATABASE_URL, Clerk/GitHub/Stripe/Vercel secrets) belongs inside
        // the generated app's runtime.
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      registry.set(sessionId, { sandbox: null, url: "", state: "error", message });
      throw new Error(`Failed to create the Vercel sandbox: ${message}`);
    }

    // Persist the id before anything else can fail — see this method's doc
    // comment above on why error states below keep `sandbox` set. Best
    // effort: a failure here only degrades a later restore from "reattach"
    // to "create fresh" (see schema.ts's comment on this column) — it must
    // not undo the sandbox we just successfully created for THIS request.
    try {
      const db = getDb();
      await db
        .update(sessions)
        .set({ vercelSandboxId: sandbox.sandboxId })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      console.error(
        `[sandbox-vercel] failed to persist vercelSandboxId for session ${sessionId}`,
        err
      );
    }

    try {
      await sandbox.writeFiles(
        fileList.map((f) => ({ path: f.path, content: Buffer.from(f.content, "utf8") }))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      registry.set(sessionId, { sandbox, url: "", state: "error", message });
      throw new Error(`Failed to write files into the sandbox: ${message}`);
    }

    options?.onStatus?.("Installing dependencies…");
    try {
      const install = await sandbox.runCommand({ cmd: "npm", args: ["install"] });
      if (install.exitCode !== 0) {
        // Mirrors LocalProcessSandboxProvider.doStart's npm-install failure
        // shape (sandbox.ts) — same 1500-char tail, same "exit code in the
        // message" framing.
        const tail = await install.output("both").catch(() => "");
        throw new Error(
          `npm install exited with code ${install.exitCode}.${
            tail.trim() ? `\n${tail.trim().slice(-1500)}` : ""
          }`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      registry.set(sessionId, { sandbox, url: "", state: "error", message });
      throw new Error(`npm install failed: ${message}`);
    }

    options?.onStatus?.("Starting the dev server…");
    try {
      // detached: true — same reason as local's spawnDevServer: this is a
      // long-lived server, not a command we wait to exit. Unlike a local
      // ChildProcess, there's no cheap synchronous "did it crash yet" check
      // on the returned Command (its exitCode only ever updates via wait(),
      // which blocks until exit) — readiness is entirely determined by the
      // domain probe below, same as how local falls back to pollUntilReady
      // for a process it doesn't own.
      await sandbox.runCommand({
        cmd: "npm",
        args: ["run", "dev", "--", "-p", String(APP_PORT)],
        detached: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      registry.set(sessionId, { sandbox, url: "", state: "error", message });
      throw new Error(`Failed to start the dev server: ${message}`);
    }

    const url = sandbox.domain(APP_PORT);
    const ready = await waitForUrlReady(url, 60_000);
    if (!ready) {
      const message = `Dev server on ${url} did not respond within 60s.`;
      registry.set(sessionId, { sandbox, url, state: "error", message });
      throw new Error(message);
    }

    registry.set(sessionId, { sandbox, url, state: "running" });
    return { url };
  }
}
