import { isClerkConfigured } from "@/lib/auth";

/**
 * Phase 3 (Half B, gated inert): catch-all sign-up route, mirrors
 * src/app/sign-in/[[...sign-in]]/page.tsx — see that file's comment.
 */
export default async function SignUpPage() {
  if (!isClerkConfigured()) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Sign-up is not configured in this environment.
      </div>
    );
  }

  const { SignUp } = await import("@clerk/nextjs");
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <SignUp />
    </div>
  );
}
