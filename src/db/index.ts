import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Lazy-initialized DB client.
//
// CRITICAL: nothing here may run at module-import time. Next.js can import
// this module while collecting page/route data during `next build`, and in
// dev/prod the app must be able to boot with no DATABASE_URL set at all
// (single-user dev mode, no DB configured yet). We only touch
// process.env.DATABASE_URL / open a connection the first time `getDb()` is
// actually called.
// ---------------------------------------------------------------------------

type Db = PostgresJsDatabase<typeof schema>;

let cached: Db | null = null;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Returns a lazily-created Drizzle client. Throws only when actually called
 * without a DATABASE_URL configured — importing this module is always safe.
 */
export function getDb(): Db {
  if (cached) return cached;

  // Node's Happy-Eyeballs connect race (autoSelectFamily, default since
  // Node 20) uses a 250ms per-address-family attempt budget — verified too
  // short for some remote hosts on at least some networks (every attempt
  // times out even though a single un-raced connect succeeds; first hit
  // against Neon endpoints, both the API and Postgres itself). Raised here,
  // inside the lazy init so module import stays side-effect free, because
  // this is the first thing that runs before any remote DB connection.
  // Process-global, so it also covers src/server/project-db.ts's fetch()es
  // and every per-app connection. Safe no-op for a localhost DATABASE_URL.
  setDefaultAutoSelectFamilyAttemptTimeout(1500);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. The app can boot and render without a " +
        "database (single-user dev mode), but this code path requires one. " +
        "Set DATABASE_URL in .env to enable persistence."
    );
  }

  const client = postgres(connectionString, { prepare: false });
  cached = drizzle(client, { schema });
  return cached;
}
