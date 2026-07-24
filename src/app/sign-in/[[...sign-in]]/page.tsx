import { SignIn } from "@clerk/nextjs";

/** Catch-all sign-in route, per Clerk's current App Router convention. */
export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <SignIn />
    </div>
  );
}
