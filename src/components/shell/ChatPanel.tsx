"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  GitFork,
  Mic,
  MessageSquareDashed,
  Paperclip,
  Square,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Timeline } from "@/components/shell/Timeline";
import { cn } from "@/lib/utils";
import type { AnswerItem, JobStatus, TimelineEvent } from "@/lib/types";
import type { SaveState } from "@/lib/hooks/useAgentSession";

// lucide-react dropped brand marks, so the GitHub logo is inlined here.
function GithubIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 .5A11.5 11.5 0 0 0 8.37 22.94c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.53-1.33-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.5 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.08.78 2.17v3.22c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

function IconAction({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const SAVE_STATUS_TEXT: Record<Exclude<SaveState, "idle">, (message: string | null, url: string | null) => string> = {
  saving: () => "Saving to GitHub…",
  done: (_message, url) => (url ? `Saved to GitHub: ${url}` : "Saved to GitHub."),
  error: (message) => message ?? "Failed to save to GitHub.",
  not_configured: (message) => message ?? "GitHub is not configured in this environment.",
};

const STATUS_STRIP_CONFIG: Record<
  JobStatus,
  { label: string; dot: string; pulse: boolean }
> = {
  running: { label: "Agent is running…", dot: "bg-emerald-500", pulse: true },
  waiting_on_user: {
    label: "Agent is waiting…",
    dot: "bg-amber-400",
    pulse: true,
  },
  done: { label: "Agent finished", dot: "bg-emerald-500", pulse: false },
  stopped: { label: "Agent stopped", dot: "bg-muted-foreground", pulse: false },
  failed: { label: "Agent failed", dot: "bg-red-500", pulse: false },
};

function StatusStrip({ jobStatus }: { jobStatus: JobStatus | null }) {
  if (!jobStatus) return null;
  const { label, dot, pulse } = STATUS_STRIP_CONFIG[jobStatus];
  return (
    <div className="mb-2 flex items-center gap-2 rounded-md bg-secondary/60 px-2.5 py-1.5 text-xs text-muted-foreground">
      <span className="relative flex size-1.5">
        {pulse && (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-75",
              dot
            )}
          />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", dot)} />
      </span>
      {label}
    </div>
  );
}

const TERMINAL_STATUSES = new Set<JobStatus>(["done", "stopped", "failed"]);

export function ChatPanel({
  events,
  jobStatus,
  isStarting,
  error,
  hasProject,
  sessionId,
  isForking = false,
  isSendingMessage = false,
  saveState = "idle",
  saveMessage = null,
  saveUrl = null,
  onSubmitPrompt,
  onAnswerQuestion,
  onStop,
  onContinueChat,
  onFork,
  onSave,
}: {
  events: TimelineEvent[];
  jobStatus: JobStatus | null;
  isStarting: boolean;
  error: string | null;
  hasProject: boolean;
  sessionId?: string | null;
  isForking?: boolean;
  isSendingMessage?: boolean;
  saveState?: SaveState;
  saveMessage?: string | null;
  saveUrl?: string | null;
  onSubmitPrompt: (prompt: string) => void;
  onAnswerQuestion: (toolUseId: string, answers: AnswerItem[]) => void;
  onStop: () => void;
  onContinueChat?: (prompt: string) => void;
  onFork?: () => void;
  onSave?: () => void;
}) {
  const [message, setMessage] = useState("");
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  // Once a job reaches a terminal status, the session (and its sandbox) is
  // still there — Phase 3 lets the user keep chatting against it (a new job
  // under the same session; see continueChat in useAgentSession) instead of
  // being stuck answering questions forever.
  const canContinueChat = hasProject && TERMINAL_STATUSES.has(jobStatus ?? "running");
  const composerDisabled =
    isStarting || isSendingMessage || (hasProject && !canContinueChat);

  function handleSubmit() {
    const trimmed = message.trim();
    if (!trimmed || composerDisabled) return;
    if (hasProject) {
      onContinueChat?.(trimmed);
    } else {
      onSubmitPrompt(trimmed);
    }
    setMessage("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const isActive = jobStatus === "running" || jobStatus === "waiting_on_user";
  const answersDisabled = jobStatus !== "waiting_on_user";

  return (
    <aside className="flex h-full min-h-0 w-[440px] shrink-0 flex-col border-r border-border bg-background">
      {/* Timeline */}
      <ScrollArea className="min-h-0 flex-1">
        {events.length === 0 ? (
          <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-3 px-8 py-16 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-secondary">
              <MessageSquareDashed className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">
              No activity yet
            </p>
            <p className="max-w-56 text-xs leading-relaxed text-muted-foreground">
              Send a message below to kick off the agent — its plan, file
              edits, and progress will stream in here.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 px-4 py-4">
            <Timeline
              events={events}
              onAnswerQuestion={onAnswerQuestion}
              disabled={answersDisabled}
              sessionId={sessionId}
            />
            <div ref={scrollAnchorRef} />
          </div>
        )}
      </ScrollArea>

      {/* Pinned bottom composer */}
      <div className="shrink-0 border-t border-border bg-background p-3">
        {error && (
          <div className="mb-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-400">
            {error}
          </div>
        )}
        <StatusStrip jobStatus={jobStatus} />

        {saveState !== "idle" && (
          <div
            className={cn(
              "mb-2 rounded-md px-2.5 py-1.5 text-xs",
              saveState === "error"
                ? "bg-red-500/10 text-red-400"
                : saveState === "not_configured"
                  ? "bg-secondary/60 text-muted-foreground"
                  : "bg-emerald-500/10 text-emerald-400"
            )}
          >
            {SAVE_STATUS_TEXT[saveState](saveMessage, saveUrl)}
          </div>
        )}

        <div className="rounded-lg border border-input bg-input/20 p-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              canContinueChat
                ? "Keep chatting to continue building…"
                : hasProject
                  ? "Answer the agent's questions above…"
                  : "What will you build today?"
            }
            disabled={composerDisabled}
            className="min-h-16 resize-none border-none bg-transparent p-1 shadow-none focus-visible:ring-0 disabled:opacity-50"
          />
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-0.5">
              <IconAction icon={<Paperclip className="size-4" />} label="Attach" />
              <IconAction
                icon={<GithubIcon className="size-4" />}
                label="Save"
                onClick={onSave}
                disabled={!hasProject || !onSave || saveState === "saving"}
              />
              <IconAction
                icon={<GitFork className="size-4" />}
                label="Fork"
                onClick={onFork}
                disabled={!hasProject || !onFork || isForking}
              />
              <IconAction icon={<Mic className="size-4" />} label="Voice input" />
            </div>
            {isActive ? (
              <Tooltip>
                <TooltipTrigger
                  aria-label="Stop agent"
                  onClick={onStop}
                  disabled={!isActive}
                  className="flex size-7 items-center justify-center rounded-md bg-foreground text-background transition-colors hover:bg-foreground/80 disabled:opacity-40"
                >
                  <Square className="size-3 fill-current" />
                </TooltipTrigger>
                <TooltipContent>Stop agent</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  aria-label="Send"
                  onClick={handleSubmit}
                  disabled={!message.trim() || composerDisabled}
                  className="flex size-7 items-center justify-center rounded-md bg-foreground text-background transition-colors hover:bg-foreground/80 disabled:opacity-40"
                >
                  <ArrowUp className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>Send</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
