# Known Issues

Open defects with their diagnosis, so the investigation doesn't have to be
repeated. Fixed issues move to `CHANGELOG.md` and come out of this file.

---

## 1. Template changes never reach existing sessions (open, low severity today)

**In one sentence.** Upgrading `src/server/sandbox-template/` only affects
sessions created after the upgrade; every session already in the database keeps
its original copy of those files forever.

**Worked example.** Alice creates a session today. The template's 7 files are
copied into her sandbox, the agent builds her app, and the whole tree is saved
as her snapshot. Next week you bump the template's `package.json` from Next
16.2.10 to 16.3. Alice returns: her sandbox is rebuilt from *her snapshot*, so
she gets 16.2.10 again, and will on every future restore. Bob, creating a
session that same day, copies from the template and gets 16.3. Two users on
different versions permanently, with nothing in any log to explain it.

**Mechanism.** A session reads the template exactly once, at creation. After
that it lives entirely off its snapshot: `restoreFromSnapshot`
(`src/server/sandbox-vercel.ts:86`) boots the VM from the session's `files`
index rows plus their R2 bytes — hydrated by `getSessionFiles` at
`src/app/api/sessions/[id]/restore/route.ts:30` — and never consults the
template again. The template is a fork point, not a live dependency.

**Half of that is correct behavior, which is why it is not a one-line fix.** The
agent edits template-owned files all the time — `app/page.tsx` *is* the user's
app. Re-reading the template on restore would silently revert those edits, and
`restoreFromSnapshot`'s doc comment exists to prevent exactly that. The real
defect is narrower: the code cannot tell an agent-edited file from one the agent
never touched, so it conservatively treats every file as agent-owned. Safe, but
it means no template change ever lands anywhere.

**Why it is low severity right now (checked 2026-07-24).** Nothing is stale, and
the blast radius is currently zero: the seven live sessions are all one-day-old
throwaway scaffolds (`minimal-next-149`, `single-page-552`, `markdown-note-440`,
…), created after every template change to date. If a template edit stranded
them today, the correct response would be to delete them.

**Trigger to actually fix it.** Before real users hold sessions worth keeping —
at that point every existing user becomes Alice, silently and permanently.

**Interim measure.** When touching `src/server/sandbox-template/`, delete the
existing sessions rather than assuming they inherit the change.

**The fix.** Tell "agent never touched this" apart from "agent wrote this" by
remembering every version the template has ever had.

1. **History manifest.** A script walks the git history of
   `src/server/sandbox-template/`, sha256s every version of every path, and
   writes a committed JSON — `{ "next.config.ts": ["3f2a…", "9c11…"], … }`.
   Regenerated whenever the template changes.

2. **Reconcile on boot**, per file in the current template:

   | session's copy | meaning | action |
   | --- | --- | --- |
   | hash is in the manifest | never edited — it is just an older template version | overwrite with current template |
   | hash matches nothing | agent wrote it | leave alone |
   | path absent from snapshot | agent deleted it | leave deleted |

3. **Both call sites.** `restoreFromSnapshot` (`sandbox-vercel.ts:107`) passes
   its `files` straight to `bootSandbox`; `buildInitialFileList` (`:294`) merges
   template and DB rows with DB winning unconditionally. Same hole, same helper.

4. **Do not write back to the DB.** Reconcile into the VM only — the next
   `snapshotSessionFiles` reads the corrected file off disk and persists it.
   Self-healing, no migration, no repair script.

5. **One test** recomputes the current template's hashes and asserts each is
   present in the manifest, so editing the template without regenerating it
   fails the build — that omission is precisely what creates this bug.

Roughly 150 lines plus the script and test. Note this needs no schema change and
does not depend on `files.hash`: `getSessionFiles` already returns content, and
hashing 7 files in memory is free. Not implemented.

**Rejected alternative.** Declaring a fixed set of infra files (`next.config.ts`,
`tsconfig.json`, `postcss.config.mjs`) permanently template-owned and always
overwriting them is ~20 lines and needs no manifest. It breaks the first time an
agent legitimately edits `next.config.ts` (image domains, rewrites, env), and it
breaks by silently reverting the user's change — the same failure mode this
issue is about, just relocated.

