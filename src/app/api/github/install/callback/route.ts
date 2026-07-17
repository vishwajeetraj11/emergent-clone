import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser, isClerkConfigured } from "@/lib/auth";
import { DEV_USER } from "@/lib/dev-user";
import { ensureUserRow } from "@/server/credits";

/**
 * GitHub App "Setup URL" — this exact path (/api/github/install/callback) is
 * registered as the App's Setup URL on GitHub's side, so it MUST live here.
 * GitHub redirects here after a user installs (or updates) the app, with
 * `installation_id` and `setup_action` (typically "install" or "update") as
 * query params. Resolves the current user the same way as everywhere else
 * in this app (getCurrentUser()/DEV_USER) and stores the installation id on
 * that user's row, then redirects back to the app.
 */
export async function GET(request: NextRequest) {
  const installationId = request.nextUrl.searchParams.get("installation_id");
  const setupAction = request.nextUrl.searchParams.get("setup_action");

  console.log(
    `[api/github/install/callback] installation_id=${installationId} setup_action=${setupAction}`
  );

  if (!installationId) {
    return NextResponse.redirect(
      new URL("/?github=error", request.url)
    );
  }

  // Same isClerkConfigured()/DEV_USER pattern as GET /api/credits: in
  // single-user dev mode the DEV_USER row may not exist yet (nothing else on
  // this path guarantees it), so ensure it before updating — otherwise the
  // UPDATE below would silently affect zero rows and the installation id
  // would be lost.
  let currentUser: { id: string };
  if (isClerkConfigured()) {
    currentUser = await getCurrentUser();
  } else {
    await ensureUserRow({
      id: DEV_USER.id,
      email: DEV_USER.email,
      name: DEV_USER.name,
    });
    currentUser = DEV_USER;
  }

  const db = getDb();
  await db
    .update(users)
    .set({ githubInstallationId: installationId })
    .where(eq(users.id, currentUser.id));

  return NextResponse.redirect(new URL("/?github=connected", request.url));
}
