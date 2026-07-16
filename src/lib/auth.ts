import { DEV_USER } from "@/lib/dev-user";

// ---------------------------------------------------------------------------
// Phase 3 (Half B, gated inert): Clerk auth replaces DEV_USER only when
// fully configured. No CLERK_SECRET_KEY / NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
// were available when this was built — verified that npm run build, npm run
// lint, and `next dev` all behave identically to before this change with
// neither var set (see PLAN.md Phase 3). The Clerk ("on") path below is
// code-complete against Clerk's current documented APIs but NOT
// live-verified — no real keys exist in this environment.
//
// isClerkConfigured() is the single gate everything else in this file (and
// src/proxy.ts, src/app/layout.tsx's ClerkGate, the sign-in/up routes) keys
// off of. `@clerk/nextjs/server` is only ever imported dynamically, and only
// from inside a branch already guarded by this check — so when unconfigured,
// none of Clerk's module code runs, not even at import time.
// ---------------------------------------------------------------------------

export function isClerkConfigured(): boolean {
  return Boolean(
    process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  );
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Resolves the acting user for server-side ownership (users/projects rows).
 * Unconfigured (the default, always-tested path): returns the fixed
 * DEV_USER row unchanged from Phase 0-2 — single-user dev mode. Configured:
 * reads the authenticated Clerk identity and upserts a matching `users` row
 * keyed by clerkUserId, so ownership of new projects follows the real
 * signed-in user instead of DEV_USER. This branch is unverified (no Clerk
 * keys in this environment).
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  if (!isClerkConfigured()) {
    return DEV_USER;
  }

  const { auth, currentUser } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) {
    throw new Error("Not authenticated");
  }

  const clerkUser = await currentUser();
  const email =
    clerkUser?.primaryEmailAddress?.emailAddress ?? `${userId}@users.noreply.clerk`;
  const name =
    clerkUser?.fullName?.trim() || clerkUser?.username || null;

  const { getDb } = await import("@/db");
  const { users } = await import("@/db/schema");
  const db = getDb();
  const [row] = await db
    .insert(users)
    .values({ clerkUserId: userId, email, name })
    .onConflictDoUpdate({
      target: users.clerkUserId,
      set: { email, name },
    })
    .returning();

  return { id: row.id, email: row.email, name: row.name };
}
