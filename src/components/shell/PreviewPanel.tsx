"use client";

import { X } from "lucide-react";
import { OnboardingCarousel } from "@/components/shell/OnboardingCarousel";
import { ProjectsList } from "@/components/shell/ProjectsList";

export function PreviewPanel({
  previewUrl,
  isRestoring = false,
  restoreError = null,
  onSelectProject,
}: {
  previewUrl?: string | null;
  /** Phase 3: POST /api/sessions/[id]/restore is in flight — bringing the
   * sandbox back up from its `files` snapshot (persistence / fork). */
  isRestoring?: boolean;
  restoreError?: string | null;
  onSelectProject?: (projectId: string) => void;
}) {
  return (
    <section className="flex h-full flex-1 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-medium text-foreground">
          App Preview
        </span>
        <button
          type="button"
          aria-label="Close preview"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      {previewUrl ? (
        // Phase 2: the sandbox is a real local child process running
        // agent-generated code (see src/server/sandbox.ts) — sandboxed
        // iframe attributes reflect that it's untrusted-ish generated output,
        // not a same-origin first-party page.
        <iframe
          key={previewUrl}
          src={previewUrl}
          title="App Preview"
          className="w-full flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      ) : isRestoring ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          <p className="text-sm text-muted-foreground">
            Restoring the sandbox from its last saved snapshot…
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          {restoreError && (
            <p className="max-w-sm text-center text-xs text-red-400">
              Couldn&apos;t restore the sandbox: {restoreError}
            </p>
          )}
          <OnboardingCarousel />
          {onSelectProject && <ProjectsList onSelectProject={onSelectProject} />}
        </div>
      )}
    </section>
  );
}
