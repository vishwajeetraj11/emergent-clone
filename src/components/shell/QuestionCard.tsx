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
              <p className="text-sm font-semibold text-foreground">
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
        <div key={q.id} className="flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground">{q.question}</p>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((option) => (
              <button
                key={option}
                type="button"
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
          <input
            type="text"
            value={freeText[q.id] ?? ""}
            onChange={(e) =>
              setFreeText((prev) => ({ ...prev, [q.id]: e.target.value }))
            }
            placeholder="Or type your own answer…"
            disabled={disabled}
            className="rounded-md border border-input bg-input/20 px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none disabled:opacity-50"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={disabled || !allAnswered}
        className="self-end rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/80 disabled:opacity-40"
      >
        Submit answers
      </button>
    </Card>
  );
}
