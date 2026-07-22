import type { ReactNode } from "react";
import { isClerkConfigured } from "@/lib/auth";

/**
 * Phase 3 (Half B, gated inert): wraps the app in <ClerkProvider> only when
 * Clerk is actually configured. `@clerk/nextjs` is dynamically imported only
 * inside that branch, so the unconfigured (default, always-tested) path
 * never touches Clerk's module at all — same gating approach as src/proxy.ts.
 */
export async function ClerkGate({ children }: { children: ReactNode }) {
  if (!isClerkConfigured()) {
    return <>{children}</>;
  }

  const { ClerkProvider } = await import("@clerk/nextjs");
  // Post-auth landing is /dashboard, not `/` — `/` is the marketing page, so
  // without these a fresh sign-in drops the user back on the pitch instead of
  // the product. Set here rather than via
  // NEXT_PUBLIC_CLERK_SIGN_{IN,UP}_FALLBACK_REDIRECT_URL so the routing lives
  // in version control next to the routes it names; these props take
  // precedence over those env vars, which still read `/` in existing
  // environments.
  return (
    <ClerkProvider
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
    >
      {children}
    </ClerkProvider>
  );
}
