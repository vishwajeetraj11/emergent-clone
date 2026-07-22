"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Markdown } from "@/components/shell/Markdown";
import { cn } from "@/lib/utils";

/**
 * Shown for a `plan` event — the planner's (Opus) proposed build/edit plan,
 * awaiting the user's approve/revise decision. Same "read-only once
 * answered, interactive form until then" shape as QuestionCard, just with
 * free-text feedback + two actions instead of multiple-choice questions.
 */
export function PlanCard({
  planEventId,
  text,
  revision,
  isFinal,
  decision,
  disabled,
  onDecide,
}: {
  planEventId: string;
  text: string;
  revision: number;
  /** True on the last plan allowed by the revision cap — "Request changes" is
   * hidden (approve or stop only) and a note explains why. */
  isFinal?: boolean;
  decision: { action: "approve" | "revise"; feedback?: string } | null;
  disabled?: boolean;
  onDecide: (
    planEventId: string,
    action: "approve" | "revise",
    feedback?: string
  ) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);

  const decided = decision !== null;

  return (
    <Card className="flex flex-col gap-3 border-border bg-card/60 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          {revision > 0 ? `Revised plan (round ${revision})` : "Build plan"}
        </p>
        {decided && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              decision.action === "approve"
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-amber-500/10 text-amber-400"
            )}
          >
            {decision.action === "approve" ? "Approved" : "Changes requested"}
          </span>
        )}
      </div>

      <Markdown text={text} />

      {decided && decision.action === "revise" && decision.feedback && (
        <div className="flex flex-col gap-1 border-l-2 border-amber-500/40 pl-2">
          <p className="text-[10px] text-muted-foreground">Your feedback:</p>
          <p className="text-xs text-foreground">{decision.feedback}</p>
        </div>
      )}

      {!decided && (
        <div className="flex flex-col gap-2">
          {isFinal && !showFeedbackInput && (
            <p className="text-[10px] text-muted-foreground">
              Revision limit reached — this is the final plan. Approve it to start building, or stop.
            </p>
          )}
          {showFeedbackInput && (
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What would you like to change about this plan?"
              disabled={disabled}
              rows={2}
              className="resize-none rounded-md border border-input bg-input/20 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none disabled:opacity-50"
            />
          )}
          <div className="flex justify-end gap-2">
            {showFeedbackInput ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setShowFeedbackInput(false);
                    setFeedback("");
                  }}
                  disabled={disabled}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => onDecide(planEventId, "revise", feedback.trim())}
                  disabled={disabled || !feedback.trim()}
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-40"
                >
                  Send feedback
                </button>
              </>
            ) : (
              <>
                {!isFinal && (
                  <button
                    type="button"
                    onClick={() => setShowFeedbackInput(true)}
                    disabled={disabled}
                    className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-40"
                  >
                    Request changes
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onDecide(planEventId, "approve")}
                  disabled={disabled}
                  className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/80 disabled:opacity-40"
                >
                  Start building
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
