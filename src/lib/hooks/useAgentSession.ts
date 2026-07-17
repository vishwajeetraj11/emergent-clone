"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnswerItem,
  JobStatus,
  ProjectSummary,
  TimelineEvent,
  TimelineEventType,
} from "@/lib/types";

export type SaveState = "idle" | "saving" | "done" | "error" | "not_configured";
export type DeployState = "idle" | "deploying" | "done" | "error" | "not_configured";

interface AgentSessionState {
  project: ProjectSummary | null;
  sessionId: string | null;
  jobId: string | null;
  jobStatus: JobStatus | null;
  events: TimelineEvent[];
  isStarting: boolean;
  error: string | null;
  /** Set once a `preview_ready` event lands for the active job (Phase 2), or
   * once a Phase 3 sandbox restore/fork resolves a port directly. */
  previewUrl: string | null;
  /** Phase 3: loading an existing project by id (GET /api/projects/[id]). */
  isLoadingProject: boolean;
  /** Phase 3: POST /api/sessions/[id]/restore is in flight. */
  isRestoringPreview: boolean;
  restoreError: string | null;
  /** Phase 3: POST /api/sessions/[id]/fork is in flight. */
  isForking: boolean;
  /** Phase 3: sending a new top-level message against an existing session
   * (continuing to chat after a job reached a terminal status). */
  isSendingMessage: boolean;
  saveState: SaveState;
  saveMessage: string | null;
  saveUrl: string | null;
  /** Phase 4 (Half B, gated inert): Vercel deploy — see src/server/vercel.ts. */
  deployState: DeployState;
  deployMessage: string | null;
  deployUrl: string | null;
}

const EVENT_TYPES: TimelineEventType[] = [
  "user_message",
  "assistant_message",
  "tool_call",
  "question",
  "answer",
  "status",
  "usage",
  "error",
  "files_changed",
  "preview_ready",
];

const TERMINAL_JOB_STATUSES = new Set<JobStatus>(["done", "stopped", "failed"]);

const INITIAL_STATE: AgentSessionState = {
  project: null,
  sessionId: null,
  jobId: null,
  jobStatus: null,
  events: [],
  isStarting: false,
  error: null,
  previewUrl: null,
  isLoadingProject: false,
  isRestoringPreview: false,
  restoreError: null,
  isForking: false,
  isSendingMessage: false,
  saveState: "idle",
  saveMessage: null,
  saveUrl: null,
  deployState: "idle",
  deployMessage: null,
  deployUrl: null,
};

/**
 * Owns the chat/agent-loop client state: creating a project+job (Phase 1),
 * subscribing to its SSE event stream (Phase 1), answering clarifying
 * questions (Phase 1), and — Phase 3 — loading an existing project by id,
 * restoring its sandbox from the `files` snapshot, forking a session, and
 * continuing to chat against an existing session once its job is done.
 */
