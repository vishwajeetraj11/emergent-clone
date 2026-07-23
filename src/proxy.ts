import { clerkMiddleware } from "@clerk/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { assertClerkConfigured } from "@/lib/auth";

// Next.js 16 renamed middleware.ts -> proxy.ts; the file must export a single
// function, default or named `proxy`.
//
// Route-level protection (e.g. /p/[projectId]) lives in each page via auth(),
// not here — Clerk's createRouteMatcher + auth.protect() middleware pattern is
// deprecated in favor of resource-based checks per page/layout/route, since
// path matching here can diverge from how Next.js actually routes a request.

type ClerkHandler = (req: NextRequest, event: NextFetchEvent) => unknown;

let clerkHandler: ClerkHandler | null = null;

// Both calls stay per-request: clerkMiddleware() throws when unconfigured, and
// at module scope that would fail `next build` (which loads this file) rather
// than the requests it protects.
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
