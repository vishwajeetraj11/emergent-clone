import type { JobStatus } from "@/lib/types";

/** Statuses a job never leaves — the point where "continue chatting" unlocks. */
export const TERMINAL_STATUSES = new Set<JobStatus>(["done", "stopped", "failed"]);
