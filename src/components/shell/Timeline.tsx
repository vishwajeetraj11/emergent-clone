"use client";

import { QuestionCard } from "@/components/shell/QuestionCard";
import { PlanCard } from "@/components/shell/PlanCard";
import { FilesChangedCard } from "@/components/shell/FilesChangedCard";
import { Markdown } from "@/components/shell/Markdown";
import type { AnswerItem, Question, TimelineEvent } from "@/lib/types";
import { findAnswerFor, findPlanDecisionFor } from "@/lib/utils/events";

export function Timeline({
  events,
  onAnswerQuestion,
  onPlanDecision,
  disabled,
  planDisabled,
  sessionId,
}: {
  events: TimelineEvent[];
  onAnswerQuestion: (toolUseId: string, answers: AnswerItem[]) => void;
  onPlanDecision?: (
    planEventId: string,
    action: "approve" | "revise",
    feedback?: string
  ) => void;
  /** Disables QuestionCard interaction — true whenever jobStatus isn't "waiting_on_user". */
  disabled?: boolean;
  /** Disables PlanCard interaction — true whenever jobStatus isn't "waiting_on_plan". Distinct from `disabled` above since the two statuses are mutually exclusive. */
  planDisabled?: boolean;
  sessionId?: string | null;
}) {
  return (
    <>
      {events.map((event) => {
        switch (event.type) {
          case "user_message": {
            const text = (event.payload as { text?: string }).text ?? "";
            return (
              // Who said what is conveyed purely by alignment and bubble
              // color — both invisible to a screen reader, which would
              // otherwise read the whole transcript as one undifferentiated
              // wall of text. An sr-only speaker prefix restores the
              // attribution without changing a pixel.
              <div
                key={`${event.jobId}-${event.seq}`}
                className="self-end whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-sm text-foreground"
              >
                <span className="sr-only">You said: </span>
                {text}
              </div>
            );
          }
          case "assistant_message": {
            const text = (event.payload as { text?: string }).text ?? "";
            return (
              <div key={`${event.jobId}-${event.seq}`}>
                <span className="sr-only">Agent said: </span>
                <Markdown text={text} />
              </div>
            );
          }
          case "status": {
            const text = (event.payload as { text?: string }).text ?? "";
            return (
              <div
                key={`${event.jobId}-${event.seq}`}
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                {/* Purely decorative pulse — announcing it would prefix every
                    status line with a meaningless blank element. */}
                <span className="relative flex size-1.5 shrink-0" aria-hidden>
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-muted-foreground/60 opacity-75" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-muted-foreground" />
                </span>
                <span className="italic">{text}</span>
              </div>
            );
          }
          case "question": {
            const payload = event.payload as {
              toolUseId?: string;
              questions?: Question[];
            };
            if (!payload.toolUseId || !payload.questions) return null;
            const answers = findAnswerFor(events, payload.toolUseId);
            return (
              <QuestionCard
                key={`${event.jobId}-${event.seq}`}
                toolUseId={payload.toolUseId}
                questions={payload.questions}
                answers={answers}
                disabled={disabled}
                onSubmit={onAnswerQuestion}
              />
            );
          }
          case "plan": {
            const payload = event.payload as {
              id?: string;
              text?: string;
              revision?: number;
              isFinal?: boolean;
            };
            if (!payload.id || !payload.text) return null;
            const decision = findPlanDecisionFor(events, payload.id);
            return (
              <PlanCard
                key={`${event.jobId}-${event.seq}`}
                planEventId={payload.id}
                text={payload.text}
                revision={payload.revision ?? 0}
                isFinal={payload.isFinal ?? false}
                decision={decision}
                disabled={planDisabled}
                onDecide={onPlanDecision ?? (() => {})}
              />
            );
          }
          case "review": {
            // No dedicated card — the review pass already appends a plain
            // assistant_message with its summary right after this event, so
            // this only exists to carry the structured
            // { issuesFound, summary, findings } payload for anything that
            // might want it later (e.g. a future "view findings" affordance).
            return null;
          }
          case "files_changed": {
            const paths = (event.payload as { paths?: string[] }).paths ?? [];
            if (paths.length === 0) return null;
            return (
              <FilesChangedCard
                key={`${event.jobId}-${event.seq}`}
                sessionId={sessionId ?? null}
                paths={paths}
              />
            );
          }
          case "error": {
            const message =
              (event.payload as { message?: string }).message ??
              "Something went wrong.";
            return (
              <div
                key={`${event.jobId}-${event.seq}`}
                role="alert"
                className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400"
              >
                {message}
              </div>
            );
          }
          // tool_call, usage, answer, and plan_decision events don't render
          // their own timeline row — tool_call/answer surface via the
          // question card, plan_decision surfaces via the plan card, usage
          // is metering-only. preview_ready has no timeline row either — it
          // only drives PreviewPanel's iframe (see useAgentSession).
          case "tool_call":
          case "usage":
          case "answer":
          case "plan_decision":
          case "preview_ready":
          default:
            return null;
        }
      })}
    </>
  );
}
