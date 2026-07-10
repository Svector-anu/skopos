import { z } from "zod";
import { HttpError } from "@agentcash/router";
import { router } from "@/lib/agentcashRouter";
import { fetchSmartMoneyServer, agentPaidEnabled } from "@/lib/smartMoneyServer";
import { isValidTokenTarget } from "@/lib/nansen";
import { isTimeframe, type Timeframe } from "@/lib/timeframe";

// Paid, agent-discoverable smart-money intel — $0.05/call via x402. Priced
// well above the internal Nansen x402 cost (lib/smartMoneyServer.ts pays
// Nansen per call already) so this doesn't lose money per request; the exact
// margin is an estimate — check against real Nansen billing after the first
// live calls and adjust if needed. Rejects unrecognized chain/address before
// spending anything, same guard as the internal /api/intel/* routes.
export const POST = router
  .route({ path: "smart-money" })
  .paid("0.05")
  .body(z.object({
    address: z.string().min(1),
    chain: z.string().min(1),
    symbol: z.string().optional(),
    direction: z.enum(["BUY", "SELL"]).default("BUY"),
    timeframe: z.string().optional(),
  }))
  .inputExample({ address: "0x6982508145454ce325ddbe47a25d4ec3d2311933", chain: "ethereum", direction: "BUY" })
  .description("Named smart-money wallets buying or selling a token, with net flow.")
  .handler(async ({ body }) => {
    if (!agentPaidEnabled()) {
      throw new HttpError("Smart-money intel is not enabled right now.", 503);
    }
    if (!isValidTokenTarget(body.address, body.chain)) {
      throw new HttpError("Unrecognized chain or malformed token address.", 400);
    }
    const timeframe: Timeframe | undefined = isTimeframe(body.timeframe) ? body.timeframe : undefined;
    const result = await fetchSmartMoneyServer(
      { symbol: body.symbol ?? null, address: body.address, chain: body.chain },
      body.direction,
      timeframe,
    );
    if (!result.ok) {
      throw new HttpError(result.error ?? "Smart-money lookup failed.", 502);
    }
    return result.data as object;
  });
