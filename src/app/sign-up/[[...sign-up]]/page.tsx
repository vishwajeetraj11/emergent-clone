import { SignUp } from "@clerk/nextjs";

/** Catch-all sign-up route, mirrors src/app/sign-in/[[...sign-in]]/page.tsx. */
export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <SignUp />
    </div>
  );
}
