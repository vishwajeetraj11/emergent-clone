# Codebase tour

Ten phases, in reading order. Each builds on the last — phase 5 won't make sense
without phase 4's event model, and phase 7 won't without phase 6's sandbox.

Roughly 5,000 lines of server code and 3,000 of client. Budget an hour or two
for the whole thing, or read one phase when you need to touch that area.

The **Traps** in each phase are things that have actually caused confusion or
bugs here, not hypotheticals.

---

## Phase 1 — Orientation

**Goal:** know what this app is and why the usual assumptions don't hold.

**Read:** `AGENTS.md`, `README.md`, `.env.example`, `docs/setup.md`, `package.json`

Emergent Clone is a Lovable/Bolt-style app builder. A user describes an app in chat;
an LLM agent plans it, writes it, reviews it, and runs it in an isolated VM with
a live preview. The user can then save it to GitHub or deploy it to Vercel.

The single most important thing on arrival is `AGENTS.md`: **this is Next.js 16**,
which renamed `middleware.ts` to `proxy.ts` among other breaking changes. The
installed docs ship at `node_modules/next/dist/docs/` — read those rather than
trusting memory. Same applies to React 19.2, AI SDK 7, Tailwind 4, and zod 4.

**Traps**
- Required config is genuinely required: Clerk, the three Vercel sandbox vars,
  all four R2 vars, `NEON_API_KEY`, and at least one LLM key. Several throw
  rather than degrading.
- `npm run db:push` applies DDL directly with no migration file. Fine now,
  dangerous once there's data worth keeping.

---

## Phase 2 — The data model

**Goal:** internalise the four-level hierarchy. Everything else is a consequence.

