import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { TEMPLATE_DIR, type SnapshotFile } from "@/server/sandbox";

// ---------------------------------------------------------------------------
// Template reading
//
// Mirrors src/server/files.ts's `walk` almost exactly, but reading straight
// off local disk into memory (for writeFiles) rather than snapshotting a
// directory into the `files` table — this provider has no on-disk sandbox
// directory of its own to snapshot from. Scoped to just this file rather
// than shared with files.ts/sandbox.ts, since it's small and the exclusion
// list only needs to match what actually exists under TEMPLATE_DIR.
// ---------------------------------------------------------------------------

const TEMPLATE_EXCLUDED_DIRS = new Set(["node_modules", ".git", ".next"]);

export function readTemplateFilesRecursive(): SnapshotFile[] {
  const out: SnapshotFile[] = [];

  function walk(dir: string): void {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (TEMPLATE_EXCLUDED_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        out.push({
          path: path.relative(TEMPLATE_DIR, fullPath),
          content: readFileSync(fullPath, "utf8"),
        });
      }
    }
  }

  walk(TEMPLATE_DIR);
  return out;
}
