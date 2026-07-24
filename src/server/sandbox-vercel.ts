import { Sandbox } from "@vercel/sandbox";
import { getSessionFiles } from "@/server/files";
import { buildSandboxEnvContent } from "@/server/project-db";
import {
  type SandboxProvider,
  type SandboxStartOptions,
  type SandboxStartResult,
  type SandboxStatus,
  type SnapshotFile,
} from "@/server/sandbox";
import {
  APP_PORT,
  SANDBOX_TIMEOUT_MS,
  SNAPSHOT_EXPIRATION_MS,
  resolveCredentials,
} from "@/server/sandbox-vercel-config";
import { probeUrl, waitForUrlReady } from "@/server/sandbox-vercel-net";
import { registry, startingPromises } from "@/server/sandbox-vercel-registry";
import { readTemplateFilesRecursive } from "@/server/sandbox-vercel-template";

/**
 * The live Sandbox handle for a running session (registry lookup), or null.
 * The build phase (src/server/agent-phases.ts) uses this after start() so the
 * AI-SDK agent's file/shell tools + snapshotSessionFiles run INSIDE the VM.
 * Returns a handle only when the sandbox is actually running — same trust
 * condition as syncFiles.
 */
export function getLiveSandbox(sessionId: string): Sandbox | null {
  const entry = registry.get(sessionId);
  return entry?.state === "running" && entry.sandbox ? entry.sandbox : null;
}

