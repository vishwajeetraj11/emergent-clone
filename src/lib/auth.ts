import { cache } from "react";
import { eq } from "drizzle-orm";
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
 * reads the authenticated Clerk identity and maps it to this app's own
 * `users` row keyed by clerkUserId, so ownership of new projects follows the
 * real signed-in user instead of DEV_USER. This branch is unverified (no
 * Clerk keys in this environment).
 *
 * HOT/COLD SPLIT — this runs on every authenticated request (34 API call
 * sites reach it via src/lib/authz.ts's assert*Ownership, which needs "who am
 * I" before it can compare against a resource's owner). It used to do a Clerk
 * Backend API fetch (`currentUser()`) plus a DB *write* (upsert ... returning)
 * every single time, which is what put /api/projects at 2.8-7.1s and
 * /api/projects/[id] at 5.5-9.6s against a remote Neon instance — those
 * numbers were a serialized round-trip count, not query cost.
 *
 * Both of those exist only to provision a row that, per user, is needed
 * exactly once. So the common path is now a single indexed read on
 * users.clerkUserId (unique, see src/db/schema.ts) with no network call and
 * no write — a write can never be served by a read replica, so keeping one
 * here would cap how far reads can ever scale. `currentUser()` is imported
 * only inside the cold branch, since its whole purpose is supplying
 * email/name to the insert.
 *
 * TRADEOFF: email/name no longer re-sync from Clerk on every request. A
 * profile edited in Clerk won't reach this table until that user's row is
 * created (or a `user.updated` webhook is added — src/app/api/webhooks/ has
 * only `razorpay` today). Safe as things stand: these columns feed ownership
 * and purchase receipts, and the UI renders Clerk's own <UserButton>, which
 * reads from Clerk directly rather than from this row.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser> => {
  if (!isClerkConfigured()) {
    return DEV_USER;
  }

  // auth() resolves the session token in-process — no Clerk API round trip.
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) {
    throw new Error("Not authenticated");
  }

  const { getDb } = await import("@/db");
  const { users } = await import("@/db/schema");
  const db = getDb();

  const [existing] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.clerkUserId, userId));
  if (existing) {
    return { id: existing.id, email: existing.email, name: existing.name };
  }

  // Cold path: genuinely the first request ever seen for this Clerk user —
  // there is no webhook telling us they signed up, so the row is provisioned
  // just-in-time here. Kept as an upsert rather than a plain insert because
  // two concurrent first requests can both miss the select above; ON CONFLICT
  // makes that a no-op update instead of a unique-violation crash.
  const { currentUser } = await import("@clerk/nextjs/server");
  const clerkUser = await currentUser();
  const email =
    clerkUser?.primaryEmailAddress?.emailAddress ?? `${userId}@users.noreply.clerk`;
  const name =
    clerkUser?.fullName?.trim() || clerkUser?.username || null;

  const [row] = await db
    .insert(users)
    .values({ clerkUserId: userId, email, name })
    .onConflictDoUpdate({
      target: users.clerkUserId,
      set: { email, name },
    })
    .returning();

  return { id: row.id, email: row.email, name: row.name };
});