**Historical note — the bug that exposed this.** Generated apps rendered but
never hydrated: HTML and chunks served fine, buttons dead, no console error.
`next dev` was rejecting the Turbopack HMR WebSocket upgrade
(`blockCrossSiteDEV` on the upgrade handler,
`node_modules/next/dist/server/lib/router-server.js:615`) because the browser
reaches the sandbox at `sb-*.vercel.run` while the dev server booted as
localhost. Fixed in `3d247ac` by `allowedDevOrigins: ["*.vercel.run"]` in the
template's `next.config.ts`, where the call-site comment now explains it. The
sessions stranded on the pre-fix config no longer exist. Two things worth
keeping from that investigation:

- **Recognizer.** Count React fibers on the sandbox page — a healthy app has
  dozens, one that never hydrated has ~2 (React attached only to a hoisted
  `<link>` and Next's devtools portal, never the app tree):

  ```js
  let n = 0;
  for (const e of document.querySelectorAll('*')) {
    if (Object.keys(e).some(k => k.startsWith('__react'))) n++;
  }
  ```

- **Dead end, so it isn't retried.** Vercel Sandbox supports WebSockets fine — a
  bare Node WS server on the exposed port accepts a browser connection through
  the public domain and delivers frames. The sandbox proxy is not at fault, and
  switching the preview to `next build` + `next start` "fixes" this class of
  symptom only by removing the dev client entirely, trading away hot reload.
  Don't.

---

## 2. `killDevServer`'s `pkill` kills its own shell (open)

`src/server/sandbox-vercel.ts`:

```sh
sh -c "pkill -f next || true; pkill -f 'npm run dev' || true"
```

The `sh` process's own command line contains both `next` and `npm run dev`, so
`pkill -f` matches the shell itself and SIGTERMs it. Confirmed: the Vercel
activity log shows this command exiting **143**, and the second `pkill` never
runs.

**Consequence.** When a dev server really is holding the port, it survives.
The replacement `npm run dev` then finds port 3000 occupied and gets bumped to
another port, so the sandbox URL keeps serving the *old* server — stale code
after an agent edit, with nothing in the logs to explain it.

**Fix.** Use a bracket class so the pattern cannot match the shell's own
cmdline, and widen it to cover a production server too:

```sh
sh -c "pkill -f '[n]ext' || true; pkill -f '[n]pm run' || true"
```

`[n]ext` matches a target process running `next dev`, but not the shell, whose
literal cmdline text is `[n]ext`. Worth a comment at the call site — it reads
like a typo and will get "simplified" back into the bug otherwise.

---

## 3. Residual races in the deferred preview stop (open, low severity)

Follow-ups from the review of the 2026-07-22 deferred-stop change. Both are
strictly better than the eager-stop behavior they replaced; neither blocks use.

- **A stop already executing is invisible to every cancel point.** The timer
  callback deletes its map entry and *then* calls `sandboxProvider.stop()`
  (~9.5s under Vercel). During that window `cancelScheduledStop` is a silent
  no-op. A restore landing at ~T+180s can be handed a URL for a VM that is
  about to die, or — because `stop()` deliberately awaits any in-flight boot —
  have its freshly resumed sandbox stopped out from under it. Fix: keep the
  in-flight promise in the map with a `cancelled` flag the callback re-checks
  before calling `stop()`.

- **`runBuildPhase`'s cancel is one-shot.** It cancels once, before `start()`,
  then a build runs for minutes with no further server-side cancel. The client
  guard reads `jobStatus`, which has no cross-tab sync, so a stale second tab
  closing mid-build can re-arm a stop that kills the VM during the build;
  `syncFiles` then silently no-ops and the job can report `done` with a dead
  preview. Fix: check the session's latest job status server-side at fire time
  and skip while non-terminal, rather than trusting the client's guard.

**Stale comments** left by the same change, all now stating something false:
`src/server/sandbox.ts` (`SandboxProvider.stop`'s caller list — the interface
contract, the most important one), and three in `src/server/sandbox-vercel.ts`
(the `stop()` race-guard example, the catch-block caller list, and the "eager
stop" cost note).
