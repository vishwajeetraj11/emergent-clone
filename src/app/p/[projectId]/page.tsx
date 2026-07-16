import { AppShell } from "@/components/shell/AppShell";

/**
 * Phase 3 persistence route: a real, bookmarkable/reloadable URL for an
 * existing project. AppShell loads it client-side via GET
 * /api/projects/[projectId] and replays its latest job's event history over
 * SSE (see useAgentSession.loadProject / src/server/projects.ts).
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <AppShell initialProjectId={projectId} />;
}
