import { NextResponse } from "next/server";
import { assertSessionOwnership } from "@/lib/authz";
import { listDeploymentsForSession } from "@/server/vercel";

/**
 * Full deploy history for a session, for the Deployments dropdown — see
 * listDeploymentsForSession in src/server/vercel.ts for why this is
 * separate from sessions.vercelDeploymentUrl (only the latest).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  try {
    await assertSessionOwnership(sessionId);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const deployments = await listDeploymentsForSession(sessionId);
  return NextResponse.json({ deployments });
}
