"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Globe,
  Mic,
  MessageSquareDashed,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Timeline } from "@/components/shell/Timeline";
import { ApiKeysPopover } from "@/components/shell/ApiKeysPopover";
import { useSpeechRecognition } from "@/lib/hooks/useSpeechRecognition";
import { cn } from "@/lib/utils";
import { userHasKeyFor } from "@/lib/utils/api-keys";
import { TERMINAL_STATUSES } from "@/lib/constants/job";
import type { AnswerItem, JobStatus, TimelineEvent } from "@/lib/types";
import type { DeployState, SaveState } from "@/lib/hooks/useAgentSession";
import { loadUserApiKeys, type UserApiKeys } from "@/lib/user-keys-storage";
import { apiRoutes } from "@/lib/constants/api-routes";

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
    fetch(apiRoutes.sessionDeployments(sessionId))
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
                // eslint-disable-next-line jsx-a11y/anchor-has-content -- Base UI's `render` prop clones this element with the menu item's children; the anchor is never actually rendered empty.
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
  pressed,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Set only for toggle-shaped actions (the mic) — renders aria-pressed so
   * the on/off state is announced. Left undefined for plain actions, where
   * aria-pressed would wrongly imply a toggle. */
  pressed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-pressed={pressed}
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
    // role="status" (an implicit aria-live="polite" region): the agent's
    // state is otherwise conveyed only by a colored dot and a text swap
    // nobody is looking at — a screen-reader user had no way to learn the
    // run finished, failed, or is waiting on them without re-reading the
    // panel. Polite, not assertive: these transitions are frequent and
    // shouldn't interrupt whatever is being read.
    <div
      role="status"
      className="mb-2 flex items-center gap-2 rounded-md bg-secondary/60 px-2.5 py-1.5 text-xs text-muted-foreground"
    >
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

interface ModelOption {
  id: string;
  label: string;
  provider: string;
  /** True when the platform itself configured this provider's env key (see src/app/api/models/route.ts). A model with this false is still shown when the user has a BYOK key for its provider — see userHasKeyFor below. */
  platformConfigured: boolean;
}

/**
 * Per-message model picker — options come from GET /api/models, which now
 * returns EVERY builder-tier catalog entry plus a `platformConfigured` flag
 * per model (see src/app/api/models/route.ts) rather than pre-filtering:
 * the server never sees the user's BYOK key (src/lib/user-keys-storage.ts),
 * so final visibility is decided here, client-side — platformConfigured ||
 * a stored key for that model's provider (see ChatPanel's userKeys state).
 * The chosen id rides the message POST body and runs that job's
 * build/review/debug passes; the planner model is never user-selected.
 * Renders nothing when no model is visible at all.
 */
