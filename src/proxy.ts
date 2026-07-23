import { clerkMiddleware } from "@clerk/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { assertClerkConfigured } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Next.js 16 renamed middleware.ts -> proxy.ts (this repo pins next@16.2.10);
// the file must export a single function, default or named `proxy`.
//
// Clerk is required in every environment (see src/lib/auth.ts), so this runs
// unconditionally — there is no passthrough branch. It used to have one, keyed
// off whether the Clerk keys happened to be set, which meant a deploy missing
// them served every route unauthenticated instead of failing.
//
// Both the assert and clerkMiddleware() are called per-request rather than at
// module scope: clerkMiddleware() throws "Missing publishableKey" when
// unconfigured, and at module scope that would fail `next build` (which loads
// this file) rather than the requests it is meant to protect. assertClerk-
// Configured() runs first only so the error says what to set.
//
// Route-level protection (e.g. /p/[projectId]) lives in each page via auth(),
// not here — Clerk's own createRouteMatcher + auth.protect() middleware pattern
// is deprecated in favor of resource-based checks per page/layout/route, since
// path matching here can diverge from how Next.js actually routes a request.
// ---------------------------------------------------------------------------

type ClerkHandler = (req: NextRequest, event: NextFetchEvent) => unknown;

let clerkHandler: ClerkHandler | null = null;

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  assertClerkConfigured();
  clerkHandler ??= clerkMiddleware() as ClerkHandler;
  return clerkHandler(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
