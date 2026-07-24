import type { AnswerItem, TimelineEvent } from "@/lib/types";

/**
 * Timeline events are an append-only log, so a question's answer and a plan's
 * decision arrive as separate later events rather than mutating the original.
 * These resolve that pairing by the id the follow-up event carries back.
 */

export function findAnswerFor(
  events: TimelineEvent[],
  toolUseId: string
): AnswerItem[] | null {
  const answerEvent = events.find(
    (e) =>
      e.type === "answer" &&
      (e.payload as { toolUseId?: string }).toolUseId === toolUseId
  );
  if (!answerEvent) return null;
  return (answerEvent.payload as { answers?: AnswerItem[] }).answers ?? [];
}

export function findPlanDecisionFor(
  events: TimelineEvent[],
  planEventId: string
): { action: "approve" | "revise"; feedback?: string } | null {
  const decisionEvent = events.find(
    (e) =>
      e.type === "plan_decision" &&
      (e.payload as { planEventId?: string }).planEventId === planEventId
  );
  if (!decisionEvent) return null;
  return decisionEvent.payload as { action: "approve" | "revise"; feedback?: string };
}
