import { NextRequest } from "next/server";
import { getAeonRead, type AeonKind } from "@/lib/aeonFeed";

export const dynamic = "force-dynamic";

const AEON_KINDS = new Set(["defi", "narrative", "trending", "protocols", "fear", "x402"]);

// Serves the self-hosted Aeon fork's cached read (lib/aeonFeed.ts) — instant,
// free, no Bankr Agent dependency. A miss (fork hasn't produced this read yet,
// or a transient fetch failure) returns a clean "not ready" rather than a
// slow async fallback; the fork's cron runs every few hours, so a real miss
// is brief.
export async function POST(req: NextRequest) {
  let kind: string;
  try {
    const body = await req.json();
    kind = typeof body?.kind === "string" ? body.kind : "";
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (!AEON_KINDS.has(kind)) {
    return Response.json({ ok: false, error: "Unsupported read." }, { status: 400 });
  }

  const read = await getAeonRead(kind as AeonKind);
  if (read) return Response.json({ ok: true, text: read }, { status: 200 });

  return Response.json({ ok: false, error: "That read isn't ready yet — try again in a moment." }, { status: 503 });
}
