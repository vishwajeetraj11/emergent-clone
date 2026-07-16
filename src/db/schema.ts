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
  // button), nullable — stays null until a real GITHUB_TOKEN is configured
  // and a save actually succeeds.
  githubRepoUrl: text("github_repo_url"),
  // Phase 4: last Vercel deployment URL for this session's files ("Deploy
  // Your Application"), nullable — stays null until a real VERCEL_TOKEN is
  // configured and a deploy actually succeeds. Mirrors githubRepoUrl above.
  vercelDeploymentUrl: text("vercel_deployment_url"),
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
