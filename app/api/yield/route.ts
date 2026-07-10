import { z } from "zod";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { getTopYields } from "@/lib/defillama";

// Paid, agent-discoverable DeFi yield lookup — $0.01/call via x402. Reuses the
// same getTopYields() the free "find highest yield for X" chat command calls.
export const POST = router
  .route({ path: "yield" })
  .paid("0.01")
  .body(z.object({
    symbol: z.string().min(1).max(20),
    chain: z.string().optional(),
    limit: z.number().int().min(1).max(10).default(5),
  }))
  .inputExample({ symbol: "USDC", limit: 5 })
  .description("Live DeFi yield pools for a token, ranked by APY — real fee yield vs. emission-funded, per pool.")
  .handler(async ({ body }) => {
    const pools = await getTopYields(body.symbol.trim().toUpperCase(), body.limit, body.chain);
    if (!pools.length) {
      throw new HttpError(`No yield pools found for "${body.symbol}".`, 404);
    }
    return { symbol: body.symbol.trim().toUpperCase(), pools };
  });
