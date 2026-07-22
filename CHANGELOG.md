# Changelog

Notable changes to the Emergent clone. Newest first.

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
