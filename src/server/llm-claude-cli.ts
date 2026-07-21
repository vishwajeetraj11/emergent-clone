import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  query,
  tool as sdkTool,
  type SDKResultError,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentQueryUsage, RunAgentQueryOptions, RunAgentQueryResult } from "@/server/llm";
import { askUserInputShape, reportReviewInputShape } from "@/server/agent-tools";

// ---------------------------------------------------------------------------
// Claude CLI runtime backend for runAgentQuery (src/server/llm.ts), dispatched
// to when AGENT_RUNTIME=claude-cli and the requested model is Anthropic's —
// see isClaudeCliRuntime()/the dispatch comment in llm.ts. This rides the
// local `claude` CLI's own subscription auth (no ANTHROPIC_API_KEY needed)
// instead of the metered AI SDK path, so local testing is free again.
//
// This is the pre-AI-SDK-rewrite runtime, revived behind that env var. The
// reference is the deleted implementation at `git show 1da2093^:src/server/agent.ts`
// (its query()/MCP/stream/usage/env handling) — mirrored here behind the SAME
// contract every AI SDK call site already speaks (RunAgentQueryOptions /
// RunAgentQueryResult), so agent.ts itself needs no per-backend branching:
// every phase just calls runAgentQuery() and this module (or the AI SDK path)
// answers depending on the dispatch above.
//
// TOOL MAPPING: options.tools is an AI-SDK ToolSet (src/server/agent-tools.ts).
// The six file tools (bash/read/write/edit/glob/grep) have their in-process JS
// implementations DROPPED here — the CLI's own native Bash/Read/Write/Edit/
// Glob/Grep tools do that work instead, enabled only for whichever of those
// six names the call site actually passed (review passes just the read-side
// four; its restriction to no Write/Edit carries over intact). Any other
// entry (ask_user, report_review) is bridged into one createSdkMcpServer so
// its *same* AI-SDK `execute` — the one agent.ts already built — still runs;
// only the transport differs. Zod validation for those two is shared with
// the AI SDK path via agent-tools.ts's exported raw shapes, so both runtimes
// accept identical input.
// ---------------------------------------------------------------------------

/** AI-SDK ToolSet key -> the CLI's built-in tool name it's replaced by here. */
const NATIVE_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
};
/** Reverse of the above, for translating a native tool_use block's name back to the AI-SDK-facing name agent.ts's onToolCall callbacks already key their own logic on (e.g. "if (call.name === 'ask_user') return"), so that logic behaves identically regardless of which backend ran the call. */
const NATIVE_TOOL_NAMES_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(NATIVE_TOOL_NAMES).map(([aiSdkName, nativeName]) => [nativeName, aiSdkName])
);

/** Raw Zod shapes for the non-file tools agent.ts may pass through options.tools, keyed by the same name the AI-SDK ToolSet uses them under — see agent-tools.ts's exported shapes for why these are shared rather than re-derived. */
const BRIDGED_TOOL_SHAPES: Record<string, Record<string, z.ZodTypeAny>> = {
  ask_user: askUserInputShape,
  report_review: reportReviewInputShape,
};

