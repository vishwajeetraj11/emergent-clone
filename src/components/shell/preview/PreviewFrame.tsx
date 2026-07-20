"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { PingDot } from "@/components/ui/ping-dot";
import { viewportMaxWidth, type Viewport } from "@/components/shell/preview/ViewportToggle";

/**
 * Renders the live generated-app iframe, framed at the given viewport
 * width. One DOM shape for every viewport mode — only classNames/maxWidth
 * change below — so toggling desktop/tablet/phone never remounts the
 * iframe (a remount reloads the whole generated app and re-covers it with
 * the loading overlay for nothing).
 */
export function PreviewFrame({
  previewUrl,
  reloadNonce,
  viewport,
}: {
  previewUrl: string;
  reloadNonce: number;
  viewport: Viewport;
}) {
  // The iframe is cross-origin (different port — see the sandbox comment
  // below), so the browser gives us no loading UI of its own: left alone,
  // the panel is just a blank white rectangle until the generated app
  // finishes compiling and paints its first frame. onLoad is the only
  // signal a cross-origin frame gives us, and it also fires for error
  // documents (e.g. a connection-refused page) — that's fine here, since
  // this overlay only covers first paint, not preview health; isPreviewDead
  // (see PreviewPanel) is what actually detects a dead sandbox.
  //
  // "Loaded" is keyed to the iframe's identity (same key the iframe element
  // uses) rather than reset via an effect: when the URL changes or the
  // reload button bumps the nonce, frameKey changes and frameLoaded is
  // derivably false again — no setState-in-effect, and a stale onLoad from
  // the previous document can never mark the new one as loaded.
  const frameKey = `${previewUrl}-${reloadNonce}`;
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null);
  const frameLoaded = loadedFrameKey === frameKey;

  const maxWidth = viewportMaxWidth(viewport);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1",
        viewport !== "desktop" && "justify-center overflow-auto bg-secondary/40 p-4"
      )}
    >
      <div
        className={cn(
          "relative flex h-full w-full flex-col",
          viewport !== "desktop" &&
            "overflow-hidden rounded-xl border border-border shadow-sm"
        )}
        style={maxWidth === undefined ? undefined : { maxWidth }}
      >
        {!frameLoaded && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
            <PingDot />
            <p className="text-sm text-muted-foreground">Loading the app…</p>
          </div>
        )}
        {/* Phase 2: the sandbox is a real local child process running
            agent-generated code (see src/server/sandbox.ts) — sandboxed
            iframe attributes reflect that it's untrusted-ish generated
            output, not a same-origin first-party page. */}
        <iframe
          key={frameKey}
          src={previewUrl}
          title="App Preview"
          onLoad={() => setLoadedFrameKey(frameKey)}
          className="w-full flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
    </div>
  );
}
