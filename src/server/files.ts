import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { files } from "@/db/schema";
import {
  deleteObjects,
  getTextObject,
  putTextObject,
  sessionFileKey,
} from "@/server/r2";

// ---------------------------------------------------------------------------
// Directory snapshot -> `files` table INDEX + Cloudflare R2 bytes, used by the
// Phase 2 build phase (src/server/agent.ts) after the build query() completes,
// and read back by GET /api/sessions/[id]/files for the timeline's file
// viewer.
//
// "R2 = bytes, DB = index" (see src/server/r2.ts + the files-table comment in
// src/db/schema.ts): a changed file's bytes go to R2 under
// sessions/<sessionId>/<path>, its row stores only {path, hash}. R2 is
// REQUIRED — putTextObject/getTextObject throw when it's unconfigured, so a
// build without R2 fails loudly at snapshot time rather than silently losing
// files. getSessionFiles hydrates the bytes back into the SessionFile
// { path, content, updatedAt } contract, so its consumers are unchanged.
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".next", ".turbo"]);

// Secret-bearing env files never leave the sandbox directory: the session's
// own DATABASE_URL lives in `.env.local` (written by src/server/project-db.ts,
// regenerated on every sandbox start), and the `files` table feeds the file
// viewer, GitHub export, Vercel deploys, and fork copies — none of which may
// carry a live connection string.
const EXCLUDED_FILES = new Set([".env", ".env.local"]);

// Best-effort binary skip list, in addition to the excluded dirs above — file
// content is stored/transferred as text (DB text column or R2 utf-8 object),
// so we don't want to jam raw binary bytes (mangled by the utf8 decode) into
// it.
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

// Bounded fan-out for R2 PUT/GET/COPY — enough to hide per-object latency
// without opening a socket per file on a large project.
const IO_CONCURRENCY = 8;

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
      if (EXCLUDED_FILES.has(entry.name)) continue;
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

function sha256hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Snapshots `dir` recursively (excluding node_modules/.git/.next/.turbo),
 * PUTs every changed file's bytes to R2, and upserts its index row {path,
 * hash} keyed by (session_id, path). Diff is by sha256. Files that have
 * vanished from disk since the last snapshot have their rows (and R2 objects)
 * deleted. Returns the list of changed relative paths that were WRITTEN —
 * vanished paths are NOT included (callers, e.g. syncChangedFilesToSandbox,
 * re-read every returned path from disk, so a deleted path in the return value
 * would ENOENT).
 *
 * R2 is required: a changed file's putTextObject throws when R2 is
 * unconfigured, failing the whole snapshot (and the build) loudly rather than
 * persisting an index row with no bytes behind it.
 *
 * NB every caller (src/server/agent-phases.ts) passes the FULL sandbox dir, so
 * the vanished-set is always computed against a complete tree — restore/fork
 * never snapshot, so they can't trigger a spurious wipe. One consequence:
 * restore no longer resurrects files the agent deleted in a later pass.
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
    .select({ path: files.path, hash: files.hash })
    .from(files)
    .where(eq(files.sessionId, sessionId));
  const existingByPath = new Map(existing.map((f) => [f.path, f.hash]));

  // Gather the files whose content actually changed (read + hash), skipping
  // unreadable/oversized ones. Do this before any writes so the write fan-out
  // below is a clean chunked pass.
  const toWrite: { relPath: string; content: string; hash: string }[] = [];
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

    const hash = sha256hex(content);
    if (existingByPath.get(relPath) === hash) continue; // unchanged
    toWrite.push({ relPath, content, hash });
  }

  const changed: string[] = [];
  for (const group of chunk(toWrite, IO_CONCURRENCY)) {
    await Promise.all(
      group.map(async ({ relPath, content, hash }) => {
        // PUT the bytes before writing the index row, so a row never points at
        // an object that doesn't exist yet.
        await putTextObject(sessionFileKey(sessionId, relPath), content);
        await db
          .insert(files)
          .values({ sessionId, path: relPath, hash })
          .onConflictDoUpdate({
            target: [files.sessionId, files.path],
            set: { hash, updatedAt: new Date() },
          });
      })
    );
    for (const { relPath } of group) changed.push(relPath);
  }

  // Vanished-file cleanup: rows whose path is no longer on disk. Guard against
  // an empty walk (a raced/half-seeded dir) wiping the whole snapshot. Use the
  // full walk output (not the read-filtered set) so a file that merely grew
  // past MAX_FILE_BYTES keeps its row.
  if (relPaths.length > 0) {
    const onDisk = new Set(relPaths);
    const vanished = existing.map((f) => f.path).filter((p) => !onDisk.has(p));
    if (vanished.length > 0) {
      // Rows first: a leftover R2 object is harmless (project delete's
      // deletePrefix sweeps it), but a hash-row pointing at a deleted object
      // would be a lie.
      await db
        .delete(files)
        .where(and(eq(files.sessionId, sessionId), inArray(files.path, vanished)));
      try {
        await deleteObjects(vanished.map((p) => sessionFileKey(sessionId, p)));
      } catch (err) {
        console.error(`[files] failed to delete vanished R2 objects for ${sessionId}`, err);
      }
    }
  }

  return changed;
}

/**
 * All latest-snapshot files for a session, for the file viewer / GitHub export
 * / Vercel deploy / restore / fork. Each index row's bytes are hydrated from
 * R2 (bounded concurrency).
 *
 * A genuinely-missing R2 object (404) is logged and that one file skipped —
 * never fails the whole call (all-missing degrades to 0 files, hitting the
 * caller's existing empty-snapshot path). A transient R2 error (unreachable /
 * 5xx) is NOT swallowed: it propagates so a deploy/export can't silently ship
 * a gutted app; every caller has an error path.
 */
export async function getSessionFiles(sessionId: string): Promise<SessionFile[]> {
  const db = getDb();
  const rows = await db
    .select({ path: files.path, updatedAt: files.updatedAt })
    .from(files)
    .where(eq(files.sessionId, sessionId));

  const out: (SessionFile | null)[] = new Array(rows.length).fill(null);
  for (const group of chunk(rows.map((_, i) => i), IO_CONCURRENCY)) {
    await Promise.all(
      group.map(async (i) => {
        const r = rows[i];
        const body = await getTextObject(sessionFileKey(sessionId, r.path));
        if (body == null) {
          console.error(`[files] R2 object missing for ${sessionId}/${r.path}; skipping`);
          return;
        }
        out[i] = { path: r.path, content: body, updatedAt: r.updatedAt };
      })
    );
  }

  return out.filter((x): x is SessionFile => x !== null);
}
