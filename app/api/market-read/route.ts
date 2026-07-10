import { z } from "zod";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { getAeonRead, stripMarkdown, type AeonKind } from "@/lib/aeonFeed";

const KINDS = ["defi", "narrative", "trending", "protocols", "fear", "x402"] as const;

// Paid, agent-discoverable market-intelligence read — $0.01/call via x402.
// Reuses the same getAeonRead() the free "defi read" / "what's trending" /
// "fear and greed divergence" / "x402 pulse" chat commands call — served from
// Skopos's self-hosted Aeon fork cache, no per-call cost internally.
export const POST = router
  .route({ path: "market-read" })
  .paid("0.01")
  .body(z.object({ kind: z.enum(KINDS) }))
  .inputExample({ kind: "defi" })
  .description("Aeon-powered market intelligence: defi regime, narratives, trending, top protocols, fear/greed divergence, or x402 ecosystem pulse.")
  .handler(async ({ body }) => {
    const kind = body.kind as AeonKind;
    const read = await getAeonRead(kind);
    if (!read) {
      throw new HttpError(`No "${body.kind}" read available right now — try again shortly.`, 503);
    }
    return { kind, text: stripMarkdown(read) };
  });
