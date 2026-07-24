import { createHash } from "node:crypto";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { Sandbox } from "@vercel/sandbox";
import { getDb } from "@/db";
import { files } from "@/db/schema";
import {
  deleteObjects,
  getTextObject,
  putTextObject,
  sessionFileKey,
} from "@/server/r2";

// Sandbox snapshot -> `files` index rows + Cloudflare R2 bytes.
//
// The agent builds INSIDE the session's Vercel sandbox, so snapshotSessionFiles
// reads the tree from that live VM, not this server's disk.
//
// "R2 = bytes, DB = index": a changed file's bytes go to R2 under
// sessions/<sessionId>/<path>, its row stores only {path, hash}. R2 is
// REQUIRED — put/getTextObject throw when unconfigured, so a build without it
// fails loudly rather than silently losing files.

// The sandbox's working directory (matches APP_DIR in agent-tools.ts).
const APP_DIR = "/vercel/sandbox";

// Secret-bearing env files never leave the sandbox: `.env.local` holds the
// session's live DATABASE_URL, and this table feeds the file viewer, GitHub
// export, Vercel deploys, and fork copies.
const EXCLUDED_FILES = new Set([".env", ".env.local"]);

// Content is stored as text (utf-8 R2 objects), so binary would be mangled.
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

// Bounded fan-out for R2 + VM reads — enough to hide per-object latency
// without opening a socket per file on a large project.
const IO_CONCURRENCY = 8;

/** Lists the relative paths of source files in the sandbox (excluding
 * regenerable dirs, secret env files, and binaries). */
async function listSandboxFiles(sandbox: Sandbox): Promise<string[]> {
  const res = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      "find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './.next/*' -not -path './.turbo/*'",
    ],
    cwd: APP_DIR,
  });
  if (res.exitCode !== 0) return [];
  const listing = await res.output("stdout");
  return listing
    .split("\n")
    .map((l) => l.trim().replace(/^\.\//, ""))
    .filter((p) => {
      if (!p) return false;
      if (EXCLUDED_FILES.has(path.posix.basename(p))) return false;
      if (BINARY_EXTENSIONS.has(path.posix.extname(p).toLowerCase())) return false;
      return true;
    });
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
 * Snapshots the session's live Vercel `sandbox` file tree (excluding
 * node_modules/.git/.next/.turbo), PUTs every changed file's bytes to R2, and
 * upserts its index row {path, hash} keyed by (session_id, path). Diff is by
 * sha256. Files that have vanished since the last snapshot have their rows
 * (and R2 objects) deleted. Returns the list of changed relative paths that
 * were WRITTEN — vanished paths are NOT included.
 *
 * R2 is required: a changed file's putTextObject throws when R2 is
 * unconfigured, failing the whole snapshot (and the build) loudly rather than
 * persisting an index row with no bytes behind it.
 *
 * The vanished-set is computed against the full VM listing, so restore/fork
 * (which don't snapshot) can't trigger a spurious wipe. One consequence:
 * restore no longer resurrects files the agent deleted in a later pass.
 */
export async function snapshotSessionFiles(
  sessionId: string,
  sandbox: Sandbox
): Promise<string[]> {
  const db = getDb();

  const relPaths = await listSandboxFiles(sandbox);

  const existing = await db
    .select({ path: files.path, hash: files.hash })
    .from(files)
    .where(eq(files.sessionId, sessionId));
  const existingByPath = new Map(existing.map((f) => [f.path, f.hash]));

  // Read + hash the files whose content actually changed, skipping
  // unreadable/oversized ones, before the write fan-out. Reads run in bounded
  // chunks (each is a VM round-trip).
  const toWrite: { relPath: string; content: string; hash: string }[] = [];
  for (const group of chunk(relPaths, IO_CONCURRENCY)) {
    await Promise.all(
      group.map(async (relPath) => {
        let content: string;
        try {
          const buf = await sandbox.readFileToBuffer({ path: `${APP_DIR}/${relPath}` });
          if (buf == null || buf.length > MAX_FILE_BYTES) return;
          content = buf.toString("utf8");
        } catch {
          // Unreadable / raced with a concurrent write — skip this pass.
          return;
        }
        const hash = sha256hex(content);
        if (existingByPath.get(relPath) === hash) return; // unchanged
        toWrite.push({ relPath, content, hash });
      })
    );
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

/**
 * Just the paths in a session's latest snapshot — no R2 fetch, so this is one
 * indexed read rather than a hydrate of every file.
 *
 * Used to hand the build agent a map of the app up front. Without it the agent
 * starts each job by listing the directory and reading files to work out what
 * exists, because every job begins with a fresh model context. Each of those
 * tool calls is a round trip to the VM, so the rediscovery is the single
 * largest chunk of wall-clock time in a typical continuation.
 */
export async function getSessionFilePaths(sessionId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ path: files.path })
    .from(files)
    .where(eq(files.sessionId, sessionId));
  return rows.map((r) => r.path).sort();
}
