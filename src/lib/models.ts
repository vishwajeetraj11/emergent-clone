// ---------------------------------------------------------------------------
// Model catalog — the single source of truth for which LLMs this platform can
// run, shared by the server runtime (src/server/llm.ts resolves ids to AI SDK
// provider instances), the credits meter (src/server/credits.ts prices by id),
// and the composer's model picker (fed via GET /api/models, because the
// browser can't see which provider API keys are configured).
//
// `tier: "planner"` marks models reserved for the planning phase (never
// user-selectable in the picker); `tier: "builder"` models are what the user
// chooses per message and run that job's build + review + debug passes.
// ---------------------------------------------------------------------------

export type ModelProvider = "anthropic" | "openai";

export interface ModelInfo {
  /** Provider API model id — also the key in credits.ts's MODEL_PRICING. */
  id: string;
  /** Short human label for the picker. */
  label: string;
  provider: ModelProvider;
  tier: "planner" | "builder";
}

export const MODEL_CATALOG: ModelInfo[] = [
  // Anthropic — hidden whenever ANTHROPIC_API_KEY isn't configured (the
  // pre-rewrite claude-CLI subscription auth doesn't exist in the AI SDK
  // runtime; Claude is metered API-only here).
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic", tier: "planner" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", tier: "builder" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", provider: "anthropic", tier: "builder" },
  // OpenAI — GPT-5.6 tier trio (verified against OpenAI's pricing page):
  // sol = flagship, terra = mid, luna = small/cheap.
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai", tier: "builder" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai", tier: "builder" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai", tier: "builder" },
];

export function getModelInfo(id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}
