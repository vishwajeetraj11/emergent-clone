"use client";

import { useState } from "react";
import { Bell, Home, Plus, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEV_USER } from "@/lib/dev-user";
import { cn } from "@/lib/utils";

type ProjectTab = {
  id: string;
  name: string;
  status: "running" | "idle" | "error";
};

const INITIAL_TABS: ProjectTab[] = [
  { id: "quiz-builder-223", name: "quiz-builder-223", status: "running" },
];

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

export function TopBar() {
  const [tabs, setTabs] = useState<ProjectTab[]>(INITIAL_TABS);
  const [activeTab, setActiveTab] = useState<string | null>(
    INITIAL_TABS[0]?.id ?? null
  );

  function closeTab(id: string) {
    setTabs((prev) => prev.filter((tab) => tab.id !== id));
    setActiveTab((prev) => (prev === id ? null : prev));
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
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
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
              onClick={() => setActiveTab(tab.id)}
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
        <Button
          size="sm"
          className="gap-1.5 bg-yellow-400 text-yellow-950 hover:bg-yellow-300"
        >
          Buy Credits
        </Button>
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
