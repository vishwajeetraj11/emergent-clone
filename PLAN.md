# Emergent Clone — Build Plan

Goal: clone the core product loop of app.emergent.sh — describe an app in chat, an agent
builds it (asks clarifying questions, writes code, runs it), you watch files/progress stream
in, get a live preview, then fork, save to GitHub, or deploy.

Grounded in the screen recording (2026-04-28) of the real dashboard:

- **Layout**: top bar (logo, App builder toggle, Home, per-project tabs like `quiz-builder-223`,
  Buy Credits, notifications, avatar) · left panel = agent chat/timeline · right panel = App Preview.
- **Agent timeline widgets**: clarifying Q&A at kickoff (generation method, model choice, auth,
  extra features), tool-use cards ("Viewing 9 paths" with a tabbed file viewer — `server.py`,
  `.env`, `requirements.txt`, `tailwind.config.js`), sub-agent chips ("Design Agent is running…",
  "4 Design Agent messages", a "Finish Sub-Agent" stop button), whimsical status lines
  ("Making things click…", "Brewing something nice…"), a global stop button, message input
  with attachments + voice, **Save (GitHub)** and **Fork** buttons.
- **Preview panel**: while the agent initializes it shows an onboarding carousel
  ("Deploy Your Application", "1M Context Window", "Manage Agent Context With Forks", "Assets")
  with an "Initializing agent…" pill; once the app runs it becomes a live iframe.
- **Wire protocol** (visible in DevTools): SSE streams per job (`stream?job_id=…`) carrying
  trajectory events (`{"trajectories": …}`, `{"status": "no_stream_found"}`), plus polling
  endpoints (`latest`, `envs`, config). Generated stack is React + Tailwind frontend,
  FastAPI + MongoDB backend (`MONGO_URL`, `DB_NAME`, `CORS_ORIGINS` in `.env`).

## Architecture

| Concern | Choice |
|---|---|
| Web app | Next.js (App Router) + Tailwind + shadcn/ui, dark theme |
| Agent loop | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, wraps the local `claude` CLI) — runs against the operator's Claude Code subscription auth, no `ANTHROPIC_API_KEY` needed for local dev. Custom `ask_user` tool via an in-process SDK MCP server; Phase 2's file-write/run-command tools are the SDK's built-in Read/Write/Edit/Bash, gated per phase via `allowedTools`. Deploying this to a hosted environment later needs its own auth story (API key or provisioned CLI credentials) — local dev doesn't. `MOCK_AGENT=1` remains the scripted fallback |
| Code execution / preview | One `SandboxProvider` interface with a single implementation to start: Vercel Sandbox (Firecracker microVMs) — one sandbox per active session, exposes a preview URL for the iframe. A Docker implementation only if Vercel Sandbox proves limiting; never maintain both in parallel during MVP |
| Streaming | SSE endpoint `GET /api/jobs/:id/stream` emitting trajectory events (message, tool_call, file_written, status, question) — mirrors Emergent's `stream?job_id`. Client sends last event cursor (`Last-Event-ID` = job-scoped `events.seq`) so reconnects resume, since the append-only `events` table is the source of truth |
| DB | Postgres (Neon via Vercel Marketplace, or local Postgres in dev) — users, projects, sessions, trajectory events, file snapshots, forks, credit ledger |
| Auth | Clerk — added in Phase 3. Until then the app runs single-user dev mode (hardcoded user row) so the core loop is never blocked on credentials |
| GitHub export | GitHub App + octokit: create repo, push sandbox filesystem |
| Deploy ("Deploy Your Application") | v1 = deploy generated app to Vercel via API; managed hosting abstraction later |
| Billing | Credit ledger decremented per agent-token usage; Stripe top-ups ("Buy Credits") last |

## Data model (first cut)

`users` · `projects` (name slug like `quiz-builder-223`, status) · `sessions` (fork lineage:
`parent_session_id`) · `jobs` (agent runs; status running/waiting_on_user/done/stopped) ·
`events` (append-only trajectory: role, type, payload JSON — the SSE source of truth) ·
`files` (latest snapshot per session for the viewer + GitHub export) · `credit_ledger`.

