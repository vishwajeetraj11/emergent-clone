import Link from "next/link";
import { Show } from "@clerk/nextjs";
import { ArrowUp, Rocket, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shown at `/` whenever Clerk is configured — for every visitor, signed in
 * or not (see src/app/page.tsx). Unconfigured (dev/no Clerk) redirects to
 * /dashboard instead, since none of the CTAs below have a sign-in flow
 * behind them in that mode.
 *
 * Because signed-in visitors see this page too, the header can't
 * unconditionally offer "Sign in" / "Get started" — that would dead-end
 * someone who already has an account and just wants back into the app.
 * Clerk's <Show when="signed-in|signed-out"> resolves that server-side from
 * auth() (this Clerk major replaced the old SignedIn/SignedOut components
 * with it), so this stays a server component and no auth check is duplicated
 * here.
 */
export function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-4 sm:px-10">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Rocket className="size-4 text-primary" />
          Emergent Clone
        </div>
        <div className="flex items-center gap-2">
          <Show when="signed-out">
            <Button
              render={<Link href="/sign-in" />}
              nativeButton={false}
              variant="ghost"
              size="sm"
            >
              Sign in
            </Button>
            <Button render={<Link href="/sign-up" />} nativeButton={false} size="sm">
              Get started
            </Button>
          </Show>
          <Show when="signed-in">
            <Button render={<Link href="/dashboard" />} nativeButton={false} size="sm">
              Go to dashboard
            </Button>
          </Show>
        </div>
      </header>

      {/* Skip-link target — see src/app/layout.tsx. */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center outline-none"
      >
        <div className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
          <Sparkles className="size-3.5" />
          Chat with an agent that ships real apps
        </div>

        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Describe an app in chat and watch an agent build it.
        </h1>
        <p className="mt-4 max-w-lg text-balance text-muted-foreground">
          Design, code, and deploy in one conversation. You own everything you
          build.
        </p>

        <div className="mt-10 w-full max-w-xl rounded-2xl border border-border bg-card p-4 text-left shadow-sm">
          <div className="min-h-16 px-1 text-sm text-muted-foreground">
            Describe your idea, we&apos;ll bring it to life...
          </div>
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">
              Sign up to start building — free to try
            </span>
            <Button
              render={<Link href="/sign-up" aria-label="Get started" />}
              nativeButton={false}
              size="icon-sm"
              className="rounded-full"
            >
              <ArrowUp />
            </Button>
          </div>
        </div>

        <Button
          render={<Link href="/sign-up" />}
          nativeButton={false}
          className="mt-8"
          size="lg"
        >
          Start building free
        </Button>
      </main>
    </div>
  );
}
