import { NextResponse } from "next/server";
import { getSessionFiles } from "@/server/files";

/**
 * Phase 2: latest file snapshot for a session, for the timeline's "Viewing N
 * paths" file viewer. Small, no auth (single-user dev mode, same as the rest
 * of the app in this phase).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const rows = await getSessionFiles(sessionId);
  return NextResponse.json(
    rows.map((f) => ({
      path: f.path,
      content: f.content,
      updatedAt: f.updatedAt,
    }))
  );
}
