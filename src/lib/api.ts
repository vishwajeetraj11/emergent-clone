interface ApiErrorBody {
  error?: string;
}

/**
 * Shared fetch → parse → throw-on-error wrapper for the repeated
 * `fetch, res.json(), if (!res.ok) throw` pattern scattered across the
 * client's fetch call sites. The body is parsed best-effort — a non-JSON or
 * empty response (e.g. a bodyless 204 from a DELETE) resolves to `{}`
 * rather than rejecting, so callers never have to special-case it.
 */
export async function fetchJson<T = unknown>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, init);
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as ApiErrorBody).error;
    throw new Error(typeof message === "string" ? message : `HTTP ${res.status}`);
  }
  return data as T;
}
