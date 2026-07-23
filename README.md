This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Generated-app auth (per-session database + secrets)

When a generated app needs login, emergent builds **real** database-backed
email/password auth with [better-auth](https://better-auth.com) — never a
localStorage/cookie mock. Everything the app's auth needs is provisioned by the
platform and injected into the sandbox as a `.env.local` file (built by
`buildSandboxEnvContent` in `src/server/project-db.ts`). That file is
**deliberately excluded from file snapshots** (`src/server/files.ts`), so these
secrets live only in the running sandbox — never in the `files` table, GitHub
exports, or agent prompts.

Three variables go in, and each is there for a specific reason:

- **`DATABASE_URL`** — the app's own Postgres database, provisioned per session
  on [Neon](https://neon.tech) (a branch per session). Gated on `NEON_API_KEY`:
  with no Neon key configured, no database is provisioned, no `.env.local` is
  written, and auth simply isn't available (the agent is told to say so rather
  than fall back to a fake auth).

- **`BETTER_AUTH_SECRET`** (also mirrored as `AUTH_SECRET`) — the cookie-signing
  secret, **generated once per session** (`ensureSessionAuthSecret`, 32 random
  bytes) and stored on `sessions.auth_secret`. It must stay **stable across
  sandbox resumes** — better-auth signs session cookies with it, so rotating it
  would silently log every user out. A **fork inherits its parent's value** so
  the fork's copy-on-write auth rows keep validating. Per-session (not one
  global secret) so one app's cookies can never be replayed against another.

- **`BETTER_AUTH_URL`** — the session's live **preview origin** (e.g.
  `https://sb-xxx.vercel.run`), known at sandbox start. **This is the fix for the
  recurring "Invalid origin" error.** The preview is served through a proxy, so
  better-auth's header-inferred `baseURL` does **not** match the external preview
  URL; better-auth defaults `trustedOrigins` to `[baseURL]`, so every sign-up /
  sign-in POST from the preview is rejected as an untrusted origin. The generated
  `lib/auth.ts` therefore pins both `baseURL` and `trustedOrigins` from
  `process.env.BETTER_AUTH_URL` (see the builder guidance in
  `src/server/agent-prompts.ts`). Setting it via an injected env var — rather
  than the app hardcoding a URL — keeps the app portable across the ephemeral,
  per-session preview URLs. When absent (no database, or the local-dir writer
  that doesn't know the URL), better-auth falls back to header inference.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
