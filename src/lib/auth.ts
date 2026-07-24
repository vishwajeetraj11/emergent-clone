import { cache } from "react";
import { eq } from "drizzle-orm";

// Clerk is REQUIRED in every environment, and deliberately has no
// isXConfigured() "off" path like the other integrations: for those, absent
// credentials remove a feature, but for auth they would remove a restriction —
// and absence is the default state of every misconfiguration.

/**
 * Throws unless both Clerk keys are present. Called from src/proxy.ts per
 * request, so a misconfigured environment gets this message rather than Clerk's
 * own "Missing publishableKey" from somewhere deeper in a render.
 */
export function assertClerkConfigured(): void {
  if (!process.env.CLERK_SECRET_KEY || !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    throw new Error(
      "Clerk is not configured: set CLERK_SECRET_KEY and " +
        "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY. Auth is required in every " +
        "environment — there is no unauthenticated mode."
    );
  }
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Resolves the acting user for server-side ownership (users/projects rows):
 * reads the authenticated Clerk identity and maps it to this app's own `users`
 * row keyed by clerkUserId. Throws when there is no signed-in user — callers
 * that can tolerate that (a signed-out visitor hitting a list endpoint) catch
 * it; page routes redirect to /sign-in before ever getting here.
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
