import type { UserApiKeys } from "@/lib/user-keys-storage";

/**
 * The BYOK-aware half of "is this model usable", mirroring src/server/llm.ts's
 * providerAvailable. `provider` is a loose string because this is client code —
 * see src/lib/user-keys-storage.ts on why it can't import the server's
 * ModelProvider type.
 */
export function userHasKeyFor(keys: UserApiKeys, provider: string): boolean {
  if (provider === "anthropic") return Boolean(keys.anthropic);
  if (provider === "openai") return Boolean(keys.openai);
  return false;
}
