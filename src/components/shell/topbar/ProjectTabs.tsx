"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { JobStatus, ProjectSummary } from "@/lib/types";

type ProjectTab = {
  id: string;
  name: string;
  status: "running" | "idle" | "error";
};

function jobStatusToDotStatus(status: JobStatus | null | undefined): ProjectTab["status"] {
  if (status === "running" || status === "waiting_on_user" || status === "waiting_on_plan")
    return "running";
  if (status === "failed") return "error";
  return "idle";
}

function statusDotClass(status: ProjectTab["status"]) {
  switch (status) {
    case "running":
      return "bg-emerald-500";
    case "error":
      return "bg-red-500";
    default:
      return "bg-muted-foreground";
  }
}

/**
 * The open-project tab strip. Phase 1 only ever drives a single active
 * project, so the tab list is derived directly from props on every render
 * rather than mirrored into state via an effect. Local state only tracks
 * UI-only overrides: a tab the user dismissed, or manually clicking a
 * (currently single) tab.
 */
export function ProjectTabs({
  project,
  jobStatus,
  onSelectProject,
  onRenameProject,
  onNewProject,
}: {
  project?: ProjectSummary | null;
  jobStatus?: JobStatus | null;
  onSelectProject?: (projectId: string) => void;
  /** PATCH /api/projects/[id] — see useAgentSession's renameProject. */
  onRenameProject?: (name: string) => Promise<void>;
  /** TopBar's guarded navigate-home — confirms first if a job is in
   * flight, same as its Home button. */
  onNewProject?: () => void;
}) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isSavingRename, setIsSavingRename] = useState(false);
  const [activeOverride, setActiveOverride] = useState<string | null>(null);

  const tabs: ProjectTab[] =
    project && !dismissedIds.has(project.id)
      ? [
          {
            id: project.id,
            name: project.name,
            status: jobStatusToDotStatus(jobStatus),
          },
        ]
      : [];
  const activeTab = tabs.some((t) => t.id === activeOverride)
    ? activeOverride
    : (tabs[0]?.id ?? null);

  function closeTab(id: string) {
    setDismissedIds((prev) => new Set(prev).add(id));
    setActiveOverride((prev) => (prev === id ? null : prev));
  }

  function startRenaming(tab: ProjectTab) {
    if (!onRenameProject) return;
    setRenamingId(tab.id);
    setRenameValue(tab.name);
  }

  async function commitRename(originalName: string) {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === originalName) {
      setRenamingId(null);
      return;
    }
    setIsSavingRename(true);
    try {
      await onRenameProject?.(trimmed);
      setRenamingId(null);
    } catch {
      // Leave the input open with the attempted value so the user can
      // retry or cancel — a silently reverted rename reads as "it worked".
    } finally {
      setIsSavingRename(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <div
            key={tab.id}
            role="button"
            tabIndex={0}
            onClick={() => {
              setActiveOverride(tab.id);
              onSelectProject?.(tab.id);
            }}
            className={cn(
              "group flex shrink-0 items-center gap-2 rounded-t-md border border-b-0 border-border px-3 py-1.5 text-xs transition-colors",
              isActive
                ? "bg-card text-foreground"
                : "bg-transparent text-muted-foreground hover:bg-secondary/50"
            )}
          >
            <span
              className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(tab.status))}
              aria-hidden
            />
            {renamingId === tab.id ? (
              <input
                autoFocus
                value={renameValue}
                disabled={isSavingRename}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => commitRename(tab.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename(tab.name);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setRenamingId(null);
                  }
                }}
                className="w-28 rounded-sm bg-transparent px-0.5 text-xs outline-none ring-1 ring-ring/50 disabled:opacity-50"
              />
            ) : (
              <span
                className="max-w-40 truncate"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRenaming(tab);
                }}
                title={onRenameProject ? "Double-click to rename" : undefined}
              >
                {tab.name}
              </span>
            )}
            <button
              type="button"
              aria-label={`Close ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New project"
        onClick={onNewProject}
        className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
