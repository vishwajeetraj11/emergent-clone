"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { AnswerItem, Question } from "@/lib/types";

export function QuestionCard({
  toolUseId,
  questions,
  answers,
  disabled,
  onSubmit,
}: {
  toolUseId: string;
  questions: Question[];
  answers: AnswerItem[] | null;
  disabled?: boolean;
  onSubmit: (toolUseId: string, answers: AnswerItem[]) => void;
}) {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  // Already answered — render the read-only "question above, chosen answer
  // below in bold" state (mirrors the real Emergent timeline).
  if (answers) {
    return (
      <Card className="flex flex-col gap-3 border-border bg-card/60 p-3">
        {questions.map((q) => {
          const answer = answers.find((a) => a.id === q.id);
          return (
            <div key={q.id} className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">{q.question}</p>
              {/* The question/answer relationship is carried by size and
                  weight alone; sr-only text names it instead of reading two
                  sentences with no connection between them. */}
              <p className="text-sm font-semibold text-foreground">
                <span className="sr-only">Your answer: </span>
                {answer?.answer ?? "—"}
              </p>
            </div>
          );
        })}
      </Card>
    );
  }

  function pickOption(questionId: string, option: string) {
    setSelections((prev) => ({ ...prev, [questionId]: option }));
    setFreeText((prev) => ({ ...prev, [questionId]: "" }));
  }

  function handleSubmit() {
    const compiled: AnswerItem[] = questions.map((q) => ({
      id: q.id,
      question: q.question,
      answer: freeText[q.id]?.trim() || selections[q.id] || "",
    }));
    if (compiled.some((a) => !a.answer)) return;
    onSubmit(toolUseId, compiled);
  }

  const allAnswered = questions.every(
    (q) => freeText[q.id]?.trim() || selections[q.id]
  );

  return (
    <Card className="flex flex-col gap-4 border-border bg-card/60 p-3">
      {questions.map((q) => (
        // Deliberately a div + aria-labelledby rather than fieldset/legend:
        // the visual design is a plain flex column, and fieldset carries
        // layout quirks (min-inline-size: min-content) that would have to be
        // undone. The grouping semantics are identical.
        <div key={q.id} className="flex flex-col gap-2">
          <p id={`${toolUseId}-${q.id}-label`} className="text-sm font-medium text-foreground">
            {q.question}
          </p>
          {/* role="radiogroup" + aria-checked, not bare buttons: picking an
              option is single-select and mutually exclusive, and the choice
              was previously signalled only by an emerald tint — no state
              reached assistive tech at all. Without the group, the chips read
              as a flat run of unrelated buttons with no hint of which
              question they answer, which is unusable once a card carries
              several questions. */}
          <div
            role="radiogroup"
            aria-labelledby={`${toolUseId}-${q.id}-label`}
            className="flex flex-wrap gap-1.5"
          >
            {q.options.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selections[q.id] === option}
                disabled={disabled}
                onClick={() => pickOption(q.id, option)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                  selections[q.id] === option
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-400"
                    : "border-border text-muted-foreground hover:bg-secondary"
                )}
              >
                {option}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor={`${toolUseId}-${q.id}-free-text`}>
            Or type your own answer to: {q.question}
          </label>
          <input
            id={`${toolUseId}-${q.id}-free-text`}
            type="text"
            value={freeText[q.id] ?? ""}
            onChange={(e) =>
              setFreeText((prev) => ({ ...prev, [q.id]: e.target.value }))
            }
            placeholder="Or type your own answer…"
            disabled={disabled}
            // focus:outline-none used to kill the focus ring outright and
            // replace it with nothing but a border tint — a ~1px color shift
            // is not a visible focus indicator. Ring restored (the same
            // focus-visible:ring-3 the ui/input primitive uses).
            className="rounded-md border border-input bg-input/20 px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          />
        </div>
      ))}
      {/* The disabled Submit is otherwise a dead end: nothing on screen says
          WHY it can't be pressed. aria-describedby points at a live hint that
          names the blocker, and it clears itself once every question has an
          answer. */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={disabled || !allAnswered}
        aria-describedby={`${toolUseId}-submit-hint`}
        className="self-end rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/80 disabled:opacity-40"
      >
        Submit answers
      </button>
      <span id={`${toolUseId}-submit-hint`} className="sr-only">
        {disabled
          ? "The agent isn't waiting for answers right now."
          : allAnswered
            ? ""
            : "Answer every question above to enable this."}
      </span>
    </Card>
  );
}
