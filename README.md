# Emergent Clone

An AI app builder. You describe an application in chat; an agent plans it, asks
you to approve the plan, writes it inside an isolated microVM, reviews its own
work, and hands back a live URL. The result is a running full-stack app with its
own Postgres database and its own login, not a code snippet.

This is a study reimplementation of [Emergent](https://emergent.sh), built to
understand how AI app builders actually work. It is not affiliated with,
endorsed by, or connected to Emergent, and does not attempt to match its scope.

Not deployed anywhere. Nothing here is mocked.

Walkthroughs: [pt-1](https://www.youtube.com/watch?v=OVXjhwnDz-k), and
[pt-2: debugging a login bug in a generated app](https://youtu.be/NauO8abC4I0).

## How a build runs

Four passes, each a separate model call with its own context:

| Pass | Model | What it does |
| --- | --- | --- |
| Plan | Opus | Asks clarifying questions, writes a build plan, then stops. Nothing is written until you approve. Revisable up to 5 times. |
| Build | Sonnet | Gets Bash, Read, Write, Edit, Glob and Grep, all executing inside the sandbox VM. |
| Review | Sonnet | A fresh context handed your request and the approved plan. Read-only tools by construction. |
| Debug | Sonnet | Runs only if review found something real. A clean review costs nothing. |

The planner is never user-selected. The builder model is, per message.

## What each session gets

- **A Firecracker microVM** ([Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)),
  one per session, holding none of the platform's environment. The agent's tools
  execute inside it, so the box the agent edits is the box serving the preview.
- **Its own Postgres**, one [Neon](https://neon.tech) project per project and one
  branch per session. Forking a session copy-on-writes its database alongside its
  files, so a fork's data matches the moment it was forked.
- **Real database-backed auth** in the generated app, via
  [better-auth](https://better-auth.com). See below.
- **A public HTTPS preview**, live while you iterate, resumable from snapshot.

Files live in Cloudflare R2 and the database holds only the index: each `files`
row is `{path, hash}`, the bytes are in R2 under `sessions/<id>/<path>`. Snapshot
and restore fall out of that.

Sessions can be saved to GitHub (via a GitHub App installation, so it works for
any user, not just the token holder) or deployed to Vercel.

## Generated-app auth

When a generated app needs login, the platform provisions it rather than letting
the agent invent one. Everything the app's auth needs is injected into the
sandbox as `.env.local` (built by `buildSandboxEnvContent` in
`src/server/project-db.ts`). That file is deliberately excluded from file
snapshots (`src/server/files.ts`), so these values live only in the running
sandbox and the deployed app, never in the `files` table, GitHub exports, or
agent prompts.

Three variables go in, each for a specific reason:

**`DATABASE_URL`** is the app's own Postgres database, a Neon branch per session.
Gated on `NEON_API_KEY`: with no Neon key configured no database is provisioned,
no `.env.local` is written, and auth is simply unavailable. The agent is told to
say so rather than fall back to a fake.

**`BETTER_AUTH_SECRET`** (mirrored as `AUTH_SECRET`) signs session cookies. It is
generated once per session and stored on `sessions.auth_secret`. It has to stay
stable across sandbox resumes, since rotating it silently logs every user out,
and a fork inherits its parent's value so the fork's copy-on-write auth rows keep
validating. Per-session rather than one global secret, so one app's cookies can
never be replayed against another.

**`BETTER_AUTH_URL`** is the origin the app is served on. This is the fix for the
recurring "Invalid origin" error. better-auth defaults `trustedOrigins` to
`[baseURL]`, and its header-inferred `baseURL` does not match the external URL
behind the preview proxy, so every sign-up POST gets rejected as untrusted. The
generated `lib/auth.ts` pins both `baseURL` and `trustedOrigins` from this
variable (see `src/server/agent-prompts.ts`).

Getting that variable right is subtler than it looks, and both halves are worth
knowing if you are building something similar:

- In the sandbox it is the session's ephemeral preview origin, known at start.
- On a Vercel deploy it is the project's production alias, which has to be read
  back from the Vercel API rather than constructed. Vercel truncates the
  auto-assigned `*.vercel.app` subdomain for long project names, so the obvious
  `https://<projectName>.vercel.app` can be a hostname that does not exist. It
  also cannot be the per-deployment URL, since env vars are baked into a
  deployment at creation time, before that URL exists. The live link a user is
  handed is therefore the alias too, so the origin they land on is the one their
  app trusts.

## Running it

Requires Node >= 22.

```bash
npm install
cp .env.example .env     # fill in credentials
npm run db:push          # apply the schema to your dev database
npm run dev
```

[`docs/setup.md`](docs/setup.md) covers where every credential comes from, what
happens without it, and how to apply the schema when deploying (nothing migrates
automatically). [`docs/codebase-tour.md`](docs/codebase-tour.md) is a ten-part
walkthrough of the codebase.

Clerk and the Vercel Sandbox credentials are required. Without Neon there are no
per-app databases, without R2 there is no file persistence, and without Razorpay
the credits flow reports itself as unconfigured instead of failing.

## Stack

Next.js 16 (App Router), TypeScript, Tailwind, Drizzle ORM, Postgres. Clerk for
platform auth, Vercel Sandbox for isolation, Neon for per-app databases,
Cloudflare R2 for file bytes, Razorpay for credit purchases, the Vercel AI SDK
for the agent runtime (Anthropic and OpenAI).

## License

MIT. See [LICENSE](LICENSE).

All product names belong to their respective owners. Generated apps run in
isolated sandboxes and are owned by whoever builds them.
