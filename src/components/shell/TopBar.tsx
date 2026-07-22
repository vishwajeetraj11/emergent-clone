"use client";

import { UserButton } from "@clerk/nextjs";
import { Bell, Home, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CreditsPill } from "@/components/shell/topbar/CreditsPill";
import { ProjectTabs } from "@/components/shell/topbar/ProjectTabs";
import { DEV_USER } from "@/lib/dev-user";
import type { JobStatus, ProjectSummary } from "@/lib/types";

// Client-safe Clerk check — mirrors src/lib/auth.ts's isClerkConfigured(),
// but that helper reads CLERK_SECRET_KEY, which is never available in
// client bundles by design (Next.js only inlines NEXT_PUBLIC_* vars
// client-side). This checks only the publishable key, which is genuinely
// safe to expose. Assumes both keys are always set together, same as every
// other isXConfigured() check in this codebase — a publishable key set
// without a matching secret key (an unsupported partial config) would try
// to render <UserButton> without the <ClerkProvider> that ClerkGate only
// mounts when BOTH keys are present, and crash.
const CLERK_CONFIGURED_CLIENT = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export function TopBar({
  project,
  jobStatus,
  onNavigateHome,
  onSelectProject,
  onRenameProject,
}: {
  project?: ProjectSummary | null;
  jobStatus?: JobStatus | null;
  /** Phase 3: real navigation for the Home button — back to `/` (the
   * "what will you build" composer), not just a visual reset. */
  onNavigateHome?: () => void;
  /** Phase 3: real navigation for a project tab — to /p/[projectId]. */
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
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
        >
          App builder
        </button>
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
            size-7 matches Clerk's default avatar; the DEV_USER fallback is
            size-6 and centers inside the same slot, so both branches occupy
            identical space. */}
        <div className="flex size-7 shrink-0 items-center justify-center">
          {CLERK_CONFIGURED_CLIENT ? (
            <UserButton />
          ) : (
            <Avatar size="sm">
              <AvatarFallback>
                {DEV_USER.name
                  .split(" ")
                  .map((part) => part[0])
                  .join("")}
              </AvatarFallback>
            </Avatar>
          )}
        </div>
      </div>
    </header>
  );
}
