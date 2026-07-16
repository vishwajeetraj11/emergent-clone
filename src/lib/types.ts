/**
 * Shared shapes for the Phase 1 job/event core. These mirror the wire format
 * sent over SSE (see src/app/api/jobs/[id]/stream/route.ts) and are used by
 * both server code (src/server/*) and client hooks/components.
 */

export type JobStatus =
  | "running"
  | "waiting_on_user"
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
  // Phase 2: emitted once the build phase upserts changed files into the
  // `files` table for this session — payload: { paths: string[] }.
  | "files_changed"
  // Phase 2: emitted once the sandbox's dev server responds 200 —
  // payload: { url: string }.
  | "preview_ready";

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
