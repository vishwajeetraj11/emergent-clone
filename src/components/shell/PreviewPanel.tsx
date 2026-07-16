"use client";

import { X } from "lucide-react";
import { OnboardingCarousel } from "@/components/shell/OnboardingCarousel";

export function PreviewPanel() {
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

      <div className="flex flex-1 items-center justify-center p-8">
        <OnboardingCarousel />
      </div>
    </section>
  );
}
