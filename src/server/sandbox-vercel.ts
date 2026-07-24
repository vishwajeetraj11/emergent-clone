import { Sandbox } from "@vercel/sandbox";
import { getSessionFiles } from "@/server/files";
import { buildSandboxEnvContent, NeonNotConfiguredError } from "@/server/project-db";
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

// VercelSandboxProvider: runs the generated app's `npm install` + dev server
// inside a Vercel Sandbox (Firecracker microVM). The only provider — the local
// child-process one was deleted in 5b781a3.
//
// IDENTITY: pinned to @vercel/sandbox@2.7.1, whose sandboxes are persistent by
// default and addressed by a caller-chosen `name`. `name: sessionId` IS the
// durable identity (unique per Vercel project), so there is no sandbox id to
// persist or reattach by, and Sandbox.getOrCreate collapses
// registry-probe -> reattach -> create into one call.
//
// ENV HYGIENE: nothing from this process's own process.env is ever passed into
// a sandbox — not on getOrCreate, not on runCommand. A VM's only environment is
// its base image plus the .env.local written in onCreate. The VERCEL_* auth is
// control-plane only: it authenticates the calls THIS process makes, and is
// never injected into the VM.
//
// COST (Hobby allotment): 5 Active-CPU hr/mo, 420 GB-hr memory/mo, 5,000
// creations/mo, 10 concurrent. Active-CPU billing ignores idle, and eager
// stop() means sandboxes mostly aren't idling at all — but a sustained
// multi-user deployment would want to watch the concurrent count.

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
    // Same "trust but re-verify" order as start(): a live registry entry means
    // "don't touch the files, it's already running what it should be".
    const viaRegistry = await this.probeRegistryEntry(sessionId);
    if (viaRegistry) return viaRegistry;

    const inFlight = startingPromises.get(sessionId);
    if (inFlight) return inFlight;

    // Seeded from `files`, NOT buildInitialFileList: snapshotSessionFiles
    // already walked the whole tree, template files included. Re-reading the
    // template here would risk reverting agent edits to them. (The cost of
    // that choice is issue 1 in KNOWN-ISSUES.md: template fixes never reach an
    // existing session.)
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
      // resume: false — never boot a stopped VM just to stop it. Throws when
      // no sandbox with this name exists; the catch treats that as any other
      // best-effort failure.
      await sandbox.stop();
    } catch (err) {
      // Best-effort: every caller is already done with this sandbox and must
      // not be blocked by a stop() that couldn't reach the API. Logs even the
      // benign "nothing to stop" case — no cheap way to tell it apart from a
      // real failure, and swallowing one that matters is worse.
      console.error(`[sandbox-vercel] failed to stop sandbox for session ${sessionId}`, err);
    }
    registry.set(sessionId, { sandbox: null, url: "", state: "stopped" });
  }

  /**
   * PERMANENT teardown for project deletion, unlike stop()'s resumable pause.
   * Best-effort; on success the session is forgotten from the registry rather
   * than left as a "stopped" tombstone.
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
    // No `port` — a remote sandbox's internal port means nothing to a caller.
    return { state: entry.state, message: entry.message };
  }

  async syncFiles(sessionId: string, files: SnapshotFile[]): Promise<void> {
    if (files.length === 0) return;
    const entry = registry.get(sessionId);
    if (!entry || entry.state !== "running" || !entry.sandbox) {
      // Nothing live to push into, and the next restore rebuilds from the
      // snapshot anyway — a no-op, not an error. Failures from an actually-live
      // writeFiles below DO propagate.
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
      // Same failure shape as bootSandbox's onCreate install.
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
   * Contract in SandboxProvider.checkPreviewHealth (sandbox.ts). Unlike
   * probeRegistryEntry, a failed probe here DELETES the registry entry: this
   * exists to catch a VM that died while nobody was calling start(), so the
   * next start() must not find a stale "running" entry and reuse it.
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
      // An eager stop already knows the sandbox is down — reflect it now so
      // the paused-preview card shows immediately, not after the next poll.
      if (entry.state === "stopped") return false;
      return true; // creating/installing/starting — booting, not dead.
    }

    // No in-memory record — e.g. the server restarted while the tab stayed
    // open. `name: sessionId` is the durable identity, so look it up directly.
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
    // The registry is a best-effort cache — always re-probe, so a
    // since-expired sandbox isn't handed back as if it were live.
    if (await probeUrl(entry.url, 2000)) return { url: entry.url };
    return null;
  }

  /** Fresh-create path, start() only: template off disk merged with the `files`
   * snapshot, snapshot winning on collision (it's the agent-edited version). */
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
   * Gets-or-creates the sandbox and brings its dev server up. `fileList` is
   * resolved by the caller, since start() and restoreFromSnapshot() seed it
   * differently — see their doc comments.
   *
   * File seeding + npm install run only inside `onCreate`, which getOrCreate
   * invokes for a fresh sandbox and never a resumed one (a resume's
   * filesystem, node_modules included, is already on disk). `created` tracks
   * which path it took, since getOrCreate doesn't tell the caller.
   *
   * Error-state registry entries deliberately KEEP the `sandbox` reference
   * rather than nulling it. Every start() call site in agent.ts calls stop()
   * on failure; keeping the reference means that stop() finds a real sandbox
   * to tear down instead of leaking a half-initialized, still-billing VM
   * whose onCreate died partway through writeFiles/npm-install.
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
        name: sessionId, // the durable identity; no id column needed
        ...resolveCredentials(),
        runtime: "node24",
        ports: [APP_PORT],
        timeout: SANDBOX_TIMEOUT_MS,
        persistent: true,
        keepLastSnapshots: { count: 1 },
        snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
        resume: true,
        // No `env` — see this module's env-hygiene note.
        onCreate: async (sbx) => {
          sandboxRef = sbx;
          created = true;

          // The session's own DATABASE_URL + auth secret are injected here
          // rather than via the file snapshot, which deliberately excludes
          // .env.local so the secrets never leave the runtime (files.ts).
          // Best-effort: failed provisioning means no .env.local, not a failed
          // sandbox. Fresh creates only — a resume already has the file.
          try {
            const envContent = await buildSandboxEnvContent(sessionId, sbx.domain(APP_PORT));
            if (envContent) {
              fileList = [
                ...fileList.filter((f) => f.path !== ".env.local"),
                { path: ".env.local", content: envContent },
              ];
            }
          } catch (err) {
            // A missing NEON_API_KEY is a deployment mistake, not a transient
            // failure — let it kill the boot rather than quietly handing back a
            // sandbox whose app can never persist anything.
            if (err instanceof NeonNotConfiguredError) throw err;
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
            // Tail-truncated: a full install log can be enormous.
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

    // Credentials can rotate while a snapshot sits stopped — observed live: a
    // Neon password reset left a resumed VM's baked .env.local failing 28P01
    // while sessions.databaseUrl was current. Compared before writing because a
    // change also forces the dev-server restart below: Next inside the VM does
    // NOT reload env-file changes on its own, so a running server would keep
    // using the dead credential until the next stop/resume.
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
    // Already serving (e.g. another server process booted it) — a second dev
    // server would just crash on the port. Skipped when the env or the deps
    // just changed: that server has the stale copy baked in, so restart it.
    if (!created && !envChanged && !depsChanged && (await probeUrl(url, 2000))) {
      registry.set(sessionId, { sandbox, url, state: "running" });
      return { url };
    }

    // A stale-env, stale-deps, or half-dead server may still hold the port.
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
      // detached: a long-lived server, not a command to wait on. There is no
      // cheap synchronous "did it crash yet" check on the returned Command
      // (exitCode only updates via wait(), which blocks until exit), so
      // readiness is determined entirely by the domain probe below.
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

    // 180s, not 60: covers the RESUME path, where a stopped VM must boot and
    // Next cold-compiles a real app — observed blowing a 60s budget on a
    // ~15-route app and failing the job even though the resume was healthy.
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