export function useAgentSession() {
  const [state, setState] = useState<AgentSessionState>(INITIAL_STATE);
  const eventSourceRef = useRef<EventSource | null>(null);

  // RAF-batched event ingestion: a burst of SSE messages (the agent can fire
  // many `tool_call`/`assistant_message` events within milliseconds of each
  // other) previously triggered one setState + one full array copy/re-sort
  // per event. Buffer incoming events here and flush them into state at most
  // once per animation frame instead, so render/sort cost is capped at
  // display refresh rate regardless of burst size.
  const pendingEventsRef = useRef<TimelineEvent[]>([]);
  const rafIdRef = useRef<number | null>(null);

  const flushPendingEvents = useCallback(() => {
    rafIdRef.current = null;
    const pending = pendingEventsRef.current;
    if (pending.length === 0) return;
    pendingEventsRef.current = [];
    setState((prev) => {
      // `seq` is only unique within a single job — a session can span many
      // jobs (initial build + one per "continue chatting" message), so once
      // multiple jobs' events coexist in `events`, dedup/keying must be
      // scoped by job too.
      const seen = new Set(prev.events.map((ev) => `${ev.jobId}:${ev.seq}`));
      const fresh: TimelineEvent[] = [];
      for (const ev of pending) {
        const key = `${ev.jobId}:${ev.seq}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(ev);
      }
      if (fresh.length === 0) return prev;
      return {
        ...prev,
        // `seq` alone no longer establishes a global order once multiple
        // jobs' events coexist — createdAt is an ISO-8601 string (Postgres
        // timestamptz via Drizzle, serialized by JSON.stringify/NextResponse
        // .json), which sorts correctly lexicographically.
        events: [...prev.events, ...fresh].sort((a, b) =>
          a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
        ),
      };
    });
  }, []);

  const closeStream = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    // Flush whatever arrived right before the stream closed (terminal
    // job_status, unmount, or resubscribing) so nothing buffered is lost.
    flushPendingEvents();
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [flushPendingEvents]);

  const subscribe = useCallback(
    (jobId: string, after = -1) => {
      closeStream();
      const es = new EventSource(`/api/jobs/${jobId}/stream?after=${after}`);
      eventSourceRef.current = es;

      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (e) => {
          const messageEvent = e as MessageEvent<string>;
          try {
            const parsed = JSON.parse(messageEvent.data) as TimelineEvent;
            pendingEventsRef.current.push(parsed);
            if (rafIdRef.current === null) {
              rafIdRef.current = requestAnimationFrame(flushPendingEvents);
            }
          } catch (err) {
            console.error("Failed to parse SSE event", err);
          }
        });
      }

      // preview_ready also flows through the generic EVENT_TYPES loop above
      // (so it lands in `events`), but PreviewPanel needs a dedicated
      // `previewUrl` field to swap the carousel for the live iframe — same
      // pattern as job_status below.
      es.addEventListener("preview_ready", (e) => {
        const messageEvent = e as MessageEvent<string>;
        try {
          const parsed = JSON.parse(messageEvent.data) as TimelineEvent;
          const url = (parsed.payload as { url?: string }).url;
          if (url) {
            setState((prev) => ({ ...prev, previewUrl: url }));
          }
        } catch (err) {
          console.error("Failed to parse preview_ready event", err);
        }
      });

      es.addEventListener("job_status", (e) => {
        const messageEvent = e as MessageEvent<string>;
        try {
          const parsed = JSON.parse(messageEvent.data) as {
            status: JobStatus | "not_found";
          };
          if (parsed.status === "not_found") {
            closeStream();
            return;
          }
          const status: JobStatus = parsed.status;
          setState((prev) => ({ ...prev, jobStatus: status }));
          // Only terminal statuses end the stream — waiting_on_user/running
          // transitions keep it open so the client sees the rest of the run.
          if (TERMINAL_JOB_STATUSES.has(status)) {
            closeStream();
          }
        } catch (err) {
          console.error("Failed to parse job_status event", err);
        }
      });

      // The browser's EventSource auto-reconnects on drop and sends
      // Last-Event-ID automatically — nothing to do here.
      es.onerror = () => {};
    },
    [closeStream, flushPendingEvents]
  );

  useEffect(() => closeStream, [closeStream]);

  /**
   * Phase 3: tries to bring a session's sandbox up from its `files`
   * snapshot and reflect the resulting preview URL — used both after
   * loading an existing project (persistence) and right after a fork
   * (independent sandbox for the new session). A 404 (no snapshot yet,
   * e.g. a session still mid-scoping) is not an error, just "nothing to
   * restore yet".
   */
  const attemptRestorePreview = useCallback(async (sessionId: string) => {
    setState((prev) => ({ ...prev, isRestoringPreview: true, restoreError: null }));
    try {
      const res = await fetch(`/api/sessions/${sessionId}/restore`, { method: "POST" });
      if (res.status === 404) {
        setState((prev) => ({ ...prev, isRestoringPreview: false }));
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const data = (await res.json()) as { url: string };
      setState((prev) => ({
        ...prev,
        previewUrl: data.url,
        isRestoringPreview: false,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isRestoringPreview: false,
        restoreError: err instanceof Error ? err.message : "Failed to restore sandbox",
      }));
    }
  }, []);

  const start = useCallback(
    async (prompt: string, onCreated?: (projectId: string) => void) => {
      setState((prev) => ({ ...prev, isStarting: true, error: null }));
      try {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const data = (await res.json()) as {
          project: ProjectSummary;
          session: { id: string };
          job: { id: string; status: JobStatus };
        };
        setState((prev) => ({
          ...prev,
          project: data.project,
          sessionId: data.session.id,
          jobId: data.job.id,
          jobStatus: data.job.status,
          events: [],
          isStarting: false,
          previewUrl: null,
        }));
        subscribe(data.job.id, -1);
        onCreated?.(data.project.id);
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isStarting: false,
          error: err instanceof Error ? err.message : "Failed to start job",
        }));
      }
    },
    [subscribe]
  );

  /**
   * Phase 3 persistence entry point: loads an existing project by id
   * (GET /api/projects/[id]), fetches the session's FULL event history
   * across every job it has ever run (GET /api/sessions/[id]/events — a
   * session can span many jobs: the initial build plus one per "continue
   * chatting" message, and `data.job` here is only the most recent one), and
   * — if the latest job isn't in a terminal state — subscribes to its SSE
   * stream from cursor -1 for live updates (dedup keyed by jobId:seq skips
   * anything already loaded from history). If the session has a `files`
   * snapshot, also tries to restore its sandbox so the preview iframe comes
   * back too.
   */
  const loadProject = useCallback(
    async (projectId: string) => {
      setState(() => ({ ...INITIAL_STATE, isLoadingProject: true }));
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const data = (await res.json()) as {
          project: ProjectSummary;
          session: { id: string } | null;
          job: { id: string; status: JobStatus } | null;
        };

        let history: TimelineEvent[] = [];
        if (data.session) {
          try {
            const historyRes = await fetch(`/api/sessions/${data.session.id}/events`);
            if (historyRes.ok) {
              const historyData = (await historyRes.json()) as { events: TimelineEvent[] };
              history = historyData.events;
            }
          } catch (err) {
            console.error("Failed to load session history", err);
          }
        }

        setState((prev) => ({
          ...prev,
          project: data.project,
          sessionId: data.session?.id ?? null,
          jobId: data.job?.id ?? null,
          jobStatus: data.job?.status ?? null,
          events: history,
          isLoadingProject: false,
        }));
        if (data.job && !TERMINAL_JOB_STATUSES.has(data.job.status)) {
          subscribe(data.job.id, -1);
        }
        if (data.session) attemptRestorePreview(data.session.id);
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isLoadingProject: false,
          error: err instanceof Error ? err.message : "Failed to load project",
        }));
      }
    },
    [subscribe, attemptRestorePreview]
  );

  const answerQuestion = useCallback(
    async (toolUseId: string, answers: AnswerItem[]) => {
      const jobId = state.jobId;
      if (!jobId) return;
      try {
        const res = await fetch(`/api/jobs/${jobId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolUseId, answers }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        setState((prev) => ({ ...prev, jobStatus: "running" }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : "Failed to send answer",
        }));
      }
    },
    [state.jobId]
  );

  const stop = useCallback(async () => {
    const jobId = state.jobId;
    if (!jobId) return;
    try {
      await fetch(`/api/jobs/${jobId}/stop`, { method: "POST" });
    } catch (err) {
      console.error("Failed to stop job", err);
    }
  }, [state.jobId]);

  /**
   * Continues chatting against the *current* session once its job has
   * reached a terminal status (done/stopped/failed) — creates a new job
   * under the same session (see continueSessionWithPrompt) and appends that
   * new job's events onto the existing timeline. The `events` table's `seq`
   * is only job-scoped, but the dedup/sort logic in flushPendingEvents keys
   * on jobId:seq and orders by createdAt, so it's safe to keep whatever's
   * already in state here rather than resetting it — the new job's events
   * layer on top through the normal SSE handling.
   */
  const continueChat = useCallback(
    async (prompt: string) => {
      const sessionId = state.sessionId;
      if (!sessionId) return;
      setState((prev) => ({ ...prev, isSendingMessage: true, error: null }));
      try {
        const res = await fetch(`/api/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const data = (await res.json()) as { job: { id: string; status: JobStatus } };
        setState((prev) => ({
          ...prev,
          jobId: data.job.id,
          jobStatus: data.job.status,
          isSendingMessage: false,
        }));
        subscribe(data.job.id, -1);
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isSendingMessage: false,
          error: err instanceof Error ? err.message : "Failed to send message",
        }));
      }
    },
    [state.sessionId, subscribe]
  );

  /**
   * Forks the current session: new session under the same project, files
   * copied (DB + its own on-disk sandbox path), synthetic history seeded.
   * Switches all client state to the fork (new sessionId/jobId, fresh
   * timeline) and kicks off an independent sandbox restore for it — the
   * original session's job/events/sandbox are never touched.
   */
  const fork = useCallback(async () => {
    const sessionId = state.sessionId;
    if (!sessionId) return;
    setState((prev) => ({ ...prev, isForking: true, error: null }));
    try {
      const res = await fetch(`/api/sessions/${sessionId}/fork`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const data = (await res.json()) as {
        session: { id: string };
        job: { id: string; status: JobStatus };
      };
      setState((prev) => ({
        ...prev,
        sessionId: data.session.id,
        jobId: data.job.id,
        jobStatus: data.job.status,
        events: [],
        previewUrl: null,
        isForking: false,
        saveState: "idle",
        saveMessage: null,
        saveUrl: null,
        deployState: "idle",
        deployMessage: null,
        deployUrl: null,
      }));
      subscribe(data.job.id, -1);
      attemptRestorePreview(data.session.id);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isForking: false,
        error: err instanceof Error ? err.message : "Failed to fork session",
      }));
    }
  }, [state.sessionId, subscribe, attemptRestorePreview]);

  /** GitHub save (Half B — see src/server/github.ts): gated inert when
   * GITHUB_TOKEN isn't configured, surfaced as saveState "not_configured"
   * rather than a silent no-op or a thrown error. */
  const saveToGitHub = useCallback(async () => {
    const sessionId = state.sessionId;
    if (!sessionId) return;
    setState((prev) => ({ ...prev, saveState: "saving", saveMessage: null }));
    try {
      const res = await fetch(`/api/sessions/${sessionId}/save-github`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        configured?: boolean;
        url?: string;
        error?: string;
      };
      if (!res.ok || data.error) {
        setState((prev) => ({
          ...prev,
          saveState: data.configured === false ? "not_configured" : "error",
          saveMessage: data.error ?? `Request failed (${res.status})`,
        }));
        return;
      }
      if (data.configured === false) {
        setState((prev) => ({
          ...prev,
          saveState: "not_configured",
          saveMessage: data.error ?? "GitHub is not configured in this environment.",
        }));
        return;
      }
      setState((prev) => ({
        ...prev,
        saveState: "done",
        saveUrl: data.url ?? null,
        saveMessage: null,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        saveState: "error",
        saveMessage: err instanceof Error ? err.message : "Failed to save to GitHub",
      }));
    }
  }, [state.sessionId]);

  /** Vercel deploy (Half B — see src/server/vercel.ts): gated inert when
   * VERCEL_TOKEN isn't configured, surfaced as deployState "not_configured"
   * rather than a silent no-op or a thrown error. */
  const deployToVercel = useCallback(async () => {
    const sessionId = state.sessionId;
    if (!sessionId) return;
    setState((prev) => ({ ...prev, deployState: "deploying", deployMessage: null }));
    try {
      const res = await fetch(`/api/sessions/${sessionId}/deploy-vercel`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        configured?: boolean;
        url?: string;
        error?: string;
      };
      if (!res.ok || data.error) {
        setState((prev) => ({
          ...prev,
          deployState: data.configured === false ? "not_configured" : "error",
          deployMessage: data.error ?? `Request failed (${res.status})`,
        }));
        return;
      }
      if (data.configured === false) {
        setState((prev) => ({
          ...prev,
          deployState: "not_configured",
          deployMessage: data.error ?? "Vercel deploy is not configured in this environment.",
        }));
        return;
      }
      setState((prev) => ({
        ...prev,
        deployState: "done",
        deployUrl: data.url ?? null,
        deployMessage: null,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        deployState: "error",
        deployMessage: err instanceof Error ? err.message : "Failed to deploy to Vercel",
      }));
    }
  }, [state.sessionId]);

  return {
    ...state,
    start,
    loadProject,
    answerQuestion,
    stop,
    continueChat,
    fork,
    saveToGitHub,
    deployToVercel,
  };
}
