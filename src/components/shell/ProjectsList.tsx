"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { formatDate } from "@/lib/format";

/**
 * Skeleton rows shown while the list loads. Six because the list container
 * caps at max-h-64 (256px) and scrolls past that, so six rows is the tallest
 * this block ever gets — the placeholder can't overshoot the real thing, and
 * anyone at or above the cap sees no size change at all when it resolves.
 */
const SKELETON_ROWS = 6;

interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
  status: "active" | "archived";
  createdAt: string;
}

/**
 * "Your projects" — the dashboard list that was previously missing
 * entirely: the app only ever navigated to one project at a time via its
 * direct URL, with nowhere to see everything you'd built. Rendered on the
 * empty/home preview state (see PreviewPanel); renders nothing while
 * loading or if the signed-in user (or DEV_USER, if Clerk is unconfigured)
 * has no projects yet, so it never displaces the onboarding carousel for a
 * genuinely new user.
 */
export function ProjectsList({
  onSelectProject,
  currentProjectId = null,
  onNavigateHome,
}: {
  onSelectProject: (projectId: string) => void;
  /** The project currently loaded in AppShell, if any — deleting it needs
   * to navigate home the same way TopBar's Home button does, since there'd
   * be nothing left to show in its place. */
  currentProjectId?: string | null;
  onNavigateHome?: () => void;
}) {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  // Row mid-delete-confirm ("Delete? Yes/No") — inline, not window.confirm,
  // matching no other confirm pattern existing in this codebase to reuse.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ projects?: ProjectListItem[] }>("/api/projects")
      .then((data) => {
        if (!cancelled) setProjects(data.projects ?? []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** DELETE /api/projects/[id] — same "update local state, no refetch" style
   * as TopBar's renameProject. Navigates home when the deleted project is
   * the one currently open, since its preview/chat would otherwise be left
   * pointing at a project that no longer exists. */
  async function handleDelete(id: string) {
    setDeletingId(id);
    setDeleteError(null);
    try {
      await fetchJson(`/api/projects/${id}`, { method: "DELETE" });
      setProjects((prev) => prev?.filter((p) => p.id !== id) ?? prev);
      setConfirmingId(null);
      if (currentProjectId === id) onNavigateHome?.();
    } catch (err) {
      console.error("Failed to delete project", err);
      setDeleteError(err instanceof Error ? err.message : "Failed to delete project");
    } finally {
      setDeletingId(null);
    }
  }

  // `null` (still fetching) and `[]` (genuinely no projects) are NOT the same
  // state and must not render the same way. They used to both return null, so
  // GET /api/projects' latency showed as blank space and a brand-new user
  // couldn't tell "loading" from "you have nothing yet". Skeleton rows while
  // loading; still nothing at all when the list is truly empty, so the
  // onboarding carousel isn't displaced for a genuinely new user.
  //
  // Skeleton height matters as much as its existence: this block sits in a
  // justify-center column (see PreviewPanel), so a placeholder shorter than
  // the list replacing it grows the block AND drags the onboarding carousel
  // above it upward. Hence SKELETON_ROWS is the container's cap, not a small
  // guess — the placeholder can only ever shrink, never jump.
  if (projects === null) {
    return (
      <div className="mt-10 w-full max-w-md" aria-busy="true">
        <h3 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Your projects
        </h3>
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div
              key={i}
              className="h-[38px] animate-pulse rounded-md border border-border bg-secondary/30"
            />
          ))}
        </div>
        <span className="sr-only" role="status">
          Loading your projects…
        </span>
      </div>
    );
  }

  if (projects.length === 0) return null;

  return (
    <div className="mt-10 w-full max-w-md">
      <h3 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Your projects
      </h3>
      {deleteError && <p className="mb-1.5 px-1 text-xs text-red-400">{deleteError}</p>}
      <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
        {projects.map((p) => (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelectProject(p.id)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onSelectProject(p.id);
            }}
            className="group flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary/60"
          >
            <span className="truncate text-foreground">{p.name}</span>
            {confirmingId === p.id ? (
              <div className="flex shrink-0 items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Delete?</span>
                <button
                  type="button"
                  disabled={deletingId === p.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(p.id);
                  }}
                  className="rounded-sm px-1 py-0.5 font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                >
                  {deletingId === p.id ? "…" : "Yes"}
                </button>
                <button
                  type="button"
                  disabled={deletingId === p.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingId(null);
                  }}
                  className="rounded-sm px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  No
                </button>
              </div>
            ) : (
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {formatDate(p.createdAt)}
                </span>
                <button
                  type="button"
                  aria-label={`Delete ${p.name}`}
                  title="Delete project"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingId(p.id);
                  }}
                  className="rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
