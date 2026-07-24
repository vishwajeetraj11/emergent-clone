/**
 * Skeleton rows shown while the project list loads. Six because the container
 * caps at max-h-64 (256px) and scrolls past that, so six is the tallest the
 * block ever gets. It sits in a justify-center column, so a placeholder shorter
 * than the real list would grow the block on resolve and drag the onboarding
 * carousel upward — sized at the cap, the placeholder can only ever shrink.
 */
export const PROJECT_LIST_SKELETON_ROWS = 6;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