**Read:** `src/db/schema.ts` (top to bottom, it's well commented), `src/db/index.ts`

```
Project   one app, owned by a user. Has one Neon project.
  Session one line of development. Owns a file snapshot, a Neon BRANCH,
          a sandbox VM, and an auth secret. Forking makes a sibling.
    Job   one agent run. A session accumulates many.
      Event  append-only log row. The UI is a replay of these.
```

`sessions.parentSessionId` is a self-reference recording fork lineage.

**Key idea:** the event log is the source of truth for anything the user sees in
chat. Nothing is mutated in place, which is why a page refresh loses nothing and
why answers arrive as *separate later events* rather than edits to a question.

**Traps**
- `getDb()` is lazy on purpose — nothing may touch `DATABASE_URL` at module
  import time, or `next build` breaks.
- `jobs.agent_session_id` is a **dead column**, marked as such. Nothing writes it.
- `sessions.vercel_sandbox_id` is probably also dead — `name: sessionId` is the
  sandbox's durable identity now. Unverified.

---

## Phase 3 — Auth and ownership

**Goal:** know who a request is, and what they're allowed to touch.

**Read:** `src/lib/auth.ts`, `src/lib/authz.ts`, `src/proxy.ts`, `src/app/layout.tsx`

Clerk is **required in every environment**, including dev. `getCurrentUser()`
maps a Clerk identity to this app's own `users` row, provisioning it just-in-time
on first authenticated request. `assertOwnership` joins jobs → sessions →
projects to check the acting user owns a resource.

**Key idea:** auth is deliberately the *one* integration with no `isXConfigured()`
off switch. Everywhere else, absent credentials remove a feature. For auth they
would remove a restriction — and absence is the default state of every
misconfiguration. It used to fall back to a fixed `DEV_USER`, which meant a
deploy missing the Clerk vars came up as a public single-identity builder.

**Traps**
- `ForbiddenError` must map to a **404**, never a 403 — a 403 confirms a resource
  exists and lets someone enumerate other users' ids.
- Route protection lives per-page via `auth()`, not in `proxy.ts`. Clerk's
  `createRouteMatcher` middleware pattern is deprecated.

---

## Phase 4 — Events and the job lifecycle

**Goal:** understand how the server talks to the browser.

**Read:** `src/lib/types.ts`, `src/server/events.ts`, `src/server/jobs.ts`,
`src/app/api/jobs/[id]/stream/route.ts`

A job moves through `running` → `waiting_on_user` | `waiting_on_plan` → `done` |
`stopped` | `failed`. Events (`user_message`, `assistant_message`, `tool_call`,
`question`, `answer`, `plan`, `plan_decision`, `files_changed`, `preview_ready`,
`usage`, `status`, `error`) stream to the client over SSE from a cursor, so a
reconnect replays from where it left off.

The two waiting states are distinct on purpose: `waiting_on_user` means an
`ask_user` tool call is pending; `waiting_on_plan` means a written plan awaits
approve/revise.

**Traps**
- The agent loop is a **detached promise in this process**. A server restart
  mid-run orphans the job — its status stays whatever it was and nothing resumes
  it. This is the "durability note" other files reference. A durable queue is the
  fix and isn't built.

---

## Phase 5 — Agent orchestration

**Goal:** follow one prompt from text to working app.

**Read:** `src/server/agent.ts` (header first), then `agent-prompts.ts`,
`agent-phases.ts`, `agent-tools.ts`, `agent-interaction.ts`, `llm.ts`

```
Plan (Opus) → user approves/revises → Build (Sonnet) → Review (Sonnet)
                                                          ↓ only if issues
                                                       Debug (Sonnet)
```

The planner must open with `ask_user` clarifying questions. Its handler **blocks**
inside the tool call, polling the events table until the answer lands. The plan
gate works the same way but is driven by the harness rather than a tool, since
writing a plan isn't itself a tool call. Revisions cap at 5; the last is flagged
`isFinal` and becomes approve-or-stop.

The reviewer runs in a **fresh context** and is handed the original request plus
the approved plan — without them it could only judge generic code quality and
would flag deliberate plan decisions as defects.

**Key idea:** `dbAware()` appends database instructions to the prompts. This is
why `NEON_API_KEY` is required — the rule forbidding fake localStorage logins
lives *inside* that note, so an unconfigured environment would produce apps with
pretend auth.

**Traps**
- `MOCK_AGENT=1` runs a scripted trajectory with identical event shapes. It stops
  after plan approval and does **not** simulate a build.
- "Phase" in `agent-prompts.ts` means the agent's scope/build phases, unrelated
  to anything else.

---

## Phase 6 — The sandbox

**Goal:** understand where generated code actually runs.

**Read:** `src/server/sandbox.ts` (the interface), `sandbox-vercel.ts`,
`sandbox-vercel-config.ts`, `preview-stop-scheduler.ts`

Every generated app runs in a Vercel Sandbox — a Firecracker microVM that also
serves the preview over a public HTTPS domain. `name: sessionId` is the VM's
durable identity, so `Sandbox.getOrCreate` collapses lookup-or-create into one
call and no id needs storing.

**Key ideas**
- **Env hygiene:** nothing from this process's `process.env` ever enters a VM.
  Its only environment is its base image plus the `.env.local` written at create.
- **stop() is a pause,** not a delete — it snapshots the filesystem and the next
  `getOrCreate` resumes in seconds.
- Closing a tab schedules a stop 3 minutes out rather than doing it immediately,
  because `pagehide` can't distinguish a refresh from a close. Anything proving
  the session is still watched cancels the timer.

**Traps**
- `killDevServer`'s patterns are bracketed (`[n]ext`) on purpose — a plain
  `next` matches the `sh` process running the pkill, so it SIGTERMs itself and
  kills nothing. Don't "simplify" the brackets away.
- The 180s readiness wait and the 45-minute timeout are both tuned from real
  failures. Don't lower either without reading why.

---

## Phase 7 — Files and persistence

**Goal:** understand what survives a VM dying.

**Read:** `src/server/files.ts`, `src/server/r2.ts`,
`src/app/api/sessions/[id]/restore/route.ts`

**"R2 = bytes, DB = index":** each `files` row holds only `{path, hash}`; the
bytes live in R2 under `sessions/<sessionId>/<path>`. `snapshotSessionFiles`
reads the tree out of the live VM after a build; `getSessionFiles` hydrates it
back. R2 is required — there's no DB-inline fallback.

**Key idea:** *the VM is disposable, the snapshot is the app.* Restore, fork,
GitHub export, and deploy all read the snapshot, never a live sandbox.

**Traps**
- `.env` and `.env.local` are excluded from snapshots so secrets never reach the
  file viewer, GitHub, or a fork.
- The template is a **fork point, not a live dependency**: a session reads
  `sandbox-template/` once, at creation. Editing the template never reaches
  existing sessions. That's `KNOWN-ISSUES.md` issue 1, and the fix design is
  written up there.
- `r2.ts` uses `@aws-sdk/client-s3` because R2 is S3-compatible. The "S3" naming
  is correct, not leftover.

---

## Phase 8 — Per-app databases

**Goal:** understand how a *generated* app gets its own database and login.

**Read:** `src/server/project-db.ts`, then `BUILD_DB_NOTE` in `agent-prompts.ts`

One Neon project per Emergent Clone project, one Neon **branch** per session — so a
fork's database is a copy-on-write snapshot of its parent, matching the fork's
copied files. The connection string and a per-session auth secret are written
into the VM as `.env.local`, which `next dev` loads natively.

Generated apps get real better-auth email/password accounts against that
database. Never a localStorage mock.

**Key ideas**
- The auth secret must stay **stable across resumes** — better-auth signs session
  cookies with it, so rotating it logs everyone out.
- A fork **inherits** the parent's secret, so pre-fork logins keep working on both.
- `BETTER_AUTH_URL` must be pinned to the preview origin, or every sign-in POST
  fails with "Invalid origin" behind the preview proxy.

**Traps**
- A missing `NEON_API_KEY` throws (`NeonNotConfiguredError`); a transient Neon API
  failure is logged and the sandbox still boots. Only the config error is fatal.

---

## Phase 9 — The client

**Goal:** see how the UI mirrors all of the above.

**Read:** `src/lib/hooks/useAgentSession.ts` (the big one), `AppShell.tsx`,
`ChatPanel.tsx`, `Timeline.tsx`, `PreviewPanel.tsx`

`useAgentSession` owns nearly all client state: creating a project, subscribing
to the SSE stream, answering questions, plan decisions, restore, fork, save,
deploy, continue-chat. `Timeline` renders events into cards. `PreviewPanel` holds
the iframe and the paused/restoring states.

Shared code lives in `src/lib/utils/`, `src/lib/constants/` (including
`api-routes.ts`, the one place client API paths are written), and
`src/lib/hooks/`. Components hold component logic only.

**Traps**
- Fork and version-switching are **implemented but hidden** — the buttons were
  removed in `7d11d65`. `POST /sessions/[id]/fork` and
  `GET /projects/[id]/sessions` still work and have no callers. `onFork` is a
  dead prop.
- Because a project resolves to its *most recent* session, a fork becomes the
  session you land on, and without the switcher the original is unreachable.

---

## Phase 10 — Money and outbound integrations

**Goal:** understand billing and the ship-it features.

**Read:** `src/server/credits.ts`, `razorpay.ts`, `github-app.ts`, `vercel.ts`,
then `KNOWN-ISSUES.md` and `CHANGELOG.md`

Every model call emits a `usage` event and debits the ledger at that specific
model's published rate — planner and builder differ materially, so cost is
computed per call, not flat. 1 credit = $0.01, priced at cost. Top-ups go through
Razorpay Checkout against a server-created Order. The callback and the
webhook both grant, keyed on the payment id, so exactly one lands.

GitHub Save uses a real App installation token. Vercel Deploy posts to
`/v13/deployments`.

**Traps**
- Credits and the purchase callback are **live-verified** (a real test-mode
  payment granted exactly one ledger row). The **webhook** is not — it needs a
  public URL. Signature
  verification and purchase idempotency have not been exercised.
- Vercel deploy is likewise code-complete but unverified.
- An installation token can't create a repo on a *personal* GitHub account — a
  platform restriction. Either install on an org or configure the OAuth client
  vars. See `docs/setup.md`.

Finish by reading `KNOWN-ISSUES.md` in full. It carries the diagnosis for open
defects so nobody re-derives them.

---

## Where to start for a given task

| Task | Phases |
| --- | --- |
| Change what the agent builds | 5, 8 |
| Fix a preview that won't load | 6, 7 |
| Add an API route | 3, 4, 9 |
| Touch billing | 2, 10 |
| Change the generated app template | 6, 7 — and read issue 1 first |
| Anything user-facing in chat | 4, 9 |
