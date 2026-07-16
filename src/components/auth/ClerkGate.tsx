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
  return <ClerkProvider>{children}</ClerkProvider>;
}
