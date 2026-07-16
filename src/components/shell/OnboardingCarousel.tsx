"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type Slide = {
  title: string;
  subtitle: string;
};

const SLIDES: Slide[] = [
  {
    title: "Deploy Your Application",
    subtitle:
      "Ship straight to production with a single click once your app is ready.",
  },
  {
    title: "1M Context Window",
    subtitle:
      "Your agent keeps the entire build in view — every file, every decision.",
  },
  {
    title: "Manage Agent Context With Forks",
    subtitle:
      "Branch a session to explore an idea without losing your working version.",
  },
  {
    title: "Assets",
    subtitle:
      "Drop in images, documents, and references for the agent to build with.",
  },
];

const AUTO_ADVANCE_MS = 4500;

export function OnboardingCarousel() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % SLIDES.length);
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(timer);
  }, []);

  function goTo(next: number) {
    setIndex((next + SLIDES.length) % SLIDES.length);
  }

  const slide = SLIDES[index];

  return (
    <div className="flex flex-col items-center gap-8">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400/20 to-emerald-600/10 ring-1 ring-emerald-400/20">
        <Sparkles className="size-6 text-emerald-400" />
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          aria-label="Previous slide"
          onClick={() => goTo(index - 1)}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>

        <div className="flex w-72 flex-col items-center gap-2 text-center">
          <h2 className="text-base font-semibold text-foreground">
            {slide.title}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {slide.subtitle}
          </p>
        </div>

        <button
          type="button"
          aria-label="Next slide"
          onClick={() => goTo(index + 1)}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        {SLIDES.map((s, i) => (
          <button
            key={s.title}
            type="button"
            aria-label={`Go to slide ${i + 1}`}
            onClick={() => goTo(i)}
            className={cn(
              "h-1.5 rounded-full transition-all",
              i === index ? "w-4 bg-foreground" : "w-1.5 bg-muted-foreground/40"
            )}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-4 py-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Initializing agent&hellip;
      </div>
    </div>
  );
}