function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelOption[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  if (models.length === 0) return null;
  const current = models.find((m) => m.id === value) ?? models[0];
  return (
    <DropdownMenu>
      {/* The name carries the current value: the trigger's visible text is
          just the model label, so "Choose model" alone left a screen-reader
          user unable to tell WHICH model is selected without opening the
          menu. */}
      <DropdownMenuTrigger
        aria-label={`Model for this message: ${current.label}`}
        disabled={disabled}
        className="flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[0.7rem] font-medium text-muted-foreground transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
      >
        {current.label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Model for this message</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {/* Radio items, not plain menu items: picking a model is a
              single-select choice, and as plain items the current one was
              signalled purely by a background tint — invisible to a screen
              reader and to anyone who can't distinguish that tint. Radio
              semantics give each row aria-checked plus a visible checkmark. */}
          <DropdownMenuRadioGroup
            value={current.id}
            onValueChange={(next) => onChange(next as string)}
          >
            {models.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id} className="text-xs">
                <span className="flex-1">{m.label}</span>
                <span className="text-[0.65rem] uppercase text-muted-foreground">
                  {m.provider}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ChatPanel({
  events,
  jobStatus,
  isStarting,
  isLoadingProject,
  error,
  hasProject,
  sessionId,
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
  onSave,
  onDeploy,
}: {
  events: TimelineEvent[];
  jobStatus: JobStatus | null;
  isStarting: boolean;
  /** A project load is in flight (GET /api/projects/[id] + its session history). */
  isLoadingProject: boolean;
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
  onSubmitPrompt: (prompt: string, model?: string) => void;
  onAnswerQuestion: (toolUseId: string, answers: AnswerItem[]) => void;
  /** The user's approve/revise response to a `plan` event (PlanCard, via Timeline). */
  onPlanDecision?: (
    planEventId: string,
    action: "approve" | "revise",
    feedback?: string
  ) => void;
  onStop: () => void;
  onContinueChat?: (prompt: string, planMode?: boolean, model?: string) => void;
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
  // Per-message model choice (see ModelPicker above). `allModels` +
  // `serverDefaultId` are the raw GET /api/models response; `userKeys` is
  // this tab's stored BYOK keys (see src/lib/user-keys-storage.ts), lifted
  // here so ApiKeysPopover's Save/Clear (onChange below) can trigger a
  // re-filter. `manualModel` is the ONLY real state — null until the user
  // actively picks something via ModelPicker's onChange; `model` itself is
  // a pure derived value (below), never written to directly, so there's no
  // effect synchronizing it against `modelOptions`/`serverDefaultId`.
  const [allModels, setAllModels] = useState<ModelOption[]>([]);
  const [serverDefaultId, setServerDefaultId] = useState<string | null>(null);
  const [userKeys, setUserKeys] = useState<UserApiKeys>(() => loadUserApiKeys());
  const [manualModel, setManualModel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(apiRoutes.models)
      .then((res) => (res.ok ? res.json() : { models: [], defaultId: null }))
      .then((data: { models?: ModelOption[]; defaultId?: string | null }) => {
        if (cancelled) return;
        setAllModels(data.models ?? []);
        setServerDefaultId(data.defaultId ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const modelOptions = useMemo(
    () => allModels.filter((m) => m.platformConfigured || userHasKeyFor(userKeys, m.provider)),
    [allModels, userKeys]
  );
  // Stays pointed at a currently-visible option: the user's own pick
  // (manualModel) when it's still visible, else the server's defaultId when
  // THAT'S visible, else the first visible model, else null (picker
  // hidden). Recomputed on every render from modelOptions/serverDefaultId —
  // including right after the popover saves/clears a key — with no state
  // (and no effect) of its own.
  const model = useMemo(() => {
    if (manualModel && modelOptions.some((m) => m.id === manualModel)) return manualModel;
    if (serverDefaultId && modelOptions.some((m) => m.id === serverDefaultId)) return serverDefaultId;
    return modelOptions[0]?.id ?? null;
  }, [manualModel, modelOptions, serverDefaultId]);
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
  // still there — the user can keep chatting against it (a new job
  // under the same session; see continueChat in useAgentSession) instead of
  // being stuck answering questions forever.
  const canContinueChat = hasProject && TERMINAL_STATUSES.has(jobStatus ?? "running");
  const composerDisabled =
    isStarting || isSendingMessage || (hasProject && !canContinueChat);

  function handleSubmit() {
    const trimmed = message.trim();
    if (!trimmed || composerDisabled) return;
    if (hasProject) {
      onContinueChat?.(trimmed, planMode, model ?? undefined);
    } else {
      onSubmitPrompt(trimmed, model ?? undefined);
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
    // Named landmark: an unnamed <aside> lands in the screen reader's
    // landmark list as a bare "complementary", indistinguishable from the
    // preview panel beside it.
    <aside
      aria-label="Agent chat"
      className="flex h-full min-h-0 w-[440px] shrink-0 flex-col border-r border-border bg-background"
    >
      {/* Timeline */}
      <ScrollArea className="min-h-0 flex-1">
        {events.length === 0 && isLoadingProject ? (
          // An empty timeline during a project load is "history hasn't
          // arrived yet", NOT "nothing ever happened" — GET /api/sessions/
          // [id]/events takes seconds, and claiming "No activity yet" for
          // that whole window tells the user something false about a session
          // that may have a long history.
          <div className="flex flex-col gap-3 px-4 py-4" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-md border border-border bg-secondary/30"
              />
            ))}
            <span className="sr-only" role="status">
              Loading this session…
            </span>
          </div>
        ) : events.length === 0 ? (
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
          // role="log" is the ARIA role for exactly this: a running,
          // chronological transcript where new entries are appended at the
          // end. It carries an implicit aria-live="polite", so streamed
          // agent messages are announced as they arrive instead of the
          // panel silently filling up. aria-relevant="additions" keeps
          // re-renders of existing rows from re-announcing them.
          <div
            role="log"
            aria-label="Conversation"
            aria-relevant="additions"
            className="flex flex-col gap-3 px-4 py-4"
          >
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
        {/* role="alert" (assertive) rather than "status": an error means the
            thing the user just asked for did not happen, and waiting for a
            polite gap to say so can leave them typing into a dead composer. */}
        {error && (
          <div
            role="alert"
            className="mb-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-400"
          >
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
              href={saveState === "needs_reauth" ? apiRoutes.githubReauthorize : apiRoutes.githubConnect}
              className="shrink-0 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background transition-colors hover:bg-foreground/80"
            >
              Connect GitHub
            </a>
          </div>
        ) : (
          saveState !== "idle" && (
            <div
              role={saveState === "error" ? "alert" : "status"}
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
            role={deployState === "error" ? "alert" : "status"}
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
          {/* A placeholder is NOT an accessible name — it's a hint, it
              disappears the moment you type, and several browser/AT combos
              never expose it at all. This textarea is the single most
              important control in the app, so it gets a real name plus a
              described-by hint spelling out the Enter/Shift+Enter keys,
              which were otherwise discoverable only by experiment. */}
          <label htmlFor="chat-composer" className="sr-only">
            Message the agent
          </label>
          <Textarea
            id="chat-composer"
            aria-describedby="chat-composer-hint"
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
          <span id="chat-composer-hint" className="sr-only">
            Press Enter to send, Shift plus Enter for a new line.
          </span>
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-0.5">
              <IconAction
                icon={<GithubIcon className="size-4" />}
                label="Save"
                onClick={onSave}
                disabled={!hasProject || !onSave || saveState === "saving"}
              />
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
                pressed={isVoiceSupported ? isListening : undefined}
                onClick={handleMicClick}
                disabled={!isVoiceSupported || composerDisabled}
              />
            </div>
            <div className="flex items-center gap-2">
            <ApiKeysPopover onChange={setUserKeys} />
            <ModelPicker
              models={modelOptions}
              value={model}
              onChange={setManualModel}
              disabled={composerDisabled}
            />
            {canContinueChat && (
              <Tooltip>
                <TooltipTrigger
                  aria-label="Plan mode"
                  aria-pressed={planMode}
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
                    ? "This message will be planned and shown for approval before anything is built."
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
      </div>
    </aside>
  );
}
