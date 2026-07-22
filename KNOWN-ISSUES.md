# Known Issues

Open defects with their diagnosis, so the investigation doesn't have to be
repeated. Fixed issues move to `CHANGELOG.md` and come out of this file.

---

## 1. Template fixes never reach existing sessions (open)

**Symptom.** A generated app loads in the preview iframe and looks fine — HTML
renders, CSS applies, all JS chunks return 200 — but it is completely inert.
Buttons do nothing. Anything gated behind a client effect never appears: an app
whose shell waits on a `useEffect` flag shows its loading spinner forever, and
an app that generates its content client-side renders an empty page. No console
error, no warning, no unhandled rejection, no Next.js error overlay. React
simply never hydrates.

**How to recognize it fast.** In the sandbox page, count React fibers:

```js
let n = 0;
for (const e of document.querySelectorAll('*')) {
  if (Object.keys(e).some(k => k.startsWith('__react'))) n++;
}
```

A healthy page has dozens (82 for the Habit Tracker app). A page hitting this
bug has ~2 — React is attached only to a hoisted `<link>` and to Next's own
devtools portal, never to the app tree.

**Root cause.** `next dev` blocks cross-origin requests to dev-only endpoints.
`node_modules/next/dist/server/lib/router-server.js:615` runs `blockCrossSiteDEV`
on the HTTP **upgrade** handler, so the Turbopack HMR WebSocket upgrade is
rejected unless the requesting host is in `allowedDevOrigins`. The dev server
boots as localhost; the browser reaches it at `https://sb-*.vercel.run`. The
socket closes `1006` without ever opening, and Turbopack's dev client entry
never resolves — so hydration never starts. Static HTML and chunks are served
by ordinary request handling and are unaffected, which is exactly why the page
looks healthy.

Confirmed causally, not just by correlation: taking a **working** local dev
app and redirecting only its `WebSocket` to a dead port reproduces the failure
signature exactly (fiber count drops to 2, empty body, no errors). One variable
changed.

**The fix already exists** in `src/server/sandbox-template/next.config.ts`:

```ts
allowedDevOrigins: ["*.vercel.run"],
```

Added in `3d247ac` (2026-07-19), the commit that introduced the Vercel provider.
Sessions created after it are fine.

**The actual open defect.** `VercelSandboxProvider.restoreFromSnapshot` seeds
the VM from the session's DB `files` snapshot, deliberately *not* from the
template — re-reading the template risks reverting agent edits to template-owned
files (see its doc comment). Correct as far as it goes, but the consequence is
that **no template fix ever reaches an already-existing session.** Sessions
whose snapshot predates `3d247ac` still carry the old empty `next.config.ts` and
will stay broken forever. Every future template change inherits the same blind
spot.

Affected sessions (checked against the `files` table), and the state of the
2026-07-22 manual data repair — each stale row had the *identical* untouched
`const nextConfig: NextConfig = {};`, so replacing it with the template
verbatim preserved no agent customization because there was none:

| session | project | created | state |
| --- | --- | --- | --- |
| `5f4e1b75` | guestbook-web-970 | Jul 21 | never affected |
| `39f75e9b` | personal-finance-296 | Jul 21 | never affected |
| `83064a15` | single-page-399 | Jul 19 | never affected |
| `37822353` | single-page-137 | Jul 19 | never affected |
| `22004529` | simple-color-140 | Jul 19 | repaired |
| `cc951e0c` | Habit Tracker | Jul 18 | repaired |
| `8baf3846` | Habit Tracker | Jul 17 | repaired |
| `15458342` | pipeline-retest-524 | Jul 19 | repaired |

All four are repaired and verified: every `next.config.ts` row in the `files`
table now contains `allowedDevOrigins`, zero stale. Note the verification is
of the stored snapshot, not of each app re-rendering — the mechanism itself
was proven end-to-end on `cc951e0c` (this exact config, hydrated and
interactive under `next dev`), so the remaining three follow from identical
data rather than from three separate live checks.

Sessions `9fa95770` (refactor-smoke-225), `2996695c` (orchestration-pipeline-843)
and `4a1e8157` (raf-batching-321) have **0 files** — they never built, so there
is no snapshot to repair and they will seed from the current template on their
first build.

A pre-repair backup of every `next.config.ts` row is in the session scratchpad
as `next-config-backup.json`.

None of this repairs the underlying defect: it patches the four rows that
happened to be stale today, and the next template change will strand every
session again.

**What a fix has to do.** Reconcile template-owned files into existing snapshots
without clobbering agent edits. A blanket "re-apply the template on restore"
re-introduces exactly the regression `restoreFromSnapshot`'s comment warns about.

**Note.** Session `cc951e0c`'s VM had the corrected `next.config.ts` written
directly to its disk during diagnosis, which is how the fix was verified
(app rendered, habit toggle worked, ring advanced to 33%, hot reload intact).
That patch is **not** in its DB snapshot, so the next restore reverts it.

**Dead end, recorded so it isn't retried.** Vercel Sandbox supports WebSockets
fine — a bare Node WS server on the exposed port accepts a browser connection
through the public domain and delivers frames (`OPEN @1162ms`, message
received). The sandbox proxy is not at fault, and switching the preview to
`next build` + `next start` "fixes" the symptom only by removing the dev
client entirely — it trades away hot reload to work around a one-line config
omission. Don't.

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
