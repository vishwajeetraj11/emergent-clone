"use client";

import { QuestionCard } from "@/components/shell/QuestionCard";
import type { AnswerItem, Question, TimelineEvent } from "@/lib/types";

function findAnswerFor(
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

export function Timeline({
  events,
  onAnswerQuestion,
  disabled,
}: {
  events: TimelineEvent[];
  onAnswerQuestion: (toolUseId: string, answers: AnswerItem[]) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {events.map((event) => {
        switch (event.type) {
          case "user_message": {
            const text = (event.payload as { text?: string }).text ?? "";
            return (
              <div
                key={event.seq}
                className="self-end whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-sm text-foreground"
              >
                {text}
              </div>
            );
          }
          case "assistant_message": {
            const text = (event.payload as { text?: string }).text ?? "";
            return (
              <p
                key={event.seq}
                className="whitespace-pre-wrap text-sm leading-relaxed text-foreground"
              >
                {text}
              </p>
            );
          }
          case "status": {
            const text = (event.payload as { text?: string }).text ?? "";
            return (
              <div
                key={event.seq}
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <span className="relative flex size-1.5 shrink-0">
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
                key={event.seq}
                toolUseId={payload.toolUseId}
                questions={payload.questions}
                answers={answers}
                disabled={disabled}
                onSubmit={onAnswerQuestion}
              />
            );
          }
          case "error": {
            const message =
              (event.payload as { message?: string }).message ??
              "Something went wrong.";
            return (
              <div
                key={event.seq}
                className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400"
              >
                {message}
              </div>
            );
          }
          // tool_call, usage, and answer events don't render their own
          // timeline row — tool_call/answer surface via the question card,
          // usage is metering-only.
          case "tool_call":
          case "usage":
          case "answer":
          default:
            return null;
        }
      })}
    </>
  );
}
