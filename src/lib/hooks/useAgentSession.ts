"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnswerItem,
  JobStatus,
  ProjectSummary,
  TimelineEvent,
  TimelineEventType,
} from "@/lib/types";

interface AgentSessionState {
  project: ProjectSummary | null;
  sessionId: string | null;
  jobId: string | null;
  jobStatus: JobStatus | null;
  events: TimelineEvent[];
  isStarting: boolean;
  error: string | null;
  /** Set once a `preview_ready` event lands for the active job (Phase 2). */
  previewUrl: string | null;
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
};

/**
 * Owns the Phase 1 chat/agent-loop client state: creating a project+job,
 * subscribing to its SSE event stream (with Last-Event-ID resume handled by
 * the browser's native EventSource reconnect), answering clarifying
 * questions, and stopping the job.
 */
export function useAgentSession() {
  const [state, setState] = useState<AgentSessionState>(INITIAL_STATE);
  const eventSourceRef = useRef<EventSource | null>(null);

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

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
            setState((prev) => {
              if (prev.events.some((ev) => ev.seq === parsed.seq)) return prev;
              return {
                ...prev,
                events: [...prev.events, parsed].sort((a, b) => a.seq - b.seq),
              };
            });
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
    [closeStream]
  );

  useEffect(() => closeStream, [closeStream]);

  const start = useCallback(
    async (prompt: string) => {
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

  return { ...state, start, answerQuestion, stop };
}
