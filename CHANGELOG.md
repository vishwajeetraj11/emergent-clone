# Changelog

Notable changes to the Emergent clone. Newest first.

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
