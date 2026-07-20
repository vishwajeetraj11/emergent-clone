import { NextResponse } from "next/server";
import { getAvailableModels, defaultBuilderModel } from "@/server/llm";

/**
 * The composer's model picker data source — the browser can't read which
 * provider API keys are configured, so availability filtering happens here
 * (see getAvailableModels in src/server/llm.ts). Only builder-tier models
 * are offered; the planner model is never user-selected.
 */
export async function GET() {
  const models = getAvailableModels().filter((m) => m.tier === "builder");
  let defaultId: string | null = null;
  try {
    defaultId = defaultBuilderModel();
  } catch {
    // No provider configured at all — picker renders empty, sends no model.
  }
  return NextResponse.json({
    models: models.map((m) => ({ id: m.id, label: m.label, provider: m.provider })),
    defaultId,
  });
}
