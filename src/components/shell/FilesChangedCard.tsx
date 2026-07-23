"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { cn } from "@/lib/utils";

interface SessionFile {
  path: string;
  content: string;
  updatedAt: string;
}

/**
 * Timeline card for a `files_changed` event — collapsed by default
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
      const all = await fetchJson<SessionFile[]>(`/api/sessions/${sessionId}/files`);
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
  // Stable per-card id prefix so the disclosure/tab wiring below can point at
  // real elements. Derived from the session + the paths it renders, which are
  // fixed for the lifetime of a `files_changed` event.
  const cardId = `files-${sessionId ?? "none"}-${paths.join("|")}`;

  return (
    <div className="rounded-md border border-border bg-secondary/40 text-xs">
      {/* A disclosure. The chevron alone communicated open/closed, so a
          screen-reader user got no state at all and no way to know the button
          controlled the region underneath it. */}
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        aria-controls={`${cardId}-panel`}
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
        <div id={`${cardId}-panel`} className="border-t border-border">
          {loading && (
            <div role="status" className="px-2.5 py-2 text-muted-foreground">
              Loading files…
            </div>
          )}
          {error && (
            <div role="alert" className="px-2.5 py-2 text-red-400">
              {error}
            </div>
          )}
          {files && files.length === 0 && !loading && (
            <div className="px-2.5 py-2 text-muted-foreground">
              No file contents available yet.
            </div>
          )}
          {files && files.length > 0 && (
            <>
              {/* Real tab semantics. As plain buttons these were announced as
                  a row of unrelated controls with no selected state (the
                  active one was inverted colors only) and no link to the code
                  below. role=tab/tabpanel + a roving tabIndex also gives the
                  standard arrow-key behavior: one Tab enters the strip, arrows
                  move between files, one Tab leaves — instead of a Tab stop
                  per file. */}
              <div
                role="tablist"
                aria-label="Changed files"
                className="flex flex-wrap gap-1 overflow-x-auto border-b border-border px-2 py-1.5"
              >
                {files.map((f, i) => (
                  <button
                    key={f.path}
                    id={`${cardId}-tab-${i}`}
                    type="button"
                    role="tab"
                    aria-selected={f.path === activePath}
                    aria-controls={`${cardId}-tabpanel`}
                    tabIndex={f.path === activePath ? 0 : -1}
                    onClick={() => setActivePath(f.path)}
                    onKeyDown={(e) => {
                      const delta =
                        e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                      if (!delta) return;
                      e.preventDefault();
                      const next = (i + delta + files.length) % files.length;
                      setActivePath(files[next].path);
                      document.getElementById(`${cardId}-tab-${next}`)?.focus();
                    }}
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
                // tabIndex=0 on the <pre>: it's a scrollable region (max-h-72
                // + overflow-auto), and a scroll container that can't be
                // focused can't be scrolled with the keyboard at all — the
                // rest of a long file was simply unreachable without a mouse.
                <pre
                  id={`${cardId}-tabpanel`}
                  role="tabpanel"
                  aria-labelledby={`${cardId}-tab-${files.findIndex((f) => f.path === activePath)}`}
                  tabIndex={0}
                  className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground"
                >
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
