import type { JobStatus } from "@/lib/types";

/** The three states the UI's status dot can show, collapsed from JobStatus. */
export type DotStatus = "running" | "idle" | "error";

export function jobStatusToDotStatus(status: JobStatus | null | undefined): DotStatus {
  if (status === "running" || status === "waiting_on_user" || status === "waiting_on_plan")
    return "running";
  if (status === "failed") return "error";
  return "idle";
}

export function statusDotClass(status: DotStatus): string {
  switch (status) {
    case "running":
      return "bg-emerald-500";
    case "error":
      return "bg-red-500";
    default:
      return "bg-muted-foreground";
  }
}