## Phases

**Phase 0 — Scaffold (½ day)**
`git init` + Next.js + Tailwind + shadcn, Postgres + Drizzle schema above (local Postgres or
Neon — no auth yet, single-user dev mode), dark shell: top bar, project tabs, empty chat +
preview panes.

**Phase 1 — Chat + agent loop (core)**
Prompt box ("What will you build today?") → creates project + job. Agent (Claude) runs
server-side with tool-calling; first turn asks 3–5 clarifying questions rendered as a Q&A
card; answers resume the job. All steps append to `events`; SSE streams them to the
timeline with status lines and a stop button. Token usage per job is logged into `events`
from this phase on (metering data exists long before billing UI does).

**Phase 2 — Sandbox build + preview + file viewer**
Give the agent `write_file`/`run_command` against a Vercel Sandbox. Template for generated
apps: **Next.js fullstack** (committed decision for MVP — see Risks; the FastAPI+Mongo
template that matches the real product comes in Phase 5+).
"Viewing N paths" cards open the tabbed read-only file viewer. When the dev server is up,
swap the carousel for the live preview iframe. Onboarding carousel while initializing.

**Phase 3 — Auth, persistence, fork, GitHub save**
Clerk auth lands here (GitHub save needs real user identity anyway; single-user dev mode
retired). Sessions restorable (files snapshot → new sandbox). Fork = copy session + files +
context into a new session ("Manage Agent Context With Forks"). Save = push snapshot to a
GitHub repo via GitHub App.

**Phase 4 — Deploy + credits**
One-click deploy of the generated app (Vercel API) with env management (`envs` endpoint).
Credit metering on token usage, Buy Credits page (Stripe).

**Phase 5 — Polish**
Notifications, home dashboard listing projects, attachments/assets upload ("Assets"),
voice input, sub-agent visualization (Design Agent chips + "Finish Sub-Agent").

## MVP = Phases 0–2

One agent, one sandbox template, clarifying questions, streamed trajectory, file viewer,
live preview. Fork/GitHub/deploy/credits layer on after the loop feels right.

## Risks / decisions

- **Sandbox lifecycle** is the hard part: cold-start time, keeping dev servers alive between
  messages, cost. Decide early between long-lived sandbox per active session vs. rehydrate-on-demand.
- **Generated-stack choice**: cloning Emergent's FastAPI+Mongo template is faithful but doubles
  runtime complexity; a Next.js template gets the loop working sooner. Recommend Next.js for MVP,
  add the FastAPI template in Phase 3+.
- **Agent cost control**: cap tool iterations per job; token usage is logged into `events` from
  Phase 1 so the Phase 4 credit ledger backfills from real data.
- **Deploying user apps** (Phase 4): pushing generated apps to Vercel requires a token/team
  scope decision — deploy into *our* team under a subdomain (simple, do this first) vs. the
  user's own Vercel account via OAuth (later).
- **Product-agent model split**: the in-product builder agent should run Sonnet-class models
  for cost; reserve stronger models for its planning/architecture turns if quality demands it.

## Build orchestration (how we build this, not part of the product)

- **Planner / Architect / Integrator — Fable 5 (main loop)**: phase planning, design
  decisions, task sequencing, plan upkeep.
- **Executor — Sonnet 5 subagents**: one scoped implementation task per spawn, per phase.
- **Code reviewer — Fable 5** (`/code-review`) after each executor pass; fixes go back to a
  Sonnet executor.
- **Verifier**: end-to-end run of the affected flow (dev server + browser) before phase
  sign-off — not just typecheck/tests.
- **Debugger**: Sonnet first pass; escalate stuck root-causes to Fable.
- **Security review** (`/security-review`) once before Phase 4 ships (billing + deploy surface).

Cadence per phase: plan (Fable) → execute (Sonnet) → review (Fable) → verify → commit.
