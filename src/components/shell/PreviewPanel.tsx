"use client";

import { useState } from "react";
import { ExternalLink, RefreshCw, X } from "lucide-react";
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
  // Bumped by the reload button to force the iframe to remount and refetch
  // — there was previously no way to retry a stuck/erroring preview short of
  // reloading the whole app page. The iframe is cross-origin (different
  // port), so we can't detect an error inside it from here; opening the URL
  // directly (below) is the real way to see what's actually happening.
  const [reloadNonce, setReloadNonce] = useState(0);

  return (
    <section className="flex h-full flex-1 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-sm font-medium text-foreground">
            App Preview
          </span>
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the preview directly in a new tab — bypasses the iframe, so you can see the real status/errors yourself"
              className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
            >
              <span className="truncate">{previewUrl}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {previewUrl && (
            <button
              type="button"
              aria-label="Reload preview"
              title="Reload preview"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label="Close preview"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      {previewUrl ? (
        // Phase 2: the sandbox is a real local child process running
        // agent-generated code (see src/server/sandbox.ts) — sandboxed
        // iframe attributes reflect that it's untrusted-ish generated output,
        // not a same-origin first-party page.
        <iframe
          key={`${previewUrl}-${reloadNonce}`}
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
