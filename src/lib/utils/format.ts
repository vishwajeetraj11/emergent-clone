/** Locale-aware date+time for timeline-ish rows (sessions, deployments). */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
/** Locale-aware date-only for list rows (project cards). */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}
