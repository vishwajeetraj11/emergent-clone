"use client";

import { X } from "lucide-react";
import { OnboardingCarousel } from "@/components/shell/OnboardingCarousel";

export function PreviewPanel({ previewUrl }: { previewUrl?: string | null }) {
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
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <OnboardingCarousel />
        </div>
      )}
    </section>
  );
}
