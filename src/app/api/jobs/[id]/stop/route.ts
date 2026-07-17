import { NextResponse } from "next/server";
import { assertJobOwnership } from "@/lib/authz";
import { getJob, setJobStatus } from "@/server/jobs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await params;

  try {
    await assertJobOwnership(jobId);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status === "done" || job.status === "stopped" || job.status === "failed") {
    return NextResponse.json({ job });
  }

  const updated = await setJobStatus(jobId, "stopped");
  return NextResponse.json({ job: updated });
}
