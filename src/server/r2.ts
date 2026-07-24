import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Cloudflare R2 as the file-BYTES store (https://developers.cloudflare.com/r2).
//
// Layout: "R2 = bytes, DB = index". The `files` table keeps one row per file
// as an index (session_id, path, hash); the file's actual content lives in R2
// under `sessions/<sessionId>/<relPath>`. src/server/files.ts is the only
// caller of these helpers — getSessionFiles hydrates bytes back into the
// unchanged SessionFile shape, so none of its 8 consumers change.
//
// Same isXConfigured() gating idiom as the Neon / GitHub App / Vercel
// integrations (see src/server/project-db.ts): with no R2_* env set every
// helper here is inert and files.ts falls back to storing content in the DB
// `content` column exactly as it did before this feature existed. All four
// vars are required together — a partial config counts as unconfigured, so
// the platform can never half-enable R2 and strand bytes.
//
// NOTE: turning R2 OFF after R2-backed rows exist strands those files
// (getSessionFiles logs + skips them) — the same one-way caveat as unsetting
// NEON_API_KEY after Neon branches exist. Don't disable a configured bucket
// that has live sessions.
// ---------------------------------------------------------------------------

export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET
  );
}

/** The R2 object key for a session file. Path-keyed so a project delete is a
 * single prefix sweep (deletePrefix) and a fork is a per-file CopyObject. */
export function sessionFileKey(sessionId: string, relPath: string): string {
  return `sessions/${sessionId}/${relPath}`;
}

// Lazy S3Client singleton — nothing runs at module import time (same
// build-safety rule as getDb() in src/db/index.ts). Only constructed once R2
// is actually used, and only when configured.
let cached: S3Client | null = null;

/** R2's S3-compatible endpoint is per-account, not a fixed host. */
const r2Endpoint = (accountId: string) => `https://${accountId}.r2.cloudflarestorage.com`;

function getClient(): S3Client {
  if (cached) return cached;
  if (!isR2Configured()) {
    throw new Error("R2 is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET).");
  }
  cached = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(process.env.R2_ACCOUNT_ID!),
    // R2 addresses buckets in the path; path-style keeps the request shape
    // deterministic regardless of bucket name.
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
    },
  });
  return cached;
}

function bucket(): string {
  return process.env.R2_BUCKET as string;
}

export async function putTextObject(key: string, body: string): Promise<void> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: "text/plain; charset=utf-8",
    })
  );
}

/**
 * Fetches an object's text. Returns null ONLY when the object genuinely does
 * not exist (NoSuchKey / 404) — every other error (network blip, auth, 5xx)
 * is retried once and then rethrown, so callers can distinguish "this one
 * file is gone" (skip it) from "R2 is unreachable" (fail loudly, never ship a
 * silently-gutted snapshot).
 */
export async function getTextObject(key: string): Promise<string | null> {
  const client = getClient();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      return (await res.Body?.transformToString("utf-8")) ?? "";
    } catch (err) {
      if (isNotFound(err)) return null;
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function copyObject(srcKey: string, dstKey: string): Promise<void> {
  const client = getClient();
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket(),
      // CopySource is `<bucket>/<key>`, URI-encoded PER SEGMENT (slashes kept
      // literal). Generated file paths can contain spaces/unicode; encoding
      // the whole thing would mangle the separators, not encoding at all
      // breaks on spaces — this is the S3 CopyObject footgun.
      CopySource: `${bucket()}/${encodeKey(srcKey)}`,
      Key: dstKey,
    })
  );
}

/**
 * Deletes every object under `prefix` (e.g. `sessions/<id>/`). No-op when R2
 * is unconfigured so project deletion can call it unconditionally. Paginates
 * ListObjectsV2 and issues one DeleteObjects per page (1000 keys/page = the
 * DeleteObjects max).
 */
export async function deletePrefix(prefix: string): Promise<void> {
  if (!isR2Configured()) return;
  const client = getClient();
  let continuationToken: string | undefined;
  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key as string }));
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys, Quiet: true } })
      );
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * Best-effort delete of an explicit set of keys (e.g. files that vanished from
 * a sandbox dir). Batched in pages of 1000. No-op when unconfigured.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (!isR2Configured() || keys.length === 0) return;
  const client = getClient();
  for (let i = 0; i < keys.length; i += 1000) {
    const page = keys.slice(i, i + 1000).map((Key) => ({ Key }));
    await client.send(
      new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: page, Quiet: true } })
    );
  }
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}
