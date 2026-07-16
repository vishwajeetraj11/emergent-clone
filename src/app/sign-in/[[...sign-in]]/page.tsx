import { isClerkConfigured } from "@/lib/auth";

/**
 * Phase 3 (Half B, gated inert): catch-all sign-in route per Clerk's current
 * App Router convention. Unconfigured (default, always-tested): a plain
 * message, no Clerk import at all. Configured: renders <SignIn /> — this
 * branch is code-complete but unverified (no real Clerk keys here).
 */
export default async function SignInPage() {
  if (!isClerkConfigured()) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Sign-in is not configured in this environment.
      </div>
    );
  }

  const { SignIn } = await import("@clerk/nextjs");
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <SignIn />
    </div>
  );
}
