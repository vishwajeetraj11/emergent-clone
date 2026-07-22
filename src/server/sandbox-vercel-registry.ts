import type { Sandbox } from "@vercel/sandbox";
import type { SandboxStartResult, SandboxStatus } from "@/server/sandbox";

// ---------------------------------------------------------------------------
// Registry — mirrors src/server/sandbox.ts's `registry`/`startingPromises`
// pattern (see that file's RegistryEntry doc comment): in-process, in-memory
// only, so it does not survive a dev-server restart. The difference from
// local: an entry surviving in memory is a *cache*, never the source of
// truth for "is this sandbox still alive" — every read through it gets
// re-probed (see probeRegistryEntry) because, unlike a ChildProcess handle,
// there's no free/synchronous "is it still running" check for a remote VM.
// ---------------------------------------------------------------------------

interface VercelRegistryEntry {
  sandbox: Sandbox | null;
  url: string;
  state: SandboxStatus["state"];
  message?: string;
}

export const registry = new Map<string, VercelRegistryEntry>();

/** Guards concurrent create-or-reattach calls for the same session — same purpose as sandbox.ts's startingPromises. */
export const startingPromises = new Map<string, Promise<SandboxStartResult>>();
