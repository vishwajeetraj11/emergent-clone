import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { files as filesTable, jobs, sessions } from "@/db/schema";
import { appendEvent } from "@/server/events";
import { getSessionFiles } from "@/server/files";
import { runAgentLoop } from "@/server/agent";
import { ensureSessionDatabase } from "@/server/project-db";
import { getSandboxDir, writeSnapshotFiles } from "@/server/sandbox";
import { copyObject, isR2Configured, sessionFileKey } from "@/server/r2";
import { setJobApiKeys, type UserApiKeys } from "@/server/user-keys";
import type { JobRow, SessionRow } from "@/server/jobs";

// ---------------------------------------------------------------------------
// Phase 3: session-scoped operations that don't fit createProjectAndJob's
// "brand new project" shape — continuing to chat against an existing
// session, and forking one. Deliberately kept separate from
// src/server/jobs.ts / src/server/agent.ts, which Phase 1/2 already own and
// this phase doesn't need to change.
// ---------------------------------------------------------------------------

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const db = getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  return session ?? null;
}

/**
 * Creates a new job under an *existing* session and kicks off the same
 * agent loop a brand-new project uses (see createProjectAndJob), just
 * without creating a new project/session first. Used to let the user keep
 * chatting once a session's previous job has reached a terminal status —
 * including right after a fork, whose seeded job is already "done" (see
 * forkSession below).
 *
 * Reuses runAgentLoop as-is: src/server/agent.ts's runRealLoop inspects the
 * session's existing files to route this into runContinuationFlow rather
 * than a fresh build. `planMode` (default false — today's direct-edit
 * behavior) rides on the `user_message` event payload rather than a new DB
 * column or a flag threaded through more layers than necessary — runRealLoop
 * reads it back off that same event.
 */
export async function continueSessionWithPrompt(
  sessionId: string,
  prompt: string,
  planMode = false,
  model?: string,
  apiKeys?: UserApiKeys
): Promise<{ session: SessionRow; job: JobRow }> {
  const db = getDb();
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Prompt must not be empty");
  }

  const session = await getSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  const [job] = await db.insert(jobs).values({ sessionId, status: "running" }).returning();
  await appendEvent(job.id, "user", "user_message", {
    text: trimmed,
    planMode,
    ...(model ? { model } : {}),
  });

  // BYOK: same stash-before-fire pattern as createProjectAndJob
  // (src/server/jobs.ts) — never on the event payload above. See
  // src/server/user-keys.ts for the store's security contract.
  if (apiKeys) setJobApiKeys(job.id, apiKeys);

  // Fire-and-forget, same pattern/limitation as createProjectAndJob.
  runAgentLoop(job.id).catch((err) => {
    console.error(`[agent] job ${job.id} loop crashed`, err);
  });

  return { session, job };
}

const MAX_FORK_SUMMARY_PATHS = 25;

/**
 * "Manage Agent Context With Forks": creates a new `sessions` row under the
 * SAME project (parentSessionId = original), copies the original session's
 * `files` rows into the new session (DB) and writes that same snapshot onto
 * the new session's own sandbox directory on disk (independently startable
 * later via sandboxProvider.restoreFromSnapshot / start — never touches the
 * original session's directory or running process), and seeds a short
 * synthetic system event summarizing what was already built. Does not start
 * the fork's sandbox itself and does not run the agent — the caller decides
 * when to restore/continue (see the /restore and session-scoped /messages
 * routes).
 */
export async function forkSession(sessionId: string): Promise<{
  session: SessionRow;
  job: JobRow;
  fileCount: number;
}> {
  const db = getDb();
  const original = await getSession(sessionId);
  if (!original) {
    throw new Error("Session not found");
  }

  const [forked] = await db
    .insert(sessions)
    .values({ projectId: original.projectId, parentSessionId: original.id })
    .returning();

  // Copy the index rows RAW (path/content/hash as-is) rather than from
  // hydrated content, so an R2-backed original stays R2-backed on the fork
  // instead of collapsing every file back into a legacy content row.
  const rawRows = await db
    .select({ path: filesTable.path, content: filesTable.content, hash: filesTable.hash })
    .from(filesTable)
    .where(eq(filesTable.sessionId, sessionId));

  if (rawRows.length > 0) {
    await db
      .insert(filesTable)
      .values(
        rawRows.map((r) => ({
          sessionId: forked.id,
          path: r.path,
          content: r.content,
          hash: r.hash,
        }))
      )
      .onConflictDoNothing({ target: [filesTable.sessionId, filesTable.path] });

    // For R2-backed rows, copy the underlying objects to the fork's own key
    // prefix. Best-effort per file (a failed copy just means that one file is
    // skipped on the fork's first hydrate) — a storage hiccup must never fail
    // the fork, matching the Neon-branch stance below.
    if (isR2Configured()) {
      const r2Paths = rawRows.filter((r) => r.hash != null).map((r) => r.path);
      for (let i = 0; i < r2Paths.length; i += 8) {
        await Promise.all(
          r2Paths.slice(i, i + 8).map((p) =>
            copyObject(sessionFileKey(sessionId, p), sessionFileKey(forked.id, p)).catch((err) =>
              console.error(`[sessions] fork R2 copy failed for ${p}`, err)
            )
          )
        );
      }
    }
  }

  // Hydrated content, written onto the forked session's own sandbox path —
  // not a copy of the original's on-disk directory, so a since-orphaned or
  // never-started original doesn't block the fork from getting real files.
  // Also feeds the file-count/paths summary message below.
  const originalFiles = await getSessionFiles(sessionId);
  if (originalFiles.length > 0) {
    writeSnapshotFiles(getSandboxDir(forked.id), originalFiles);
  }

  // If the original session has its own database (Neon branch), branch the
  // fork's database off it NOW — a Neon branch is a copy-on-write snapshot
  // taken at creation time, so doing this eagerly (rather than lazily on the
  // fork's first sandbox start, which ensureSessionDatabase would otherwise
  // do) pins the fork's data to the moment of the fork, matching the file
  // copy above. Best-effort: a database hiccup must not fail the fork.
  if (original.neonBranchId) {
    await ensureSessionDatabase(forked.id).catch((err) => {
      console.error(`[project-db] forking database for session ${forked.id} failed`, err);
    });
  }

  const [job] = await db.insert(jobs).values({ sessionId: forked.id, status: "done" }).returning();

  const shownPaths = originalFiles.slice(0, MAX_FORK_SUMMARY_PATHS).map((f) => f.path);
  const moreCount = originalFiles.length - shownPaths.length;
  const filesSummary =
    originalFiles.length > 0
      ? ` It starts from the ${originalFiles.length} file${
          originalFiles.length === 1 ? "" : "s"
        } already built there${
          shownPaths.length > 0
            ? ` (${shownPaths.join(", ")}${moreCount > 0 ? `, +${moreCount} more` : ""})`
            : ""
        }.`
      : "";

  await appendEvent(job.id, "system", "assistant_message", {
    text: `This session is a fork of an earlier one.${filesSummary} The original session's job and files are untouched — keep chatting here to continue building independently from this point.`,
  });

  return { session: forked, job, fileCount: originalFiles.length };
}
