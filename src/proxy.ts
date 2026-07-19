import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { isClerkConfigured } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Phase 3 (Half B, gated inert): Next.js 16 renamed middleware.ts -> proxy.ts
// (this repo pins next@16.2.10) — the default export must be named `proxy`.
//
// Clerk's own docs confirm `clerkMiddleware()` throws ("Missing
// publishableKey") when called without keys configured — so the only safe
// way to keep this a true no-op when unconfigured is to never call it, and
// never even import `@clerk/nextjs/server` (a static import would still pull
// the module in, but its side effects only fire when clerkMiddleware() is
// actually invoked to build a handler). The dynamic import below only
// happens inside the isClerkConfigured() branch, so with no
// CLERK_SECRET_KEY / NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY set (the default in
// this environment and verified via `npm run build` / `npm run lint` /
// `next dev`), this proxy is a pure passthrough — no Clerk code ever runs.
// ---------------------------------------------------------------------------

type ClerkHandler = (req: NextRequest, event: NextFetchEvent) => unknown;

let clerkHandler: ClerkHandler | null = null;

// Route-level protection (e.g. /p/[projectId]) lives in each page via
// isClerkConfigured() + auth(), not here — Clerk's own createRouteMatcher +
// auth.protect() middleware pattern is deprecated in favor of resource-based
// checks per-page/layout/route, since path matching here can diverge from
// how Next.js actually routes a request.
async function getClerkHandler(): Promise<ClerkHandler> {
  if (!clerkHandler) {
    const { clerkMiddleware } = await import("@clerk/nextjs/server");
    clerkHandler = clerkMiddleware() as ClerkHandler;
  }
  return clerkHandler;
}

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!isClerkConfigured()) {
    return NextResponse.next();
  }
  const handler = await getClerkHandler();
  return handler(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
