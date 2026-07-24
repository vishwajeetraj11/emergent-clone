import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { glob as tinyGlob } from "tinyglobby";
import type { AnswerItem, Question } from "@/lib/types";

// ---------------------------------------------------------------------------
// The agent tool belt for the AI SDK runtime (src/server/llm.ts).
//
// Under the old Claude Agent SDK, the `claude` CLI subprocess executed
// Bash/Read/Write/Edit/Glob/Grep itself. The AI SDK has no execution
// environment — every tool below runs in THIS Node process via `execute`,
// scoped to the phase's working directory. Two hardenings the CLI never had:
//   - file tools refuse paths that resolve outside `cwd` (same containment
//     check as writeSnapshotFiles in src/server/sandbox.ts). Bash remains a
//     soft boundary (same accepted residual risk as before — single-user
//     local tool, documented in agent.ts's header).
//   - bash gets a curated env, not process.env — the platform's own secrets
//     (ANTHROPIC/OPENAI keys, platform DATABASE_URL, GitHub/Razorpay/Neon…)
//     are no longer inherited by agent-run shell commands.
//
// Tool failures return error strings rather than throwing: the AI SDK relays
// a returned string straight back to the model, which is exactly what a
// coding agent needs to self-correct ("file not found", "old_string not
// unique", …).
// ---------------------------------------------------------------------------

const BASH_TIMEOUT_MS = 120_000;
const MAX_TOOL_OUTPUT_CHARS = 30_000;
const MAX_READ_CHARS = 100_000;

function tailCap(text: string, cap = MAX_TOOL_OUTPUT_CHARS): string {
  return text.length > cap ? `…(truncated)…\n${text.slice(-cap)}` : text;
}

/** Resolves `relPath` inside `cwd`, or null if it would escape it. */
function resolveInside(cwd: string, relPath: string): string | null {
  const root = path.resolve(cwd);
  const full = path.resolve(root, relPath);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** Minimal env for agent bash commands — see module doc comment. */
function toolEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, TMPDIR, USER, SHELL, LANG, LC_ALL, NODE_ENV } = process.env;
  return { PATH, HOME, TMPDIR, USER, SHELL, LANG, LC_ALL, NODE_ENV };
}

function runBash(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env: toolEnv() });
    let out = "";
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      resolve(text);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(`${tailCap(out)}\n(command timed out after ${Math.round(timeoutMs / 1000)}s)`);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(`Failed to run command: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(`${tailCap(out)}${code === 0 ? "" : `\n(exit code ${code})`}`);
    });
  });
}

/**
 * The build/review/debug file+shell toolset, scoped to `cwd`. Names match
 * the old CLI tool names (lowercased) so existing prompt language ("use
 * Bash", "Read the file") still lands on the obvious tool.
 */
export function buildFileTools(cwd: string) {
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
        runBash(command, cwd, (timeout_seconds ?? BASH_TIMEOUT_MS / 1000) * 1000),
    }),

    read: tool({
      description: "Read a text file (path relative to the working directory).",
      inputSchema: z.object({ file_path: z.string().min(1) }),
      execute: async ({ file_path }) => {
        const full = resolveInside(cwd, file_path);
        if (!full) return "Error: path escapes the working directory.";
        if (!existsSync(full)) return `Error: ${file_path} does not exist.`;
        try {
          const content = readFileSync(full, "utf8");
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
        const full = resolveInside(cwd, file_path);
        if (!full) return "Error: path escapes the working directory.";
        try {
          mkdirSync(path.dirname(full), { recursive: true });
          writeFileSync(full, content, "utf8");
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
        const full = resolveInside(cwd, file_path);
        if (!full) return "Error: path escapes the working directory.";
        if (!existsSync(full)) return `Error: ${file_path} does not exist.`;
        try {
          const content = readFileSync(full, "utf8");
          const first = content.indexOf(old_string);
          if (first === -1) return `Error: old_string not found in ${file_path}.`;
          if (content.indexOf(old_string, first + 1) !== -1) {
            return `Error: old_string occurs more than once in ${file_path} — add more surrounding context to make it unique.`;
          }
          writeFileSync(full, content.replace(old_string, new_string), "utf8");
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
        try {
          const matches = await tinyGlob(pattern, {
            cwd,
            ignore: ["**/node_modules/**", "**/.next/**", "**/.git/**", "**/.turbo/**"],
            onlyFiles: true,
          });
          if (matches.length === 0) return "No files matched.";
          return tailCap(matches.sort().slice(0, 500).join("\n"));
        } catch (err) {
          return `Error globbing: ${err instanceof Error ? err.message : String(err)}`;
        }
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
        const target = subPath ? resolveInside(cwd, subPath) : cwd;
        if (!target) return "Error: path escapes the working directory.";
        // -I skips binary files; grep exits 1 on "no matches", which runBash
        // reports as an exit-code note the model can read as "not found".
        const cmd = `grep -rnIE --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude-dir=.turbo -e ${JSON.stringify(pattern)} ${JSON.stringify(path.relative(cwd, target) || ".")}`;
        const out = await runBash(cmd, cwd, 30_000);
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
 * the Claude CLI runtime backend (src/server/llm-claude-cli.ts) can register
 * the exact same validation on its own bridged MCP tool, whose `tool()`
 * (from @anthropic-ai/claude-agent-sdk) wants a bare shape rather than a
 * `ZodObject`. Both runtimes parse identical input as a result.
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
