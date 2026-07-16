/**
 * Single-user dev mode (Phase 0-2): there is no auth yet. Every project,
 * session, and job in local/dev environments belongs to this fixed user
 * row. Real auth (Clerk) replaces this in Phase 3.
 */
export const DEV_USER = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "dev@local.test",
  name: "Dev User",
} as const;