const MCP_SERVER_NAME = "emergent";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** A tool_use block's raw `name` -> the AI-SDK-facing name agent.ts's callbacks expect, undoing whichever of the two mappings above applied (MCP-bridged or native-builtin); anything else (shouldn't happen — these are the only two shapes agent.ts ever builds) passes through unchanged. */
function unqualifyToolName(name: string): string {
  if (name.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
  return NATIVE_TOOL_NAMES_REVERSE[name] ?? name;
}

// ---------------------------------------------------------------------------
// Production credential swap point — verbatim from the deleted reference
// (git show 1da2093^:src/server/agent.ts, ~lines 250-270).
//
// Returns `undefined` when ANTHROPIC_API_KEY is not set in the server's own
// process environment — the SDK's `query()` then omits `options.env`
// entirely, so the subprocess inherits this process's shell environment and
// falls through to the local `claude` CLI's own login (Claude Code
// subscription auth). This is the default, always-tested path in this
// environment: no ANTHROPIC_API_KEY is set here, so every call site below
// passes `env: getAgentEnv()` === `env: undefined`, which is exactly what
// those call sites did before this function existed (they simply didn't set
// `env` at all).
//
// Returns `{ ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }`
// only once a real, centrally-held key is configured for a production
// deploy. No other code changes are needed to swap credential sources: this
// is the one function a production deployment's ops config needs to make
// true.
// ---------------------------------------------------------------------------
function getAgentEnv(): Record<string, string | undefined> | undefined {
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  return { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
}

/** Maps a non-success result message to a human-readable failure string — mirrors the reference's describeResultError. */
function describeResultError(message: SDKResultError, maxTurns: number): string {
  if (message.subtype === "error_max_turns") {
    return `Reached the maximum of ${maxTurns} agent iterations for this job.`;
  }
  if (message.subtype === "error_max_budget_usd") {
    return "Reached the maximum budget for this job.";
  }
  if (message.errors.length > 0) {
    return message.errors.join("; ");
  }
  return `Agent run failed (${message.subtype}).`;
}

export async function runAgentQueryViaClaudeCli(
  options: RunAgentQueryOptions
): Promise<RunAgentQueryResult> {
  // Split the AI-SDK ToolSet into "native CLI builtin" vs. "bridge into an
  // in-process MCP server" — see this module's header comment.
  const nativeToolNames: string[] = [];
  const bridgedToolDefs: ReturnType<typeof sdkTool>[] = [];

  for (const [name, aiTool] of Object.entries(options.tools ?? {})) {
    const nativeName = NATIVE_TOOL_NAMES[name];
    if (nativeName) {
      nativeToolNames.push(nativeName);
      continue;
    }
    const shape = BRIDGED_TOOL_SHAPES[name];
    // Defensive: agent.ts only ever passes the six file tools plus ask_user/
    // report_review through options.tools. Anything else is skipped rather
    // than crashing the job — there is nothing sensible to bridge it to.
    if (!shape || !aiTool.execute) continue;
    const execute = aiTool.execute;
    // aiTool.description is typed as `string | ((options) => string)` at the
    // AI SDK level (dynamic per-call descriptions), but every tool this
    // codebase builds (agent-tools.ts) passes a plain string — the function
    // form is unreachable here in practice; fall back to the tool's own name
    // rather than trying to invoke a description callback we don't have
    // real call context for.
    const description = typeof aiTool.description === "string" ? aiTool.description : name;
    bridgedToolDefs.push(
      sdkTool(name, description, shape, async (args) => {
        // The bridged handler is the SAME AI-SDK `execute` agent.ts already
        // built (e.g. ask_user's waitForAnswer-blocking handler in
        // agent-tools.ts) — only the transport differs. Its second argument
        // (ToolExecutionOptions: toolCallId/messages/context/...) exists for
        // AI-SDK-internal bookkeeping (telemetry, multi-step context) that
        // none of this codebase's tool implementations read; a minimal stub
        // satisfies it without pretending to reconstruct a real generateText
        // step here.
        const result = await execute(args, {
          toolCallId: randomUUID(),
          messages: [],
          context: undefined,
        } as unknown as Parameters<typeof execute>[1]);
        return { content: [{ type: "text" as const, text: String(result) }] };
      })
    );
  }

  const mcpServers: Record<string, ReturnType<typeof createSdkMcpServer>> =
    bridgedToolDefs.length > 0
      ? {
          [MCP_SERVER_NAME]: createSdkMcpServer({
            name: MCP_SERVER_NAME,
            version: "1.0.0",
            tools: bridgedToolDefs,
          }),
        }
      : {};
  const allowedTools = [
    ...nativeToolNames,
    ...bridgedToolDefs.map((t) => `${MCP_TOOL_PREFIX}${t.name}`),
  ];

  // Fully autonomous: there is no interactive TTY/canUseTool callback in this
  // server process to answer a permission prompt, and the build/review/debug
  // phases genuinely need Bash/Write/Edit to run unattended against the
  // sandbox directory — see the reference's identical rationale (checked
  // against node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts: bypassing
  // requires allowDangerouslySkipPermissions alongside permissionMode). Only
  // engaged when a native file tool is actually in play; planning/summary
  // (ask_user-only, or no tools at all) keep the reference's "default" mode,
  // which never needed bypassing — allowedTools already auto-allows their
  // one MCP tool, and there's no filesystem/shell access to gate.
  const needsBypass = nativeToolNames.length > 0;

  const q = query({
    prompt: options.prompt,
    options: {
      model: options.modelId,
      cwd: options.cwd,
      env: getAgentEnv(),
      systemPrompt: options.system,
      maxTurns: options.maxSteps,
      tools: nativeToolNames,
      mcpServers,
      allowedTools,
      strictMcpConfig: true, // ignore project .mcp.json / other MCP config
      settingSources: [], // ignore filesystem settings (user/project/local)
      permissionMode: needsBypass ? "bypassPermissions" : "default",
      ...(needsBypass ? { allowDangerouslySkipPermissions: true } : {}),
    },
  });

  const textParts: string[] = [];
  let usage: AgentQueryUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

  try {
    for await (const message of q) {
      if (options.shouldAbort && (await options.shouldAbort())) {
        await q.interrupt().catch(() => {});
        return { text: textParts.join("\n\n"), usage, aborted: true };
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            textParts.push(block.text);
            await options.onText?.(block.text, message.uuid);
          } else if (block.type === "tool_use") {
            await options.onToolCall?.({
              id: block.id,
              name: unqualifyToolName(block.name),
              input: block.input,
            });
          }
        }
        continue;
      }

      if (message.type === "result") {
        usage = {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cachedInputTokens: message.usage.cache_read_input_tokens,
        };
        // stopOnToolCall (e.g. review's "report_review") has no dedicated
        // early-exit here: the reference never force-stopped on it either
        // (grepped — its four abort points are all tied to the job-stopped
        // check, never to a specific tool call) — the review/debug system
        // prompts already instruct the model to call that tool "exactly
        // once, at the end", so the query naturally winds down on its own
        // right after, same as the reference. Cutting it off manually would
        // risk losing this very usage block for a real, billable turn if
        // done wrong (interrupting mid-flight isn't guaranteed to still
        // yield a `success` result to read usage from) — not worth it for a
        // saving that, unlike the metered AI SDK path, is moot here anyway
        // (this runtime's whole point is free subscription auth, not
        // per-token cost).
        if (message.subtype !== "success") {
          throw new Error(describeResultError(message, options.maxSteps));
        }
      }
    }
  } finally {
    q.close();
  }

  return { text: textParts.join("\n\n"), usage, aborted: false };
}
