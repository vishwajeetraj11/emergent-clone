"use client";

import { useEffect, useState } from "react";

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
}: {
  onSelectProject: (projectId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { projects?: ProjectListItem[] } | null) => {
        if (!cancelled) setProjects(data?.projects ?? []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!projects || projects.length === 0) return null;

  return (
    <div className="mt-10 w-full max-w-md">
      <h3 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Your projects
      </h3>
      <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelectProject(p.id)}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary/60"
          >
            <span className="truncate text-foreground">{p.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {new Date(p.createdAt).toLocaleDateString()}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
