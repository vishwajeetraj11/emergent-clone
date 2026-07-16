"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

interface SessionFile {
  path: string;
  content: string;
  updatedAt: string;
}

/**
 * Phase 2 timeline card for a `files_changed` event — collapsed by default
 * ("Viewing N paths"), expands into a tabbed, read-only, monospace file
 * viewer. Fetches file contents lazily (on first expand) from
 * GET /api/sessions/[id]/files, since the event payload only carries paths.
 */
export function FilesChangedCard({
  sessionId,
  paths,
}: {
  sessionId: string | null;
  paths: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<SessionFile[] | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);

  async function handleToggle() {
    const next = !expanded;
    setExpanded(next);
    if (!next || files !== null || !sessionId) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/files`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const all = (await res.json()) as SessionFile[];
      const byPath = new Map(all.map((f) => [f.path, f]));
      const shown = paths
        .map((p) => byPath.get(p))
        .filter((f): f is SessionFile => Boolean(f));
      setFiles(shown);
      setActivePath(shown[0]?.path ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  }

  const activeFile = files?.find((f) => f.path === activePath) ?? null;

  return (
    <div className="rounded-md border border-border bg-secondary/40 text-xs">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <FileText className="size-3.5 shrink-0" />
        <span>
          Viewing {paths.length} path{paths.length === 1 ? "" : "s"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border">
          {loading && (
            <div className="px-2.5 py-2 text-muted-foreground">Loading files…</div>
          )}
          {error && <div className="px-2.5 py-2 text-red-400">{error}</div>}
          {files && files.length === 0 && !loading && (
            <div className="px-2.5 py-2 text-muted-foreground">
              No file contents available yet.
            </div>
          )}
          {files && files.length > 0 && (
            <>
              <div className="flex flex-wrap gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
                {files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setActivePath(f.path)}
                    className={cn(
                      "rounded px-2 py-0.5 font-mono text-[11px] transition-colors",
                      f.path === activePath
                        ? "bg-foreground text-background"
                        : "bg-background text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {f.path}
                  </button>
                ))}
              </div>
              {activeFile && (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                  {activeFile.content}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
