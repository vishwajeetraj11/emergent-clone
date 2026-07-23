import { NextResponse } from "next/server";
import { assertSessionOwnership } from "@/lib/authz";
import { getSessionFiles } from "@/server/files";

/**
 * Latest file snapshot for a session, for the timeline's "Viewing N
 * paths" file viewer.
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

  const rows = await getSessionFiles(sessionId);
  return NextResponse.json(
    rows.map((f) => ({
      path: f.path,
      content: f.content,
      updatedAt: f.updatedAt,
    }))
  );
}
