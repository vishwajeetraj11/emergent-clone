# Integration setup

How to obtain each credential in `.env.example`, and what happens without it.

Every optional integration is gated inert: unset means the feature surfaces
"X is not configured" rather than failing silently or crashing. The gates all
use the same `isXConfigured()` idiom.

---

## Postgres — `DATABASE_URL`

Local Postgres, or Neon via the Vercel Marketplace. The app boots and renders
with this unset — the client is lazy-init (`src/db/index.ts`) and only required
once a persistence-backed route is hit.

Schema changes go through `npm run db:push` (see `drizzle.config.ts`). Note that
push applies DDL directly, with no migration file and no backfill — fine
pre-launch, unsafe once there is data worth keeping.

## Vercel Sandbox — `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`

Where every generated app's `npm install` and dev server actually run: an
isolated, ephemeral Firecracker microVM holding none of this process's
environment, reached at a public HTTPS domain.

**Required, with no fallback.** The local child-process provider was removed in
`5b781a3`. With any of the three unset, `isVercelSandboxConfigured()`
(`src/server/sandbox-vercel-config.ts`) returns false and builds fail outright
rather than running anything on this host. There is no `SANDBOX_PROVIDER`
switch — that variable is no longer read anywhere.

- `VERCEL_TOKEN` — personal or team token from
  https://vercel.com/account/tokens. Also powers the "Deploy Your Application"
  button (`src/server/vercel.ts`).
- `VERCEL_TEAM_ID` — the team the token is scoped to. One value covers both
  sandboxes and deploys.
- `VERCEL_PROJECT_ID` — the project sandbox usage is billed and scoped under;
  the "Project ID" field on that project's Settings page. It need not be the
  same project you deploy generated apps to; it is just an attribution target.

## Cloudflare R2 — `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`

File-bytes storage (`src/server/r2.ts`). "R2 = bytes, DB = index": each `files`
row stores only `{path, hash}`, the bytes live under
`sessions/<sessionId>/<path>`.

**Required — all four.** There is no DB-inline fallback; a build snapshot with
R2 unconfigured throws from `putTextObject` rather than persisting index rows
that point at nothing.

Create a bucket and an S3-API token (Account API token, Object Read & Write) in
the Cloudflare dashboard under R2.

## LLM providers — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`

At least one is required for the agent to run (`src/server/llm.ts`). Models
whose provider key is missing are hidden from the composer's model picker.
`OPEN_AI_KEY` is accepted as an alias for `OPENAI_API_KEY`. Without
`ANTHROPIC_API_KEY`, Claude models are hidden and the planner falls back to GPT.

`MOCK_AGENT=1` runs a scripted trajectory instead, with no model calls at all.

## Clerk auth — `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`

**Required in every environment, dev included.** There is no unauthenticated
mode. With either key missing, `assertClerkConfigured()` throws from
`src/proxy.ts` on the first request and says what to set.

This used to fall back to a fixed `DEV_USER` when the keys were absent. That
made missing configuration silently disable auth: a deploy without these vars
came up as a public, single-identity builder where every visitor shared one
user's projects, credits, and GitHub installation, and `/` redirected straight
into the builder so nothing looked wrong. Every other integration here fails
closed — no Stripe key means no "Buy Credits" — but auth was the one place
where absence removed a restriction rather than a feature.

Get both from a Clerk dashboard instance. Local dev needs its own (a
development instance's `pk_test_`/`sk_test_` pair is free).

---

## GitHub "Save" — `GITHUB_APP_*`

A real GitHub App plus installation-token flow (`src/server/github-app.ts`),
not a static personal access token. Unset, the Save button surfaces "GitHub not
configured".

Register an app at https://github.com/settings/apps/new with:

- Repository permissions: Contents (read/write), Administration (read/write),
  Metadata (read-only).
- Webhooks: disabled — this app handles no webhook events.
- Setup URL: `http://localhost:3000/api/github/install/callback`, matching the
  callback route exactly.

`GITHUB_APP_ID` is the numeric App ID from the app's settings page.

`GITHUB_APP_PRIVATE_KEY_BASE64` is the generated private key `.pem`, base64'd
onto one line so it survives a `.env` file without breaking on newlines:

```bash
base64 -i path/to/your-app.private-key.pem | tr -d '\n'   # Linux: base64 -w0
```

It is decoded back to PEM at runtime.

### Personal accounts cannot create repos with an installation token

`POST /orgs/{org}/repos` is `enabledForGitHubApps`; `POST /user/repos` is not.
An installation token alone can therefore never create a *new* repo on a
personal account. Reading and writing files in an *existing* repo works the same
either way, and org installs never hit this at all.

Two ways around it:

1. Install the app on a GitHub **organization**. Simplest.
2. Set `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET`, so personal-account
   users additionally grant a user-to-server OAuth token during install — the
   only token type GitHub allows for `POST /user/repos`.

For option 2, on the same app's settings page: check "Request user
authorization (OAuth) during installation", and set the Authorization callback
URL to the **same** URL as the Setup URL above. GitHub then appends a `code`
param alongside `installation_id` on that one redirect — no separate consent
screen or callback route needed. No extra repository permission is required;
this only adds a second, independent token type.

Leave both unset and personal-account users are told to reinstall on an org
instead (`GitHubPersonalAccountRepoCreationError`). Nothing breaks.

## Stripe "Buy Credits" — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

`src/server/stripe.ts`. This redirects to Stripe-hosted Checkout
(`session.url`) rather than embedding Stripe.js/Elements, so no publishable key
is needed.

`STRIPE_WEBHOOK_SECRET` is required by `POST /api/webhooks/stripe` to verify
delivery signatures. Without it, purchases can never grant credits even with
`STRIPE_SECRET_KEY` set.

## Neon per-app databases — `NEON_API_KEY`, `NEON_REGION`, `NEON_ORG_ID`

Per-app Postgres for generated apps (`src/server/project-db.ts`). Unset,
generated apps simply get no database and everything else is unchanged.

With a key set: one Neon project per emergent project (created lazily on first
sandbox start), one Neon **branch** per session — so a fork's database is a
copy-on-write snapshot of its parent, matching the fork's copied files. The
session's connection string is written into its sandbox as `.env.local`, which
is deliberately excluded from file snapshots and GitHub export.

Create a key under Neon console → Account settings → API keys.

- `NEON_REGION` — region for new projects. Defaults to `aws-ap-southeast-1`.
- `NEON_ORG_ID` — only needed when the key spans several orgs; otherwise the
  key's sole org is used (`src/server/project-db.ts:82`).
