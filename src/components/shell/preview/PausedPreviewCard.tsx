import { PowerOff } from "lucide-react";
import {
  PAUSED_PREVIEW_BODY,
  PAUSED_PREVIEW_BUTTON,
  PAUSED_PREVIEW_TITLE,
} from "@/lib/messages";

/**
 * Shown in place of the iframe once useAgentSession's background health
 * poll confirms the sandbox's runtime has vanished (e.g. a Vercel VM hit
 * its max timeout) — the iframe itself is cross-origin, so it can't
 * surface the sandbox's own death.
 */
export function PausedPreviewCard({
  restoreError,
  onRestartPreview,
}: {
  restoreError?: string | null;
  onRestartPreview?: () => void;
}) {
  return (
    // role="status": the preview dying is a state change nobody asked for —
    // the iframe is simply replaced by this card, which a screen-reader user
    // has no way to notice otherwise.
    <div
      role="status"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <PowerOff className="size-8 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{PAUSED_PREVIEW_TITLE}</p>
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        {PAUSED_PREVIEW_BODY}
      </p>
      {restoreError && (
        <p role="alert" className="max-w-sm text-center text-xs text-red-400">
          Restart failed: {restoreError}
        </p>
      )}
      <button
        type="button"
        onClick={onRestartPreview}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        {PAUSED_PREVIEW_BUTTON}
      </button>
    </div>
  );
}
