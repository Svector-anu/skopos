import { z } from "zod";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { lookupAddress } from "@/lib/alchemy";
import { DAO_TREASURIES } from "@/app/api/chat/route";

// Paid, agent-discoverable DAO treasury lookup — $0.01/call via x402. Reuses
// lookupAddress() + the same curated, hand-verified DAO_TREASURIES map the
// free "treasury of X" chat command uses — deliberately small, not scraped.
export const POST = router
  .route({ path: "treasury" })
  .paid("0.01")
  .body(z.object({ dao: z.string().min(1).max(40) }))
  .inputExample({ dao: "uniswap" })
  .description(`Live, multi-chain DAO treasury value and top holdings. Currently supports: ${Object.keys(DAO_TREASURIES).join(", ")}.`)
  .handler(async ({ body }) => {
    const key = body.dao.trim().toLowerCase();
    const dao = DAO_TREASURIES[key];
    if (!dao) {
      throw new HttpError(
        `"${body.dao}" isn't in the curated treasury list — currently supporting: ${Object.values(DAO_TREASURIES).map(d => d.label).join(", ")}.`,
        404,
      );
    }
    const data = await lookupAddress(dao.address);
    return {
      dao: dao.label,
      address: dao.address,
      totalUsdValue: data.totalUsdValue ?? null,
      balances: data.balances,
      topTokens: data.tokenBalances.slice(0, 10),
    };
  });
