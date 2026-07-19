import Link from "next/link";
import { ArrowUp, Rocket, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shown at `/` instead of AppShell whenever Clerk is configured and the
 * visitor has no session — see src/app/page.tsx. Unconfigured (dev/no
 * Clerk) keeps going straight to AppShell, unchanged.
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
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
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
