// ---------------------------------------------------------------------------
// URL readiness probing — the remote-sandbox analog of src/server/sandbox.ts's
// pollUntilReady, just fetching a public https:// domain instead of
// 127.0.0.1:<port>.
// ---------------------------------------------------------------------------

/**
 * Single bounded fetch attempt. Deliberately checks `res.ok` (2xx) only, the
 * same bar src/server/sandbox.ts's pollUntilReady/waitForServerReady use —
 * NOT "any response" — because the sandbox's public domain is served
 * through a Vercel-operated edge proxy: before the dev server inside the VM
 * is actually listening on port 3000, that proxy can itself answer with a
 * 502/503/504 (a real HTTP response, not a connection failure). Accepting
 * "any response below 500" would risk nothing here since a proxy error IS
 * >=500, but accepting >=500 too would risk mistaking "no upstream yet" for
 * "app is up" — so this stays strictly 2xx, matching local's own bar.
 */
export async function probeUrl(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false; // connection refused, DNS not ready yet, timed out, ...
  }
}

/** Loops probeUrl until `deadlineMs` elapses — used only while waiting for a freshly-started dev server to come up for the first time. */
export async function waitForUrlReady(url: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probeUrl(url, 2000)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
