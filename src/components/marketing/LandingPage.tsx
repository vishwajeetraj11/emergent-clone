import Link from "next/link";
import { Show } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";

/**
 * Shown at `/` for every visitor, signed in or not (see src/app/page.tsx).
 *
 * Because signed-in visitors see this page too, the header can't
 * unconditionally offer "Sign in" / "Get started" — that would dead-end
 * someone who already has an account. Clerk's <Show when="signed-in|signed-out">
 * resolves that server-side from auth(), so this stays a server component and
 * no auth check is duplicated here.
 *
 * Written as a spec sheet rather than a product pitch: the audience is other
 * engineers, so the architecture IS the pitch. Every value below is real — the
 * timeout comes from src/server/sandbox-vercel-config.ts, the pipeline from
 * src/server/agent.ts. Nothing here describes a feature that doesn't run.
 */

const PIPELINE = [
  {
    stage: "Plan",
    model: "Opus",
    body: "Asks clarifying questions, then writes a build plan and stops. Nothing is written until you approve it. Revise as many times as you want.",
  },
  {
    stage: "Build",
    model: "Sonnet",
    body: "Gets Bash, Read, Write, Edit, Glob and Grep — every one of them executing inside the sandbox VM, never on the host.",
  },
  {
    stage: "Review",
    model: "Sonnet",
    body: "A second pass in a fresh context, handed your original request and the approved plan. Read-only tools by construction.",
  },
  {
    stage: "Debug",
    model: "Sonnet",
    body: "Runs only when review found something real. A clean review costs nothing.",
  },
];

const RUNTIME: [string, string][] = [
  ["Isolation", "Firecracker microVM, one per session"],
  ["Host environment", "never inherited — not on create, not on exec"],
  ["Database", "dedicated Postgres, branched per session"],
  ["Auth in your app", "real email + password, database-backed"],
  ["Preview", "public HTTPS, live while you iterate"],
  ["Session window", "45 min, resumes from snapshot in seconds"],
  ["Export", "push to GitHub, or deploy to Vercel"],
];

export function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-5 sm:px-10">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-tight">Emergent Clone</span>
          <span className="text-xs text-muted-foreground">
            a small clone, for learning
          </span>
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
      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
        {/* Deliberately left-aligned and off-centre: the eye starts at the
            headline and runs down that same edge through every section. */}
        <section className="px-6 pb-20 pt-20 sm:px-10 sm:pt-28">
          <div className="mx-auto max-w-5xl">
            <h1 className="max-w-3xl text-pretty text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
              Describe an app. An agent plans it, builds it in a
              <span className="text-emerald-400"> disposable VM</span>, reviews
              its own work, and hands you a live URL.
            </h1>
            <p className="mt-7 max-w-xl text-pretty leading-relaxed text-muted-foreground">
              Not a code snippet — a running application, with its own database
              and its own login, on a URL you can open on your phone.
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Show when="signed-out">
                <Button render={<Link href="/sign-up" />} nativeButton={false} size="lg">
                  Start building
                </Button>
              </Show>
              <Show when="signed-in">
                <Button render={<Link href="/dashboard" />} nativeButton={false} size="lg">
                  Open the builder
                </Button>
              </Show>
              <p className="text-sm text-muted-foreground">
                A study build of <span className="text-foreground/80">Emergent</span>,
                not affiliated with it.
              </p>
            </div>
          </div>
        </section>

        {/* The pipeline is the actual differentiator, so it carries the most
            structural weight — a numbered spine rather than a grid of cards. */}
        <section className="border-t border-border px-6 py-20 sm:px-10">
          <div className="mx-auto max-w-5xl">
            <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Four passes, not one prompt
            </h2>
            <p className="mt-4 max-w-2xl text-pretty text-xl leading-snug tracking-tight">
              Most of the work happens after the model stops typing.
            </p>

            <ol className="mt-12">
              {PIPELINE.map(({ stage, model, body }, i) => (
                <li
                  key={stage}
                  className="grid grid-cols-[2.5rem_1fr] gap-x-5 border-t border-border py-7 sm:grid-cols-[3.5rem_9rem_1fr] sm:gap-x-8"
                >
                  <span className="font-mono text-sm tabular-nums text-emerald-400/70">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="sm:contents">
                    <h3 className="text-base font-semibold tracking-tight">
                      {stage}
                      <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                        {model}
                      </span>
                    </h3>
                    <p className="mt-2 max-w-xl text-pretty text-sm leading-relaxed text-muted-foreground sm:mt-0">
                      {body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Runtime facts as a spec table. Mono is used for the values because
            they are values, not to make the section look "technical". */}
        <section className="border-t border-border px-6 py-20 sm:px-10">
          <div className="mx-auto grid max-w-5xl gap-12 lg:grid-cols-[17rem_1fr] lg:gap-20">
            <div>
              <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                What your app gets
              </h2>
              <p className="mt-4 text-pretty text-xl leading-snug tracking-tight">
                Every session is a real machine, not a preview pane.
              </p>
            </div>

            <dl className="text-sm">
              {RUNTIME.map(([term, value]) => (
                <div
                  key={term}
                  className="flex flex-col gap-1 border-t border-border py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8"
                >
                  <dt className="font-medium">{term}</dt>
                  <dd className="font-mono text-xs leading-relaxed text-muted-foreground sm:text-right">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="border-t border-border px-6 py-20 sm:px-10">
          <div className="mx-auto max-w-5xl">
            <p className="max-w-2xl text-pretty text-2xl font-semibold leading-snug tracking-tight">
              A small clone, built to learn how these things actually work.
            </p>
            <p className="mt-5 max-w-2xl text-pretty leading-relaxed text-muted-foreground">
              Nowhere near the scope of the product it borrows from — but the
              parts that are here are real. Sandbox isolation, per-app databases,
              snapshot and restore, credit accounting, self-review: the bits that
              are easy to describe and awkward to get right. Nothing is mocked.
            </p>
            <Show when="signed-out">
              <Button
                render={<Link href="/sign-up" />}
                nativeButton={false}
                variant="ghost"
                className="mt-8 -ml-4"
              >
                Try it yourself
              </Button>
            </Show>
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-6 py-10 text-sm text-muted-foreground sm:px-10">
        <div className="mx-auto flex max-w-5xl flex-col gap-3">
          <p className="max-w-2xl text-pretty leading-relaxed">
            A personal learning project — a small working clone of Emergent,
            built to understand how AI app builders are put together. It is not
            affiliated with, endorsed by, or connected to Emergent, and does not
            attempt to match its scope. All product names belong to their
            respective owners.
          </p>
          <p className="text-xs">
            Generated apps run in isolated sandboxes and are owned by whoever
            builds them.
          </p>
        </div>
      </footer>
    </div>
  );
}
