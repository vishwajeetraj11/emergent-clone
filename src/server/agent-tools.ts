import path from "node:path";
import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import type { Sandbox } from "@vercel/sandbox";
import type { AnswerItem, Question } from "@/lib/types";

// ---------------------------------------------------------------------------
// The agent tool belt for the AI SDK runtime (src/server/llm.ts).
//
// Every tool below runs INSIDE the session's Vercel sandbox (the same VM that
// serves the preview) via the @vercel/sandbox API — runCommand for shell,
// readFileToBuffer/writeFiles for files — NOT on the Emergent Clone server's local
// disk. The agent edits the exact filesystem the dev server runs, so there is
// no local working dir and no sync step. Two hardenings:
//   - file tools refuse paths that resolve outside the sandbox app dir
//     (APP_DIR). Bash remains a soft boundary (the sandbox is the isolation).
//   - bash inherits only the VM's own environment; the Emergent Clone platform's
//     secrets never cross into the box (they live only in the server process).
//
// Tool failures return error strings rather than throwing: the AI SDK relays
// a returned string straight back to the model, which is exactly what a
// coding agent needs to self-correct ("file not found", "old_string not
// unique", …).
// ---------------------------------------------------------------------------

// The sandbox's working directory — @vercel/sandbox writeFiles/runCommand
// default here, and the app (package.json, next dev) is seeded/run here.
const APP_DIR = "/vercel/sandbox";

const BASH_TIMEOUT_MS = 120_000;
const MAX_TOOL_OUTPUT_CHARS = 30_000;
const MAX_READ_CHARS = 100_000;

function tailCap(text: string, cap = MAX_TOOL_OUTPUT_CHARS): string {
  return text.length > cap ? `…(truncated)…\n${text.slice(-cap)}` : text;
}

/** Resolves `relPath` to an absolute path inside APP_DIR, or null if it would
 * escape it. Uses posix (the sandbox is Linux) regardless of the server's OS. */
function resolveInside(relPath: string): string | null {
  const root = APP_DIR;
  const full = path.posix.resolve(root, relPath);
  if (full !== root && !full.startsWith(root + "/")) return null;
  return full;
}

/** Minimal glob -> anchored regex (supports **, *, ?). Used to match a find
 * listing from the sandbox server-side, since there's no local fs to glob. */
function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Run a shell command in the sandbox and return capped combined output + a
 * non-zero exit note (never throws — infra errors become an error string). */
