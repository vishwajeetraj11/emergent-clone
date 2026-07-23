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
 * The open-project tab strip. Only ever drives a single active
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
          // Was a role="button" div with tabIndex=0 and NO onKeyDown — it
          // announced itself as a button and then did nothing on Enter or
          // Space, so the project tab was simply not operable by keyboard.
          // It also nested a real <button> (close) inside that fake one,
          // which is invalid. Now a plain container holding two real
          // sibling buttons.
          <div
            key={tab.id}
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
              <>
                <label htmlFor={`rename-${tab.id}`} className="sr-only">
                  Rename project
                </label>
                {/* Callback ref rather than autoFocus (which jsx-a11y
                    rejects, since it also fires on initial page load): this
                    input only appears in response to the user's own
                    double-click/F2, and not focusing it would leave them
                    unable to type into the thing they just opened. */}
                <input
                  id={`rename-${tab.id}`}
                  ref={(node) => node?.focus()}
                  value={renameValue}
                  disabled={isSavingRename}
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
              </>
            ) : (
              // aria-current marks which tab is the open one — previously
              // conveyed only by background color. F2 is the keyboard
              // equivalent of the double-click rename, which had no keyboard
              // path at all; the title/hint names both.
              <button
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => {
                  setActiveOverride(tab.id);
                  onSelectProject?.(tab.id);
                }}
                onDoubleClick={() => startRenaming(tab)}
                onKeyDown={(e) => {
                  if (e.key !== "F2" || !onRenameProject) return;
                  e.preventDefault();
                  startRenaming(tab);
                }}
                title={onRenameProject ? "Double-click (or press F2) to rename" : undefined}
                className="max-w-40 truncate rounded-sm"
              >
                {tab.name}
              </button>
            )}
            {/* opacity-0 until group-hover left this invisible while focused
                — focus-visible:opacity-100 makes the keyboard path visible. */}
            <button
              type="button"
              aria-label={`Close ${tab.name}`}
              onClick={() => closeTab(tab.id)}
              className="rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
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
