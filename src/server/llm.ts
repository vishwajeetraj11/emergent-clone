import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  stepCountIs,
  hasToolCall,
  type LanguageModel,
  type StopCondition,
  type ToolSet,
} from "ai";
import { MODEL_CATALOG, getModelInfo, type ModelInfo } from "@/lib/models";

// ---------------------------------------------------------------------------
// Provider-agnostic LLM runtime (Vercel AI SDK) — replaces the Claude Agent
// SDK/`claude` CLI. Providers are env-gated with the same isXConfigured()
// idiom as GitHub/Neon/Vercel: a provider with no API key simply doesn't
// exist — its models are filtered out of the picker (getAvailableModels) and
// resolveModel throws a clear error if something still asks for one.
//
// NOTE the cost-model change this implies for Anthropic: the old CLI rode
// the local `claude login` subscription; this runtime uses the metered API
// via ANTHROPIC_API_KEY. No key -> Claude models hidden, planner falls back
// to the strongest OpenAI model (resolvePlannerModel).
// ---------------------------------------------------------------------------

export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function isOpenAIConfigured(): boolean {
  // OPENAI_API_KEY is the standard name; OPEN_AI_KEY accepted as an alias.
  return Boolean(process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY);
}

function providerConfigured(provider: ModelInfo["provider"]): boolean {
  return provider === "anthropic" ? isAnthropicConfigured() : isOpenAIConfigured();
}

/** Catalog filtered to providers whose API key is configured — feeds GET /api/models and all server-side validation/defaults. */
export function getAvailableModels(): ModelInfo[] {
  return MODEL_CATALOG.filter((m) => providerConfigured(m.provider));
}

/** First available builder-tier model in catalog order (Sonnet first when Anthropic is configured, else the GPT-5.6 tiers). */
export function defaultBuilderModel(): string {
  const m = getAvailableModels().find((m) => m.tier === "builder");
  if (!m) throw new Error("No LLM provider is configured — set OPENAI_API_KEY and/or ANTHROPIC_API_KEY.");
  return m.id;
}

/** Planner is never user-selected: Opus when Anthropic is configured, else the flagship OpenAI model. */
export function resolvePlannerModel(): string {
  if (isAnthropicConfigured()) return "claude-opus-4-8";
  if (isOpenAIConfigured()) return "gpt-5.6-sol";
  throw new Error("No LLM provider is configured — set OPENAI_API_KEY and/or ANTHROPIC_API_KEY.");
}

/**
 * Validates a client-supplied model id: must exist in the catalog, be
 * builder-tier, and its provider configured — anything else falls back to
 * the default. Never throws on bad input (client data).
 */
export function resolveBuilderModel(requested: unknown): string {
  if (typeof requested === "string") {
    const info = getModelInfo(requested);
    if (info && info.tier === "builder" && providerConfigured(info.provider)) return info.id;
  }
  return defaultBuilderModel();
}

let anthropicProvider: ReturnType<typeof createAnthropic> | null = null;
let openaiProvider: ReturnType<typeof createOpenAI> | null = null;

function resolveModel(modelId: string): LanguageModel {
  const info = getModelInfo(modelId);
  if (!info) throw new Error(`Unknown model id: ${modelId}`);
  if (!providerConfigured(info.provider)) {
    throw new Error(`Model ${modelId} requires the ${info.provider} API key, which is not configured.`);
  }
  if (info.provider === "anthropic") {
    anthropicProvider ??= createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return anthropicProvider(modelId);
  }
  openaiProvider ??= createOpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY,
  });
  return openaiProvider(modelId);
}

export interface AgentQueryUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface RunAgentQueryOptions {
  modelId: string;
  system: string;
  prompt: string;
  tools?: ToolSet;
  maxSteps: number;
  /** Extra stop conditions beyond the step cap (e.g. hasToolCall("report_review")). */
  stopOnToolCall?: string;
  /** Called with each assistant text chunk, in order. */
  onText?: (text: string, stepId: string) => Promise<void>;
  /** Called for each tool call the model makes (before/independent of its execution). */
  onToolCall?: (call: AgentToolCall) => Promise<void>;
  /** Polled between steps — return true to abort the run (job stopped by user). */
  shouldAbort?: () => Promise<boolean>;
}

export interface RunAgentQueryResult {
  text: string;
  usage: AgentQueryUsage;
  /** True when shouldAbort() ended the run — callers treat this like the old "job stopped" quiet return. */
  aborted: boolean;
}

/**
 * One agentic LLM run: system + prompt + tools, looping until the model
 * finishes, the step cap hits, or `stopOnToolCall` fires. The Anthropic
 * system prompt carries a cacheControl breakpoint so multi-step loops re-read
 * the prefix from prompt cache instead of re-billing it in full every step
 * (OpenAI caches automatically; the providerOptions namespace is ignored by
 * non-Anthropic providers).
 */
export async function runAgentQuery(options: RunAgentQueryOptions): Promise<RunAgentQueryResult> {
  const abortController = new AbortController();
  const stopWhen: StopCondition<ToolSet>[] = [stepCountIs(options.maxSteps)];
  if (options.stopOnToolCall) stopWhen.push(hasToolCall(options.stopOnToolCall));

  let aborted = false;

  // OpenAI's Responses API rejects a system-role entry inside `messages`
  // (verified live: "System messages are not allowed in the prompt or
  // messages fields") — it takes the system prompt as the top-level option.
  // Anthropic, conversely, only supports a cacheControl breakpoint on a
  // message-level providerOptions, so IT gets the messages-array form.
  const info = getModelInfo(options.modelId);
  const promptShape =
    info?.provider === "anthropic"
      ? {
          messages: [
            {
              role: "system" as const,
              content: options.system,
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
            },
            { role: "user" as const, content: options.prompt },
          ],
        }
      : { system: options.system, prompt: options.prompt };

  try {
    const result = await generateText({
      model: resolveModel(options.modelId),
      ...promptShape,
      tools: options.tools,
      stopWhen,
      abortSignal: abortController.signal,
      onStepFinish: async (step) => {
        if (step.text.trim() && options.onText) {
          await options.onText(step.text, randomStepId());
        }
        if (options.onToolCall) {
          for (const call of step.toolCalls) {
            await options.onToolCall({
              id: call.toolCallId,
              name: call.toolName,
              input: call.input,
            });
          }
        }
        if (options.shouldAbort && (await options.shouldAbort())) {
          aborted = true;
          abortController.abort();
        }
      },
    });

    return {
      text: result.text,
      usage: extractUsage(result.totalUsage),
      aborted: false,
    };
  } catch (err) {
    if (aborted || abortController.signal.aborted) {
      return { text: "", usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, aborted: true };
    }
    throw err;
  }
}

function randomStepId(): string {
  return crypto.randomUUID();
}

/**
 * Usage fields defensively across SDK/provider variations: the AI SDK's
 * LanguageModelUsage exposes `cachedInputTokens`; some provider paths nest
 * it as inputTokenDetails.cacheReadTokens. Missing fields count as 0.
 */
function extractUsage(raw: unknown): AgentQueryUsage {
  const u = (raw ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
  };
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cachedInputTokens: u.cachedInputTokens ?? u.inputTokenDetails?.cacheReadTokens ?? 0,
  };
}
