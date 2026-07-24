"use client";

import { UserButton } from "@clerk/nextjs";
import { Bell, Home, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CreditsPill } from "@/components/shell/topbar/CreditsPill";
import { ProjectTabs } from "@/components/shell/topbar/ProjectTabs";
import type { JobStatus, ProjectSummary } from "@/lib/types";

export function TopBar({
  project,
  jobStatus,
  onNavigateHome,
  onSelectProject,
  onRenameProject,
}: {
  project?: ProjectSummary | null;
  jobStatus?: JobStatus | null;
  /** Real navigation for the Home button — back to `/` (the
   * "what will you build" composer), not just a visual reset. */
  onNavigateHome?: () => void;
  /** Real navigation for a project tab — to /p/[projectId]. */
  onSelectProject?: (projectId: string) => void;
  /** PATCH /api/projects/[id] — see useAgentSession's renameProject. */
  onRenameProject?: (name: string) => Promise<void>;
}) {
  // Navigating home/starting a new project is just a route change — the
  // current project is never deleted, always reachable again from "Your
  // projects" on the home screen — but leaving mid-job LOOKS like the chat
  // vanished (the agent is actively answering/building and the view just
  // cuts away). Confirm only in that case; a finished/idle project has
  // nothing at risk, so don't nag every single click.
  const jobInFlight =
    jobStatus === "running" ||
    jobStatus === "waiting_on_user" ||
    jobStatus === "waiting_on_plan";

  function guardedNavigateHome() {
    if (
      jobInFlight &&
      !window.confirm(
        "The agent is still working on this project. Leave anyway? Nothing is deleted — you can always come back from \"Your projects.\""
      )
    ) {
      return;
    }
    onNavigateHome?.();
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-3">
      {/* Left cluster */}
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-emerald-400 to-emerald-600 text-background">
          <Sparkles className="size-3.5" />
        </div>
        {/* A pill-shaped LABEL, not a control — it has no handler and never
            had one. As a <button> it was still a tab stop that announced
            "App builder, button" and then did nothing when activated, which
            is worse for a keyboard/screen-reader user than for a mouse one
            (they can't see that nothing happened). A <span> keeps the exact
            same pixels without promising an action. */}
        <span className="flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs font-medium text-foreground">
          App builder
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          onClick={guardedNavigateHome}
        >
          <Home className="size-3.5" />
          Home
        </Button>
      </div>

      <ProjectTabs
        project={project}
        jobStatus={jobStatus}
        onSelectProject={onSelectProject}
        onRenameProject={onRenameProject}
        onNewProject={guardedNavigateHome}
      />

      {/* Right cluster */}
      <div className="flex shrink-0 items-center gap-2">
        <CreditsPill jobStatus={jobStatus} />
        <Tooltip>
          <TooltipTrigger
            aria-label="Notifications"
            className="relative flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Bell className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Notifications</TooltipContent>
        </Tooltip>
        {/* Fixed-size slot, NOT a bare <UserButton />. Clerk renders that
            control from its own client bundle, so it occupies zero width
            until that bundle loads and mounts — in a flex row, popping from
            0 to ~28px shoves every sibling to its left sideways, which is
            the visible topbar jolt on every page load. Reserving the box up
            front means the avatar fades into space already allocated for it.
            size-7 matches Clerk's default avatar. */}
        <div className="flex size-7 shrink-0 items-center justify-center">
          <UserButton />
        </div>
      </div>
    </header>
  );
}
