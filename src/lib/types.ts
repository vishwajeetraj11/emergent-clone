/**
 * Shared shapes for the job/event core. These mirror the wire format
 * sent over SSE (see src/app/api/jobs/[id]/stream/route.ts) and are used by
 * both server code (src/server/*) and client hooks/components.
 */

export type JobStatus =
  | "running"
  | "waiting_on_user"
  // Orchestration: a plan is written and awaiting the user's
  // approve/revise decision — distinct from waiting_on_user, which is only
  // ever "an ask_user tool call is pending" (see src/server/agent.ts's
  // runPlanQuery / waitForPlanDecision).
  | "waiting_on_plan"
  | "done"
  | "stopped"
  | "failed";

export type EventRole = "user" | "assistant" | "system";

export type TimelineEventType =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "question"
  | "answer"
  | "status"
  | "usage"
  | "error"
  // Emitted once the build phase upserts changed files into the
  // `files` table for this session — payload: { paths: string[] }.
  | "files_changed"
  // Emitted once the sandbox's dev server responds 200 —
  // payload: { url: string }.
  | "preview_ready"
  // Orchestration: a plan is ready for the user's approve/revise decision —
  // payload: { id: string, text: string, revision: number, isFinal?: boolean }.
  // isFinal marks the last plan allowed by the revision cap (approve-or-stop only).
  | "plan"
  // Orchestration: the user's response to a "plan" event — payload:
  // { planEventId: string, action: "approve" | "revise", feedback?: string }.
  | "plan_decision"
  // Orchestration: structured output of the post-build review pass —
  // payload: { issuesFound: boolean, summary: string,
  // findings: { description: string, file?: string, evidence?: string }[] }.
  // (Rows written before findings were structured hold plain strings.)
  | "review";

export interface Question {
  id: string;
  question: string;
  options: string[];
}

export interface AnswerItem {
  id: string;
  question: string;
  answer: string;
}

/** Shape of one event as delivered over SSE / consumed by the client. */
export interface TimelineEvent {
  seq: number;
  jobId: string;
  role: EventRole;
  type: TimelineEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
}