// ---------------------------------------------------------------------------
// VercelSandboxProvider: runs the generated app's `npm install` + dev server
// inside a real Vercel Sandbox (Firecracker microVM) instead of directly on
// this host — see src/server/sandbox.ts's LocalProcessSandboxProvider,
// whose top-of-file comment explains why that's the default and what it
// costs: zero isolation, and the generated app's dev server inherits this
// process's FULL environment (ANTHROPIC_API_KEY, DATABASE_URL, Clerk/GitHub/
// Razorpay/Vercel secrets, ...). This provider is the fix, gated behind
// SANDBOX_PROVIDER=vercel + isVercelSandboxConfigured() (see sandbox.ts's
// factory export) so the zero-isolation local behavior stays the default.
//
// PACKAGE VERSION: this repo pins @vercel/sandbox@2.7.1 — the GA v2 line.
// v2's headline change is persistent-by-default sandboxes addressed by a
// caller-chosen `name` instead of an opaque id: `Sandbox.getOrCreate`
// resolves "does session X already have a sandbox" and "create one if not"
// in a single call, which replaces v1's whole registry-probe →
// DB-id-reattach → fresh-create ladder — there's no sandbox id to persist
// or reattach by anymore, `name: sessionId` IS the durable identity, unique
// per Vercel project.
//
// COST (Hobby free allotment, as documented for @vercel/sandbox): 5
// Active-CPU hr/mo, 420 GB-hr memory/mo, 5,000 creations/mo, 10 concurrent
// sandboxes. Active-CPU billing ignores idle/I/O-wait time, and eager
// stop() means a sandbox mostly isn't even sitting idle while nobody has
// the tab open — comfortably inside the free tier for this app's
// verification/demo usage; a sustained multi-user deployment would want to
// watch the concurrent-sandbox count against the cap.
//
// ENV HYGIENE: nothing from this process's own `process.env` is ever passed
// into a sandbox — not on Sandbox.getOrCreate, not on runCommand. The only
// "environment" a sandbox VM gets is whatever its base image ships with.
// Auth (VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID) is a control-plane
// concern — it authenticates the API calls THIS process makes to create/
// manage the sandbox, it is never injected into the VM itself.
// ---------------------------------------------------------------------------

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
    // Same "trust but re-verify" order as start(): a live registry entry
    // means "don't touch the files, it's already running exactly what it
    // should be" — matching local restoreFromSnapshot's early-return
    // semantics (sandbox.ts).
    const viaRegistry = await this.probeRegistryEntry(sessionId);
    if (viaRegistry) return viaRegistry;

    const inFlight = startingPromises.get(sessionId);
    if (inFlight) return inFlight;

    // Seeded from `files` (the caller's DB snapshot), NOT buildInitialFileList
    // — snapshotSessionFiles already walked the whole sandbox directory when
    // it wrote that snapshot, so it already contains the full tree including
    // whatever came from the template. Re-reading the template here would
    // only risk *reverting* agent edits to template files with the
    // never-edited original.
    const promise = this.bootSandbox(sessionId, files, options);
    startingPromises.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      startingPromises.delete(sessionId);
    }
  }

  async stop(sessionId: string): Promise<void> {
    // A stop must not race a mid-boot create/resume for the same session —
    // e.g. the eager /api/sessions/[id]/stop-preview call landing while
    // bootSandbox is still mid-`npm install` for a create/resume that raced
    // it.
    const inFlight = startingPromises.get(sessionId);
    if (inFlight) await inFlight.catch(() => {});

    const entry = registry.get(sessionId);
    try {
      const sandbox =
        entry?.sandbox ??
        (await Sandbox.get({ name: sessionId, resume: false, ...resolveCredentials() }));
      // resume: false — never boot a stopped VM just to stop it. Throws
      // when no sandbox with this name exists (a session that never
      // started one, or a pre-migration v1 session with no v2 counterpart)
      // — the catch below treats that the same as any other best-effort
      // failure.
      await sandbox.stop();
    } catch (err) {
      // Best-effort, same spirit as src/server/vercel.ts's
      // disableDeploymentProtection: every caller — agent.ts's
      // runBuildPhase failure paths, and the eager stop-preview route on
      // navigate-away — is already done with this sandbox and must not be
      // blocked by a stop() that couldn't reach the API. Logging here is
      // noisy for the common "nothing to stop" case (no sandbox with this
      // name), but there's no cheap way to distinguish that from a real
      // failure, so it logs either way rather than risk swallowing one
      // that matters.
      console.error(`[sandbox-vercel] failed to stop sandbox for session ${sessionId}`, err);
    }
    registry.set(sessionId, { sandbox: null, url: "", state: "stopped" });
  }

  /**
   * PERMANENT teardown for project deletion — Sandbox.delete() (VM becomes
   * inert, no resume), unlike stop()'s resumable pause. Same in-flight-await +
   * registry-or-lookup structure as stop(); best-effort (a not-found throw for
   * a session that never started a VM is the common benign case). On success
   * the session is fully forgotten from the registry rather than left as a
   * "stopped" tombstone.
   */
  async destroy(sessionId: string): Promise<void> {
    const inFlight = startingPromises.get(sessionId);
    if (inFlight) await inFlight.catch(() => {});

    const entry = registry.get(sessionId);
    try {
      const sandbox =
        entry?.sandbox ??
        (await Sandbox.get({ name: sessionId, resume: false, ...resolveCredentials() }));
      await sandbox.delete();
    } catch (err) {
      console.error(`[sandbox-vercel] failed to delete sandbox for session ${sessionId}`, err);
    }
    registry.delete(sessionId);
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

    // Dependency changes are the one edit hot-reload can't absorb: the VM's
    // node_modules was installed exactly once, at create time (bootSandbox's
    // onCreate), so a pushed package.json with a new dependency leaves the dev
    // server 500ing with "Module not found" until npm install runs again.
    // Gated strictly on the manifest filename so ordinary source edits stay a
    // pure writeFiles. Keyed on package.json (not package-lock.json): the
    // template ships no lockfile and a generated lock can exceed the snapshot
    // size cap, so package.json is the only manifest guaranteed to sync.
    const depsChanged = files.some(
      (f) => f.path === "package.json" || f.path === "package-lock.json"
    );
    if (!depsChanged) return;

    const sandbox = entry.sandbox;
    const url = entry.url;

    // "starting", not "running", while install+restart is in flight — so
    // checkPreviewHealth treats this as booting (returns true) instead of
    // probing the mid-restart URL, failing, and deleting the entry.
    registry.set(sessionId, { sandbox, url, state: "starting" });

    const install = await sandbox.runCommand({ cmd: "npm", args: ["install"] });
    if (install.exitCode !== 0) {
      // Mirrors bootSandbox's onCreate install-failure shape above — same
      // 1500-char tail, same "exit code in the message" framing.
      const tail = await install.output("both").catch(() => "");
      const message = `npm install exited with code ${install.exitCode}.${
        tail.trim() ? `\n${tail.trim().slice(-1500)}` : ""
      }`;
      registry.set(sessionId, { sandbox, url, state: "error", message });
      throw new Error(message);
    }

    // Restart so Next re-resolves modules against the refreshed node_modules.
    await this.killDevServer(sandbox);
    await this.startDevServerAndWait(sessionId, sandbox, url);
  }

  /**
   * See SandboxProvider.checkPreviewHealth's doc comment (sandbox.ts) for the
   * false/true contract. Unlike probeRegistryEntry above (which silently
   * falls through to a fresh create on a dead entry), a failed probe here
   * actively deletes the registry entry: this method exists specifically to
   * catch a VM that died *while nobody was calling start()* (the timeout
   * expiring mid-session), so the next start()/restoreFromSnapshot() must
   * not find a stale "running" entry and skip straight to reusing it.
   */
  async checkPreviewHealth(sessionId: string): Promise<boolean> {
    const entry = registry.get(sessionId);
    if (entry) {
      if (entry.state === "running") {
        if (await probeUrl(entry.url, 3000)) return true;
        registry.delete(sessionId);
        return false;
      }
      if (entry.state === "error") return false;
      // An eager stop (/api/sessions/[id]/stop-preview, or an agent.ts
      // failure path) already knows the sandbox is down — reflect that
      // immediately rather than waiting for a probe, so the paused-preview
      // card shows right away instead of only after the next poll.
      if (entry.state === "stopped") return false;
      return true; // creating/installing/starting — booting, not dead.
    }

    // No in-memory record at all — e.g. the main server restarted while the
    // user's tab stayed open. `name: sessionId` is this sandbox's durable
    // identity (see this file's module doc comment), so a direct by-name
    // lookup replaces the old DB vercelSandboxId indirection.
    try {
      const sandbox = await Sandbox.get({ name: sessionId, resume: false, ...resolveCredentials() });
      if (sandbox.status !== "running") return false; // stopped/snapshotting/failed → paused card
      return probeUrl(sandbox.domain(APP_PORT), 3000);
    } catch {
      return false; // no sandbox with this name — nothing is serving the preview URL the client holds
    }
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

  /** Fresh-create path used only by start() — reads the template off disk plus whatever's already in the `files` table (DB rows win on path collision: they're the newer, possibly agent-edited version). restoreFromSnapshot seeds bootSandbox from its own `files` param instead, since that snapshot already contains the full tree. */
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
    const fileList = await this.buildInitialFileList(sessionId);
    return this.bootSandbox(sessionId, fileList, options);
  }

  /**
   * Gets-or-creates the sandbox and brings its dev server up — the Vercel
   * analog of LocalProcessSandboxProvider.doStart (src/server/sandbox.ts),
   * and the v2 replacement for the old createFresh: `Sandbox.getOrCreate`
   * collapses what used to be a DB-id-reattach-then-create ladder into one
   * call, since `name: sessionId` is itself the durable identity to look up
   * by. `fileList` is already resolved by the caller (buildInitialFileList
   * for start(), the `files` param directly for restoreFromSnapshot) since
   * the two callers seed it differently — see their doc comments.
   *
   * File seeding + npm install only run inside `onCreate`, which
   * getOrCreate only invokes for an actually-fresh sandbox (never a resumed
   * one) — a resume's filesystem, node_modules included, is already on
   * disk from before its last stop(). `created` tracks that distinction for
   * the status-text/already-serving branches below, since getOrCreate
   * itself doesn't otherwise tell the caller which path it took.
   *
   * Error-state registry entries below deliberately KEEP the `sandbox`
   * reference (when one was actually created/retrieved) rather than
   * nulling it out. This matters: every call site in src/server/agent.ts
   * that calls sandboxProvider.start() already calls
   * sandboxProvider.stop(sessionId) on failure (its six
   * `.catch(() => {})`'d stop() calls). Keeping the reference here means
   * THAT stop() call finds a real sandbox to tear down instead of leaking
   * a half-initialized, still-billing VM whose onCreate failed partway
   * through writeFiles/npm-install.
   */
  private async bootSandbox(
    sessionId: string,
    fileList: SnapshotFile[],
    options?: SandboxStartOptions
  ): Promise<SandboxStartResult> {
    registry.set(sessionId, { sandbox: null, url: "", state: "starting" });

    let sandboxRef: Sandbox | null = null; // for error-path registry entries — see this method's doc comment
    let created = false;

    options?.onStatus?.("Preparing the sandbox…");
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.getOrCreate({
        name: sessionId, // stable identity — replaces sessions.vercelSandboxId
        ...resolveCredentials(),
        runtime: "node24",
        ports: [APP_PORT],
        timeout: SANDBOX_TIMEOUT_MS,
        persistent: true,
        keepLastSnapshots: { count: 1 },
        snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
        resume: true,
        // No `env` — see this module's doc comment on env hygiene. Nothing
        // from this process's own environment (ANTHROPIC_API_KEY,
        // DATABASE_URL, Clerk/GitHub/Razorpay/Vercel secrets) belongs inside
        // the generated app's runtime.
        onCreate: async (sbx) => {
          sandboxRef = sbx;
          created = true;

          // The session's own Postgres DATABASE_URL + auth secret ride into
          // the VM as a `.env.local` alongside the app files — they can't
          // arrive via the file snapshot (src/server/files.ts deliberately
          // excludes .env.local from the `files` table precisely so the
          // secrets never leave the runtime), so it's injected here.
          // Best-effort inside buildSandboxEnvContent's own gating:
          // unconfigured/failed provisioning just means no .env.local, never a
          // failed sandbox. Runs only here, on a fresh create — a resumed
          // sandbox's filesystem (.env.local included) is already sitting on
          // disk from before its last stop().
          try {
            const envContent = await buildSandboxEnvContent(sessionId, sbx.domain(APP_PORT));
            if (envContent) {
              fileList = [
                ...fileList.filter((f) => f.path !== ".env.local"),
                { path: ".env.local", content: envContent },
              ];
            }
          } catch (err) {
            console.error(
              `[sandbox-vercel] database provisioning for session ${sessionId} failed`,
              err
            );
          }

          options?.onStatus?.("Creating the sandbox…");
          await sbx.writeFiles(
            fileList.map((f) => ({ path: f.path, content: Buffer.from(f.content, "utf8") }))
          );

          options?.onStatus?.("Installing dependencies…");
          const install = await sbx.runCommand({ cmd: "npm", args: ["install"] });
          if (install.exitCode !== 0) {
            // Mirrors LocalProcessSandboxProvider.doStart's npm-install
            // failure shape (sandbox.ts) — same 1500-char tail, same "exit
            // code in the message" framing.
            const tail = await install.output("both").catch(() => "");
            throw new Error(
              `npm install exited with code ${install.exitCode}.${
                tail.trim() ? `\n${tail.trim().slice(-1500)}` : ""
              }`
            );
          }
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      registry.set(sessionId, { sandbox: sandboxRef, url: "", state: "error", message });
      throw new Error(
        `Failed to ${created ? "initialize" : "get or create"} the Vercel sandbox: ${message}`
      );
    }
    sandboxRef = sandbox;

    // Resumed sandboxes get their .env.local refreshed too — onCreate above
    // only covers fresh creates, but the credential can rotate while a
    // snapshot sits stopped (observed live: a password reset on the Neon
    // role left a resumed VM's baked .env.local failing with 28P01 while
    // sessions.databaseUrl was current). Compared before writing because a
    // CHANGED credential also forces a dev-server restart below — Next
    // inside the VM was observed NOT reloading env-file changes on its own,
    // so a running server would otherwise keep serving with the dead
    // credential until the next stop/resume. Best-effort, same contract as
    // the onCreate injection.
    let envChanged = false;
    if (!created) {
      try {
        const desired = await buildSandboxEnvContent(sessionId, sandbox.domain(APP_PORT));
        if (desired) {
          const current = await sandbox
            .runCommand({ cmd: "cat", args: [".env.local"] })
            .then((r) => r.output("stdout"))
            .catch(() => "");
          if (current !== desired) {
            await sandbox.writeFiles([
              { path: ".env.local", content: Buffer.from(desired, "utf8") },
            ]);
            envChanged = true;
          }
        }
      } catch (err) {
        console.error(
          `[sandbox-vercel] refreshing .env.local for session ${sessionId} failed`,
          err
        );
      }
    }

    // Resumed sandboxes also get package.json reconciled against the snapshot.
    // onCreate is the ONLY place files are written, and getOrCreate skips it
    // for a resume — so a VM whose disk drifted from the snapshot keeps the
    // stale copy forever. Observed live: a VM holding the agent's source files
    // but the TEMPLATE's package.json, so every import of a dependency the
    // agent had installed failed to resolve, every route 500'd, and restore
    // timed out at 180s waiting for a server that was running fine and serving
    // nothing but errors.
    //
    // Only package.json is reconciled, not the whole tree: it is the one file
    // whose staleness silently breaks the build rather than just showing old
    // content, and re-writing everything here would clobber work the agent did
    // in the VM that hasn't been snapshotted yet.
    let depsChanged = false;
    if (!created) {
      try {
        const desired = fileList.find((f) => f.path === "package.json")?.content;
        if (desired) {
          const current = await sandbox
            .runCommand({ cmd: "cat", args: ["package.json"] })
            .then((r) => r.output("stdout"))
            .catch(() => "");
          if (current.trim() !== desired.trim()) {
            await sandbox.writeFiles([
              { path: "package.json", content: Buffer.from(desired, "utf8") },
            ]);
            options?.onStatus?.("Installing dependencies…");
            const install = await sandbox.runCommand({ cmd: "npm", args: ["install"] });
            if (install.exitCode !== 0) {
              const tail = await install.output("both").catch(() => "");
              throw new Error(
                `npm install exited with code ${install.exitCode}.${
                  tail.trim() ? `\n${tail.trim().slice(-1500)}` : ""
                }`
              );
            }
            depsChanged = true;
          }
        }
      } catch (err) {
        // Best-effort, same contract as the .env.local refresh: a reconcile
        // failure must not block a boot that might otherwise have worked.
        console.error(
          `[sandbox-vercel] reconciling dependencies for session ${sessionId} failed`,
          err
        );
      }
    }

    const url = sandbox.domain(APP_PORT);
    // A resumed-or-still-running sandbox may already be serving (e.g. another
    // server process booted it) — starting a second dev server would just
    // crash on the port. Skipped when the credential just changed: that
    // server is running with the stale env baked in, so fall through to the
    // kill-and-restart below instead of adopting it.
    if (!created && !envChanged && !depsChanged && (await probeUrl(url, 2000))) {
      registry.set(sessionId, { sandbox, url, state: "running" });
      return { url };
    }

    // A stale-env or stale-deps server — or a half-dead one — may still hold
    // the port; clear it before starting fresh.
    if (!created) {
      await this.killDevServer(sandbox);
    }

    if (!created) options?.onStatus?.("Waking the sandbox…");
    options?.onStatus?.("Starting the dev server…");
    return this.startDevServerAndWait(sessionId, sandbox, url);
  }

  /**
   * Kills any dev server holding APP_PORT inside the VM. Best-effort.
   *
   * The bracket classes are load-bearing, NOT a typo. `pkill -f` matches
   * against full command lines, and this `sh` process's own cmdline contains
   * whatever pattern it is given — so a plain `pkill -f next` matches the shell
   * running it and SIGTERMs itself (exit 143), leaving the real dev server
   * alive and the second pkill unreached. `[n]ext` still matches a process
   * running `next dev`, but not this shell, whose cmdline holds the literal
   * text `[n]ext`. Do not "simplify" the brackets away.
   */
  private async killDevServer(sandbox: Sandbox): Promise<void> {
    await sandbox
      .runCommand({
        cmd: "sh",
        args: ["-c", "pkill -f '[n]ext' || true; pkill -f '[n]pm run' || true"],
      })
      .catch(() => {});
  }

  private async startDevServerAndWait(
    sessionId: string,
    sandbox: Sandbox,
    url: string
  ): Promise<SandboxStartResult> {
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

    // 180s, not 60: this wait covers BOTH the create path (npm install
    // already done above, dev server compiles a near-empty template fast)
    // and the RESUME path, where a stopped VM must boot and Next must
    // cold-compile a real, fully-built app — observed live blowing a 60s
    // budget on a ~15-route app and failing the job even though the resume
    // itself was healthy. The create path only pays this length when
    // something is genuinely wrong.
    const ready = await waitForUrlReady(url, 180_000);
    if (!ready) {
      const message = `Dev server on ${url} did not respond within 180s.`;
      registry.set(sessionId, { sandbox, url, state: "error", message });
      throw new Error(message);
    }

    registry.set(sessionId, { sandbox, url, state: "running" });
    return { url };
  }
}
