"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Renders agent-authored text (plans, summaries) as markdown — the model
 * writes real markdown (bold, bullet lists, inline code) and the timeline
 * was previously dumping it as raw text, so users saw literal "**Plan**"
 * asterisks instead of formatting.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 text-sm leading-relaxed text-foreground [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1 [&_ol]:flex [&_ol]:flex-col [&_ol]:gap-1",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => (
            <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
            >
              {children}
            </a>
          ),
          code: ({ children, className: codeClassName }) => {
            const isBlock = /language-/.test(codeClassName ?? "");
            return isBlock ? (
              <code className={codeClassName}>{children}</code>
            ) : (
              <code className="rounded bg-secondary px-1 py-0.5 font-mono text-xs text-foreground">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md bg-secondary p-3 font-mono text-xs text-foreground">
              {children}
            </pre>
          ),
          h1: ({ children }) => (
            <h3 className="text-sm font-semibold text-foreground">{children}</h3>
          ),
          h2: ({ children }) => (
            <h3 className="text-sm font-semibold text-foreground">{children}</h3>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-foreground">{children}</h3>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
