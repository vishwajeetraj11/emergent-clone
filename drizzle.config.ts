import type { Config } from "drizzle-kit";

// Read lazily at CLI-invocation time only (drizzle-kit commands), never at
// app boot — the Next.js app itself must never require DATABASE_URL to be
// set just to start.
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies Config;
