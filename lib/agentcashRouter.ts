import { createRouterFromEnv } from "@agentcash/router";

// x402-payable API surface for agents (agentcash.dev integration). Separate
// from the free /api/chat surface — this is Skopos's own paid, machine-
// discoverable API, not a client paying someone else (see lib/smartMoneyClient.ts
// / lib/subscribeClient.ts for that direction). Config is pulled from env at
// module load; missing/mismatched credentials throw RouterConfigError there,
// which fails `next build` — this must not be imported by anything until
// BASE_URL / EVM_PAYEE_ADDRESS / CDP_API_KEY_ID / CDP_API_KEY_SECRET are set.
export const router = createRouterFromEnv({
  title: "Skopos",
  description: "Non-custodial, cross-chain crypto copilot — live prices, swap/bridge quotes, token safety, smart-money intel, DeFi yield, prediction markets, DAO treasuries, and Aeon-powered market reads.",
  guidance: "See /openapi.json for the full route list. Quick start: POST /api/price with { symbol: string } for a live spot price.",
  serviceName: "Skopos",
  tags: ["crypto", "defi", "price", "swap", "intel"],
  strictRoutes: true,
});
