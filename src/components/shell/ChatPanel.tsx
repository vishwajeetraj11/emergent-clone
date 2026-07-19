"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  GitFork,
  Globe,
  History,
  Mic,
  MessageSquareDashed,
  Paperclip,
  Rocket,
  Square,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Timeline } from "@/components/shell/Timeline";
import { useSpeechRecognition } from "@/lib/hooks/useSpeechRecognition";
import { cn } from "@/lib/utils";
import type { AnswerItem, JobStatus, TimelineEvent } from "@/lib/types";
import type { DeployState, SaveState } from "@/lib/hooks/useAgentSession";

interface SessionSummary {
  id: string;
  parentSessionId: string | null;
  createdAt: string;
  job: { id: string; status: JobStatus } | null;
}

/**
 * Dropdown listing every session under the current project (original +
 * every fork) — without this, forkSession's newest-session-wins behavior
 * (see getProjectDetail in src/server/projects.ts) makes older forks
 * permanently unreachable through the UI. Fetches the list lazily (only
 * once opened), same pattern as TopBar's credit-balance fetch. Deliberately
 * explicit that forks are one-way copies, not real branches: there is no
 * merge-back in this app (see forkSession's doc comment) — the footer note
 * exists so users don't discover that the hard way after diverging both
 * sides.
 */
