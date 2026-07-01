import { NextRequest } from "next/server";
import { pollAgentJob, aeonEnabled, isJobId } from "@/lib/bankrAgent";

export const dynamic = "force-dynamic";

// One status check for an Aeon read job. Fast (single GET), so the client can poll
// it every few seconds without holding a serverless function open for the full
// 50-70s read. No budget here — the read was already charged at submit.
export async function POST(req: NextRequest) {
  if (!aeonEnabled()) {
    return Response.json({ ok: false, status: "unknown", error: "Aeon reads are not enabled." }, { status: 503 });
  }

  let jobId: unknown;
  try {
    jobId = (await req.json())?.jobId;
  } catch {
    return Response.json({ ok: false, status: "unknown", error: "Invalid request body." }, { status: 400 });
  }

  if (!isJobId(jobId)) {
    return Response.json({ ok: false, status: "unknown", error: "Invalid job id." }, { status: 400 });
  }

  const result = await pollAgentJob(jobId);
  return Response.json(result);
}
