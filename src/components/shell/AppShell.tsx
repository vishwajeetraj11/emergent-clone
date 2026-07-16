"use client";

import { TopBar } from "@/components/shell/TopBar";
import { ChatPanel } from "@/components/shell/ChatPanel";
import { PreviewPanel } from "@/components/shell/PreviewPanel";
import { useAgentSession } from "@/lib/hooks/useAgentSession";

export function AppShell() {
  const session = useAgentSession();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <TopBar project={session.project} jobStatus={session.jobStatus} />
      <main className="flex min-h-0 flex-1">
        <ChatPanel
          events={session.events}
          jobStatus={session.jobStatus}
          isStarting={session.isStarting}
          error={session.error}
          hasProject={Boolean(session.project)}
          onSubmitPrompt={session.start}
          onAnswerQuestion={session.answerQuestion}
          onStop={session.stop}
        />
        <PreviewPanel />
      </main>
    </div>
  );
}
