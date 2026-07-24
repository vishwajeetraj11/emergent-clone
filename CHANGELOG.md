# Changelog

Notable changes to the Emergent clone. Newest first.

## 2026-07-24 — Fix `killDevServer` killing its own shell instead of the dev server

**Before.** The kill was written as:

```sh
sh -c "pkill -f next || true; pkill -f 'npm run dev' || true"
```

`pkill -f` matches against full command lines, and the `sh` process's own
cmdline contains both patterns — so it matched itself and SIGTERMed itself.
Confirmed in the Vercel activity log: the command exits **143**, and the second
`pkill` never runs. `killDevServer` therefore never killed anything, while
appearing to succeed (errors are swallowed by design).

**Consequence.** Both call sites are restarts within a live VM — after
`npm install` so Next re-resolves modules, and when a stale-env or half-dead
server is holding the port. With the old server surviving, the replacement
`npm run dev -- -p 3000` found the port taken and Next bumped it
(`start-server.js`: "Port 3000 is in use ... using available port 3001
instead"). The preview URL is `sandbox.domain(APP_PORT)`, so it kept serving
the OLD server: stale code after an agent edit, or the dead credentials the
restart existed to clear. The health probe passed too — something was
answering on 3000 — so nothing surfaced the problem.

**Now.** Bracket classes, which cannot match the shell's own cmdline:

```sh
sh -c "pkill -f '[n]ext' || true; pkill -f '[n]pm run' || true"
```

`[n]ext` still matches a process running `next dev`, but not this shell, whose
cmdline holds the literal text `[n]ext`. The second pattern is widened from
`npm run dev` to `npm run` so a production server is covered too.

The call site carries a comment saying the brackets are load-bearing — it reads
like a typo and would otherwise get "simplified" straight back into the bug.

## 2026-07-22 — Move the builder to `/dashboard`, make `/` the landing page for everyone

**Before.** `/` meant two different things depending on who was looking:
`AppShell` for signed-in visitors, `LandingPage` for signed-out ones. A link
to the product's front door showed an existing user their own dashboard
instead of the pitch, and there was no stable URL for the marketing page.

**Now.** `/` is the landing page for everyone; the builder lives at
`/dashboard` (`src/app/dashboard/page.tsx`, which sends signed-out visitors
to `/sign-in` rather than rendering a shell whose every API call would 404 on
ownership). Since signed-in visitors now see the landing page too, its header
swaps "Sign in / Get started" for "Go to dashboard" via Clerk's
`<Show when="signed-in">` — this Clerk major replaced the old
`SignedIn`/`SignedOut` components with it. `AppShell`'s Home button points at
`/dashboard`, since "home" there means the builder's empty state, not the
marketing page.

Post-auth redirects are set as `signInFallbackRedirectUrl` /
`signUpFallbackRedirectUrl` props on `<ClerkProvider>` (`ClerkGate`) so the
routing lives in version control next to the routes it names. They take
precedence over `NEXT_PUBLIC_CLERK_SIGN_{IN,UP}_FALLBACK_REDIRECT_URL`, which
should be updated to `/dashboard` in every environment for consistency.

**Unconfigured (dev, default) is unchanged in spirit:** with no Clerk keys
there is no sign-in flow behind the landing page's CTAs, so every button on
it would dead-end. That mode redirects `/` straight to `/dashboard`,
preserving the single-user experience the root route had.

## 2026-07-22 — Give the three slowest fetches an actual loading state

**Bug.** Projects, credits, and session history each take seconds, and none
of them said so — every one modelled its data as `T | null`, a two-state
model for a four-state problem, so "loading" was indistinguishable from
"empty" or "failed":

- `ProjectsList` returned `null` for both `projects === null` (still
  fetching) and `[]` (genuinely none), so the list was blank space for ~2s
  and a brand-new user couldn't tell loading from "you have nothing yet".
- `CreditsPill` rendered the literal text **"Buy Credits"** until the
  balance arrived — not a loading state but a confidently wrong one, on
  screen for the whole fetch, then replaced by "704 credits".
- `ChatPanel` showed **"No activity yet"** while a session's history was
  still in flight, which is a false statement about a session that may have
  a long history. `useAgentSession` already tracked `isLoadingProject`;
  `AppShell` simply never passed it down.

**Fix.** Skeleton rows for the project list (empty still renders nothing, so
the onboarding carousel isn't displaced); a pulsing placeholder in the
credits pill; skeleton timeline entries while a project loads, with
`isLoadingProject` wired through `AppShell` to `ChatPanel`. Loading and
empty are now distinct states everywhere.

Only the *first* balance load counts as loading — `useCredits` refetches on
every `jobStatus` change, and flashing a placeholder over a balance already
on screen would flicker for no reason.

**Follow-up: the placeholders themselves had to stop shifting the layout.**
A skeleton that isn't the size of what replaces it just moves the jank
rather than removing it. Three fixes:

- `<UserButton />` renders from Clerk's own client bundle, so it occupies
  zero width until that bundle mounts — in the topbar's flex row, popping
  from 0 to ~28px shoved every sibling sideways on every page load. It now
  sits in a fixed `size-7` slot, as does the DEV_USER fallback.
- The project-list skeleton was a hardcoded 3 rows resolving into 6, growing
  the block ~114px. Because `PreviewPanel` centers that column
  (`justify-center`), the growth also dragged the onboarding carousel above
  it upward. It now renders `SKELETON_ROWS = 6` — the container's own
  `max-h-64` cap, past which the list scrolls — so the placeholder can only
  shrink, never jump.
- The credits placeholder is `w-[68px]` (the loaded pill measures 88px with
  20px of padding, so the pill is now identical in both states) and
  `rounded-full` rather than `rounded-sm`, since a sharp-cornered bar inside
  a 28px-tall pill with a 12px radius read as the shape changing on load.

## 2026-07-22 — Stop doing a Clerk fetch and two DB writes on every authenticated read

**Bug.** `getCurrentUser` (`src/lib/auth.ts`) runs on every authenticated
request — 34 API call sites reach it via `authz.ts`'s `assert*Ownership`,
which needs "who am I" before it can compare against a resource's owner. It
did a Clerk Backend API fetch (`currentUser()`) *and* a DB write
(`insert ... onConflictDoUpdate ... returning`) every single time. Both exist
only to provision a `users` row that, per user, is needed exactly once —
Clerk owns identity but `projects.userId` foreign-keys to this app's own
`users.id`, so a mapping row has to exist, and no Clerk webhook exists to
create it. `GET /api/credits` added a third: `ensureSignupBonus` wrote a
ledger row on every poll of a *balance*.

Against a remote Neon instance those were the whole cost — the observed
2.8-7.1s on `/api/projects` and 5.5-9.6s on `/api/projects/[id]` were a
serialized round-trip count, not query cost.

**Fix.** Read before write, on all three. `getCurrentUser` now resolves
`userId` from `auth()` (in-process, no round trip) and looks the row up by
`users.clerkUserId` (unique-indexed) — one cheap read on the common path,
with the Clerk fetch and the upsert moved to a cold branch that only runs on
a user's genuinely-first authenticated request. Same for
`ensureSignupBonus`. Both keep `onConflict*` on the cold path, since two
concurrent first requests can still race the lookup. `getCurrentUser` is
wrapped in React `cache()` so `/api/projects/[id]`, which resolves the user
twice (ownership check + handler), now does it once. `assertOwnership`'s two
independent lookups run under `Promise.all` instead of back to back.

**Measured** (warm): `/api/projects` 2.8-7.1s → 1.9s, `/api/credits`
3.2-7.5s → 2.8s. `/api/projects/[id]` is essentially unchanged at 7.6s —
auth was never its main cost; it issues several sequential queries of its
own, which is now the dominant remaining cost there.

**Tradeoff.** `email`/`name` no longer re-sync from Clerk on every request,
so a profile edited in Clerk won't reach this table until a `user.updated`
webhook exists (`src/app/api/webhooks/` has only `stripe`). Safe today:
those columns feed ownership and Stripe receipts, and the UI renders Clerk's
own `<UserButton>`, which reads from Clerk directly.

**Not verified.** The cold path — provisioning a brand-new Clerk user's row
— needs a never-before-seen login to exercise. Same caveat this file already
carried for the whole configured branch.

## 2026-07-22 — Defer the preview sandbox stop instead of firing it on every `pagehide`

**Bug.** `pagehide` fires identically on a real tab-close and on a plain page
refresh — the event carries nothing that distinguishes them. The client's
teardown beacon therefore stopped the sandbox VM on every refresh, and the
refresh's own follow-up load immediately cold-resumed it. Measured on one
refresh of a project page: `stop-preview` 200 in 9.5s, then `restore` 200 in
20.3s. ~30s of dead time, on the single most common interaction in the app.

**Fix.** `/api/sessions/[id]/stop-preview` no longer stops anything itself.
It schedules the stop 180s out via a new `src/server/preview-stop-scheduler.ts`
(module-level `Map<sessionId, Timeout>`, same in-process-state pattern as the
sandbox registry and job state) and returns immediately. Anything that proves
the session is still being watched cancels the pending timer: `/restore`, every
`/preview-health` poll, and `runBuildPhase` right before it starts a sandbox of
its own. Since an open tab polls health every 45s — well inside the 180s
window — the timer can only ever reach zero when nothing is actually watching.

**Verified.** A refresh now costs `restore` 6.8s/8.8s with no VM stop at all
(the sandbox is simply still running, so restore takes its adopt-already-
serving path). `stop-preview` returns in 3.2s, and that remainder is the
`assertSessionOwnership` DB round trip, not sandbox work. The timer still
fires when genuinely abandoned: with no tab polling, the VM reported
`running` through 170s and `stopped` at 191s.

**Not changed.** The agent failure paths in `agent-phases.ts` still call
`sandboxProvider.stop()` directly and immediately — teardown after a failed
build must not be deferred. The client is unchanged apart from a doc comment;
it still fires the same beacon at the same moment, only the server's response
to it differs.

**Cost.** A genuinely closed tab now bills up to 3 extra idle minutes. If the
main server restarts with a timer pending, the timer is lost and the VM idles
until `SANDBOX_TIMEOUT_MS` (45 min) — the pre-existing backstop under the
Vercel provider, not a new failure mode. Note that backstop is Vercel-only:
the local provider has no timeout mechanism, so a lost timer there leaves the
detached dev-server child running.

## 2026-07-21 — Free local testing: Claude CLI runtime behind `AGENT_RUNTIME=claude-cli`

**Problem.** The model-picker rewrite replaced the Claude Agent SDK runtime —
which rode the user's free local `claude login` subscription — with a Vercel
AI SDK runtime billing metered `ANTHROPIC_API_KEY` calls. Testing constantly
now means paying API rates for what used to be free.

**Fix.** Wire the CLI runtime back as a second backend behind the exact same
seam every phase already calls, `runAgentQuery` (`src/server/llm.ts`):
`AGENT_RUNTIME=claude-cli` makes Anthropic models available with no API key
at all, and dispatches those calls to a new `runAgentQueryViaClaudeCli`
(`src/server/llm-claude-cli.ts`) that spawns the local `claude` CLI —
authenticated by whatever subscription it's already logged into — instead of
calling the metered API. Re-adds `@anthropic-ai/claude-agent-sdk` at the
pre-rewrite version. Tool calls map onto the CLI's own native Bash/Read/
Write/Edit/Glob/Grep where possible; the two custom tools (`ask_user`,
`report_review`) bridge into an in-process MCP server so the *same* handlers
the AI SDK path already built keep running, just over a different transport.

**Not changed.** OpenAI models and BYOK still resolve exactly as before —
this is a platform-operator dev switch, not a per-job option, so a job's own
Anthropic key does not opt back out of CLI mode once it's set. Leaving
`AGENT_RUNTIME` unset keeps the metered AI SDK runtime as the only path, byte
for byte.

Also split the now-larger `src/server/agent.ts` along its own section
headers — prompts/DB notes into `agent-prompts.ts`, the mock trajectory into
`agent-mock.ts`, the ask_user machinery into `agent-interaction.ts` — pure
moves, no behavior change.

## 2026-07-21 — Fix context loss at the review/debug agent handoffs

**Bug.** The agent pipeline (plan → build → review → debug) runs each phase
as a fresh LLM context. The plan → build handoff carried the user's original
request and the approved plan, but the two later handoffs dropped them:

- The **review** phase's entire prompt was *"Review the app that was just
  built or edited in this working directory."* — the reviewer never saw what
  the app was supposed to be. It could only judge generic code quality,
  could not flag "doesn't do what was asked" at all, and could misreport
  deliberate plan decisions as defects.
- The **debug** phase received only the review's finding strings. A fixer
  with no knowledge of the request could "fix" findings in ways that broke
  the app's actual intent.

This is the classic multi-agent context-transfer failure — every agent
boundary is a lossy compression of context, and downstream agents that need
the *why* (not just the *what*) get neither. Identified after reading
<https://michaellivs.com/blog/multi-agent-context-transfer/> and auditing
our handoffs against its failure modes.

**Fix.** Widen the interface at both boundaries instead of merging the
agents (`src/server/agent.ts`):

- `runReviewPhase` now receives the original request + approved plan text
  and is explicitly told to review against that intent — a mismatch with
  the request is now a reportable finding, and deliberate plan choices are
  not.
- `runDebugPhase` now receives the original request and is instructed to
  keep every fix consistent with it.
- Both values thread through `runReviewAndDebugTail` from `runBuildPhase`,
  which already had them in scope; no schema, event, or client changes.

**Not changed (already sound).** Plan → build already carried the request +
plan; the shared working directory serves as a self-explanatory artifact;
`report_review` is a structured interface; the human plan-approval gate
inserts real context at the riskiest boundary. The pipeline stays linear,
so coordination overhead (the article's other failure mode) does not apply.
