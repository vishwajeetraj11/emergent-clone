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
