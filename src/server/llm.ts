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
import type { UserApiKeys } from "@/server/user-keys";

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
//
// BYOK (see src/server/user-keys.ts): every resolver below optionally takes
// `keys`, a job's user-supplied provider key(s). A user key WIDENS
// availability (a provider with no platform env key still counts as
// available once a user key exists for it) and, in resolveModel, TAKES
// PRECEDENCE over the platform's env key when both exist — that precedence
// is what makes "the user's build bills their key" true rather than a
// fallback that only ever matters when the platform has nothing configured.
// ---------------------------------------------------------------------------

export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function isOpenAIConfigured(): boolean {
  // OPENAI_API_KEY is the standard name; OPEN_AI_KEY accepted as an alias.
  return Boolean(process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY);
}

/** A provider is available when the platform's own env key is configured, or
 * the caller supplied a BYOK user key for it (see the BYOK note above). */
function providerAvailable(provider: ModelInfo["provider"], keys?: UserApiKeys): boolean {
  return provider === "anthropic"
    ? isAnthropicConfigured() || Boolean(keys?.anthropic)
    : isOpenAIConfigured() || Boolean(keys?.openai);
}

/** Catalog filtered to providers whose API key is configured — feeds all server-side validation/defaults. Platform-env only, no BYOK widening: GET /api/models needs the full catalog plus a per-model flag instead (see src/app/api/models/route.ts), since BYOK availability is decided client-side. */
export function getAvailableModels(): ModelInfo[] {
  return MODEL_CATALOG.filter((m) => providerAvailable(m.provider));
}

/** First available builder-tier model in catalog order (Sonnet first when Anthropic is configured, else the GPT-5.6 tiers) — widened by `keys` exactly like resolveBuilderModel. */
export function defaultBuilderModel(keys?: UserApiKeys): string {
  const m = MODEL_CATALOG.find((m) => m.tier === "builder" && providerAvailable(m.provider, keys));
  if (!m) {
    throw new Error(
      "No LLM provider is configured — set OPENAI_API_KEY and/or ANTHROPIC_API_KEY, or supply a personal API key."
    );
  }
  return m.id;
}

/** Planner is never user-selected: Opus when Anthropic is configured, else the flagship OpenAI model. A BYOK key widens this the same way as the builder path — a user with only an OpenAI key still gets a real planner model on an Anthropic-only platform. */
export function resolvePlannerModel(keys?: UserApiKeys): string {
  if (providerAvailable("anthropic", keys)) return "claude-opus-4-8";
  if (providerAvailable("openai", keys)) return "gpt-5.6-sol";
  throw new Error(
    "No LLM provider is configured — set OPENAI_API_KEY and/or ANTHROPIC_API_KEY, or supply a personal API key."
  );
}

/**
 * Validates a client-supplied model id: must exist in the catalog, be
 * builder-tier, and its provider available (platform-configured or
 * BYOK-keyed) — anything else falls back to the default. Never throws on bad
 * input (client data).
 */
export function resolveBuilderModel(requested: unknown, keys?: UserApiKeys): string {
  if (typeof requested === "string") {
    const info = getModelInfo(requested);
    if (info && info.tier === "builder" && providerAvailable(info.provider, keys)) return info.id;
  }
  return defaultBuilderModel(keys);
}

let anthropicProvider: ReturnType<typeof createAnthropic> | null = null;
let openaiProvider: ReturnType<typeof createOpenAI> | null = null;

/**
 * Resolves a model id to an AI SDK LanguageModel. A BYOK user key (see the
 * BYOK note above) gets a fresh, uncached provider instance per call — a
 * config object with just an `apiKey` string is cheap to construct, and NOT
 * caching it in the module singletons below matters: those singletons are
 * shared across every job in this process, so caching a user's key on them
 * would leak it into other jobs' calls. The env-keyed path is unchanged —
 * still the `??=` singleton.
 */
function resolveModel(modelId: string, keys?: UserApiKeys): LanguageModel {
  const info = getModelInfo(modelId);
  if (!info) throw new Error(`Unknown model id: ${modelId}`);
  if (!providerAvailable(info.provider, keys)) {
    throw new Error(`Model ${modelId} requires the ${info.provider} API key, which is not configured.`);
  }

  if (info.provider === "anthropic") {
    if (keys?.anthropic) return createAnthropic({ apiKey: keys.anthropic })(modelId);
    anthropicProvider ??= createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return anthropicProvider(modelId);
  }

  if (keys?.openai) return createOpenAI({ apiKey: keys.openai })(modelId);
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
  /** BYOK: this job's user-supplied provider key(s), if any (see src/server/user-keys.ts) — threaded to resolveModel, where a user key takes precedence over the platform's env key. */
  apiKeys?: UserApiKeys;
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

  // The system prompt goes in the top-level `system` option for BOTH
  // providers. A `role: "system"` entry inside `messages` is rejected by the
  // AI SDK ("System messages are not allowed in the prompt or messages
  // fields") — the top-level option is the portable form. (Trade-off: we no
  // longer set an explicit Anthropic cacheControl breakpoint on the system
  // prefix; Anthropic still caches heuristically, and correctness across both
  // providers wins over that optimization.)
  try {
    const result = await generateText({
      model: resolveModel(options.modelId, options.apiKeys),
      system: options.system,
      prompt: options.prompt,
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
