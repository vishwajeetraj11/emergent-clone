"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/shell/TopBar";
import { ChatPanel } from "@/components/shell/ChatPanel";
import { PreviewPanel } from "@/components/shell/PreviewPanel";
import { useAgentSession } from "@/lib/hooks/useAgentSession";

/**
 * `initialProjectId` is set by /p/[projectId] (Phase 3 persistence route) —
 * when present, AppShell loads that project instead of showing the empty
 * "what will you build" composer. The `/` route renders AppShell with no
 * prop and, once a project is created, navigates to its real /p/[id] URL.
 */
export function AppShell({ initialProjectId }: { initialProjectId?: string }) {
  const session = useAgentSession();
  const router = useRouter();
  const loadedProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!initialProjectId || loadedProjectIdRef.current === initialProjectId) return;
    loadedProjectIdRef.current = initialProjectId;
    session.loadProject(initialProjectId);
    // Only re-run if the route param itself changes (e.g. Home -> back to a
    // project) — `session` is stable-enough (new object each render, but
    // loadProject is memoized) and must not retrigger this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProjectId]);

  function handleCreated(projectId: string) {
    router.push(`/p/${projectId}`);
  }

  function handleNavigateHome() {
    router.push("/");
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <TopBar
        project={session.project}
        jobStatus={session.jobStatus}
        onNavigateHome={handleNavigateHome}
        onSelectProject={(id) => router.push(`/p/${id}`)}
        onRenameProject={session.renameProject}
      />
      <main className="flex min-h-0 flex-1">
        <ChatPanel
          events={session.events}
          jobStatus={session.jobStatus}
          isStarting={session.isStarting}
          error={session.error}
          hasProject={Boolean(session.project)}
          sessionId={session.sessionId}
          projectId={session.project?.id ?? null}
          isForking={session.isForking}
          isSendingMessage={session.isSendingMessage}
          saveState={session.saveState}
          saveMessage={session.saveMessage}
          saveUrl={session.saveUrl}
          deployState={session.deployState}
          deployMessage={session.deployMessage}
          deployUrl={session.deployUrl}
          onSubmitPrompt={(prompt) => session.start(prompt, handleCreated)}
          onAnswerQuestion={session.answerQuestion}
          onPlanDecision={session.decidePlan}
          onStop={session.stop}
          onContinueChat={session.continueChat}
          onFork={session.fork}
          onSwitchSession={session.switchSession}
          onSave={session.saveToGitHub}
          onDeploy={session.deployToVercel}
        />
        <PreviewPanel
          previewUrl={session.previewUrl}
          isRestoring={session.isRestoringPreview}
          restoreError={session.restoreError}
          isPreviewDead={session.isPreviewDead}
          onRestartPreview={session.restartPreview}
          onSelectProject={(id) => router.push(`/p/${id}`)}
        />
      </main>
    </div>
  );
}
