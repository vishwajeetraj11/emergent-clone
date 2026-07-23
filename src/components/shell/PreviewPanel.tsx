"use client";

import { useState } from "react";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { PingDot } from "@/components/ui/ping-dot";
import { OnboardingCarousel } from "@/components/shell/OnboardingCarousel";
import { ProjectsList } from "@/components/shell/ProjectsList";
import { PausedPreviewCard } from "@/components/shell/preview/PausedPreviewCard";
import { PreviewFrame } from "@/components/shell/preview/PreviewFrame";
import { ViewportToggle, type Viewport } from "@/components/shell/preview/ViewportToggle";
import { RESTORING_PREVIEW_MESSAGE } from "@/lib/messages";

export function PreviewPanel({
  previewUrl,
  isRestoring = false,
  restoreError = null,
  isPreviewDead = false,
  onRestartPreview,
  onSelectProject,
  currentProjectId = null,
  onNavigateHome,
}: {
  previewUrl?: string | null;
  /** POST /api/sessions/[id]/restore is in flight — bringing the
   * sandbox back up from its `files` snapshot (persistence / fork). */
  isRestoring?: boolean;
  restoreError?: string | null;
  /** Set by useAgentSession's background health poll when the sandbox's
   * runtime has vanished (e.g. a Vercel VM hit its max timeout) — swaps the
   * stale iframe below for a "Preview stopped" restart card. */
  isPreviewDead?: boolean;
  onRestartPreview?: () => void;
  onSelectProject?: (projectId: string) => void;
  /** The project currently loaded in AppShell (session.project?.id), if
   * any — passed through to ProjectsList so deleting it can navigate home
   * instead of leaving a dead project open. */
  currentProjectId?: string | null;
  /** Same navigation AppShell's Home button uses — ProjectsList calls this
   * when the project it just deleted is the one currently open. */
  onNavigateHome?: () => void;
}) {
  // Bumped by the reload button to force the iframe to remount and refetch
  // — there was previously no way to retry a stuck/erroring preview short of
  // reloading the whole app page. The iframe is cross-origin (different
  // port), so we can't detect an error inside it from here; opening the URL
  // directly (below) is the real way to see what's actually happening.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Lets the generated app be checked at common device widths without
  // leaving the panel or resizing the browser window — desktop renders the
  // iframe full-bleed exactly as before; tablet/phone frame it at a fixed
  // width inside a centered "device" card so responsive bugs are visible
  // without a real device. Deliberately left out of the frameLoaded reset
  // effect below: switching frame size shouldn't re-cover an already-loaded
  // app — and (see the iframe branch) desktop/tablet/phone share one DOM
  // shape specifically so toggling this never remounts the iframe.
  const [viewport, setViewport] = useState<Viewport>("desktop");

  return (
    // Named: an unnamed <section> is not exposed as a landmark at all, so
    // this whole half of the app was missing from the landmark list.
    <section aria-label="App preview" className="flex h-full flex-1 flex-col bg-background">
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
          {previewUrl && <ViewportToggle viewport={viewport} onChange={setViewport} />}
          {previewUrl && (
            <IconButton label="Reload preview" onClick={() => setReloadNonce((n) => n + 1)}>
              <RefreshCw className="size-3.5" />
            </IconButton>
          )}
          <IconButton label="Close preview">
            <X className="size-4" />
          </IconButton>
        </div>
      </header>

      {isRestoring ? (
        <div
          role="status"
          className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
        >
          <PingDot />
          <p className="text-sm text-muted-foreground">{RESTORING_PREVIEW_MESSAGE}</p>
        </div>
      ) : previewUrl && isPreviewDead ? (
        // The iframe below is cross-origin, so it can't surface the
        // sandbox's own death — a background health poll in useAgentSession
        // flips isPreviewDead once a server-side probe confirms the runtime
        // is actually gone (see that hook's poll effect).
        <PausedPreviewCard restoreError={restoreError} onRestartPreview={onRestartPreview} />
      ) : previewUrl ? (
        <PreviewFrame previewUrl={previewUrl} reloadNonce={reloadNonce} viewport={viewport} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          {restoreError && (
            <p role="alert" className="max-w-sm text-center text-xs text-red-400">
              Couldn&apos;t restore the sandbox: {restoreError}
            </p>
          )}
          <OnboardingCarousel />
          {onSelectProject && (
            <ProjectsList
              onSelectProject={onSelectProject}
              currentProjectId={currentProjectId}
              onNavigateHome={onNavigateHome}
            />
          )}
        </div>
      )}
    </section>
  );
}
