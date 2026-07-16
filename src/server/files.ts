import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { files } from "@/db/schema";

// ---------------------------------------------------------------------------
// Directory snapshot -> `files` table upsert, used by the Phase 2 build
// phase (src/server/agent.ts) after the build query() completes, and read
// back by GET /api/sessions/[id]/files for the timeline's file viewer.
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".next", ".turbo"]);

// Best-effort binary skip list, in addition to the excluded dirs above — the
// files table stores `content` as text, so we don't want to jam raw binary
// bytes (mangled by the utf8 decode) into it.
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".zip",
]);

// Skip anything bigger than this per file — defense against accidentally
// snapshotting something huge (e.g. a stray lockfile-like artifact).
const MAX_FILE_BYTES = 512 * 1024;

function walk(dir: string, baseDir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), baseDir, out);
    } else if (entry.isFile()) {
      if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(path.relative(baseDir, path.join(dir, entry.name)));
    }
  }
}

export interface SessionFile {
  path: string;
  content: string;
  updatedAt: Date;
}

/**
 * Snapshots `dir` recursively (excluding node_modules/.git/.next/.turbo) and
 * upserts every changed file into the `files` table, keyed by
 * (session_id, path) — the schema's existing unique index makes this a
 * plain upsert. Only rows whose content actually changed are written.
 * Returns the list of changed relative paths.
 */
export async function snapshotSessionFiles(
  sessionId: string,
  dir: string
): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const db = getDb();

  const relPaths: string[] = [];
  walk(dir, dir, relPaths);

  const existing = await db
    .select({ path: files.path, content: files.content })
    .from(files)
    .where(eq(files.sessionId, sessionId));
  const existingByPath = new Map(existing.map((f) => [f.path, f.content]));

  const changed: string[] = [];
  for (const relPath of relPaths) {
    const fullPath = path.join(dir, relPath);
    let content: string;
    try {
      const stat = statSync(fullPath);
      if (stat.size > MAX_FILE_BYTES) continue;
      content = readFileSync(fullPath, "utf8");
    } catch {
      // Unreadable, or raced with a concurrent write/delete — skip this pass,
      // it'll be picked up on the next snapshot if it settles.
      continue;
    }

    if (existingByPath.get(relPath) === content) continue;

    await db
      .insert(files)
      .values({ sessionId, path: relPath, content })
      .onConflictDoUpdate({
        target: [files.sessionId, files.path],
        set: { content, updatedAt: new Date() },
      });
    changed.push(relPath);
  }

  return changed;
}

/** All latest-snapshot files for a session, for the file viewer / GitHub export. */
export async function getSessionFiles(sessionId: string): Promise<SessionFile[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(files)
    .where(eq(files.sessionId, sessionId));
  return rows.map((r) => ({ path: r.path, content: r.content, updatedAt: r.updatedAt }));
}
