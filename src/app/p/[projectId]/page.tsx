import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { AppShell } from "@/components/shell/AppShell";

/**
 * Bookmarkable URL for an existing project. AppShell loads it client-side via
 * GET /api/projects/[projectId] and replays its latest job's event history over
 * SSE (see useAgentSession.loadProject).
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const { userId } = await auth();
  if (!userId) {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(`/p/${projectId}`)}`);
  }

  return <AppShell initialProjectId={projectId} />;
}
