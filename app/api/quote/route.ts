import { z } from "zod";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { resolveLeg } from "@/app/api/chat/route";

const SITE = "https://www.tryskopos.xyz";

// Paid, agent-discoverable swap/bridge quote — $0.02/call via x402. Structured
// input instead of natural language (agents are code, not people typing
// sentences) but calls the exact same resolveLeg() the free chat swap/bridge
// flow uses, so quote accuracy never diverges between the two surfaces.
// Non-custodial like everything else in Skopos: this returns a route summary
// + a sign-in link, never raw calldata for an agent to blind-sign.
export const POST = router
  .route({ path: "quote" })
  .paid("0.02")
  .body(z.object({
    originChain: z.string().min(1),
    destinationChain: z.string().min(1),
    token: z.string().min(1),
    amount: z.string().min(1),
    destinationToken: z.string().min(1).optional(),
    senderAddress: z.string().optional(),
    solanaAddress: z.string().optional(),
  }))
  .inputExample({ originChain: "ethereum", destinationChain: "base", token: "ETH", amount: "0.1" })
  .description("Swap/bridge route quote — live fees, output amount, and a sign-in link. Execution happens non-custodially in the Skopos app; this endpoint never returns raw calldata.")
  .handler(async ({ body }) => {
    const destinationToken = body.destinationToken ?? body.token;
    const result = await resolveLeg(
      { originChain: body.originChain, destinationChain: body.destinationChain, token: body.token, amount: body.amount, destinationToken },
      body.senderAddress,
      undefined,
      body.solanaAddress,
    );
    if (!result.ok) {
      throw new HttpError(result.text, 422);
    }
    const message = body.originChain.toLowerCase() === body.destinationChain.toLowerCase()
      ? `swap ${body.amount} ${body.token} to ${destinationToken} on ${body.destinationChain}`
      : `bridge ${body.amount} ${body.token} from ${body.originChain} to ${body.destinationChain}`;
    return {
      intent: result.intent,
      route: result.route,
      signInUrl: `${SITE}/app?q=${encodeURIComponent(message)}`,
    };
  });
