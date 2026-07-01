import { NextRequest } from "next/server";
import { promptAgent, aeonEnabled } from "@/lib/bankrAgent";
import { checkAeonBudget, incrAeon } from "@/lib/usage";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // agent reads poll for up to ~45s

// Prompts map a card `kind` to the natural-language ask that triggers the matching
// Aeon skill on the connected Bankr agent. Keep them tight — the agent scans
// sources and we render whatever text comes back.
const PROMPTS: Record<string, string> = {
  narrative:
    "What's the crypto narrative today? Give the daily narrative map: the top narratives right now with a clear front-run / ride / fade / skip call for each. Keep it concise and skimmable.",
};

// Agent-proxied Aeon read. Skopos's Bankr agent runs the installed Aeon skill; a
// global daily budget guards the agent's credits, incremented only on success.
export async function POST(req: NextRequest) {
  if (!aeonEnabled()) {
    return Response.json({ ok: false, error: "Aeon reads are not enabled." }, { status: 503 });
  }

  let kind: string;
  try {
    const body = await req.json();
    kind = typeof body?.kind === "string" ? body.kind : "";
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const prompt = PROMPTS[kind];
  if (!prompt) {
    return Response.json({ ok: false, error: "Unsupported read." }, { status: 400 });
  }

  if (!(await checkAeonBudget())) {
    return Response.json(
      { ok: false, error: "Aeon reads are at today's free limit. Try again tomorrow." },
      { status: 429 },
    );
  }

  const result = await promptAgent(prompt);
  if (result.ok) await incrAeon();

  return Response.json(result, { status: result.ok ? 200 : 502 });
}