async function runVmBash(sandbox: Sandbox, command: string, timeoutMs: number): Promise<string> {
  try {
    const res = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", command],
      cwd: APP_DIR,
      timeoutMs,
    });
    const out = await res.output("both");
    return `${tailCap(out)}${res.exitCode === 0 ? "" : `\n(exit code ${res.exitCode})`}`;
  } catch (err) {
    return `Failed to run command: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * The build/review/debug file+shell toolset, executing inside the session's
 * Vercel `sandbox`. Names match the old CLI tool names (lowercased) so
 * existing prompt language ("use Bash", "Read the file") still lands.
 */
export function buildFileTools(sandbox: Sandbox) {
  return {
    bash: tool({
      description:
        "Run a shell command inside the app's working directory. Long-running servers must be started in the background (`... &`). Output is capped; exit code is appended when non-zero.",
      inputSchema: z.object({
        command: z.string().min(1).describe("The shell command to run"),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe("Optional timeout in seconds (default 120)"),
      }),
      execute: async ({ command, timeout_seconds }) =>
        runVmBash(sandbox, command, (timeout_seconds ?? BASH_TIMEOUT_MS / 1000) * 1000),
    }),

    read: tool({
      description: "Read a text file (path relative to the working directory).",
      inputSchema: z.object({ file_path: z.string().min(1) }),
      execute: async ({ file_path }) => {
        const full = resolveInside(file_path);
        if (!full) return "Error: path escapes the working directory.";
        try {
          const buf = await sandbox.readFileToBuffer({ path: full });
          if (buf == null) return `Error: ${file_path} does not exist.`;
          const content = buf.toString("utf8");
          return content.length > MAX_READ_CHARS
            ? `${content.slice(0, MAX_READ_CHARS)}\n…(truncated — file is ${content.length} chars)`
            : content;
        } catch (err) {
          return `Error reading ${file_path}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    write: tool({
      description:
        "Create or overwrite a file with the given content (path relative to the working directory). Creates parent directories as needed.",
      inputSchema: z.object({
        file_path: z.string().min(1),
        content: z.string(),
      }),
      execute: async ({ file_path, content }) => {
        const full = resolveInside(file_path);
        if (!full) return "Error: path escapes the working directory.";
        try {
          const dir = path.posix.dirname(full);
          if (dir && dir !== APP_DIR) await sandbox.mkDir(dir).catch(() => {});
          await sandbox.writeFiles([{ path: full, content }]);
          return `Wrote ${file_path} (${content.length} chars).`;
        } catch (err) {
          return `Error writing ${file_path}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    edit: tool({
      description:
        "Replace an exact string in a file with a new string (path relative to the working directory). old_string must occur exactly once — include enough surrounding context to make it unique.",
      inputSchema: z.object({
        file_path: z.string().min(1),
        old_string: z.string().min(1),
        new_string: z.string(),
      }),
      execute: async ({ file_path, old_string, new_string }) => {
        const full = resolveInside(file_path);
        if (!full) return "Error: path escapes the working directory.";
        try {
          const buf = await sandbox.readFileToBuffer({ path: full });
          if (buf == null) return `Error: ${file_path} does not exist.`;
          const content = buf.toString("utf8");
          const first = content.indexOf(old_string);
          if (first === -1) return `Error: old_string not found in ${file_path}.`;
          if (content.indexOf(old_string, first + 1) !== -1) {
            return `Error: old_string occurs more than once in ${file_path} — add more surrounding context to make it unique.`;
          }
          await sandbox.writeFiles([{ path: full, content: content.replace(old_string, new_string) }]);
          return `Edited ${file_path}.`;
        } catch (err) {
          return `Error editing ${file_path}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    glob: tool({
      description:
        'Find files by glob pattern (e.g. "app/**/*.tsx"), relative to the working directory. node_modules/.next/.git are always excluded.',
      inputSchema: z.object({ pattern: z.string().min(1) }),
      execute: async ({ pattern }) => {
        const listing = await runVmBash(
          sandbox,
          "find . -type f -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' -not -path './.turbo/*'",
          30_000
        );
        const re = globToRegex(pattern);
        const matches = listing
          .split("\n")
          .map((l) => l.trim().replace(/^\.\//, ""))
          .filter((p) => p && !p.startsWith("(") && re.test(p))
          .sort()
          .slice(0, 500);
        return matches.length ? tailCap(matches.join("\n")) : "No files matched.";
      },
    }),

    grep: tool({
      description:
        "Search file contents for a pattern (extended regex), relative to the working directory. Returns matching lines as path:line:text.",
      inputSchema: z.object({
        pattern: z.string().min(1),
        path: z.string().optional().describe("Subdirectory or file to search (default: whole working directory)"),
      }),
      execute: async ({ pattern, path: subPath }) => {
        const target = subPath ? resolveInside(subPath) : APP_DIR;
        if (!target) return "Error: path escapes the working directory.";
        const rel = target === APP_DIR ? "." : path.posix.relative(APP_DIR, target) || ".";
        // -I skips binary files; grep exits 1 on "no matches", surfaced as an
        // exit-code note the model reads as "not found".
        const cmd = `grep -rnIE --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude-dir=.turbo -e ${JSON.stringify(pattern)} ${JSON.stringify(rel)}`;
        const out = await runVmBash(sandbox, cmd, 30_000);
        return out.trim() === "(exit code 1)" || out.trim() === "" ? "No matches." : out;
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// ask_user — the blocking question tool (same contract as the old SDK MCP
// version in agent.ts: append tool_call + question events, flip the job to
// waiting_on_user, poll the events table until the user's answer arrives via
// POST /api/jobs/[id]/messages).
// ---------------------------------------------------------------------------

export interface AskUserDeps {
  jobId: string;
  appendEvent: (
    jobId: string,
    role: "assistant",
    type: "tool_call" | "question",
    payload: Record<string, unknown>
  ) => Promise<unknown>;
  setJobStatus: (jobId: string, status: "waiting_on_user") => Promise<unknown>;
  waitForAnswer: (jobId: string, toolUseId: string) => Promise<AnswerItem[] | null>;
  normalizeQuestions: (raw: unknown) => Question[];
  formatAnswersAsToolResult: (answers: AnswerItem[]) => string;
}

/**
 * Dependencies are injected rather than imported to keep this module free of
 * an import cycle with agent.ts (which owns waitForAnswer & friends and
 * imports this module for the toolsets).
 */
/**
 * Raw shape (not wrapped in `z.object`) for ask_user's input — exported so
 * callers can reuse the exact validation where a bare shape is wanted rather
 * than a `ZodObject`.
 */
export const askUserInputShape = {
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        options: z.array(z.string().min(1)).min(2).max(6),
      })
    )
    .min(3)
    .max(5)
    .describe("3-5 clarifying questions, each with 2-6 short suggested options"),
};

export function buildAskUserTool(deps: AskUserDeps) {
  return tool({
    description:
      "Ask the user 3-5 clarifying questions about the app they want built, each with 2-6 short suggested options. Call this exactly once, on your first turn, before writing any plan or doing anything else.",
    inputSchema: z.object(askUserInputShape),
    execute: async ({ questions: rawQuestions }) => {
      const toolUseId = randomUUID();
      const questions = deps.normalizeQuestions(rawQuestions);

      await deps.appendEvent(deps.jobId, "assistant", "tool_call", {
        id: toolUseId,
        name: "ask_user",
        input: { questions },
      });
      await deps.appendEvent(deps.jobId, "assistant", "question", { toolUseId, questions });
      await deps.setJobStatus(deps.jobId, "waiting_on_user");

      const answers = await deps.waitForAnswer(deps.jobId, toolUseId);
      if (answers === null) return "The job was stopped before the user answered.";
      return deps.formatAnswersAsToolResult(answers);
    },
  });
}

// ---------------------------------------------------------------------------
// report_review — structured review verdict (same contract as before: write
// into a shared ref the harness reads after the loop; the loop itself stops
// on this call via hasToolCall("report_review") in llm.ts's stopWhen).
// ---------------------------------------------------------------------------

export interface ReviewResult {
  issuesFound: boolean;
  summary: string;
  findings: string[];
}

/** Raw shape for report_review's input — see askUserInputShape's comment above; same reasoning, same reuse. */
export const reportReviewInputShape = {
  issuesFound: z.boolean(),
  summary: z.string().min(1),
  findings: z.array(z.string().min(1)).max(10).default([]),
};

export function buildReportReviewTool(resultRef: { value: ReviewResult | null }) {
  return tool({
    description:
      "Report the final result of your code review. Call this exactly once, when you have formed your verdict.",
    inputSchema: z.object(reportReviewInputShape),
    execute: async ({ issuesFound, summary, findings }) => {
      resultRef.value = { issuesFound, summary, findings: findings ?? [] };
      return "Review recorded.";
    },
  });
}
