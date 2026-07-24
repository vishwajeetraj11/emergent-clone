"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/hooks/usePrefersReducedMotion";
import {
  ONBOARDING_SLIDES,
  ONBOARDING_AUTO_ADVANCE_MS,
} from "@/lib/constants/onboarding";

export function OnboardingCarousel() {
  const [index, setIndex] = useState(0);
  // WCAG 2.2.2 (Pause, Stop, Hide): content that starts moving automatically
  // and lasts more than five seconds must be pausable by the user. This
  // carousel rotates indefinitely, so it needs a real control — an
  // auto-advancing panel is also a genuine reading problem for anyone slow to
  // read, using magnification, or translating the page.
  const [isPaused, setIsPaused] = useState(false);
  // Hovering or tabbing into the carousel stops it too: having the slide
  // swap out from under the pointer/focus mid-read is the specific failure
  // the criterion exists to prevent.
  const [isHeld, setIsHeld] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  // Reduced motion stops the rotation outright rather than merely shortening
  // it — the CSS override in globals.css can flatten a transition, but it
  // can't stop a setInterval swapping the content.
  const isRunning = !isPaused && !isHeld && !prefersReducedMotion;

  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % ONBOARDING_SLIDES.length);
    }, ONBOARDING_AUTO_ADVANCE_MS);
    return () => clearInterval(timer);
  }, [isRunning]);

  function goTo(next: number) {
    setIndex((next + ONBOARDING_SLIDES.length) % ONBOARDING_SLIDES.length);
  }

  const slide = ONBOARDING_SLIDES[index];

  return (
    <section
      aria-roledescription="carousel"
      aria-label="What you can build here"
      onMouseEnter={() => setIsHeld(true)}
      onMouseLeave={() => setIsHeld(false)}
      onFocusCapture={() => setIsHeld(true)}
      onBlurCapture={() => setIsHeld(false)}
      className="flex flex-col items-center gap-8"
    >
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

        {/* aria-live="polite" only while the carousel is actually rotating on
            its own. When the user drives it (arrows, dots) the change is a
            direct result of their action and the new slide gets read by
            normal focus/reading order — announcing it again would double up. */}
        <div
          aria-live={isRunning ? "polite" : "off"}
          aria-atomic="true"
          aria-roledescription="slide"
          aria-label={`Slide ${index + 1} of ${ONBOARDING_SLIDES.length}`}
          className="flex w-72 flex-col items-center gap-2 text-center"
        >
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
        {ONBOARDING_SLIDES.map((s, i) => (
          <button
            key={s.title}
            type="button"
            // The dot's own name says which slide it is; aria-current says
            // which one you're on. Previously the active dot differed only by
            // being wider, which reaches nobody using assistive tech.
            aria-label={`Go to slide ${i + 1}: ${s.title}`}
            aria-current={i === index}
            onClick={() => goTo(i)}
            className={cn(
              "h-1.5 rounded-full transition-all",
              i === index ? "w-4 bg-foreground" : "w-1.5 bg-muted-foreground/40"
            )}
          />
        ))}

        {/* Hidden entirely under reduced motion: there's nothing running to
            pause, so a control claiming otherwise would just be a lie. */}
        {!prefersReducedMotion && (
          <button
            type="button"
            aria-label={isPaused ? "Resume auto-advancing slides" : "Pause auto-advancing slides"}
            onClick={() => setIsPaused((prev) => !prev)}
            className="ml-1.5 flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {isPaused ? <Play className="size-3" /> : <Pause className="size-3" />}
          </button>
        )}
      </div>
    </section>
  );
}
