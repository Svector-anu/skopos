import { z } from "zod";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { getPrice } from "@/lib/priceCache";

// Paid, agent-discoverable price lookup — $0.01/call via x402. Reuses the same
// getPrice() the free /api/chat price fast-path calls (priceCache.ts), so this
// route never duplicates the CoinGecko/DexScreener fetch logic or its cache.
export const POST = router
  .route({ path: "price" })
  .paid("0.01")
  .body(z.object({ symbol: z.string().min(1).max(20) }))
  .inputExample({ symbol: "ETH" })
  .description("Live spot price and 24h change for a crypto token symbol.")
  .handler(async ({ body }) => {
    const symbol = body.symbol.trim().toUpperCase();
    const result = await getPrice(symbol);
    if (!result || result.price <= 0) {
      throw new HttpError(`No reliable price found for "${symbol}".`, 404);
    }
    return {
      symbol: result.symbol,
      price: result.price,
      change24h: result.change24h,
      source: result.source,
    };
  });
