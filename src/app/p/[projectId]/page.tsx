import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { isClerkConfigured } from "@/lib/auth";

/**
 * Phase 3 persistence route: a real, bookmarkable/reloadable URL for an
 * existing project. AppShell loads it client-side via GET
 * /api/projects/[projectId] and replays its latest job's event history over
 * SSE (see useAgentSession.loadProject / src/server/projects.ts).
 *
 * Signed-out visitors (Clerk configured, no session) get bounced to
 * sign-in — a resource-based check here rather than middleware path
 * matching, per Clerk's current guidance (createRouteMatcher +
 * auth.protect() in proxy.ts is deprecated).
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  if (isClerkConfigured()) {
    const { auth } = await import("@clerk/nextjs/server");
    const { userId } = await auth();
    if (!userId) {
      redirect(`/sign-in?redirect_url=${encodeURIComponent(`/p/${projectId}`)}`);
    }
  }

  return <AppShell initialProjectId={projectId} />;
}
