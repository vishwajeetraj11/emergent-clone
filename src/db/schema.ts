import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  jsonb,
  timestamp,
  pgEnum,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const jobStatusEnum = pgEnum("job_status", [
  "running",
  "waiting_on_user",
  // Orchestration: a plan is written and awaiting the user's
  // approve/revise decision — see src/lib/types.ts's JobStatus for why this
  // is distinct from waiting_on_user.
  "waiting_on_plan",
  "done",
  "stopped",
  "failed",
]);

export const projectStatusEnum = pgEnum("project_status", [
  "active",
  "archived",
]);

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  // Phase 3: nullable, only ever populated when Clerk is configured (see
  // src/lib/auth.ts's isClerkConfigured()) — single-user dev mode (the
  // default, unconfigured behavior) never touches this column.
  clerkUserId: varchar("clerk_user_id", { length: 255 }).unique(),
  // GitHub App installation id for this user's connected GitHub account (see
  // src/server/github-app.ts). Nullable — stays null until the user
  // completes the "Install GitHub App" flow (GET /api/github/connect ->
  // GitHub's consent screen -> GET /api/github/install/callback). Stored as
  // varchar rather than a numeric type: installation ids are large numbers
  // but this app never does arithmetic on them, so varchar sidesteps any
  // precision edge cases (e.g. bigint/JS number interop) for no cost.
  githubInstallationId: varchar("github_installation_id", { length: 64 }),
  // GitHub App user-to-server OAuth token (see src/server/github-app.ts's
  // createRepoForPersonalAccount) — separate from githubInstallationId's
  // installation token. Only a user token, not an installation token, is
  // allowed to call POST /user/repos, so this is the one gap installation
  // tokens can't cover: creating a brand-new repo on a personal (non-org)
  // account. Nullable: stays null unless GITHUB_APP_CLIENT_ID/SECRET are
  // configured and the user completed the install flow with GitHub's
  // "request user authorization (OAuth) during installation" step.
  githubUserAccessToken: text("github_user_access_token"),
  githubUserRefreshToken: text("github_user_refresh_token"),
  // Null when the App has "expire user authorization tokens" turned off
  // (GitHub's older/default behavior) — in that case the access token above
  // never expires and this column is never populated.
  githubUserTokenExpiresAt: timestamp("github_user_token_expires_at", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  status: projectStatusEnum("status").notNull().default("active"),
  // Neon project backing this project's per-app Postgres databases (see
  // src/server/project-db.ts). One Neon project per emergent project; each
  // session gets its own BRANCH inside it (sessions.neonBranchId below), so
  // a fork's copy-on-write database matches the fork's copy-of-the-files
  // semantics exactly. Nullable — stays null until the first sandbox start
  // actually provisions it, and forever when NEON_API_KEY isn't configured.
  neonProjectId: text("neon_project_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// sessions — fork lineage via parent_session_id self-reference
// ---------------------------------------------------------------------------

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  parentSessionId: uuid("parent_session_id").references(
    (): AnyPgColumn => sessions.id,
    { onDelete: "set null" }
  ),
  // Phase 3: last GitHub repo this session's files were pushed to (Save
  // button), nullable — stays null until the GitHub App is configured and
  // the current user has connected it, and a save actually succeeds.
  githubRepoUrl: text("github_repo_url"),
  // Phase 4: last Vercel deployment URL for this session's files ("Deploy
  // Your Application"), nullable — stays null until a real VERCEL_TOKEN is
  // configured and a deploy actually succeeds. Mirrors githubRepoUrl above.
  vercelDeploymentUrl: text("vercel_deployment_url"),
  // Preview-sandbox identity for VercelSandboxProvider (src/server/sandbox-vercel.ts),
  // nullable — stays null under the default LocalProcessSandboxProvider.
  // @vercel/sandbox v1's sandboxes are ephemeral (die on timeout) and only
  // ever tracked in that provider's in-process registry, which — same
  // accepted tradeoff as the local provider's registry, see sandbox.ts — dies
  // on every dev-server restart. Without durable storage for the id, a
  // restart would strand a still-running, still-billing sandbox (Vercel has
  // no way to know it's abandoned until its timeout elapses) AND create a
  // brand new one on the next restore, silently multiplying live sandboxes
  // against the Hobby plan's 10-concurrent cap. This column lets restore
  // look the id up via Sandbox.get() and reattach instead.
  vercelSandboxId: text("vercel_sandbox_id"),
  // Per-session Neon branch id + its Postgres connection string (see
  // src/server/project-db.ts and projects.neonProjectId above). The
  // connection string is written into the sandbox as `.env.local` (excluded
  // from file snapshots — see src/server/files.ts) so the generated app's
  // own code reads process.env.DATABASE_URL natively; it is deliberately
  // NEVER placed in the files table, GitHub exports, or agent prompts.
  // Both nullable — populated lazily on first sandbox start when
  // NEON_API_KEY is configured, otherwise never.
  neonBranchId: text("neon_branch_id"),
  databaseUrl: text("database_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// deployments — full history of Vercel deploys for a session
// ---------------------------------------------------------------------------

// sessions.vercelDeploymentUrl only ever holds the LATEST deploy — each
// redeploy overwrites it, so once a newer deploy lands there's no way back
// to an older one's URL even though Vercel keeps it live. This table is the
// append-only history behind it (mirrors why `files` exists alongside a
// session instead of one column): every successful deploy gets a row here,
// and "Deploy" (create a new one) stays a separate action in the UI from
// "view a past one" (no new deploy needed) — see the Deployments dropdown
// in src/components/shell/ChatPanel.tsx.
export const deployments = pgTable("deployments", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// jobs — one agent run against a session
// ---------------------------------------------------------------------------

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  status: jobStatusEnum("status").notNull().default("running"),
  // Claude Agent SDK session id for this job's main query() call, so a later
  // phase can resume it. Nullable: mock-mode jobs and jobs that never made
  // it past the first turn never populate this.
  agentSessionId: text("agent_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// events — append-only trajectory log, source of truth for SSE stream
// ---------------------------------------------------------------------------

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    // Monotonic per-job cursor: the SSE stream orders by it and Last-Event-ID
    // resume seeks past it, so duplicates would corrupt both.
    seq: integer("seq").notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("events_job_id_seq_idx").on(t.jobId, t.seq)]
);

// ---------------------------------------------------------------------------
// files — latest snapshot per session (file viewer + GitHub export)
// ---------------------------------------------------------------------------

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // One row per path per session — file writes are upserts on this key.
  (t) => [uniqueIndex("files_session_id_path_idx").on(t.sessionId, t.path)]
);

// ---------------------------------------------------------------------------
// credit_ledger — per-token usage accounting
// ---------------------------------------------------------------------------

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    reason: varchar("reason", { length: 255 }).notNull(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    // Nullable dedupe key backing atomic, race-proof idempotent grants (see
    // src/server/credits.ts's ensureSignupBonus / grantStripePurchase) — a
    // unique index over this column lets concurrent callers race an
    // onConflictDoNothing insert instead of a check-then-insert that
    // Postgres read-committed can't make atomic. Regular usage-debit rows
    // (debitForJobUsage) leave this null; NULLs don't collide under a
    // unique index in Postgres, so many null rows are fine.
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("credit_ledger_idempotency_key_idx").on(t.idempotencyKey),
  ]
);
