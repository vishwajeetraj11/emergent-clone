"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { formatDate } from "@/lib/utils/format";
import { PROJECT_LIST_SKELETON_ROWS } from "@/lib/constants/ui";

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
 * loading or if the signed-in user has no projects yet, so it never displaces
 * the onboarding carousel for a genuinely new user.
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
  if (projects === null) {
    return (
      <div className="mt-10 w-full max-w-md" aria-busy="true">
        <h3 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Your projects
        </h3>
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: PROJECT_LIST_SKELETON_ROWS }, (_, i) => (
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
      {deleteError && (
        <p role="alert" className="mb-1.5 px-1 text-xs text-red-400">
          {deleteError}
        </p>
      )}
      {/* A real list. The rows used to be role="button" divs with more
          buttons nested inside them — invalid (a control inside a control),
          and it left the delete/confirm buttons unreachable or ambiguous
          depending on the screen reader. Now: <ul>/<li> for structure, and
          the row's own "open this project" affordance is a real <button>
          that stretches across the row via an absolutely-positioned overlay,
          so the visual full-row hit area survives while the delete controls
          stay siblings rather than descendants. */}
      <ul className="flex max-h-64 list-none flex-col gap-1.5 overflow-y-auto">
        {projects.map((p) => (
          <li
            key={p.id}
            className="group relative flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary/60"
          >
            {/* The focus ring lives on the overlay button, not on the row via
                focus-within — otherwise focusing the delete button would
                light up the whole row and read as "the row is focused". */}
            <button
              type="button"
              onClick={() => onSelectProject(p.id)}
              className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="sr-only">Open project {p.name}</span>
            </button>
            {/* aria-hidden: the visible name is already announced by the
                overlay button's accessible name above, and reading it twice
                is noise. */}
            <span aria-hidden className="truncate text-foreground">
              {p.name}
            </span>
            {confirmingId === p.id ? (
              // relative z-10 lifts these above the row's full-bleed overlay
              // button so clicks land here, not on "open project".
              // "Yes"/"No" alone are meaningless out of context, so each
              // carries an aria-label naming the project and the action.
              <div className="relative z-10 flex shrink-0 items-center gap-1.5 text-xs">
                <span aria-hidden className="text-muted-foreground">
                  Delete?
                </span>
                <button
                  type="button"
                  disabled={deletingId === p.id}
                  aria-label={`Confirm deleting ${p.name}`}
                  onClick={() => handleDelete(p.id)}
                  className="rounded-sm px-1 py-0.5 font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                >
                  {deletingId === p.id ? "…" : "Yes"}
                </button>
                <button
                  type="button"
                  disabled={deletingId === p.id}
                  aria-label={`Keep ${p.name}`}
                  onClick={() => setConfirmingId(null)}
                  className="rounded-sm px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  No
                </button>
              </div>
            ) : (
              <div className="relative z-10 flex shrink-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {formatDate(p.createdAt)}
                </span>
                {/* opacity-0 + group-hover:opacity-100 made this button
                    mouse-only: a keyboard user could focus it while it was
                    still fully transparent, i.e. focus vanished from the
                    screen. focus-visible:opacity-100 reveals it on focus too. */}
                <button
                  type="button"
                  aria-label={`Delete ${p.name}`}
                  title="Delete project"
                  onClick={() => setConfirmingId(p.id)}
                  className="rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
