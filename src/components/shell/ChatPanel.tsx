"use client";

import { useState } from "react";
import { GitFork, Mic, MessageSquareDashed, Paperclip, Square } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// lucide-react dropped brand marks, so the GitHub logo is inlined here.
function GithubIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 .5A11.5 11.5 0 0 0 8.37 22.94c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.53-1.33-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.5 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.08.78 2.17v3.22c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

function IconAction({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ChatPanel() {
  const [message, setMessage] = useState("");

  return (
    <aside className="flex h-full w-[440px] shrink-0 flex-col border-r border-border bg-background">
      {/* Timeline */}
      <ScrollArea className="flex-1">
        <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-3 px-8 py-16 text-center">
          <div className="flex size-10 items-center justify-center rounded-full bg-secondary">
            <MessageSquareDashed className="size-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground">
            No activity yet
          </p>
          <p className="max-w-56 text-xs leading-relaxed text-muted-foreground">
            Send a message below to kick off the agent — its plan, file
            edits, and progress will stream in here.
          </p>
        </div>
      </ScrollArea>

      {/* Pinned bottom composer */}
      <div className="shrink-0 border-t border-border bg-background p-3">
        <div className="mb-2 flex items-center gap-2 rounded-md bg-secondary/60 px-2.5 py-1.5 text-xs text-muted-foreground">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-amber-400" />
          </span>
          Agent is waiting&hellip;
        </div>

        <div className="rounded-lg border border-input bg-input/20 p-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Message Agent…"
            className="min-h-16 resize-none border-none bg-transparent p-1 shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-0.5">
              <IconAction icon={<Paperclip className="size-4" />} label="Attach" />
              <IconAction icon={<GithubIcon className="size-4" />} label="Save" />
              <IconAction icon={<GitFork className="size-4" />} label="Fork" />
              <IconAction icon={<Mic className="size-4" />} label="Voice input" />
            </div>
            <Tooltip>
              <TooltipTrigger
                aria-label="Stop agent"
                className="flex size-7 items-center justify-center rounded-md bg-foreground text-background transition-colors hover:bg-foreground/80"
              >
                <Square className="size-3 fill-current" />
              </TooltipTrigger>
              <TooltipContent>Stop agent</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </aside>
  );
}
