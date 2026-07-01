import { NextRequest } from "next/server";
import { submitAgentPrompt, aeonEnabled } from "@/lib/bankrAgent";
import { checkAeonBudget, incrAeon } from "@/lib/usage";

export const dynamic = "force-dynamic";

// Prompts map a card `kind` to the natural-language ask that triggers the matching
// Aeon skill on the connected Bankr agent.
const PROMPTS: Record<string, string> = {
  narrative:
    "What's the crypto narrative today? Give the daily narrative map: the top narratives right now with a clear front-run / ride / fade / skip call for each. Keep it concise and skimmable.",
  defi:
    "What's the DeFi market read today? Give the regime (risk-on / risk-off / neutral), the top movers with a one-line reason each, and note where yield is real vs just emissions. Keep it concise and skimmable.",
};

// Submits the read and returns a jobId immediately — the client polls
// /api/aeon/job for the result, because reads run 50-70s (beyond serverless
// limits). Budget is charged on submit (the agent runs regardless of polling).
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

  const result = await submitAgentPrompt(prompt);
  if (result.ok) await incrAeon();

  return Response.json(result, { status: result.ok ? 200 : 502 });
}
