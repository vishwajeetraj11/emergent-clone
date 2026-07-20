import { NextResponse } from "next/server";
import { MODEL_CATALOG } from "@/lib/models";
import { getAvailableModels, defaultBuilderModel } from "@/server/llm";

/**
 * The composer's model picker data source. BYOK (see
 * src/server/user-keys.ts) means "available" is no longer a purely
 * server-side fact: a user's own key, held only in their browser's
 * sessionStorage, can unlock a provider this platform hasn't configured at
 * all — and this route never sees that key. So instead of pre-filtering to
 * what the platform configured, every builder-tier catalog entry is
 * returned with a `platformConfigured` flag (today's env-gating, see
 * getAvailableModels in src/server/llm.ts), and the CLIENT decides final
 * visibility: platformConfigured || (a stored key for that provider). The
 * planner model is never user-selected either way, so it's never included
 * here. `defaultId` stays platform-only (null when nothing platform-
 * configured) — the client recomputes its own default from whichever models
 * a stored key additionally unlocks.
 */
export async function GET() {
  const platformConfiguredIds = new Set(getAvailableModels().map((m) => m.id));
  const models = MODEL_CATALOG.filter((m) => m.tier === "builder").map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    platformConfigured: platformConfiguredIds.has(m.id),
  }));
  let defaultId: string | null = null;
  try {
    defaultId = defaultBuilderModel();
  } catch {
    // Nothing platform-configured at all — not necessarily "no models
    // available" anymore (a BYOK key can still unlock some), so the client
    // recomputes its own default rather than this route guessing at one.
  }
  return NextResponse.json({ models, defaultId });
}
