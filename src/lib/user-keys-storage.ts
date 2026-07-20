// ---------------------------------------------------------------------------
// BYOK client storage: the user's own Anthropic/OpenAI API key(s), kept only
// in this browser tab's sessionStorage — never localStorage, never a cookie,
// never sent anywhere except riding a job-start POST body (see
// useAgentSession's start/continueChat) — and never persisted server-side
// (see src/server/user-keys.ts's in-memory, per-job store).
//
// sessionStorage is a deliberate choice, not an oversight: it's per-tab and
// gone the moment the tab closes, which matches "session-only" far better
// than a store that survives a browser restart. Trade-off, accepted for a
// BYOK dev tool: a key sitting in sessionStorage is readable by any
// same-origin XSS — don't reuse this pattern for a longer-lived secret.
//
// Deliberately NOT importing UserApiKeys from src/server/user-keys.ts even
// though the shape matches exactly — this file is client code, and nothing
// in this app imports from src/server/* outside of the app/api routes
// themselves, so the shape is duplicated here rather than crossing that
// boundary.
// ---------------------------------------------------------------------------

export interface UserApiKeys {
  anthropic?: string;
  openai?: string;
}

const STORAGE_KEY = "emergent.byok";

/** False during SSR/prerendering (no `window`), true inside a real browser tab. */
function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/** Never throws: SSR (no window), a corrupt/foreign value, or a private-mode storage exception all degrade to "no stored keys" rather than crashing the caller. */
export function loadUserApiKeys(): UserApiKeys {
  if (!hasWindow()) return {};
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const keys: UserApiKeys = {};
    if (typeof record.anthropic === "string") keys.anthropic = record.anthropic;
    if (typeof record.openai === "string") keys.openai = record.openai;
    return keys;
  } catch {
    return {};
  }
}

/** Overwrites the whole stored object — callers pass the full {anthropic?, openai?} they want kept, not a partial patch. */
export function saveUserApiKeys(keys: UserApiKeys): void {
  if (!hasWindow()) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Private-mode quota / storage disabled — the caller's own in-memory
    // state for this page view is unaffected, it just won't survive a
    // reload. Not worth surfacing as an error for a BYOK dev tool.
  }
}

export function clearUserApiKeys(): void {
  if (!hasWindow()) return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // See saveUserApiKeys above.
  }
}
