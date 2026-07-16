"use client";

import { useEffect, useState } from "react";
import { Bell, Home, Plus, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEV_USER } from "@/lib/dev-user";
import { cn } from "@/lib/utils";
import type { JobStatus, ProjectSummary } from "@/lib/types";

type ProjectTab = {
  id: string;
  name: string;
  status: "running" | "idle" | "error";
};

function jobStatusToDotStatus(status: JobStatus | null | undefined): ProjectTab["status"] {
  if (status === "running" || status === "waiting_on_user") return "running";
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

export function TopBar({
  project,
  jobStatus,
  onNavigateHome,
  onSelectProject,
}: {
  project?: ProjectSummary | null;
  jobStatus?: JobStatus | null;
  /** Phase 3: real navigation for the Home button — back to `/` (the
   * "what will you build" composer), not just a visual reset. */
  onNavigateHome?: () => void;
  /** Phase 3: real navigation for a project tab — to /p/[projectId]. */
  onSelectProject?: (projectId: string) => void;
}) {
  // Phase 1 only ever drives a single active project, so the tab list is
  // derived directly from props on every render rather than mirrored into
  // state via an effect. Local state only tracks UI-only overrides: a tab
  // the user dismissed, or manually clicking a (currently single) tab.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [activeOverride, setActiveOverride] = useState<string | null>(null);

  // Phase 4 (Half A, REAL): the "Buy Credits" button now reflects the
  // signed-in user's actual credit_ledger balance (GET /api/credits) instead
  // of being a purely decorative label. Refetched whenever the active job's
  // status changes, since a running/just-finished job is exactly when new
  // `usage` events (and their matching ledger debits) land.
  const [balance, setBalance] = useState<number | null>(null);
  // Phase 4 (Half B, gated inert): clicking the button attempts a real
  // Stripe Checkout session (src/server/stripe.ts) when configured, and
  // surfaces "Stripe is not configured" otherwise — never a silent no-op.
  const [buyStatus, setBuyStatus] = useState<
    "idle" | "loading" | "not_configured" | "error"
  >("idle");
  const [buyMessage, setBuyMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/credits")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { balance?: number } | null) => {
        if (!cancelled && data && typeof data.balance === "number") {
          setBalance(data.balance);
        }
      })
      .catch(() => {
        // Balance display is best-effort — no DB configured yet, etc.
      });
    return () => {
      cancelled = true;
    };
  }, [jobStatus]);

  async function handleBuyCredits() {
    setBuyStatus("loading");
    setBuyMessage(null);
    try {
      const res = await fetch("/api/billing/checkout", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        configured?: boolean;
        url?: string;
        error?: string;
      };
      if (data.configured === false) {
        setBuyStatus("not_configured");
        setBuyMessage(
          data.error ?? "Stripe is not configured in this environment."
        );
        return;
      }
      if (!res.ok || data.error || !data.url) {
        setBuyStatus("error");
        setBuyMessage(data.error ?? `Request failed (${res.status})`);
        return;
      }
      setBuyStatus("idle");
      window.location.href = data.url;
    } catch (err) {
      setBuyStatus("error");
      setBuyMessage(
        err instanceof Error ? err.message : "Failed to start checkout"
      );
    }
  }

  const buyTooltipText =
    buyStatus === "not_configured" || buyStatus === "error"
      ? (buyMessage ?? "Something went wrong.")
      : "Your current credit balance — click to buy more.";

  const tabs: ProjectTab[] =
    project && !dismissedIds.has(project.id)
      ? [
          {
            id: project.id,
            name: project.slug,
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
          onClick={onNavigateHome}
        >
          <Home className="size-3.5" />
          Home
        </Button>
      </div>

      {/* Project tabs */}
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
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  statusDotClass(tab.status)
                )}
                aria-hidden
              />
              <span className="max-w-40 truncate">{tab.name}</span>
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
          className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {/* Right cluster */}
      <div className="flex shrink-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            aria-label="Buy credits"
            onClick={handleBuyCredits}
            disabled={buyStatus === "loading"}
            className="flex h-7 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] bg-yellow-400 px-2.5 text-[0.8rem] font-medium text-yellow-950 transition-colors hover:bg-yellow-300 disabled:pointer-events-none disabled:opacity-50"
          >
            {balance !== null ? `${balance.toLocaleString()} credits` : "Buy Credits"}
          </TooltipTrigger>
          <TooltipContent>{buyTooltipText}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            aria-label="Notifications"
            className="relative flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Bell className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Notifications</TooltipContent>
        </Tooltip>
        <Avatar size="sm">
          <AvatarFallback>
            {DEV_USER.name
              .split(" ")
              .map((part) => part[0])
              .join("")}
          </AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}
