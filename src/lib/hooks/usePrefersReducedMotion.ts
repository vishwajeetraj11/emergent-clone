"use client";

import { useSyncExternalStore } from "react";
import { REDUCED_MOTION_QUERY } from "@/lib/constants/ui";

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Reads the user's reduced-motion preference, live. Auto-advancing content is
 * exactly what that setting is for, and it can be toggled at OS level while the
 * page is open — hence a subscription rather than a one-shot read.
 *
 * useSyncExternalStore, not useState + useEffect: matchMedia IS an external
 * store, and reading it in an effect would mean an extra render pass on every
 * mount (plus a setState-in-effect, which React now flags). The server snapshot
 * is `false` because there is no media query to evaluate during SSR; the
 * client's first paint has the real value.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false
  );
}