function SessionSwitcher({
  projectId,
  currentSessionId,
  onSwitch,
}: {
  projectId: string | null;
  currentSessionId?: string | null;
  onSwitch: (sessionId: string, job: { id: string; status: JobStatus } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/sessions`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { sessions?: SessionSummary[] } | null) => {
        if (!cancelled && data?.sessions) setSessions(data.sessions);
      })
      .catch(() => {
        // Best-effort — dropdown just shows "Loading…" indefinitely on failure.
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label="Switch version"
        title="Switch version"
        disabled={!projectId}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <History className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Versions</DropdownMenuLabel>
          {sessions === null ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No versions yet</div>
          ) : (
            sessions.map((s) => (
              <DropdownMenuItem
                key={s.id}
                onClick={() => onSwitch(s.id, s.job)}
                className={cn(
                  "flex flex-col items-start gap-0.5",
                  s.id === currentSessionId && "bg-secondary/60"
                )}
              >
                <span className="text-xs font-medium">
                  {s.parentSessionId ? "Fork" : "Original"}
                  {s.id === currentSessionId ? " (current)" : ""}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(s.createdAt).toLocaleString()}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
          Forks are independent copies — they can&apos;t be merged back automatically.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DeploymentSummary {
  id: string;
  url: string;
  createdAt: string;
}

/**
 * Dropdown listing every past Vercel deploy for this session, newest first
 * — opening one is just a link (no new deploy). Deliberately a separate
 * control from the Rocket "Deploy" button next to it: Deploy always creates
 * a new deployment, this only ever looks at ones that already exist. See
 * listDeploymentsForSession in src/server/vercel.ts for why history exists
 * at all instead of just sessions.vercelDeploymentUrl (which only holds the
 * latest).
 */
function DeploymentHistory({ sessionId }: { sessionId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [deploymentList, setDeploymentList] = useState<DeploymentSummary[] | null>(null);

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/deployments`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { deployments?: DeploymentSummary[] } | null) => {
        if (!cancelled && data?.deployments) setDeploymentList(data.deployments);
      })
      .catch(() => {
        // Best-effort — dropdown just shows "Loading…" indefinitely on failure.
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label="View past deployments"
        title="View past deployments — no new deploy needed"
        disabled={!sessionId}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <Globe className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Past deployments</DropdownMenuLabel>
          {deploymentList === null ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
          ) : deploymentList.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No deployments yet — use Deploy to create one.
            </div>
          ) : (
            deploymentList.map((d, i) => (
              <DropdownMenuItem
                key={d.id}
                render={<a href={d.url} target="_blank" rel="noopener noreferrer" />}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="text-xs font-medium">
                  {i === 0 ? "Latest" : `${deploymentList.length - i} versions back`}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(d.createdAt).toLocaleString()}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
          Opens the live app for that deploy — doesn&apos;t create a new one.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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

const SAVE_STATUS_TEXT: Record<
  Exclude<SaveState, "idle" | "not_connected" | "needs_reauth">,
  (message: string | null, url: string | null) => string
> = {
  saving: () => "Saving to GitHub…",
  done: (_message, url) => (url ? `Saved to GitHub: ${url}` : "Saved to GitHub."),
  error: (message) => message ?? "Failed to save to GitHub.",
  not_configured: (message) => message ?? "GitHub is not configured in this environment.",
};

const DEPLOY_STATUS_TEXT: Record<Exclude<DeployState, "idle">, (message: string | null, url: string | null) => string> = {
  deploying: () => "Deploying to Vercel…",
  done: (_message, url) => (url ? `Deployed: ${url}` : "Deployed."),
  error: (message) => message ?? "Failed to deploy to Vercel.",
  not_configured: (message) => message ?? "Deploying isn't turned on for this app yet.",
};

const STATUS_STRIP_CONFIG: Record<
  JobStatus,
  { label: string; dot: string; pulse: boolean }
> = {
  running: { label: "Agent is running", dot: "bg-emerald-500", pulse: true },
  waiting_on_user: {
    label: "Agent is waiting",
    dot: "bg-amber-400",
    pulse: true,
  },
  waiting_on_plan: {
    label: "Plan ready for review",
    dot: "bg-amber-400",
    pulse: true,
  },
  done: { label: "Agent finished", dot: "bg-emerald-500", pulse: false },
  stopped: { label: "Agent stopped", dot: "bg-muted-foreground", pulse: false },
  failed: { label: "Agent failed", dot: "bg-red-500", pulse: false },
};

/** Three-dot "thinking…" indicator, each dot fading in turn — same idea as
 * Claude's own thinking animation, built from Tailwind's stock animate-pulse
 * (no custom keyframes needed) staggered per dot via inline animation-delay. */
function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1 animate-pulse rounded-full bg-current"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </span>
  );
}

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
      {pulse && <ThinkingDots />}
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
  projectId = null,
  isForking = false,
  isSendingMessage = false,
  saveState = "idle",
  saveMessage = null,
  saveUrl = null,
  deployState = "idle",
  deployMessage = null,
  deployUrl = null,
  onSubmitPrompt,
  onAnswerQuestion,
  onPlanDecision,
  onStop,
  onContinueChat,
  onFork,
  onSwitchSession,
  onSave,
  onDeploy,
}: {
  events: TimelineEvent[];
  jobStatus: JobStatus | null;
  isStarting: boolean;
  error: string | null;
  hasProject: boolean;
  sessionId?: string | null;
  /** Backs the session-switcher dropdown (SessionSwitcher above). */
  projectId?: string | null;
  isForking?: boolean;
  isSendingMessage?: boolean;
  saveState?: SaveState;
  saveMessage?: string | null;
  saveUrl?: string | null;
  deployState?: DeployState;
  deployMessage?: string | null;
  deployUrl?: string | null;
  onSubmitPrompt: (prompt: string) => void;
  onAnswerQuestion: (toolUseId: string, answers: AnswerItem[]) => void;
  /** The user's approve/revise response to a `plan` event (PlanCard, via Timeline). */
  onPlanDecision?: (
    planEventId: string,
    action: "approve" | "revise",
    feedback?: string
  ) => void;
  onStop: () => void;
  onContinueChat?: (prompt: string, planMode?: boolean) => void;
  onFork?: () => void;
  onSwitchSession?: (sessionId: string, job: { id: string; status: JobStatus } | null) => void;
  onSave?: () => void;
  onDeploy?: () => void;
}) {
  const [message, setMessage] = useState("");
  // Only meaningful for a follow-up message (a brand-new project always
  // plans regardless of this) — lets the user opt a specific edit into the
  // full Opus-plan -> approve -> Sonnet-build pipeline instead of today's
  // direct-edit default. See src/server/agent.ts's runContinuationFlow.
  const [planMode, setPlanMode] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  // Text already in the composer when listening starts — interim/final
  // speech results are appended after this, not appended to each other, so
  // a still-updating interim result doesn't compound on itself.
  const dictationBaseRef = useRef("");
  const { isSupported: isVoiceSupported, isListening, start, stop } =
    useSpeechRecognition((transcript, isFinal) => {
      const base = dictationBaseRef.current;
      const next = base && transcript ? `${base} ${transcript}` : base || transcript;
      setMessage(next);
      if (isFinal) dictationBaseRef.current = next;
    });

  function handleMicClick() {
    if (isListening) {
      stop();
      return;
    }
    dictationBaseRef.current = message;
    start();
  }

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
      onContinueChat?.(trimmed, planMode);
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

  const isActive =
    jobStatus === "running" ||
    jobStatus === "waiting_on_user" ||
    jobStatus === "waiting_on_plan";
  const answersDisabled = jobStatus !== "waiting_on_user";
  const planDisabled = jobStatus !== "waiting_on_plan";

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
              onPlanDecision={onPlanDecision}
              disabled={answersDisabled}
              planDisabled={planDisabled}
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

        {saveState === "not_connected" || saveState === "needs_reauth" ? (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md bg-secondary/60 px-2.5 py-1.5 text-xs text-muted-foreground">
            <span>
              {saveState === "needs_reauth"
                ? "Reconnect GitHub and accept the authorization prompt to create this repo."
                : "Connect your GitHub account to save this project."}
            </span>
            <a
              href={saveState === "needs_reauth" ? "/api/github/reauthorize" : "/api/github/connect"}
              className="shrink-0 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background transition-colors hover:bg-foreground/80"
            >
              Connect GitHub
            </a>
          </div>
        ) : (
          saveState !== "idle" && (
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
          )
        )}

        {deployState !== "idle" && (
          <div
            className={cn(
              "mb-2 rounded-md px-2.5 py-1.5 text-xs",
              deployState === "error"
                ? "bg-red-500/10 text-red-400"
                : deployState === "not_configured"
                  ? "bg-secondary/60 text-muted-foreground"
                  : "bg-emerald-500/10 text-emerald-400"
            )}
          >
            {DEPLOY_STATUS_TEXT[deployState](deployMessage, deployUrl)}
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
              {onSwitchSession && (
                <SessionSwitcher
                  projectId={projectId}
                  currentSessionId={sessionId}
                  onSwitch={onSwitchSession}
                />
              )}
              <IconAction
                icon={<Rocket className="size-4" />}
                label="Deploy a new version"
                onClick={onDeploy}
                disabled={!hasProject || !onDeploy || deployState === "deploying"}
              />
              <DeploymentHistory sessionId={sessionId} />
              <IconAction
                icon={
                  <Mic
                    className={cn("size-4", isListening && "text-red-500")}
                  />
                }
                label={
                  isVoiceSupported
                    ? isListening
                      ? "Listening… click to stop"
                      : "Voice input"
                    : "Voice input isn't supported in this browser"
                }
                onClick={handleMicClick}
                disabled={!isVoiceSupported || composerDisabled}
              />
            </div>
            {canContinueChat && (
              <Tooltip>
                <TooltipTrigger
                  aria-label="Toggle Plan mode"
                  onClick={() => setPlanMode((prev) => !prev)}
                  disabled={composerDisabled}
                  className={cn(
                    "flex items-center gap-1 rounded-full border px-2 py-1 text-[0.7rem] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
                    planMode
                      ? "border-emerald-500 bg-emerald-500/10 text-emerald-400"
                      : "border-border text-muted-foreground hover:bg-secondary"
                  )}
                >
                  {planMode ? "Plan" : "Build"}
                </TooltipTrigger>
                <TooltipContent>
                  {planMode
                    ? "This message will be planned (Opus) and shown for approval before anything is built."
                    : "This message will be built directly. Toggle to Plan mode to review a plan first."}
                </TooltipContent>
              </Tooltip>
            )}
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
