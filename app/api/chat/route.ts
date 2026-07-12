import { NextRequest, NextResponse } from "next/server";
import { NATIVE_ADDRESS, resolveChainId, toWei } from "@/lib/chains";
import { getToken, getQuote, getChainById,} from "@/lib/delora";
import {
  parseIntent,
  parseRebalanceIntent,
  looksLikeRebalance,
  getInformationalReply,
  generateDecisionAnalysis,
  generateTxSummary,
  generateAddressSummary,
  classifyIntent,
  parseLaunchIntent,
  ParsedIntent,
  type LlmTier,
  type LlmMeta,
} from "@/lib/parseIntent";
import { checkSmartQuota, incrSmart } from "@/lib/usage";
import { isEntitled } from "@/lib/subscription";
import { resolveHolderCap } from "@/lib/tokenGate";
import { looksLikePay, buildPayIntent } from "@/lib/pay";
import { getMemoPayments } from "@/lib/payments";
import { launchToken, isBankrEnabled } from "@/lib/bankr";
import { lookupTx, lookupAddress, resolveENS } from "@/lib/alchemy";
import { scanToken, resolveTokenTarget, type TokenRisk } from "@/lib/dexscreener";
import { getSubscription } from "@/lib/notifications";
import { registerWatcher } from "@/lib/watchers";
import { toNansenChain } from "@/lib/nansen";
import { getTopYields, type YieldPool } from "@/lib/defillama";
import { getTopMarkets, PolymarketEvent } from "@/lib/polymarket";
import { generateDepositAddress, getDepositStatus, getPolymarketBalance } from "@/lib/polymarket-bridge";
import { getPrice, getPriceChart, type PriceResult } from "@/lib/priceCache";
import { getPythRates, getPythRate, toUSDRate, type PythFeedKey } from "@/lib/pyth";
import { fetchWebContext, extractUrl } from "@/lib/intel";
import { agentPaidEnabled, fetchSmartMoneyServer } from "@/lib/smartMoneyServer";
import { getRecentRobinhoodLaunches, robinhoodFeedEnabled } from "@/lib/robinhoodLaunches";
import { discoverX402Endpoint } from "@/lib/x402Discover";
import { parseTimeframe } from "@/lib/timeframe";
import { cardToText, executeLinkFor, chartImageFor } from "@/lib/cardToText";

// ── price query token recognition ────────────────────────────────────────────

const PRICE_TOKENS = [
  "ETH","WETH","BTC","WBTC","SOL","BNB","MATIC","POL","AVAX","ARB","OP",
  "LINK","UNI","AAVE","MKR","CRV","LDO","SNX","COMP","PEPE","SHIB","DOGE",
  "XRP","ADA","DOT","USDC","USDT","DAI","FRAX","MEGA",
];

const PRICE_TOKEN_RE = new RegExp(
  `\\b(${PRICE_TOKENS.join("|")}|bitcoin|ethereum|solana|dogecoin|cardano|chainlink|avalanche|polygon|optimism|arbitrum|uniswap|polkadot|maker|curve|lido|synthetix|megeth|megaeth)\\b`,
  "i"
);

const TOKEN_NAME_TO_SYMBOL: Record<string, string> = {
  bitcoin: "BTC",   ethereum: "ETH",   solana: "SOL",
  dogecoin: "DOGE", cardano: "ADA",    chainlink: "LINK",
  avalanche: "AVAX", polygon: "MATIC", optimism: "OP",
  arbitrum: "ARB",  uniswap: "UNI",    polkadot: "DOT",
  maker: "MKR",     curve: "CRV",      lido: "LDO",
  synthetix: "SNX", megeth: "MEGA",    megaeth: "MEGA",
};

// Curated DAO treasury addresses (#17) — deliberately small and verified, not
// scraped. Each address confirmed by hand against its Etherscan/Arbiscan label
// (e.g. "ENS: DAO Wallet") before being added — a wrong entry here would just
// report the wrong treasury's numbers with total confidence. lookupAddress
// already scans all 10 chains Skopos supports per address, so one address per
// DAO is enough even though the underlying assets may span chains.
export const DAO_TREASURIES: Record<string, { label: string; address: string }> = {
  uniswap: { label: "Uniswap", address: "0x1a9C8182C09F50C8318d769245beA52c32BE35BC" },
  ens:     { label: "ENS",     address: "0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7" },
  arbitrum: { label: "Arbitrum", address: "0xf3fc178157fb3c87548baa86f9d24ba38e649b58" },
};

// Live-data grounding for the Smart informational path. Pulls the current price
// for the primary recognized token in a free-form question so Smart can reason
// over real numbers instead of refusing. Returns null when no token is named or
// the fetch fails — caller then falls back to the ungrounded (redacted) reply.
function formatLiveData(symbol: string, p: PriceResult): string {
  const px = p.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const chg = p.change24h !== null
    ? `${p.change24h >= 0 ? "+" : ""}${p.change24h.toFixed(2)}% (24h)`
    : "24h change unavailable";
  return `${symbol}: $${px}, ${chg} — source ${p.source}`;
}

async function gatherLiveData(text: string): Promise<string | null> {
  const match = text.match(PRICE_TOKEN_RE);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const symbol = TOKEN_NAME_TO_SYMBOL[raw] ?? raw.toUpperCase();
  const price = await getPrice(symbol);
  return price ? formatLiveData(symbol, price) : null;
}

// ── decision analysis prompt builders ────────────────────────────────────────

function buildTokenAnalysisPrompt(risk: TokenRisk): string {
  const mcap = risk.marketCap ?? 0;
  const liq  = risk.totalLiquidityUsd;
  const fmtUsd = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${(n / 1_000).toFixed(1)}K`;

  const liquidityPct   = mcap > 0 ? ((liq / mcap) * 100).toFixed(2) : "N/A";
  const volToLiq       = liq > 0  ? (risk.volume24h / liq).toFixed(1) : "N/A";
  const buys           = risk.topPair?.txns?.h24.buys  ?? 0;
  const sells          = risk.topPair?.txns?.h24.sells ?? 0;
  const buyPct         = (buys + sells) > 0 ? Math.round((buys / (buys + sells)) * 100) : null;
  const pairAgeDays    = risk.topPair?.pairCreatedAt
    ? Math.floor((Date.now() - risk.topPair.pairCreatedAt) / 86_400_000)
    : null;

  return [
    `Token: ${risk.symbol} (${risk.name})`,
    `Price: ${risk.priceUsd ? `$${risk.priceUsd}` : "N/A"}`,
    `Market cap: ${mcap > 0 ? fmtUsd(mcap) : "N/A"}`,
    `Liquidity: ${fmtUsd(liq)} (${liquidityPct}% of market cap)`,
    `24h volume: ${fmtUsd(risk.volume24h)} (${volToLiq}× liquidity)`,
    buyPct != null ? `Buy/sell split: ${buyPct}% buys, ${100 - buyPct}% sells` : null,
    risk.priceChange24h != null
      ? `24h price change: ${risk.priceChange24h >= 0 ? "+" : ""}${risk.priceChange24h.toFixed(1)}%`
      : null,
    `Risk score: ${risk.label} (${risk.score}/4)`,
    risk.flags.length > 0 ? `Flags: ${risk.flags.join(", ")}` : null,
    pairAgeDays != null ? `Pair age: ${pairAgeDays} days` : null,
    `\nUse ONLY the figures above — never state a price, market cap, volume, or percentage not listed here.`,
    `Give a directional take: who does this setup favor — buyers, sellers, or neither? What is the key risk?`,
  ].filter(Boolean).join("\n");
}

function buildYieldAnalysisPrompt(symbol: string, pools: YieldPool[]): string {
  const lines = pools.filter(p => p.apy <= 10_000).slice(0, 3).map(p => {
    const base    = p.apyBase  ?? 0;
    const reward  = p.apyReward ?? 0;
    const total   = base + reward;
    const emPct   = total > 0 ? Math.round((reward / total) * 100) : 0;
    const tvl     = p.tvlUsd >= 1_000_000
      ? `$${(p.tvlUsd / 1_000_000).toFixed(0)}M` : `$${(p.tvlUsd / 1_000).toFixed(0)}K`;
    return `${p.project} on ${p.chain}: ${p.apy.toFixed(1)}% APY (${base.toFixed(1)}% fees + ${reward.toFixed(1)}% emissions = ${emPct}% emission-funded) · TVL ${tvl}`;
  }).join("\n");

  return `${symbol} yield opportunities:\n${lines}\n\nUse ONLY the APY and TVL figures above — never state a rate or amount not listed here. Classify each as sustainable real yield or an emission-funded coordination game. Give a directional take on which pool structurally favors LPs vs. which extracts from them.`;
}

const SKOPOS_HELP = `Skopos is a non-custodial, cross-chain crypto copilot — live at tryskopos.xyz, and embeddable anywhere else via API, Agent Skill, or MCP. Tell it what you want in plain English, it builds the route or pulls the data, and you sign in your own wallet. It never holds or moves your funds.

What you can do:
• Swap or bridge across 25+ chains (EVM + Solana) — e.g. "bridge 0.1 ETH from ethereum to base"
• Rebalance across chains — e.g. "split 1 ETH from ethereum across base and arbitrum"
• Live token price + 7-day chart — e.g. "ETH price"
• Find the best DeFi yield — e.g. "find highest yield for USDC"
• Scan or deep-dive a token's risk — e.g. "scan PEPE risk" or "deep dive on pepe"
• Get a token pick or check the scorecard — "give me a token pick" or "picks tracker"
• Look up a DAO treasury — e.g. "treasury of uniswap"
• Aeon market reads — e.g. "defi read", "what's trending", "fear and greed divergence", "x402 pulse"
• Set standing alerts — e.g. "alert me when eth hits $5000", "monitor polymarket X", "watch 0x... for activity"
• Check a wallet's portfolio — "show my portfolio" or paste an address
• Prediction market odds or pulse — e.g. "odds on Bitcoin hitting $100k" or "pm pulse"
• FX, gold, equities — e.g. "USD to EUR", "gold price"
• Look up any tx, ENS name, or address — just paste it

Not live yet: recurring/DCA, limit orders, off-ramp to bank/card.

Just type what you want to do.`;

function buildBridgeAnalysisPrompt(
  intent: ParsedIntent,
  route: { tool: string; outputAmount: string; feesUSD: string | null; gasUSD: string | null; inputUSD: number | null; outputUSD: number | null },
): string {
  // Judge value retention in USD so cross-token swaps (ETH→USDC) are assessed on
  // real dollar value, not the token-count ratio. The model is forbidden below
  // from supplying any price itself — without these figures it would guess one
  // from training data and report a phantom loss.
  const valueKeptPct = route.inputUSD && route.outputUSD && route.inputUSD > 0
    ? (route.outputUSD / route.inputUSD) * 100
    : null;
  const lostPct = valueKeptPct != null ? 100 - valueKeptPct : null;

  // Whether a given spread is good is deterministic — don't delegate it to the
  // 8B Fast model, which treats any non-zero loss as "bad" even with a rubric.
  // Compute the verdict here and have the model only narrate it.
  const verdict = lostPct == null ? null
    : lostPct < 1   ? "This route is efficient. A spread under 1% is normal and good for a swap — recommend executing."
    : lostPct <= 3  ? "This route is reasonable. The cost is acceptable — fine to execute."
    : `This route is expensive: ${lostPct.toFixed(1)}% of value is lost to spread and fees. Suggest the user reconsider or try a smaller or alternative route.`;

  return [
    `Swap: ${intent.amount} ${intent.token} from ${intent.originChain} → ${intent.destinationChain}, receiving ${intent.destinationToken}`,
    `Adapter: ${route.tool}`,
    `Output: ${route.outputAmount} ${intent.destinationToken}`,
    route.inputUSD  != null ? `Input value: $${route.inputUSD.toFixed(2)}` : null,
    route.outputUSD != null ? `Output value: $${route.outputUSD.toFixed(2)}` : null,
    lostPct != null ? `Cost of this route: ${lostPct.toFixed(1)}% of value lost to spread + fees (you keep ${valueKeptPct!.toFixed(1)}%)` : null,
    route.feesUSD ? `Total fees: $${route.feesUSD}` : null,
    route.gasUSD  ? `Gas: $${route.gasUSD}` : null,
    `\nUse ONLY the figures above. Never state or assume any token's USD price beyond what is given — if a value is not listed, do not invent it.`,
    verdict
      ? `Your conclusion is FIXED: "${verdict}" State it plainly in 1-2 short sentences using only the figures above. Do NOT repeat it verbatim, do NOT contradict or reverse it, and do NOT state any percentage other than the one given. Only add an adapter note if it's genuinely useful — otherwise skip it.`
      : `Give a one-sentence directional take: is this route worth executing at these costs? Only mention the adapter if something about it is genuinely worth knowing.`,
  ].filter(Boolean).join("\n");
}

// ── in-memory rate limiter (sliding window, per IP) ──────────────────────────
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT     = 30;     // max 30 requests per minute per IP

const rateMap = new Map<string, number[]>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const hits = (rateMap.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateMap.set(ip, hits);
  return hits.length <= RATE_LIMIT;
}

// ── retry helper ──────────────────────────────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 300): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error("unreachable");
}

// ── shared leg resolver ───────────────────────────────────────────────────────

export type LegOk = {
  ok: true;
  intent: {
    from: { chain: string; chainId: number; token: string; amount: string };
    to:   { chain: string; chainId: number; token: string; receiver: string };
  };
  route: { tool: string; outputAmount: string; feesUSD: string | null; gasUSD: string | null; inputUSD: number | null; outputUSD: number | null; etaSec?: number | null };
  approval: { tokenAddress: string; spender: string; amount: string } | null;
  calldata: { to: string; value: string; data: string } | null;
  raw: unknown;
};

export type LegErr = { ok: false; text: string };

const SOLANA_CHAIN_ID = 1000000001;

// normalizeToken() aliases a generic "btc"/"bitcoin" mention to "WBTC" everywhere,
// which is right on Ethereum/Arbitrum (WBTC is the deep, dominant pool there) but
// wrong on chains where a different BTC wrapper is the liquid, canonical one:
//   Base       — cbBTC has ~100x WBTC's on-chain liquidity (Coinbase built both)
//   BSC        — WBTC isn't listed at all; BTCB is the chain's native wrapped BTC
//   Avalanche  — BTC.b has ~12x WBTC.e's liquidity (the native bridge asset)
// Only applies when the user said BTC generically — an explicit "wbtc" in the
// message is always honored literally, never silently substituted.
const CHAIN_PREFERRED_BTC: Record<number, string> = {
  8453:  "CBBTC",
  56:    "BTCB",
  43114: "BTC.b",
};

function preferredBtcSymbol(symbol: string, chainId: number, explicitWbtc: boolean): string {
  if (explicitWbtc || symbol.toUpperCase() !== "WBTC") return symbol;
  return CHAIN_PREFERRED_BTC[chainId] ?? symbol;
}

export async function resolveLeg(intent: ParsedIntent, senderAddress?: string, slippage?: number, solanaAddress?: string, rawMessage?: string): Promise<LegOk | LegErr> {
  const parsedAmount = parseFloat(intent.amount);
  if (!isFinite(parsedAmount) || parsedAmount <= 0) {
    return { ok: false, text: `Invalid amount "${intent.amount}". Amount must be greater than 0.` };
  }

  const explicitWbtc = /\bwbtc\b/i.test(rawMessage ?? "");

  const originChainId = resolveChainId(intent.originChain);
  const destChainId   = resolveChainId(intent.destinationChain);

  if (!originChainId || !destChainId) {
    const unknown = !originChainId ? intent.originChain : intent.destinationChain;
    return { ok: false, text: `Unknown chain: "${unknown}". Supported: ethereum, base, arbitrum, optimism, polygon, avalanche, bsc, and more.` };
  }

  // Guard: same-chain bridge with the same token is a no-op — Delora will 500.
  // Catches cases where the LLM filled in originChain = destinationChain when only
  // the destination was mentioned (e.g. "bridge 100 USDC to ethereum").
  if (
    originChainId === destChainId &&
    intent.token.toUpperCase() === intent.destinationToken.toUpperCase()
  ) {
    return {
      ok: false,
      text: `Specify your source chain — e.g. "bridge 100 ${intent.token} from base to ${intent.destinationChain}". No bridge is needed if you're already on ${intent.destinationChain}.`,
    };
  }

  // Fetch chain metadata from Delora — gives us native token address, symbol, decimals
  const [originChain, destChain] = await Promise.all([
    getChainById(originChainId),
    getChainById(destChainId),
  ]);

  const originNativeSymbol = originChain?.nativeToken.symbol;
  const destNativeSymbol   = destChain?.nativeToken.symbol;

  // When bridging a native token cross-chain without an explicit destination token,
  // the parser defaults destToken = originToken. Remap to the dest chain's native instead
  // so "bridge 1 SOL from Solana to Ethereum" receives ETH, not wrapped SOL.
  const destToken = (() => {
    const raw = intent.destinationToken;
    if (
      raw === intent.token &&
      originChainId !== destChainId &&
      raw.toUpperCase() === originNativeSymbol?.toUpperCase() &&
      destNativeSymbol &&
      raw.toUpperCase() !== destNativeSymbol.toUpperCase()
    ) return destNativeSymbol;
    return raw;
  })();

  // Native token address and decimals come directly from Delora chain data
  const originNativeAddress = originChain?.nativeToken.address ?? NATIVE_ADDRESS;
  const destNativeAddress   = destChain?.nativeToken.address   ?? NATIVE_ADDRESS;

  let originCurrency = originNativeAddress;
  let destCurrency   = destNativeAddress;
  let originDecimals = originChain?.nativeToken.decimals ?? 18;
  let destDecimals   = destChain?.nativeToken.decimals   ?? 18;

  const isOriginNative = intent.token.toUpperCase() === originNativeSymbol?.toUpperCase();
  const isDestNative   = destToken.toUpperCase()    === destNativeSymbol?.toUpperCase();

  // Display symbols shown to the user — start as the parsed symbol, updated below
  // if a chain-preferred BTC substitute (cbBTC/BTCB/BTC.b) actually resolved, so
  // the card never shows "WBTC" while the calldata routes to a different token.
  let originDisplaySymbol = intent.token;
  let destDisplaySymbol   = destToken;

  // For EVM native tokens Delora expects the token contract address, not the zero address
  if (isOriginNative && originChain?.chainType === "EVM") {
    const tokenData = await getToken(originChainId, originNativeSymbol ?? intent.token);
    if (!tokenData) return { ok: false, text: `${intent.token} on ${originChain?.name ?? originChainId} is not yet supported. Try an EVM-to-EVM route instead.` };
    originCurrency = tokenData.address;
    originDecimals = tokenData.decimals;
  }

  if (isDestNative && destChain?.chainType === "EVM") {
    const tokenData = await getToken(destChainId, destNativeSymbol ?? destToken);
    if (!tokenData) return { ok: false, text: `${destToken} on ${destChain?.name ?? destChainId} is not yet supported as a destination.` };
    destCurrency = tokenData.address;
    destDecimals = tokenData.decimals;
  }

  if (!isOriginNative) {
    const originSymbol = preferredBtcSymbol(intent.token, originChainId, explicitWbtc);
    let tokenData = await getToken(originChainId, originSymbol);
    if (tokenData && originSymbol !== intent.token) originDisplaySymbol = originSymbol;
    // ETH on non-ETH chains (Polygon, BSC, etc.) is listed as WETH — fall back transparently
    if (!tokenData && intent.token.toUpperCase() === "ETH" && originNativeSymbol?.toUpperCase() !== "ETH") {
      tokenData = await getToken(originChainId, "WETH");
    }
    // Preferred BTC substitute not found for some reason — fall back to the literal symbol
    if (!tokenData && originSymbol !== intent.token) {
      tokenData = await getToken(originChainId, intent.token);
      originDisplaySymbol = intent.token;
    }
    if (!tokenData) return { ok: false, text: `Could not find ${intent.token} on ${originChain?.name ?? originChainId}.` };
    originCurrency = tokenData.address;
    originDecimals = tokenData.decimals;
  }

  if (!isDestNative) {
    const destSymbol = preferredBtcSymbol(destToken, destChainId, explicitWbtc);
    let tokenData = await getToken(destChainId, destSymbol);
    if (tokenData && destSymbol !== destToken) destDisplaySymbol = destSymbol;
    // ETH on non-ETH chains — same fallback as origin
    if (!tokenData && destToken.toUpperCase() === "ETH" && destNativeSymbol?.toUpperCase() !== "ETH") {
      tokenData = await getToken(destChainId, "WETH");
    }
    // Preferred BTC substitute not found for some reason — fall back to the literal symbol
    if (!tokenData && destSymbol !== destToken) {
      tokenData = await getToken(destChainId, destToken);
      destDisplaySymbol = destToken;
    }
    if (!tokenData) return { ok: false, text: `Could not find ${destToken} on ${destChain?.name ?? destChainId}.` };
    destCurrency = tokenData.address;
    destDecimals = tokenData.decimals;
  }

  const amountWei = toWei(intent.amount, originDecimals);

  if (!senderAddress || !senderAddress.startsWith("0x")) {
    return { ok: false, text: "Invalid or missing wallet. Reconnect your wallet." };
  }

  const isSolanaOrigin = originChainId === SOLANA_CHAIN_ID;
  const isSolanaDest   = destChainId   === SOLANA_CHAIN_ID;

  const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  // EVM → Solana: a Solana receive address is needed — Phantom provides it,
  // or the user can paste their address inline (handled by the POST handler).
  if (isSolanaDest && (!solanaAddress || !SOLANA_PUBKEY_RE.test(solanaAddress))) {
    return {
      ok: false,
      text: "I need a Solana address to send the funds to. Connect your Phantom wallet, or include your Solana address in the message — e.g. \"bridge 2 ETH from base to solana YOUR_SOLANA_ADDRESS\".",
    };
  }

  // Solana → EVM: Phantom must be connected to sign the Solana transaction.
  if (isSolanaOrigin && (!solanaAddress || !SOLANA_PUBKEY_RE.test(solanaAddress))) {
    return {
      ok: false,
      text: "Connect your Phantom wallet to sign the transaction from Solana.",
    };
  }

  const effectiveSender   = isSolanaOrigin ? (solanaAddress ?? senderAddress) : senderAddress;
  const effectiveReceiver = isSolanaDest   ? (solanaAddress ?? senderAddress) : senderAddress;

  let quote;
  try {
    quote = await withRetry(() => getQuote({
      originChainId,
      destinationChainId: destChainId,
      amount: amountWei,
      originCurrency,
      destinationCurrency: destCurrency,
      senderAddress: effectiveSender,
      receiverAddress: effectiveReceiver,
      slippage,
    }));
  } catch (err) {
    console.error(`[resolveLeg] getQuote failed: ${err instanceof Error ? err.message : err}`);
    const msg        = err instanceof Error ? err.message : "Unknown error";
    const noAdapters = msg.includes("No adapters available");
    const isSolana   = originChain?.chainType === "SVM" || destChain?.chainType === "SVM";
    return {
      ok: false,
      text: noAdapters
        ? isSolana
          ? `No route found for ${intent.amount} ${intent.token} on Solana. Solana cross-chain routes require Mayan bridge — try a larger amount (≥0.1 SOL) or check back as liquidity improves.`
          : `No route found for ${intent.amount} ${intent.token} — try a smaller amount. Minimum is roughly 0.001 ETH or $1 worth.`
        : `Could not get a quote: ${msg}`,
    };
  }

  // Simulation guard: Delora simulates the route before returning it. Only a
  // definitive REVERTED means it will fail on-chain — don't hand the user a
  // transaction that's guaranteed to burn gas. UNVERIFIABLE / SKIPPED (e.g. a
  // sim provider disabled) are not failures, so they pass through.
  if (quote.simulation?.executionStatus === "REVERTED") {
    const adapter = quote.adapter ?? "the best available route";
    console.warn(`[resolveLeg] route ${adapter} simulated REVERTED: ${quote.simulation.reason ?? "no reason given"}`);
    return {
      ok: false,
      text: `This route (${adapter}) fails Delora's on-chain simulation and would revert — executing it would only burn gas, so Skopos won't hand it to you. Try a different amount or token pair, or check back as routing liquidity shifts.`,
    };
  }

  const outputFormatted = quote.outputAmount
    ? (Number(quote.outputAmount) / 10 ** destDecimals).toFixed(6)
    : "unknown";

  const tool         = quote.adapter ?? "best route";
  const feeBreakdown = quote.fees?.breakdown ?? [];
  const gasFee       = feeBreakdown.find((f) => f.type === "gas");
  const totalFeesUSD = quote.fees?.totalUsd ?? null;
  const gasUSD       = gasFee?.amountUsd ?? null;

  const originPriceUSD = parseFloat(quote.usd?.originCurrency?.priceUSD ?? "");
  const destPriceUSD   = parseFloat(quote.usd?.destinationCurrency?.priceUSD ?? "");
  const inputUSD  = Number.isFinite(originPriceUSD) ? parseFloat(intent.amount) * originPriceUSD : null;
  const outputUSD = Number.isFinite(destPriceUSD) && outputFormatted !== "unknown"
    ? parseFloat(outputFormatted) * destPriceUSD
    : null;

  return {
    ok: true,
    intent: {
      from: { chain: originChain?.name ?? String(originChainId), chainId: originChainId, token: originDisplaySymbol, amount: intent.amount },
      to:   { chain: destChain?.name   ?? String(destChainId),   chainId: destChainId,   token: destDisplaySymbol, receiver: effectiveReceiver },
    },
    route:    { tool, outputAmount: outputFormatted, feesUSD: totalFeesUSD, gasUSD, inputUSD, outputUSD, etaSec: quote.estimatedTimeSec ?? null },
    approval: isOriginNative ? null : {
      tokenAddress: originCurrency,
      spender:      quote.calldata?.to ?? "",
      amount:       amountWei,
    },
    calldata: quote.calldata ?? null,
    raw:      quote,
  };
}

// ── POST handler ──────────────────────────────────────────────────────────────

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { ...init, headers: { ...NO_CACHE, ...(init?.headers ?? {}) } });
}

// ENS name (*.eth) — character class must NOT include "." or the greedy * eats ".eth".
// An exact ENS format is unambiguous and must beat the fuzzy price classifier, which
// otherwise reads the "eth" in "vitalik.eth" as a token and hijacks it to the price path.
const ENS_RE = /\b([a-z0-9][a-z0-9-]*)\.eth\b/i;

// Bareword false-positives to reject when a query names no $ticker/address — so
// "where is it going" doesn't resolve "IT" as a token.
const INTEL_STOP = new Set([
  "OF", "THE", "IS", "A", "AN", "MY", "THIS", "THAT", "IT", "ARE", "IN", "ON", "TOP",
  "BIGGEST", "MOST", "FOR", "ABOUT", "WITH", "INTO", "UP", "MORE", "NOW", "TODAY",
  "AND", "TO", "GOING", "HEADING", "FLOWING", "MOVING", "PRESSURE", "SELL", "BUY",
  "WHAT", "WHERE", "SMART", "MONEY", "EXCHANGE", "CEX", "FLOW", "FLOWS",
]);

// Public entry. Peeks `format` from a cloned body (leaving the real body untouched
// for handleChat), then for format:"text" projects the returned card to plain text
// for headless clients. Browser (format omitted/"card") path is byte-for-byte
// unchanged — it never enters the projection branch.
export async function POST(req: NextRequest): Promise<NextResponse> {
  let format = "card";
  let anonId: string | undefined;
  let senderAddress: string | undefined;
  let message: string | undefined;
  let sparkline: boolean | undefined;
  try {
    const peek = await req.clone().json();
    if (peek?.format === "text") format = "text";
    if (typeof peek?.anonId === "string") anonId = peek.anonId;
    if (typeof peek?.senderAddress === "string") senderAddress = peek.senderAddress;
    if (typeof peek?.message === "string") message = peek.message;
    if (typeof peek?.sparkline === "boolean") sparkline = peek.sparkline;
  } catch {
    // malformed body — let handleChat produce the canonical error response
  }

  const res = await handleChat(req);
  if (format !== "text") return res;

  let card: unknown;
  try {
    card = await res.clone().json();
  } catch {
    return res;
  }
  const type = card && typeof card === "object" && "type" in card ? String((card as { type: unknown }).type) : "text";
  const text = await cardToText(card, { anonId, senderAddress, sparkline });
  const link = executeLinkFor(card, message);
  const image = chartImageFor(card);
  return json({ type, text, ...(link ? { link } : {}), ...(image ? { image } : {}) }, { status: res.status });
}

// /api/chat is POST-only. A browser click sends GET — instead of a bare error,
// serve a small on-brand teapot with the curl that actually works. 418, obviously.
export function GET(): NextResponse {
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>skopos api · 418</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:grid;place-items:center;background:#000;color:#e8e8e8;font-family:'JetBrains Mono',ui-monospace,monospace;padding:24px;background-image:radial-gradient(60% 50% at 72% -10%,rgba(245,184,0,.16),transparent 70%)}
.term{width:100%;max-width:660px;background:#0c0c0c;border:1px solid rgba(255,255,255,.1);border-radius:16px;overflow:hidden;box-shadow:0 30px 90px -30px #000}
.bar{display:flex;gap:8px;align-items:center;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.07)}
.bar i{width:11px;height:11px;border-radius:50%;display:inline-block}
.r{background:#ff5f57}.y{background:#F5B800}.g{background:#28c840}
.bar b{margin-left:auto;color:rgba(255,255,255,.5);letter-spacing:.14em;font-size:13px;font-weight:700}
.bar b span{color:#F5B800}
.body{padding:22px;font-size:14px;line-height:1.7}
.p{color:#F5B800}.dim{color:rgba(255,255,255,.45)}
p{margin:14px 0}
pre{margin:14px 0;padding:14px;background:rgba(245,184,0,.05);border:1px solid rgba(245,184,0,.16);border-radius:10px;white-space:pre-wrap;word-break:break-word;font-size:12.5px;color:#fff}
a{color:#F5B800;text-decoration:none}
</style></head><body>
<div class="term">
  <div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><b>&#10022; <span>skopos</span></b></div>
  <div class="body">
    <div><span class="p">&gt;</span> GET /api/chat</div>
    <div class="dim">418 &mdash; i'm a teapot &#129380; (well, a POST-only api)</div>
    <p>you can't read the smart money by staring at a url. this endpoint only speaks POST. talk to it:</p>
<pre>curl -sX POST https://www.tryskopos.xyz/api/chat \\
  -H 'content-type: application/json' \\
  -d '{"message":"who is buying $pepe","format":"text"}'</pre>
    <div class="dim">&rarr; named wallets, in plain text.</div>
    <p class="dim" style="margin-top:16px">built for bots, agents &amp; blue bubbles.<br>say it, it executes &middot; <a href="https://www.tryskopos.xyz">tryskopos.xyz</a></p>
  </div>
</div>
</body></html>`;
  return new NextResponse(html, {
    status: 418,
    headers: { "content-type": "text/html; charset=utf-8", "x-skopos": "say it, it executes", ...NO_CACHE },
  });
}

async function handleChat(req: NextRequest): Promise<NextResponse> {
  // CORS — only allow requests from the production origin and localhost dev
  const origin = req.headers.get("origin") ?? "";
  const allowedOrigins = new Set(["https://www.tryskopos.xyz", "https://tryskopos.xyz"]);
  const corsOrigin = allowedOrigins.has(origin) ? origin : (origin.startsWith("http://localhost") ? origin : null);
  const corsHeaders: Record<string, string> = corsOrigin
    ? { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin" }
    : {};

  // Body size guard — reject before parsing to avoid memory pressure from large payloads
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > 64_000) {
    return json({ type: "error", text: "Request too large." }, { status: 413 });
  }

  // Use the rightmost trusted IP from x-forwarded-for to prevent header spoofing
  const forwardedFor = req.headers.get("x-forwarded-for") ?? "";
  const ips = forwardedFor.split(",").map(s => s.trim()).filter(Boolean);
  const ip = ips[ips.length - 1] ?? req.headers.get("x-real-ip") ?? "unknown";
  if (!checkRateLimit(ip)) {
    return json({ type: "error", text: "Too many requests — slow down and try again in a minute." }, { status: 429, headers: corsHeaders });
  }

  const { message, senderAddress, solanaAddress: rawSolanaAddress, history, slippage, llmTier, anonId, format } = await req.json();
  const textMode = format === "text";

  // Fast (Groq) vs Smart (Bankr gateway). Default fast → behaviour unchanged.
  const tier: LlmTier = llmTier === "smart" ? "smart" : "fast";

  if (!message?.trim()) {
    return json({ error: "No message provided" }, { status: 400, headers: corsHeaders });
  }

  // Smart-quote normalization — iOS/macOS autocorrect turns a typed "'" into a
  // curly ’ (U+2019), which every apostrophe-tolerant trigger regex below
  // (what's trending, what's the narrative, how's defi, etc.) only matches as
  // a literal straight quote. Without this, those messages fall through all
  // the way to the generic Groq fallback instead of hitting their real card.
  const trimmed = message.trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

  // Length check runs before any regex to prevent adversarial ReDoS inputs
  if (trimmed.length > 2000) {
    return json({ type: "error", text: "Message too long." }, { status: 400, headers: corsHeaders });
  }

  // ── Smart-tier metering gate (Fast is always free + anonymous, never gated) ──
  // Wallet users get the free daily cap; anon users get a small teaser keyed by a
  // client-generated id, then a connect paywall. Read-only here: the counter only
  // increments after a Smart reply genuinely serves (recordSmart, below), so a
  // structural card or a gateway fallback to Fast never burns a count.
  // An active subscription bypasses the counter entirely (uncapped Smart): when
  // entitled we leave smartKey null so recordSmart() never increments. Only
  // non-subscribed wallets (and anon teaser users) hit the daily-cap path.
  let smartKey: string | null = null;
  if (tier === "smart" && !(await isEntitled(senderAddress))) {
    const holderCap = await resolveHolderCap(senderAddress);
    const quota = await checkSmartQuota({ wallet: senderAddress, anonId }, holderCap);
    if (!quota.allowed) {
      return json({ type: "paywall", reason: quota.reason, used: quota.used, cap: quota.cap }, { headers: corsHeaders });
    }
    smartKey = quota.key;
  }
  const meterMeta: LlmMeta = {};
  const recordSmart = async () => {
    if (smartKey && meterMeta.servedBy === "smart") {
      await incrSmart(smartKey);
      meterMeta.servedBy = undefined;
    }
  };

  // If Phantom isn't connected, the user can paste their Solana address inline.
  // Extract it so EVM→Solana bridges can proceed without Phantom.
  const SOLANA_INLINE_RE = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/;
  const inlineSolanaAddr  = !rawSolanaAddress ? trimmed.match(SOLANA_INLINE_RE)?.[1] : undefined;
  const solanaAddress     = rawSolanaAddress ?? inlineSolanaAddr;

  const rawSlip = typeof slippage === "number" ? slippage : parseFloat(String(slippage ?? ""));
  const safeSlippage = Number.isFinite(rawSlip) && rawSlip >= 0 && rawSlip <= 0.1 ? rawSlip : 0.005;

  const queryType = classifyIntent(trimmed);
  console.log(`[chat] ip=${ip} type=${queryType} len=${trimmed.length}`);

  // ── Embedded URL → x402 check, or free web-context intel card (Jina Reader) ─
  // A URL is the strongest structural signal, so this runs before the price /
  // intent fast-paths — otherwise a link containing a token-name substring
  // (e.g. docs.uniswap.org) gets hijacked into a price card. Distinct surface,
  // not merged into other cards. Falls through on failure so the message still
  // gets a normal answer.
  //
  // "check/call/query/hit <url>" tries x402 discovery FIRST (lib/x402Discover.ts
  // — free probe only, SSRF-guarded: no private/internal addresses, no redirects
  // followed). Genuinely paid endpoints are the whole point of this verb — the
  // reader below would only ever show their raw 402 JSON body as page text,
  // never the actual price. If discovery finds nothing paid there (a normal
  // page, or an address explicitly blocked for safety), it falls through to the
  // same free reader every other embedded URL gets — "check <url>" on an
  // ordinary article must keep behaving exactly as it did before this existed.
  // The paid call itself always happens client-side with the USER'S OWN wallet
  // (lib/x402GenericClient.ts, X402CheckDisplay) — never Skopos's agent wallet,
  // since an arbitrary user-named endpoint isn't something Skopos vetted.
  const intelUrl = extractUrl(trimmed);
  // https only, matching discoverX402Endpoint's own scheme requirement — a
  // "check http://..." page is never an x402 challenge, so don't even try;
  // let it fall straight through to the free reader like it always did.
  if (intelUrl?.startsWith("https://") && /\b(?:check|call|query|hit)\s+https:\/\//i.test(trimmed)) {
    const discovery = await discoverX402Endpoint(intelUrl);
    if (discovery.ok || /private or internal address/.test(discovery.error ?? "")) {
      return json({ type: "x402check", url: intelUrl, method: "GET", discovery });
    }
  }
  if (intelUrl) {
    const context = await fetchWebContext(intelUrl);
    if (context) {
      return json({ type: "intel", context });
    }
  }

  // ── Aeon narrative read — "what's the narrative / what's hot today". Served
  // from the self-hosted Aeon fork's cache (lib/aeonFeed.ts) — no Bankr Agent
  // dependency. Market-wide by nature: if the query names a token ($ticker /
  // 0x address), let the token-scoped Nansen intel blocks below win instead.
  if (
    !/\$[a-zA-Z]|\b0x[0-9a-fA-F]{40}\b/.test(trimmed) &&
    /\bnarrative(?:s)?\b|\bwhat(?:'?s|s| is)?\s+hot\b|\bnarrative\s+map\b/i.test(trimmed)
  ) {
    return json({
      type: "aeon",
      kind: "narrative",
      title: "Today's narratives",
      subtitle: "What's hot in crypto and AI right now — with a front-run / ride / fade / skip call per narrative.",
      premium: { available: true, label: "Get the read", note: "Free · powered by Aeon" },
    });
  }

  // ── Aeon DeFi read — "defi read today / market regime / risk on or off".
  // Market-wide; same token guard so a token query goes to Nansen intel instead.
  if (
    !/\$[a-zA-Z]|\b0x[0-9a-fA-F]{40}\b/.test(trimmed) &&
    /\bdefi\s+(?:read|overview|regime|today|market)\b|\bmarket\s+regime\b|\brisk[\s-]?(?:on|off)\b|\bhow'?s\s+defi\b/i.test(trimmed)
  ) {
    return json({
      type: "aeon",
      kind: "defi",
      title: "Today's DeFi read",
      subtitle: "Risk-on or risk-off, the top movers, and where yield is real vs just emissions.",
      premium: { available: true, label: "Get the read", note: "Free · powered by Aeon" },
    });
  }

  // ── Aeon Trending read — "what's trending" (CoinGecko). Free: harvested from the
  // same market-context.md the DeFi cron already commits. Token guard so a token
  // query routes to Nansen intel. Narrower than the smart-money screener's
  // "trending tokens/coins/plays", which stays token-discovery.
  if (
    !/\$[a-zA-Z]|\b0x[0-9a-fA-F]{40}\b/.test(trimmed) &&
    /\bwhat(?:'?s|s| is)?\s+trending\b|\btrending\s+(?:on\s+)?coingecko\b|\bcoingecko\s+trending\b/i.test(trimmed)
  ) {
    return json({
      type: "aeon",
      kind: "trending",
      title: "What's trending",
      subtitle: "The coins climbing CoinGecko right now, with why each is moving.",
      premium: { available: true, label: "Get the read", note: "Free · powered by Aeon" },
    });
  }

  // ── Aeon Top-protocols read — "top defi protocols / biggest TVL". Free: same
  // market-context.md source. Token guard as above.
  if (
    !/\$[a-zA-Z]|\b0x[0-9a-fA-F]{40}\b/.test(trimmed) &&
    /\btop\s+(?:defi\s+)?protocols?\b|\bbiggest\s+(?:defi\s+)?protocols?\b|\bwhere(?:'?s|s| is)?\s+(?:the\s+)?tvl\b|\b(?:biggest|highest|most)\s+tvl\b|\btvl\s+(?:leaders?|rankings?|leaderboard)\b/i.test(trimmed)
  ) {
    return json({
      type: "aeon",
      kind: "protocols",
      title: "Top DeFi protocols",
      subtitle: "The biggest protocols by TVL and how they moved this week.",
      premium: { available: true, label: "Get the read", note: "Free · powered by Aeon" },
    });
  }

  // ── Aeon Fear-divergence read — conditional (only screens when Fear & Greed
  // < 25); a clean "nothing to screen today" is a legitimate answer, not a miss.
  if (
    !/\$[a-zA-Z]|\b0x[0-9a-fA-F]{40}\b/.test(trimmed) &&
    /\bfear\s*(?:&|and)?\s*greed\s+diverg\w*\b|\bfear\s+diverg\w*\b|\bdiverg\w*\s+(?:from|despite)\s+(?:the\s+)?fear\b/i.test(trimmed)
  ) {
    return json({
      type: "aeon",
      kind: "fear",
      title: "Fear divergence",
      subtitle: "Assets holding up while the market's in Fear & Greed — or an honest 'nothing today.'",
      premium: { available: true, label: "Get the read", note: "Free · powered by Aeon" },
    });
  }

  // ── Aeon x402 monitor — weekly protocol/ecosystem velocity tracker.
  if (
    !/\$[a-zA-Z]|\b0x[0-9a-fA-F]{40}\b/.test(trimmed) &&
    /\bx402\s+(?:monitor|pulse|ecosystem|adoption|update|tracker)\b|\bwhat'?s?\s+(?:new|happening)\s+(?:with\s+)?x402\b/i.test(trimmed)
  ) {
    return json({
      type: "aeon",
      kind: "x402",
      title: "x402 pulse",
      subtitle: "New integrations, npm downloads, and adoption signals in the x402 ecosystem.",
      premium: { available: true, label: "Get the read", note: "Free · powered by Aeon" },
    });
  }

  // ── Smart-money screener — discovery, no token. "what is smart money buying".
  if (/\bwhat(?:'s|s| is| are)?\s+(?:the\s+)?smart\s+money\s+(?:buying|accumulating|aping|into|loading|grabbing)\b|\bsmart\s+money\s+screener\b|\btrending\s+(?:smart\s+money\s+)?(?:tokens?|coins?|plays?)\b|\bwhat\s+should\s+i\s+(?:buy|ape|look\s+at)\b/i.test(trimmed)) {
    const CHAIN_ALIAS: Record<string, string> = { eth: "ethereum", ethereum: "ethereum", base: "base", solana: "solana", sol: "solana", arbitrum: "arbitrum", arb: "arbitrum", polygon: "polygon", matic: "polygon" };
    const chainWord = trimmed.match(/\bon\s+(ethereum|eth|base|solana|sol|arbitrum|arb|polygon|matic)\b/i)?.[1]?.toLowerCase() ?? null;
    const agentPaid = agentPaidEnabled();
    const label = "Show what smart money's buying";
    return json({
      type: "intel",
      read: "screener",
      timeframe: parseTimeframe(trimmed),
      screenChain: chainWord ? CHAIN_ALIAS[chainWord] : null,
      premium: agentPaid
        ? { available: true, mode: "agent", label, price: "Reveal", note: "Free — Skopos covers the data fee · smart-money screener via Nansen" }
        : { available: false, mode: "agent", label, price: "Reveal", note: "Live screener is rolling out — check back soon." },
    });
  }

  // ── Flow intelligence — where a token is moving (exchanges vs wallet segments).
  if (/\b(?:exchange|cex)\s+(?:in|out)?flows?\b|\b(?:cex|exchange)\s+(?:deposits?|withdrawals?)\b|\bwhere\s+is\s+\$?[a-zA-Z0-9]+\s+(?:flowing|going|heading|moving)\b|\bsell\s+pressure\b|\bflow\s+intel(?:ligence)?\b/i.test(trimmed)) {
    const address = trimmed.match(/\b(0x[0-9a-fA-F]{40})\b/)?.[1] ?? null;
    let symbol = trimmed.match(/\$([a-zA-Z][a-zA-Z0-9]{1,14})\b/)?.[1]?.toUpperCase() ?? null;
    if (!symbol && !address) {
      const bw = (
        trimmed.match(/\bwhere\s+is\s+([a-zA-Z][a-zA-Z0-9]{1,14})\b/i)?.[1]
        ?? trimmed.match(/\b(?:pressure|flows?|intel(?:ligence)?)\s+(?:on|for|of)\s+([a-zA-Z][a-zA-Z0-9]{1,14})\b/i)?.[1]
      )?.toUpperCase();
      if (bw && !INTEL_STOP.has(bw)) symbol = bw;
    }
    if (address || symbol) {
      const target = await resolveTokenTarget(address ?? symbol!);
      const nansenChain = target ? toNansenChain(target.chainId) : null;
      const canPay = !!(target && nansenChain);
      const agentPaid = agentPaidEnabled();
      const label = "Break down the flows";
      return json({
        type: "intel",
        read: "flow-intel",
        timeframe: parseTimeframe(trimmed),
        token: { symbol: target?.symbol ?? symbol, address: target?.address ?? address, chain: nansenChain },
        premium:
          canPay && agentPaid
            ? { available: true, mode: "agent", label, price: "Reveal", note: "Free — Skopos covers the data fee · exchange & wallet flows via Nansen" }
            : { available: false, mode: "agent", label, price: "Reveal", note: canPay ? "Rolling out — check back soon." : "Not available for this token yet." },
      });
    }
  }

  // ── Smart-money flows — accumulation trend over time for a $ticker or contract.
  if (/\bflows?\b|\bflow\s+trend\b|\baccumulation\s+trend\b|\baccumulating\s+over\s+time\b/i.test(trimmed)) {
    const address = trimmed.match(/\b(0x[0-9a-fA-F]{40})\b/)?.[1] ?? null;
    let symbol = trimmed.match(/\$([a-zA-Z][a-zA-Z0-9]{1,14})\b/)?.[1]?.toUpperCase() ?? null;
    if (!symbol && !address) {
      const bw = (
        trimmed.match(/\b([a-zA-Z][a-zA-Z0-9]{1,14})\s+flows?\b/i)?.[1]
        ?? trimmed.match(/\bflows?\s+(?:on|for|of)\s+([a-zA-Z][a-zA-Z0-9]{1,14})\b/i)?.[1]
      )?.toUpperCase();
      if (bw && !INTEL_STOP.has(bw)) symbol = bw;
    }
    if (address || symbol) {
      const target = await resolveTokenTarget(address ?? symbol!);
      const nansenChain = target ? toNansenChain(target.chainId) : null;
      const canPay = !!(target && nansenChain);
      const agentPaid = agentPaidEnabled();
      const label = "Show the accumulation trend";
      return json({
        type: "intel",
        read: "flows",
        timeframe: parseTimeframe(trimmed),
        token: { symbol: target?.symbol ?? symbol, address: target?.address ?? address, chain: nansenChain },
        premium:
          canPay && agentPaid
            ? { available: true, mode: "agent", label, price: "Reveal", note: "Free — Skopos covers the data fee · smart-money flow trend via Nansen" }
            : { available: false, mode: "agent", label, price: "Reveal", note: canPay ? "Rolling out — check back soon." : "Not available for this token yet." },
      });
    }
  }

  // ── Token holders — "who holds / top holders of" a $ticker or contract.
  // Agent-paid tgm/holders read: top holders, % supply, recent balance change.
  if (/\bholders?\b|\bwho\s+(?:holds|owns)\b|\bholder\s+concentration\b/i.test(trimmed)) {
    const HSTOP = new Set(["OF", "THE", "IS", "A", "AN", "MY", "THIS", "THAT", "IT", "ARE", "IN", "ON", "TOP", "BIGGEST", "MOST"]);
    const address = trimmed.match(/\b(0x[0-9a-fA-F]{40})\b/)?.[1] ?? null;
    let symbol = trimmed.match(/\$([a-zA-Z][a-zA-Z0-9]{1,14})\b/)?.[1]?.toUpperCase() ?? null;
    if (!symbol && !address) {
      const bareword = (
        trimmed.match(/\bholders?\s+(?:of|for)\s+([a-zA-Z][a-zA-Z0-9]{1,14})\b/i)?.[1]
        ?? trimmed.match(/\bwho\s+(?:holds|owns)\s+([a-zA-Z][a-zA-Z0-9]{1,14})\b/i)?.[1]
        ?? trimmed.match(/\b([a-zA-Z][a-zA-Z0-9]{1,14})\s+holders?\b/i)?.[1]
      )?.toUpperCase();
      if (bareword && !HSTOP.has(bareword)) symbol = bareword;
    }
    if (address || symbol) {
      const target = await resolveTokenTarget(address ?? symbol!);
      const nansenChain = target ? toNansenChain(target.chainId) : null;
      const canPay = !!(target && nansenChain);
      // Holders runs only on the agent-paid rail for now (no user-signed fallback
      // wired), so offer the button only when Skopos can front the fee.
      const agentPaid = agentPaidEnabled();
      const label = "Show top holders";
      return json({
        type: "intel",
        read: "holders",
        token: {
          symbol: target?.symbol ?? symbol,
          address: target?.address ?? address,
          chain: nansenChain,
        },
        premium:
          canPay && agentPaid
            ? {
                available: true,
                mode: "agent",
                label,
                price: "Reveal",
                note: "Free — Skopos covers the data fee · holder distribution via Nansen",
              }
            : {
                available: false,
                mode: "agent",
                label,
                price: "Reveal",
                note: canPay ? "Live holder data is rolling out — check back soon." : "Not available for this token yet.",
              },
      });
    }
  }

  // ── Token intel — explicit "smart money" / "intel on" a $ticker or contract.
  // Gated on the intel keyword so it never swallows normal price or risk-scan
  // queries. Gives the smart-money read (paid, user-signed x402) a token target.
  if (/\b(smart[\s-]?money|intel)\b|\bwho(?:'s|s| is| has| have)?\s+(?:been\s+)?(?:buying|bought|selling|sold|accumulating|accumulated|dumping|dumped|aping|loading)\b/i.test(trimmed)) {
    const STOP = new Set(["ON", "FOR", "READ", "ABOUT", "THE", "OF", "IS", "A", "AN", "DOING", "WITH", "INTO", "UP", "MORE", "MY", "THIS", "THAT", "IT", "NOW", "TODAY", "BEEN"]);
    const address = trimmed.match(/\b(0x[0-9a-fA-F]{40})\b/)?.[1] ?? null;
    let symbol = trimmed.match(/\$([a-zA-Z][a-zA-Z0-9]{1,14})\b/)?.[1]?.toUpperCase() ?? null;
    if (!symbol && !address) {
      const bareword = (
        trimmed.match(/\b(?:smart[\s-]?money|intel)(?:\s+(?:on|for|read|about))?\s+([a-zA-Z][a-zA-Z0-9]{1,14})\b/i)?.[1]
        ?? trimmed.match(/\b(?:buying|bought|selling|sold|accumulating|accumulated|dumping|dumped|aping|loading(?:\s+up)?(?:\s+on)?)\s+(?:into\s+|on\s+)?([a-zA-Z][a-zA-Z0-9]{1,14})\b/i)?.[1]
      )?.toUpperCase();
      if (bareword && !STOP.has(bareword)) symbol = bareword;
    }
    if (address || symbol) {
      // Resolve the bare symbol/address into a concrete chain + contract so the
      // paid Token God Mode read has a valid target. Only offer the paid button
      // when the token resolves to a Nansen-supported chain — otherwise the user
      // would pay and Nansen would reject the chain with a 422.
      const target = await resolveTokenTarget(address ?? symbol!);
      const nansenChain = target ? toNansenChain(target.chainId) : null;
      const canPay = !!(target && nansenChain);
      // Agent-paid mode: Skopos's wallet fronts the x402 fee, so the user pays
      // nothing and never touches a wallet. Falls back to the user-signed $0.01
      // path when SKOPOS_X402_PRIVATE_KEY is unset.
      const agentPaid = agentPaidEnabled();
      const mode = agentPaid ? "agent" : "user";
      const label = "See who's buying & selling";
      // who-bought-sold defaults to the BUY side; flip to SELL when the user asked
      // about selling/dumping/exiting so the read matches the question.
      const direction: "BUY" | "SELL" =
        /\b(sell|selling|sold|dump|dumping|dumped|exit|exiting|offload|offloading|unload|unloading)\b/i.test(trimmed)
          ? "SELL"
          : "BUY";
      return json({
        type: "intel",
        read: "smart-money",
        direction,
        timeframe: parseTimeframe(trimmed),
        token: {
          symbol: target?.symbol ?? symbol,
          address: target?.address ?? address,
          chain: nansenChain,
        },
        premium: canPay
          ? {
              available: true,
              mode,
              label,
              price: agentPaid ? "Reveal" : "$0.01",
              note: agentPaid
                ? "Free — Skopos covers the data fee · live smart-money flows via Nansen"
                : "$0.01 from your wallet pulls live smart-money flows · Nansen",
            }
          : { available: false, mode, label, price: agentPaid ? "Reveal" : "$0.01", note: "Not available for this token yet." },
      });
    }
  }

  // ── Guided buy/sell — must run BEFORE the price fast-path ──────────────────
  // Price card buttons emit "buy MEGA on base" / "sell MEGA on megaeth".
  // classifyIntent sees the token name and returns "price", so without this
  // early check the message would loop back into a price card.
  const CHAIN_NATIVE: Record<string, string> = {
    ethereum: "ETH",  base: "ETH",   arbitrum: "ETH",   optimism: "ETH",
    linea:    "ETH",  scroll: "ETH", blast: "ETH",      mode: "ETH",  megaeth: "ETH",
    polygon:  "POL",  bsc: "BNB",   avalanche: "AVAX",  mantle: "MNT",
    solana:   "SOL",  berachain: "BERA", cronos: "CRO", hyperevm: "HYPE",
  };
  const TRADE_SYMBOL_CHAIN: Record<string, string> = {
    MEGAETH: "megaeth", MEGA: "megaeth",
    SOL: "solana",      MATIC: "polygon", POL: "polygon",
    AVAX: "avalanche",  BNB: "bsc",       MNT: "mantle",
    BERA: "berachain",  CRO: "cronos",    HYPE: "hyperevm",
  };
  const guidedBuyMatch  = trimmed.match(/^buy\s+([a-z0-9]+)(?:\s+on\s+([a-z][a-z0-9\s]*))?$/i);
  const guidedSellMatch = !guidedBuyMatch && trimmed.match(/^sell\s+([a-z0-9]+)(?:\s+on\s+([a-z][a-z0-9\s]*))?$/i);
  if (guidedBuyMatch || guidedSellMatch) {
    const isBuy = !!guidedBuyMatch;
    const [, rawSymbol, rawChain] = (guidedBuyMatch ?? guidedSellMatch)!;
    const symbol = rawSymbol.toUpperCase();
    const chain  = rawChain?.trim().toLowerCase();
    if (isBuy) {
      const sourceChain = chain ?? "ethereum";
      const sourceToken = CHAIN_NATIVE[sourceChain] ?? "ETH";
      return json({
        type: "text",
        text: `How much ${sourceToken} from ${sourceChain} would you like to spend on ${symbol}? Type an amount — e.g. "swap 0.5 ${sourceToken} from ${sourceChain} to ${symbol}"`,
      });
    } else {
      const sourceChain = chain ?? TRADE_SYMBOL_CHAIN[symbol] ?? "ethereum";
      return json({
        type: "text",
        text: `How much ${symbol} from ${sourceChain} would you like to sell, and for which token? Type it — e.g. "swap 0.5 ${symbol} from ${sourceChain} to USDC" or "swap 0.5 ${symbol} from ${sourceChain} to ETH"`,
      });
    }
  }

  // ── Token deep-dive — "deep dive on $X" / "$X deep dive". Must run before the
  // price fast-path: classifyIntent has no "deep dive" signal, so a bare mention
  // of a known token (pepe, eth, doge…) classifies as "price" via its last-resort
  // fallback and would otherwise never reach a deep-dive check. Reuses the same
  // grounded scan (price/liquidity/volume/flags + directional take), not a new
  // prompt — this is the verdict-first read, not a separate feature.
  const DEEP_DIVE_RE = /\bdeep\s*-?\s*dive\b/i;
  if (DEEP_DIVE_RE.test(trimmed)) {
    const deepDiveMatch = trimmed.match(/deep\s*-?\s*dive\s*(?:on|for)?\s+(\$?[a-z0-9]{2,20}|0x[0-9a-f]{40})/i)
      ?? trimmed.match(/(\$?[a-z0-9]{2,20}|0x[0-9a-f]{40})\s+deep\s*-?\s*dive/i);
    const raw = deepDiveMatch?.[1];
    // Only trust a bare (non-$/non-0x) capture when it's an already-recognized
    // token, so "deep dive on the quarterly report" isn't mistaken for a ticker.
    if (raw && (raw.startsWith("$") || raw.startsWith("0x") || PRICE_TOKEN_RE.test(raw))) {
      const query = raw.replace(/^\$/, "");
      const risk = await scanToken(query);
      if (risk) {
        const analysis = await generateDecisionAnalysis(buildTokenAnalysisPrompt(risk), tier, meterMeta);
        await recordSmart();
        return json({ type: "token_risk", risk, ...(analysis && { analysis }) });
      }
    }
  }

  // ── Pre-buy research bundle — "should i buy X" / "research X (before i buy)"
  // / "tell me about X before i buy". One card: price+risk (scanToken already
  // covers both — DexScreener's feed doubles as the "price" slot here, no
  // separate getPrice call needed), smart money (Nansen, agent-paid, only when
  // the resolved chain has a known Nansen slug), and a same-chain USDC→token
  // swap quote (Delora, only when the chain resolves AND a wallet is connected)
  // — all three run in parallel. "tell me about X" requires the "before i buy"
  // qualifier so it doesn't hijack ordinary "tell me about ethereum"-style
  // education questions (classifyIntent already routes bare "tell me about X"
  // to a Groq informational reply further down); "should i buy X" / "research
  // X" don't need that guard since both phrasings are unambiguously about a
  // purchasable asset already.
  const prebuyMatch =
    trimmed.match(/\bshould\s+i\s+buy\s+(\$?[a-z0-9]{2,20}|0x[0-9a-f]{40})\b/i)
    ?? trimmed.match(/\bresearch\s+(\$?[a-z0-9]{2,20}|0x[0-9a-f]{40})(?:\s+before\s+i\s+buy)?\b/i)
    ?? trimmed.match(/\btell\s+me\s+about\s+(\$?[a-z0-9]{2,20}|0x[0-9a-f]{40})\s+before\s+i\s+buy\b/i);
  if (prebuyMatch) {
    const query = prebuyMatch[1].replace(/^\$/, "");
    const risk = await scanToken(query);
    if (!risk) {
      return json({ type: "error", text: `Could not find token data for "${query}". Try a contract address or a well-known symbol.` });
    }

    const dexChain      = risk.topPair?.chainId ?? null;
    const nansenChain   = dexChain ? toNansenChain(dexChain) : null;
    const deloraChainId = dexChain ? resolveChainId(dexChain) : null;
    const tokenAddress  = risk.topPair?.baseToken?.address ?? null;

    // Skopos's own wallet fronts the Nansen fee (same agent-paid pattern as the
    // "intel" card) — only attempted when the chain has a confirmed Nansen slug,
    // so an unroutable chain never burns a paid call destined to 422.
    const smartMoneyPromise = (nansenChain && tokenAddress && agentPaidEnabled())
      ? fetchSmartMoneyServer({ symbol: risk.symbol, address: tokenAddress, chain: nansenChain }, "BUY").catch(() => null)
      : Promise.resolve(null);

    // A default $100 USDC→token reference quote, same chain only — Delora has
    // no cross-chain path relevant here, this is "what would entering cost me
    // right now," not a bridge. Needs a connected wallet the same way every
    // other execution path does (resolveLeg rejects without one).
    const quotePromise = (deloraChainId && senderAddress)
      ? resolveLeg(
          { originChain: dexChain!, destinationChain: dexChain!, token: "USDC", amount: "100", destinationToken: risk.symbol },
          senderAddress, safeSlippage, solanaAddress, message,
        ).catch(() => null)
      : Promise.resolve(null);

    const [smartMoneyRes, quoteRes, analysis] = await Promise.all([
      smartMoneyPromise,
      quotePromise,
      generateDecisionAnalysis(buildTokenAnalysisPrompt(risk), tier, meterMeta),
    ]);
    await recordSmart();

    // Collapse Nansen's raw wallet-level rows into a glance-able summary — the
    // full per-wallet breakdown is already the "intel" card's job, not this one's.
    let smartMoney: { buyerCount: number; totalBoughtUsd: number } | null = null;
    if (smartMoneyRes?.ok && smartMoneyRes.data && typeof smartMoneyRes.data === "object") {
      const rows = (smartMoneyRes.data as { data?: Array<{ bought_volume_usd?: number }> }).data;
      if (Array.isArray(rows)) {
        smartMoney = {
          buyerCount: rows.length,
          totalBoughtUsd: rows.reduce((sum, r) => sum + (r.bought_volume_usd ?? 0), 0),
        };
      }
    }

    let quote: Record<string, unknown> | null = null;
    let quoteUnavailable: string | null = null;
    if (quoteRes && "ok" in quoteRes && quoteRes.ok) {
      const { intent: legIntent, route, approval, calldata } = quoteRes as LegOk;
      quote = { type: "quote", mode: "preview", quotedAt: Date.now(), intent: legIntent, route, approval, calldata };
    } else if (!deloraChainId) {
      // The Robinhood Chain gap lands here today — see the TODO in lib/delora.ts.
      quoteUnavailable = "Routing isn't available for this chain yet.";
    } else if (!senderAddress) {
      quoteUnavailable = "Connect a wallet to see an entry route.";
    } else {
      quoteUnavailable = `Couldn't find a route for ${risk.symbol} right now.`;
    }

    return json({
      type: "prebuy",
      query: risk.symbol,
      risk,
      smartMoney,
      quote,
      quoteUnavailable,
      ...(analysis && { analysis }),
    });
  }

  // ── Token pick — "pick a token" / "give me a token pick" / "what should I
  // buy". Served from the Aeon fork's real token-pick skill (lib/aeonFeed.ts) —
  // a 7-day dedup gate + 0-10 multi-signal scoring + HIGH/MEDIUM/SKIP conviction,
  // replacing Skopos's former homemade version (live CoinGecko fetch, first
  // candidate that cleared a bare risk score, no dedup — the exact reason a
  // single trending coin could get re-served on every call). Must run before
  // the price fast-path for the same classifyIntent-precedence reason as
  // deep-dive above — "pick" has no signal there either.
  const TOKEN_PICK_RE = /\b(?:token\s*-?\s*pick|pick\s+(?:me\s+)?a\s+token|what\s+(?:token\s+)?should\s+i\s+buy|give\s+me\s+a\s+pick|any\s+(?:good\s+)?picks?(?:\s+(?:today|right\s+now))?|recommend\s+a\s+token)\b/i;
  if (TOKEN_PICK_RE.test(trimmed)) {
    return json({
      type: "aeon",
      kind: "tokenpick",
      title: "Today's token pick",
      subtitle: "One dedup-gated, scored pick a day — or an honest skip when nothing clears the bar.",
      premium: { available: true, label: "Get the read", note: "Free · powered by Aeon" },
    });
  }

  // ── Picks tracker — scorecard for past token-pick calls. Served from Aeon's
  // real picks-tracker skill (win/hold/loss classification + hit rate, weekly),
  // replacing Skopos's former bare Redis list of raw % change.
  const PICKS_TRACKER_RE = /\b(?:picks?\s+tracker|how\s+(?:are|did)\s+(?:my|the|your)\s+picks?\s+(?:doing|do|perform(?:ing)?)|track\s+record|pick\s+history|past\s+picks?)\b/i;
  if (PICKS_TRACKER_RE.test(trimmed)) {
    return json({
      type: "aeon",
      kind: "pickstracker",
      title: "Picks scorecard",
      subtitle: "Win/hold/loss on every past pick, updated weekly. No cherry-picking dates.",
      premium: { available: true, label: "Get the read", note: "Free · powered by Aeon" },
    });
  }

  // ── Price alert — "alert me when eth hits $5000" / "notify me when btc
  // drops below $90000". First of the standing-watch trio (onchain-monitor,
  // price-alert, monitor-polymarket) — needs a push subscription to already
  // exist (lib/notifications.ts), since Skopos has no other way to reach a
  // user outside a request-response chat turn. Evaluated by the Vercel cron
  // at /api/cron/watchers, not here — this block only registers the watcher.
  const PRICE_ALERT_TRIGGER_RE = /\b(?:alert\s+me|notify\s+me|price\s+alert)\b/i;
  if (PRICE_ALERT_TRIGGER_RE.test(trimmed)) {
    const parsed = trimmed.match(
      /(\$?[a-z0-9]{2,10})\s+(hits|reaches|crosses|goes\s+above|is\s+above|is\s+over|above|over|drops?\s+below|goes\s+below|falls?\s+below|is\s+below|is\s+under|below|under)\s+\$?([\d,]+(?:\.\d+)?)/i
    );
    if (!parsed) {
      return json({
        type: "error",
        text: 'Specify a token and target price — e.g. "alert me when eth hits $5000" or "notify me when btc drops below $90000".',
      });
    }
    const rawToken     = parsed[1].replace(/^\$/, "").toLowerCase();
    const symbol       = TOKEN_NAME_TO_SYMBOL[rawToken] ?? rawToken.toUpperCase();
    const direction: "above" | "below" = /below|under|drop|fall/i.test(parsed[2]) ? "below" : "above";
    const targetPrice  = Number(parsed[3].replace(/,/g, ""));
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      return json({ type: "error", text: 'That target price doesn\'t look right — try again with a number, e.g. "alert me when eth hits $5000".' });
    }

    const identity = (senderAddress ?? anonId ?? "").toLowerCase();
    if (!identity) {
      return json({ type: "error", text: "I need a stable way to identify you first — connect your wallet or keep using the app, then try again." });
    }

    const watcher = await registerWatcher("price", identity, { symbol, targetPrice, direction });
    if (!watcher) {
      return json({ type: "error", text: "Alerts aren't available right now — try again in a bit." });
    }
    const subscription = await getSubscription(identity);
    const note = subscription ? "" : " Open tryskopos.xyz/app once and enable notifications with this same wallet so it can actually reach you.";
    return json({ type: "text", text: `Alert set — I'll notify you when ${symbol} goes ${direction} $${targetPrice.toLocaleString()}.${note}` });
  }

  // ── Monitor Polymarket — "monitor polymarket <topic>" / "watch <topic> on
  // polymarket". Second of the standing-watch trio. Unlike price-alert this is
  // a RECURRING watch (matches the "watch over time" framing in the original
  // ask) — the cron re-arms with a refreshed baseline after each notable move
  // instead of deleting the watcher.
  // Two phrasings: "monitor polymarket <topic>" (verb+platform first) and
  // "watch <topic> market on polymarket" (topic first, platform named last).
  const monitorPolyMatch =
    trimmed.match(/\b(?:monitor\s+polymarket|watch\s+(?:this\s+|the\s+)?polymarket)\s+(?:market\s+)?(?:for\s+|on\s+)?(.+)$/i) ??
    trimmed.match(/\bwatch\s+(?:this\s+|the\s+)?(.+?)\s+(?:market\s+)?on\s+polymarket\b/i);
  if (monitorPolyMatch) {
    const topic = monitorPolyMatch[1].trim();
    if (!topic) {
      return json({ type: "error", text: 'Specify a market — e.g. "monitor polymarket trump 2028" or "watch the fed rate market on polymarket".' });
    }
    let markets: PolymarketEvent[];
    try {
      markets = await getTopMarkets(topic, 1);
    } catch {
      return json({ type: "error", text: "Prediction market data is unavailable right now. Try again in a moment." });
    }
    const market = markets[0];
    if (!market) {
      return json({ type: "error", text: `Couldn't find a Polymarket market matching "${topic}".` });
    }

    const identity = (senderAddress ?? anonId ?? "").toLowerCase();
    if (!identity) {
      return json({ type: "error", text: "I need a stable way to identify you first — connect your wallet or keep using the app, then try again." });
    }

    const watcher = await registerWatcher("polymarket", identity, { slug: market.slug, title: market.title, baselineVolume: market.volume });
    if (!watcher) {
      return json({ type: "error", text: "Alerts aren't available right now — try again in a bit." });
    }
    const subscription = await getSubscription(identity);
    const note = subscription ? "" : " Open tryskopos.xyz/app once and enable notifications with this same wallet so it can actually reach you.";
    return json({ type: "text", text: `Watching "${market.title}" on Polymarket — I'll notify you if volume moves significantly.${note}` });
  }

  // ── Onchain monitor — "watch 0x123... for activity" / "monitor address
  // 0x123...". Third of the standing-watch trio. Reuses lookupAddress's
  // recentTransfers (already built for the address-lookup card) as the
  // activity signal — no new data source. Recurring, same reasoning as
  // monitor-polymarket above.
  const onchainMatch = trimmed.match(/\b(?:watch|monitor)\b.*\b(0x[0-9a-fA-F]{40})\b/i);
  if (onchainMatch) {
    const watchAddress = onchainMatch[1];
    const identity = (senderAddress ?? anonId ?? "").toLowerCase();
    if (!identity) {
      return json({ type: "error", text: "I need a stable way to identify you first — connect your wallet or keep using the app, then try again." });
    }

    const data = await lookupAddress(watchAddress);
    const lastSeenTxHash = data.recentTransfers[0]?.hash ?? null;

    const watcher = await registerWatcher("onchain", identity, { address: watchAddress, chainId: 1, lastSeenTxHash });
    if (!watcher) {
      return json({ type: "error", text: "Alerts aren't available right now — try again in a bit." });
    }
    const subscription = await getSubscription(identity);
    const note = subscription ? "" : " Open tryskopos.xyz/app once and enable notifications with this same wallet so it can actually reach you.";
    return json({ type: "text", text: `Watching ${watchAddress} — I'll notify you on new activity.${note}` });
  }

  // ── DAO treasury lookup (#17) — "treasury of X" / "X's treasury" / "X DAO
  // treasury" / "how big is X's treasury". Native, no Aeon relay, no Dune,
  // no DeFiLlama Pro — reuses lookupAddress (already multi-chain, already
  // computes totalUsdValue) against a small hand-verified address map above.
  // Deliberately curated, not scraped: a wrong address here reports the
  // wrong treasury's numbers with total confidence, so scope stays small
  // until each entry is verified against its Etherscan/Arbiscan label.
  const TREASURY_STOPWORDS = new Set(["a", "an", "the", "what", "my", "this", "that", "which", "whose", "your"]);
  const treasuryMatch =
    trimmed.match(/\btreasury\s+of\s+(?:the\s+)?(\w+)/i) ??
    trimmed.match(/\bhow\s+big\s+is\s+(?:the\s+)?(\w+)(?:'s)?\s+(?:dao\s+)?treasury/i) ??
    trimmed.match(/\b(\w+)(?:'s)?\s+(?:dao\s+)?treasury\b/i);
  if (treasuryMatch && !TREASURY_STOPWORDS.has(treasuryMatch[1].toLowerCase())) {
    const name = treasuryMatch[1].toLowerCase();
    const dao = DAO_TREASURIES[name];
    if (!dao) {
      const supported = Object.values(DAO_TREASURIES).map(d => d.label).join(", ");
      return json({
        type: "error",
        text: `I don't have "${treasuryMatch[1]}" in the curated treasury list yet — currently supporting: ${supported}.`,
      });
    }
    const data = await lookupAddress(dao.address);
    const summary = await generateAddressSummary(data);
    return json({ type: "address", data, summary: `${dao.label} DAO treasury:\n\n${summary}` });
  }

  // ── Robinhood Chain launch feed (paid, x402) — "robinhood chain launches" /
  // "what's launching on robinhood". Skopos's own wallet pays $0.001/call
  // (lib/robinhoodLaunches.ts, docs/paid-data-sources.md) — no user wallet
  // needed. Surfaces the creator's repeat-launch count as the safety signal;
  // DexScreener doesn't index this chain yet so there's no honeypot/liquidity
  // check to run on top of it. Token names are also unverified — permissionless
  // launches routinely reference real public figures/brands with zero actual
  // affiliation (e.g. a token symbol riffing on a known CT persona's name),
  // so the disclaimer calls that out explicitly rather than implying any vetting.
  if (/\brobinhood\s+chain\s+launch(?:es)?\b|\blaunch(?:es|ing)?\s+on\s+robinhood(?:\s+chain)?\b|\bwhat'?s?\s+launching\s+on\s+robinhood\b/i.test(trimmed)) {
    if (!robinhoodFeedEnabled()) {
      return json({ type: "error", text: "Robinhood Chain launch reads aren't configured right now." });
    }
    const launches = await getRecentRobinhoodLaunches(5);
    if (!launches || launches.length === 0) {
      return json({ type: "error", text: "Couldn't fetch Robinhood Chain launches right now — try again shortly." });
    }
    const lines = launches.map(l => {
      const repeat = l.creator.repeatLaunchCount > 1
        ? ` ⚠️ ${l.creator.repeatLaunchCount} launches from this wallet in the current feed`
        : "";
      const mcap = l.marketCapUsd > 0
        ? `$${l.marketCapUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} mcap`
        : "no trades yet";
      return `${l.symbol} (${l.name}) — ${l.ageMinutes}m old, ${mcap}, by @${l.creator.xUsername ?? "unknown"}${repeat}`;
    });
    return json({
      type: "text",
      text: `Recent Robinhood Chain launches:\n\n${lines.join("\n")}\n\nNo liquidity/honeypot data yet — DexScreener hasn't indexed this chain. Token names are unverified — anyone can launch a token referencing a public figure or brand with zero affiliation. Repeat-launch count is the only safety signal available right now.`,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRICE FAST-PATH
  // Runs before structural checks — a classified "price" query must never fall
  // through to address/ENS lookups. Structural layer assumes input is unclassified.
  // ═══════════════════════════════════════════════════════════════════════════

  if (queryType === "price" && !ENS_RE.test(trimmed)) {
    const tokenMatch = trimmed.match(PRICE_TOKEN_RE);
    const rawSymbol  = tokenMatch?.[1] ?? "";
    const symbol     = (TOKEN_NAME_TO_SYMBOL[rawSymbol.toLowerCase()] ?? rawSymbol).toUpperCase();
    const [result, chart] = await Promise.all([getPrice(symbol), getPriceChart(symbol)]);
    if (!result || result.price <= 0) {
      return json({ type: "error", text: "Unable to fetch reliable data right now." });
    }
    const { price, change24h, source } = result;
    console.log(`[price] query symbol=${symbol} price=${price} source=${source}`);
    return json({
      type: "price",
      symbol,
      name:              chart?.name              ?? null,
      image:             chart?.image             ?? null,
      price,
      change24h,
      sparkline:         chart?.sparkline         ?? [],
      marketCap:         chart?.marketCap         ?? null,
      volume24h:         chart?.volume24h         ?? null,
      circulatingSupply: chart?.circulatingSupply ?? null,
      maxSupply:         chart?.maxSupply         ?? null,
    });
  }

  // ── FX conversion / rate ──────────────────────────────────────────────────
  if (queryType === "fx") {
    const CURRENCY_NORM: Record<string, string> = {
      euro: "EUR", euros: "EUR",
      pound: "GBP", pounds: "GBP", sterling: "GBP",
      yen: "JPY",
      franc: "CHF", francs: "CHF",
      dollar: "USD", dollars: "USD",
      australian: "AUD",
    };
    const SUPPORTED = new Set(["EUR", "GBP", "AUD", "JPY", "CHF", "USD"]);
    const FEED_FOR: Record<string, PythFeedKey> = {
      EUR: "EUR/USD", GBP: "GBP/USD", AUD: "AUD/USD", JPY: "USD/JPY", CHF: "USD/CHF",
    };

    const norm = trimmed.toLowerCase().replace(
      /\b(euro|euros|pound|pounds|sterling|yen|franc|francs|dollar|dollars|australian)\b/gi,
      (w: string) => CURRENCY_NORM[w.toLowerCase()] ?? w,
    );

    const currencies = [...(norm.match(/\b(EUR|GBP|JPY|CHF|AUD|USD)\b/gi) ?? [])]
      .map(c => c.toUpperCase())
      .filter(c => SUPPORTED.has(c));
    const from = currencies[0] ?? "EUR";
    const to   = currencies[1] ?? "USD";

    const amountMatch = trimmed.match(/[\d,]+(?:\.\d+)?/);
    const amount = amountMatch ? parseFloat(amountMatch[0].replace(/,/g, "")) : null;

    const keysNeeded = [...new Set([FEED_FOR[from], FEED_FOR[to]].filter(Boolean))] as PythFeedKey[];
    const rates = await getPythRates(keysNeeded);

    const fromUSD = toUSDRate(from, rates);
    const toUSD_  = toUSDRate(to, rates);

    if (!isFinite(fromUSD) || !isFinite(toUSD_)) {
      return json({ type: "error", text: `FX rate unavailable for ${from}/${to} right now.` });
    }

    const rate = fromUSD / toUSD_;
    const stale = keysNeeded.some(k => rates[k]?.stale);
    const staleNote = stale ? " (markets closed — last quoted rate)" : "";
    const fmt = (n: number, decimals = 4) =>
      n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: decimals });

    if (amount !== null && from !== to) {
      const converted = amount * rate;
      return json({
        type: "text",
        text: `${fmt(amount, 2)} ${from} = ${fmt(converted, 2)} ${to} (rate: 1 ${from} = ${fmt(rate)} ${to})${staleNote}`,
      });
    }

    return json({
      type: "text",
      text: `1 ${from} = ${fmt(rate)} ${to}${staleNote}`,
    });
  }

  // ── Metal spot prices ─────────────────────────────────────────────────────
  if (queryType === "metal") {
    const isSilver = /\b(silver|xag)\b/i.test(trimmed);
    const key: PythFeedKey = isSilver ? "XAG/USD" : "XAU/USD";
    const name  = isSilver ? "Silver" : "Gold";
    const label = isSilver ? "XAG" : "XAU";

    const rate = await getPythRate(key);
    if (!rate || rate.price <= 0) {
      return json({ type: "error", text: `Unable to fetch ${name} price right now.` });
    }

    const staleNote = rate.stale ? " (markets closed — last quoted price)" : "";
    const fmt = rate.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return json({
      type: "text",
      text: `${name} (${label}/USD): $${fmt} / troy oz${staleNote}`,
    });
  }

  // ── Equity prices ─────────────────────────────────────────────────────────
  if (queryType === "equity") {
    const EQUITIES: { re: RegExp; key: PythFeedKey; ticker: string; name: string }[] = [
      { re: /\b(hood|robinhood)\b/i,  key: "HOOD",  ticker: "HOOD",  name: "Robinhood Markets" },
      { re: /\b(nvda|nvidia)\b/i,     key: "NVDA",  ticker: "NVDA",  name: "NVIDIA" },
      { re: /\b(tsla|tesla)\b/i,      key: "TSLA",  ticker: "TSLA",  name: "Tesla" },
      { re: /\b(googl|google)\b/i,    key: "GOOGL", ticker: "GOOGL", name: "Alphabet" },
      { re: /\b(amzn|amazon)\b/i,     key: "AMZN",  ticker: "AMZN",  name: "Amazon" },
      { re: /\b(meta)\b/i,            key: "META",  ticker: "META",  name: "Meta" },
      { re: /\b(coinbase)\b/i,        key: "COIN",  ticker: "COIN",  name: "Coinbase" },
      { re: /\b(mstr|microstrategy)\b/i, key: "MSTR", ticker: "MSTR", name: "MicroStrategy" },
      { re: /\b(mara|marathon)\b/i,   key: "MARA",  ticker: "MARA",  name: "Marathon Digital" },
      { re: /\b(riot)\b/i,            key: "RIOT",  ticker: "RIOT",  name: "Riot Platforms" },
      { re: /\b(amd)\b/i,             key: "AMD",   ticker: "AMD",   name: "AMD" },
      { re: /\b(pltr|palantir)\b/i,   key: "PLTR",  ticker: "PLTR",  name: "Palantir" },
      { re: /\b(avgo|broadcom)\b/i,   key: "AVGO",  ticker: "AVGO",  name: "Broadcom" },
      { re: /\b(smci|supermicro)\b/i, key: "SMCI",  ticker: "SMCI",  name: "Super Micro" },
      { re: /\b(nflx|netflix)\b/i,    key: "NFLX",  ticker: "NFLX",  name: "Netflix" },
      { re: /\b(pypl|paypal)\b/i,     key: "PYPL",  ticker: "PYPL",  name: "PayPal" },
      { re: /\b(sofi)\b/i,            key: "SOFI",  ticker: "SOFI",  name: "SoFi" },
      { re: /\b(uber)\b/i,            key: "UBER",  ticker: "UBER",  name: "Uber" },
      { re: /\b(jpm|jpmorgan)\b/i,    key: "JPM",   ticker: "JPM",   name: "JPMorgan" },
      { re: /\b(baba|alibaba)\b/i,    key: "BABA",  ticker: "BABA",  name: "Alibaba" },
      { re: /\b(dis|disney)\b/i,      key: "DIS",   ticker: "DIS",   name: "Disney" },
      { re: /\b(crm|salesforce)\b/i,  key: "CRM",   ticker: "CRM",   name: "Salesforce" },
      { re: /\b(orcl)\b/i,            key: "ORCL",  ticker: "ORCL",  name: "Oracle" },
      { re: /\b(intc)\b/i,            key: "INTC",  ticker: "INTC",  name: "Intel" },
      { re: /\b(spy)\b/i,             key: "SPY",   ticker: "SPY",   name: "SPDR S&P 500 ETF" },
      { re: /\b(qqq)\b/i,             key: "QQQ",   ticker: "QQQ",   name: "Invesco QQQ" },
      { re: /\b(arkk)\b/i,            key: "ARKK",  ticker: "ARKK",  name: "ARK Innovation ETF" },
      { re: /\b(msft|microsoft)\b/i,  key: "MSFT",  ticker: "MSFT",  name: "Microsoft" },
      { re: /\b(aapl|apple)\b/i,      key: "AAPL",  ticker: "AAPL",  name: "Apple" },
    ];
    const stock = EQUITIES.find((e) => e.re.test(trimmed)) ?? EQUITIES[EQUITIES.length - 1];

    const rate = await getPythRate(stock.key);
    if (!rate || rate.price <= 0) {
      return json({ type: "error", text: `Unable to fetch ${stock.name} price right now.` });
    }

    const fmt = rate.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const staleNote = rate.stale
      ? " (US markets closed — last close price)"
      : " (live — US market hours)";
    return json({
      type: "text",
      text: `${stock.name} (${stock.ticker}): $${fmt}${staleNote}`,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 1 — STRUCTURAL
  // Format-based detection: ENS names, addresses, tx hashes.
  // No intent classification. No wallet required.
  // ═══════════════════════════════════════════════════════════════════════════

  // ENS name (*.eth) — see ENS_RE definition above the POST handler
  const ensMatch = trimmed.match(ENS_RE);
  if (ensMatch) {
    const ensName = (ensMatch[1] + ".eth").toLowerCase();
    const resolved = await resolveENS(ensName);
    if (!resolved) {
      return json({ type: "error", text: `Could not resolve ${ensName}. Make sure the ENS name is registered.` });
    }
    const data = await lookupAddress(resolved);
    const summary = await generateAddressSummary(data);
    return json({ type: "address", data, summary, ensName });
  }

  // Address embedded in a sentence ("analyze wallet 0x…", "check 0x…").
  // Skip pay commands — their recipient is a 0x address but the intent is a
  // payment, not a wallet lookup (handled in the intent layer below).
  const embeddedAddrMatch = trimmed.match(/\b(0x[0-9a-fA-F]{40})\b/);
  if (embeddedAddrMatch && !/^0x[0-9a-fA-F]{40}$/.test(trimmed) && !looksLikePay(trimmed)) {
    const data = await lookupAddress(embeddedAddrMatch[1]);
    const summary = await generateAddressSummary(data);
    return json({ type: "address", data, summary });
  }

  // TX hash — exactly 0x + 64 hex chars
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    const tx = await lookupTx(trimmed);
    if (tx) {
      const llmSummary = await generateTxSummary(tx);
      const flag = tx.approval?.unlimited
        ? `⚠️ Unlimited token approval — this granted ${tx.approval.spender.slice(0, 6)}…${tx.approval.spender.slice(-4)} permission to move that token from the sender's wallet with no cap. If you don't recognize the spender, revoke the allowance.\n\n`
        : "";
      return json({ type: "tx", tx, summary: flag + llmSummary });
    }
    return json({ type: "error", text: "Transaction not found on any supported chain." });
  }

  // Bare address — exactly 0x + 40 hex chars
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    const data = await lookupAddress(trimmed);
    const summary = await generateAddressSummary(data);
    return json({ type: "address", data, summary });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 2 — ACCOUNT
  // Wallet-state queries. Runs before intent classification so that account
  // queries (balance, deposit status) are never misrouted to prediction/yield.
  // Account-priority rule: when a wallet is connected and the query mentions
  // deposit / funds / balance / money / ready / bet, this layer fires first.
  // ═══════════════════════════════════════════════════════════════════════════

  // Portfolio (connected wallet)
  if (/\b(my\s+)?(portfolio|wallet|balances?|holdings)\b/i.test(trimmed)) {
    if (!senderAddress) {
      return json({ type: "text", text: "Connect your wallet first — I'll fetch your live balances across all supported chains." });
    }
    const data = await lookupAddress(senderAddress);

    // Chain-specific filter: "show my portfolio on Base"
    const chainMatch = trimmed.match(/\bon\s+([a-z][a-z\s]*?)(?:\s*[?]?\s*$)/i);
    const requestedChain = chainMatch?.[1]?.trim().toLowerCase();
    if (requestedChain) {
      const requestedChainId = resolveChainId(requestedChain);
      const filteredBalances = data.balances.filter(b =>
        requestedChainId ? b.chainId === requestedChainId : b.chainName.toLowerCase().includes(requestedChain)
      );
      const filteredTokens = data.tokenBalances.filter(t =>
        requestedChainId ? t.chainId === requestedChainId : t.chainName.toLowerCase().includes(requestedChain)
      );

      if (filteredBalances.length === 0 && filteredTokens.length === 0) {
        const chainData = requestedChainId ? await getChainById(requestedChainId) : null;
        const label = chainData?.name ?? requestedChain;
        const activeChains = [
          ...data.balances.map(b => b.chainName),
          ...data.tokenBalances.map(t => t.chainName),
        ];
        const elsewhere = [...new Set(activeChains)].join(", ") || "no balances detected";
        return json({
          type: "text",
          text: `No assets found on ${label} for this wallet. Active balances are on: ${elsewhere}.`,
        });
      }

      const filteredData = { ...data, balances: filteredBalances, tokenBalances: filteredTokens };
      const summary = await generateAddressSummary(filteredData);
      return json({ type: "address", data: filteredData, summary });
    }

    const summary = await generateAddressSummary(data);
    return json({ type: "address", data, summary });
  }

  // Polymarket balance — account-priority: fires before prediction intent so
  // "did my deposit land?" / "is my money ready?" never reaches classifyIntent.
  const POLY_BALANCE_RE = /\b(did\s+my\s+(?:deposit|funds?)\s+(?:land|arrive|go\s+through|show\s+up)|my\s+polymarket\s+(?:balance|funds?|account|money)|polymarket\s+balance|check\s+polymarket|is\s+my\s+(?:deposit|money)\s+(?:ready|there|on\s+polymarket)|how\s+much\s+(?:is\s+)?on\s+polymarket|polymarket\s+funds?)\b/i;
  if (POLY_BALANCE_RE.test(trimmed)) {
    if (!senderAddress) {
      return json({ type: "error", text: "Connect your wallet — I'll check your Polymarket balance automatically." });
    }
    const balance = await getPolymarketBalance(senderAddress);
    if (balance === null) {
      return json({ type: "error", text: "Unable to check your Polymarket balance right now." });
    }
    if (balance === 0) {
      return json({ type: "text", text: "No pUSD balance found on Polymarket yet. If you just sent funds, it can take 1–3 minutes to arrive." });
    }
    const fmt = balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return json({ type: "text", text: `$${fmt} ready on Polymarket.` });
  }

  // Polymarket deposit status — keyed on a deposit address in the message
  const depositAddrInMsg = trimmed.match(/\b(0x[0-9a-fA-F]{40})\b/)?.[1];
  if (
    depositAddrInMsg &&
    /\b(deposit|arrived?|confirmed?|status|funds?|balance)\b/i.test(trimmed)
  ) {
    try {
      const result = await getDepositStatus(depositAddrInMsg);
      if (!result) return json({ type: "error", text: "Unable to fetch deposit status right now." });
      const STATUS_LABEL: Record<string, string> = {
        pending:    "Pending — waiting for your transfer to be detected.",
        processing: "Processing — bridging to Polygon. Usually takes 1–3 minutes.",
        complete:   "Complete — your pUSD is on Polymarket and ready to use.",
        failed:     "Failed — the deposit did not go through. Contact Polymarket support.",
        refunded:   "Refunded — funds were returned to your wallet.",
        expired:    "Expired — the deposit address is no longer valid.",
      };
      const msg = STATUS_LABEL[result.status] ?? result.status;
      const amtStr = result.amount ? ` Amount: $${parseFloat(result.amount).toFixed(2)}.` : "";
      return json({ type: "text", text: `Deposit ${depositAddrInMsg.slice(0, 10)}… — ${msg}${amtStr}` });
    } catch {
      return json({ type: "error", text: "Unable to fetch deposit status right now." });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 3 — INTENT
  // All paths go through classifyIntent(). Tool always wins over LLM.
  // LLM is only used for explanation — never for live data.
  // ═══════════════════════════════════════════════════════════════════════════

  // Security boundary: block identity/model questions before any LLM path
  const META_RE = /\b(system\s*prompt|your\s*instructions?|what\s*(?:model|llm|ai)\s*(?:are\s*you|is\s*this)|which\s*(?:model|api|llm)\s*(?:do\s*you|are\s*you)|openai|anthropic|are\s*you\s*(?:gpt|claude|chatgpt|llama)|gpt[-\s]?\d|how\s+old\s+are\s+you|when\s+(?:were|was)\s+you\s+(?:created|born|built|made|trained|launched)|(?:your|you\s+have\s+a?)\s*(?:age|birthday|birth\s*date)|knowledge\s+cutoff|training\s+(?:data|cutoff)|(?:do\s+you|you)\s+know\s+(?:about\s+)?\d{4}|what\s+year\s+(?:is\s+it|are\s+you|do\s+you\s+think)|who\s+(?:made|built|created|trained)\s+you)\b/i;
  if (META_RE.test(trimmed)) {
    return json({ type: "text", text: "I'm here to help with DeFi and on-chain tasks." });
  }

  // Identity / capabilities — answered deterministically so the product can never
  // misdescribe itself (the LLM used to claim it "can't execute"). Scoped to
  // identity/help phrasings + general "can you <verb>" questions; a real
  // execution request carries an amount and classifies as "execution", so it's
  // excluded here and still routes to a quote.
  const HELP_RE = /^\s*(?:help|menu|start|gm|hi|hey|hello)\s*[!.?]*\s*$|what(?:'s| is| are)?\s+skopos\b|who\s+are\s+you\b|what\s+can\s+(?:you|skopos|i)\s+do\b|what\s+do\s+you\s+do\b|how\s+(?:do|can)\s+i\s+use\s+(?:you|this|skopos)\b|what\s+are\s+your\s+(?:features|capabilities|commands)\b|(?:can|do)\s+you\s+(?:execute|swap|bridge|rebalance|trade|sign|help)\b/i;
  if (queryType !== "execution" && HELP_RE.test(trimmed)) {
    return json({ type: "text", text: SKOPOS_HELP });
  }

  // MCP capability question — deterministic (zero-LLM), same pattern as HELP_RE
  // just above. skopos-mcp is a real, published npm package (mcp/index.js), so
  // this must never fall into NOT_LIVE's generic "isn't live yet" denial below —
  // that's exactly the bug this block replaces (the old NOT_LIVE entry told
  // users MCP wasn't live while Skopos was already shipping it).
  const MCP_RE = /\b(mcp|model\s+context\s+protocol|claude\s+desktop)\b/i;
  if (MCP_RE.test(trimmed)) {
    return json({
      type: "text",
      text: `Yes — Skopos ships a real MCP server. Install it with "npx -y skopos-mcp" in Claude Desktop, Cursor, or any MCP client; it's a thin wrapper that answers the same way this chat does, non-custodially. More at tryskopos.xyz/docs.`,
    });
  }

  // Not-live features — answer honestly instead of mis-parsing the request (a DCA
  // ask used to become a nonsensical bridge prompt). Fires before execution and
  // rebalance parsing, so "buy ETH when it hits $X" isn't run as a market order.
  const NOT_LIVE: Array<[RegExp, string]> = [
    [/\b(dca|dollar[-\s]?cost\s*averag\w*|recurring|every\s+(?:day|week|month|hour|other\s+day)|set\s+up\s+an?\s+agent|automate\s+(?:my|a|the)\s+(?:buy|swap|purchase|dca))\b/i,
      `Recurring buys and DCA agents aren't live yet — that's on the roadmap. For now I can do one-off swaps and bridges, e.g. "swap $20 of USDC to ETH on base".`],
    [/\b(limit\s+order|stop[-\s]?loss|take[-\s]?profit)\b|\bwhen\s+(?:the\s+)?(?:price|it|eth|btc|sol)\s+(?:drops?|hits?|reaches?|falls?|is)\b.*\$?\d/i,
      `Limit and conditional orders aren't live yet — Skopos executes at the current market rate. You can swap or bridge now at live prices; price-triggered orders are coming.`],
    [/\b(off[-\s]?ramp|cash\s*out|withdraw\s+to\s+(?:my\s+)?(?:bank|card|debit)|to\s+my\s+(?:debit|bank)\s+(?:card|account)?|fiat\s+out)\b/i,
      `Cashing out to a bank or card isn't live yet. Skopos handles on-chain swaps and bridges; fiat off-ramp is on the roadmap.`],
    [/\b(whale\s+(?:signals?|tracking|watch\w*|alerts?)|smart\s+money|top\s+wallets|what\s+(?:others|people|whales)\s+are\s+(?:bridging|buying|trading|doing))\b/i,
      `Whale and smart-money tracking isn't live yet. You can scan a specific wallet (paste its address) or a token's risk ("scan PEPE risk") today.`],
  ];
  for (const [re, text] of NOT_LIVE) {
    if (re.test(trimmed)) return json({ type: "text", text });
  }

  // B20 memo payment — "pay AMOUNT 0xTOKEN to 0xADDR for MEMO on CHAIN". Runs
  // before swap/rebalance parsing; the "to 0xADDRESS" shape distinguishes a
  // payment from a swap ("to TOKEN/CHAIN"). Non-custodial: the client signs the
  // transferWithMemo. Base + Base Sepolia.
  if (looksLikePay(trimmed)) {
    const pay = await buildPayIntent(trimmed);
    if (pay) {
      if ("error" in pay) return json({ type: "error", text: pay.error }, { headers: corsHeaders });
      return json({ type: "pay", ...pay }, { headers: corsHeaders });
    }
  }

  // Payments inbox — incoming B20 memo payments to the connected wallet, with the
  // memo decoded ("order-1024 paid"). The reconcile half of the payment rail.
  const PAYMENTS_RE = /\b(payments?\s+(?:received|inbox|to\s+me)|who\s+(?:paid|has\s+paid)\s+me|did\s+i\s+get\s+paid|my\s+payments|memo\s+payments|payment\s+inbox|incoming\s+payments|reconcile\s+payments)\b/i;
  if (PAYMENTS_RE.test(trimmed)) {
    if (!senderAddress || !senderAddress.startsWith("0x")) {
      return json({ type: "error", text: "Connect a wallet to see payments tagged to you." }, { headers: corsHeaders });
    }
    const [sepolia, mainnet] = await Promise.all([
      getMemoPayments(84532, senderAddress),
      getMemoPayments(8453, senderAddress),
    ]);
    return json({ type: "payments", address: senderAddress, payments: [...mainnet, ...sepolia] }, { headers: corsHeaders });
  }

  // Token launch via Bankr Partner Deploy API. Two-step: a launch request previews,
  // an explicit "confirm" deploys — never a one-shot launch from a single message.
  if (queryType === "launch") {
    if (!isBankrEnabled()) {
      return json({ type: "text", text: "Token launching is coming soon to Skopos." });
    }
    const launch = parseLaunchIntent(trimmed);
    if (!launch) {
      return json({ type: "text", text: `Tell me the name, e.g. "launch a token called Skopos ($SKO) on base".` });
    }
    if (!senderAddress || !senderAddress.startsWith("0x")) {
      return json({ type: "error", text: "Connect your wallet first — creator fees route to your address." });
    }
    const symbol = launch.symbol ?? launch.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase();
    if (launch.chain !== "base") {
      return json({ type: "text", text: `Bankr launches run on Base. Send "launch a token called ${launch.name} $${symbol} on base" to go ahead.` });
    }
    if (!/\bconfirm\b/i.test(trimmed)) {
      return json({
        type: "text",
        text: `Ready to launch ${launch.name} ($${symbol}) on Base. Creator fees route to ${senderAddress.slice(0, 6)}…${senderAddress.slice(-4)}.\n\nTo deploy, send: confirm launch token called ${launch.name} $${symbol}`,
      });
    }
    try {
      const token = await launchToken({ name: launch.name, symbol, feeRecipient: senderAddress });
      const addr = token.tokenAddress;
      return json({
        type: "text",
        text: `Launched ${token.name ?? launch.name} ($${token.symbol ?? symbol}) on Base.${addr ? `\nContract: ${addr}\nhttps://basescan.org/token/${addr}` : ""}\nCreator fees route to your wallet.`,
      });
    } catch (err) {
      return json({ type: "error", text: err instanceof Error ? err.message : "Could not launch the token right now." });
    }
  }

  // Multi-leg rebalance — must run before single-leg so "split X across Y and Z" isn't parsed as one bridge
  if (looksLikeRebalance(message)) {
    const legs = await parseRebalanceIntent(message);
    if (legs && legs.length >= 2) {
      // Headless: hand off to the app via the link rather than quoting each leg.
      if (textMode) return json({ type: "rebalance", mode: "handoff", legs: [] });
      // Validate that legs are actually cross-chain — same-chain legs indicate the LLM couldn't infer origin
      const samechainLegs = legs.filter(l => resolveChainId(l.originChain) === resolveChainId(l.destinationChain));
      if (samechainLegs.length > 0) {
        return json({ type: "text", text: `Which chain are the funds coming from? Name the source and I'll split it — e.g. "split 1 ETH from ethereum across base and arbitrum".` });
      }

      const results = await Promise.all(legs.map(leg => resolveLeg(leg, senderAddress, safeSlippage, solanaAddress, message)));

      const firstErr = results.find((r): r is LegErr => !r.ok);
      if (firstErr) {
        return json({ type: "error", text: `Rebalance aborted: ${firstErr.text}` });
      }

      const quotedAt = Date.now();
      return json({
        type: "rebalance",
        mode: "preview",
        quotedAt,
        legs: results.map((r, idx) => {
          const { intent, route, approval, calldata, raw } = r as LegOk;
          const pl = legs[idx];
          const sameToken = (pl.destinationToken || pl.token).toUpperCase() === pl.token.toUpperCase();
          const originMessage = sameToken
            ? `bridge ${pl.amount} ${pl.token} from ${pl.originChain} to ${pl.destinationChain}`
            : `swap ${pl.amount} ${pl.token} from ${pl.originChain} to ${pl.destinationToken} on ${pl.destinationChain}`;
          return { type: "quote", mode: "preview", quotedAt, intent, route, approval, calldata, raw, originMessage };
        }),
      });
    }
  }

  // Missing-source guard — catches "bridge X TOKEN to CHAIN" with no "from" before Groq
  // can hallucinate a source chain. Skipped when the token implies its own source.
  const TOKEN_IMPLIES_SOURCE: Record<string, string> = {
    // ETH-native chains where chain name = token shorthand
    BASE:      "base",
    MEGAETH:   "megaeth",
    MEGA:      "megaeth",
    // ETH-native L2s (arb, op, etc.) use "eth on CHAIN" format — not listed here
    // Non-ETH native chains — chain name IS the native token
    SOL:       "solana",
    SOLANA:    "solana",
    MATIC:     "polygon",
    POL:       "polygon",
    POLYGON:   "polygon",
    BNB:       "bsc",
    AVAX:      "avalanche",
    CELO:      "celo",
    MNT:       "mantle",
    MANTLE:    "mantle",
    BERA:      "berachain",
    BERACHAIN: "berachain",
    CRO:       "cronos",
    CRONOS:    "cronos",
    HYPE:      "hyperevm",
  };

  // Token symbols that are never chain names — used to detect "bridge 1 SOL to USDC"
  // patterns where the user named a destination token but not a destination chain.
  const NON_CHAIN_TOKEN_DEST_RE = /^(usdc|usdt|weth|wbtc|dai|link|uni|aave|crv|mkr|snx|comp|frax|gho|lusd|crvusd|cbbtc|pepe|shib|doge)$/i;

  const missingSource = trimmed.match(
    /^(?:bridge|move|send|transfer|swap)\s+[\d.]+\s+([a-z]+)\s+to\s+([a-z][a-z\s]*?)(?:\s*[?.]?\s*)$/i
  );
  if (missingSource && !/\bfrom\b/i.test(trimmed)) {
    const token    = missingSource[1].toUpperCase();
    const destSlot = missingSource[2].trim();
    const destFirst = destSlot.split(/\s+/)[0];
    // If the destination slot starts with a pure token name (not a chain), the user
    // is specifying what they want to receive but hasn't named the destination chain.
    // "bridge 1 sol to usdc" and "bridge 1 ETH to USDC on base" both match here;
    // the latter is only caught when the "on CHAIN" suffix is in the dest slot
    // (meaning pCross / p5Cross didn't fire because it needs an explicit "from ORIGIN").
    const destSlotHasChain = /\bon\s+[a-z]/i.test(destSlot);
    if (NON_CHAIN_TOKEN_DEST_RE.test(destFirst) && !destSlotHasChain) {
      const sourceChain = TOKEN_IMPLIES_SOURCE[token];
      if (sourceChain) {
        return json({
          type: "error",
          text: `Which chain do you want to receive ${destFirst.toUpperCase()} on? e.g. "bridge 1 ${token} from ${sourceChain} to base" or "bridge 1 ${token} from ${sourceChain} to ethereum"`,
        });
      }
      return json({
        type: "error",
        text: `Specify the source chain and destination chain — e.g. "bridge 100 ${token} from ethereum to base" (receiving ${destFirst.toUpperCase()}).`,
      });
    }
    // Original guard: no "from" AND no "on" AND token doesn't imply its source.
    if (!/\bon\b/i.test(trimmed) && !TOKEN_IMPLIES_SOURCE[token]) {
      return json({
        type: "error",
        text: `Where are you bridging from? Specify the source chain — e.g. "bridge 100 ${token} from base to ${destFirst}" or "bridge 100 ${token} from arbitrum to ${destFirst}".`,
      });
    }
  }

  // Prediction → Polymarket (single entry point via classifyIntent)
  if (queryType === "prediction") {
    const STOP_WORDS_RE = /^(?:the|a|an)\s+/i;

    const isBetIntent = /\b(bet|wager|buy\s+(?:yes|no)|place\s+(?:a\s+)?bet|take\s+(?:a\s+)?position\s+on)\b/i.test(trimmed);
    if (isBetIntent) {
      const betTopicMatch = trimmed.match(
        /(?:bet\s+(?:\$?\d[\d.,]*\s+)?on|buy\s+(?:yes|no)\s+on|wager\s+(?:\$?\d[\d.,]*\s+)?on|position\s+on)\s+([a-z0-9$][a-z0-9$\s]{1,50}?)(?:\s+(?:to\s+hit|hitting|winning|passing|losing|going)|\s*[?.]?\s*$)/i
      );
      const cryptoMatch = trimmed.match(
        /\b(bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|avax|matic|dogecoin|doge|cardano|ada|chainlink|link)\b/i
      );
      const betAmountMatch = trimmed.match(/\$(\d[\d.,]*)/);
      const rawTopic = betTopicMatch?.[1]?.trim() || cryptoMatch?.[1]?.trim() || undefined;
      const topic    = rawTopic ? rawTopic.replace(STOP_WORDS_RE, "").trim() : undefined;
      const amount   = betAmountMatch?.[1]?.replace(/,/g, "") ?? undefined;

      if (!senderAddress) {
        return json({ type: "error", text: "Connect your wallet — I need your address to generate a Polymarket deposit address." });
      }

      let markets: PolymarketEvent[];
      try {
        markets = await getTopMarkets(topic, 3);
      } catch {
        return json({ type: "error", text: "Prediction market data is unavailable right now. Try again in a moment." });
      }

      // Topic search came up empty — fall back to top trending markets
      if (markets.length === 0 && topic) {
        try { markets = await getTopMarkets(undefined, 3); } catch { markets = []; }
      }

      if (markets.length === 0) {
        return json({ type: "error", text: "No active prediction markets available right now." });
      }

      const depositAddresses = await generateDepositAddress(senderAddress);
      return json({
        type: "polymarket",
        topic: topic ?? null,
        markets,
        deposit: depositAddresses
          ? { evm: depositAddresses.evm, svm: depositAddresses.svm, btc: depositAddresses.btc, amount }
          : null,
      });
    }

    // View-only: show markets / odds
    const topicMatch = trimmed.match(
      /\b(?:odds\s+(?:on|for|of)|chances?\s+(?:of|for|that)|polymarket\s+(?:on|for)|market\s+(?:for|on))\s+([a-z0-9][a-z0-9 ]{2,39}?)(?:\s+(?:win|winning|happen|pass|lose|hit))?$/i
    );
    const cryptoMatch = trimmed.match(
      /\b(bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|avax|matic|dogecoin|doge|cardano|ada|chainlink|link)\b/i
    );
    const rawTopic = topicMatch?.[1]?.trim() || cryptoMatch?.[1]?.trim() || undefined;
    const topic    = rawTopic ? rawTopic.replace(STOP_WORDS_RE, "").trim() : undefined;

    let markets: PolymarketEvent[];
    try {
      markets = await getTopMarkets(topic);
    } catch {
      return json({ type: "error", text: "Prediction market data is unavailable right now. Try again in a moment." });
    }

    // Topic search came up empty — fall back to top trending markets
    if (markets.length === 0 && topic) {
      try { markets = await getTopMarkets(undefined); } catch { markets = []; }
    }

    if (markets.length === 0) {
      return json({ type: "error", text: "No active prediction markets available right now." });
    }

    return json({ type: "polymarket", topic: topic ?? null, markets, deposit: null });
  }

  // ── informational — handled before parseIntent to avoid a wasted Groq call ──
  if (queryType === "informational") {
    const OPINION_RE = /\b(long|short|buy|sell|hold|good\s+time|should\s+i|worth\s+(?:buying|holding)|time\s+to\s+(?:buy|sell|long|short))\b/i;
    const tokenMatch = trimmed.match(PRICE_TOKEN_RE);

    if (OPINION_RE.test(trimmed)) {
      if (tokenMatch) {
        // Known token (ETH, BTC…) — fetch the live price up front.
        const rawToken    = tokenMatch[1].toLowerCase();
        const symbol      = TOKEN_NAME_TO_SYMBOL[rawToken] ?? rawToken.toUpperCase();
        const priceResult = await getPrice(symbol);
        if (priceResult) {
          // Smart reasons over the real number (grounded analysis); Fast keeps
          // the cheap canned line.
          if (tier === "smart") {
            const text = await getInformationalReply(message, history, tier, meterMeta, {
              liveData: formatLiveData(symbol, priceResult),
            });
            await recordSmart();
            return json({ type: "text", text });
          }
          const fmt    = priceResult.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const change = priceResult.change24h !== null
            ? ` (${priceResult.change24h >= 0 ? "+" : ""}${priceResult.change24h.toFixed(2)}% 24h)`
            : "";
          return json({ type: "text", text: `I can't give trading advice, but here's the data: ${symbol} is currently $${fmt}${change}.` });
        }
      } else {
        // Unknown token — extract from "buy BONK" (verb-first) or "is BONK a good buy" (noun-first)
        const unknownMatch = trimmed.match(
          /(?:buy|sell|long|short|hold(?:ing)?|invest\s+in)\s+(\$?[a-z]{2,15})\b/i
        ) ?? trimmed.match(
          /\b(?:is|should\s+i)\s+(\$?[a-z]{2,15})\b/i
        );
        if (unknownMatch) {
          const query = unknownMatch[1].replace(/^\$/, "");
          const risk  = await scanToken(query);
          if (risk) {
            const analysis = await generateDecisionAnalysis(buildTokenAnalysisPrompt(risk), tier, meterMeta);
            await recordSmart();
            return json({ type: "token_risk", risk, ...(analysis && { analysis }) });
          }
        }
      }
    }

    // "why is X pumping/dumping" — classifyIntent's broad "why is" pattern lands
    // here before it ever reaches the risk-scanner block below, so without this
    // carve-out a live-market momentum question would fall to the generic,
    // ungrounded chat reply. Reuse the same grounded scan (price/liquidity/
    // volume/flags + a directional take) rather than duplicating a new prompt.
    const MOMENTUM_RE = /\b(?:pump\w*|dump\w*|moon\w*|rally\w*|crash\w*|tank\w*|surg\w*|spik\w*)\b/i;
    if (MOMENTUM_RE.test(trimmed)) {
      const momentumMatch = trimmed.match(/(\$?[a-z0-9]{2,20})\s+(?:is\s+)?(?:pump\w*|dump\w*|moon\w*|rally\w*|crash\w*|tank\w*|surg\w*|spik\w*)/i)
        ?? trimmed.match(/(?:pump\w*|dump\w*|moon\w*|rally\w*|crash\w*|tank\w*|surg\w*|spik\w*)[a-z\s]*?(\$[a-z0-9]{2,20})/i);
      // Guard against hijacking a historical/generic question ("explain the 1929
      // crash") — only scan when the captured word is unambiguously a ticker
      // ($-prefixed) or a token Skopos already recognizes.
      const raw = momentumMatch?.[1];
      if (raw && (raw.startsWith("$") || PRICE_TOKEN_RE.test(raw))) {
        const query = raw.replace(/^\$/, "");
        const risk = await scanToken(query);
        if (risk) {
          const analysis = await generateDecisionAnalysis(buildTokenAnalysisPrompt(risk), tier, meterMeta);
          await recordSmart();
          return json({ type: "token_risk", risk, ...(analysis && { analysis }) });
        }
      }
    }

    const liveData = tier === "smart" ? await gatherLiveData(trimmed) : null;
    const text = await getInformationalReply(message, history, tier, meterMeta, {
      ...(liveData ? { liveData } : {}),
    });
    await recordSmart();
    return json({ type: "text", text });
  }

  // ── single-leg intent (runs before scanners so "bridge X for yield" parses as bridge) ──
  const intent = await parseIntent(message);

  if (intent) {
    // Headless clients have no wallet, so a quote build would fail the wallet guard.
    // Hand the intent off to the app via the link instead of building/quoting.
    if (textMode) {
      return json({
        type: "quote",
        mode: "handoff",
        intent: {
          from: { chain: intent.originChain, token: intent.token, amount: intent.amount },
          to:   { chain: intent.destinationChain, token: intent.destinationToken || intent.token },
        },
      });
    }
    const result = await resolveLeg(intent, senderAddress, safeSlippage, solanaAddress, message);
    if (!result.ok) return json({ type: "error", text: result.text });
    const { intent: legIntent, route, approval, calldata, raw } = result as LegOk;
    // Use the resolved display symbols (e.g. CBBTC, not the raw parsed WBTC) so the
    // analysis text never contradicts what the card actually shows.
    const analysisIntent = { ...intent, token: legIntent.from.token, destinationToken: legIntent.to.token };
    const bridgeAnalysis = await generateDecisionAnalysis(buildBridgeAnalysisPrompt(analysisIntent, route), tier, meterMeta);
    await recordSmart();
    return json({ type: "quote", mode: "preview", quotedAt: Date.now(), intent: legIntent, route, approval, calldata, raw, ...(bridgeAnalysis && { analysis: bridgeAnalysis }) });
  }

  // ── token risk scanner ────────────────────────────────────────────────────
  // "deep dive" phrasing is handled earlier (before the price fast-path, since
  // classifyIntent has no signal for it) — not duplicated here.
  const riskMatch = trimmed.match(
    /(?:scan|analyze|check|risk\s+of|is\s+(?:it\s+)?safe|rug(?:pull)?)\s+(?:token\s+)?(\$?[a-z0-9]{2,20}|0x[0-9a-f]{40})/i
  ) ?? trimmed.match(
    // "is PEPE safe to buy?" / "is SHIB legit?" — token comes BETWEEN "is" and the qualifier
    /\bis\s+(\$?[a-z0-9]{2,20})\s+(?:safe|legit|good|risky|a\s+rug)/i
  ) ?? trimmed.match(
    /(?:^|\s)(\$[a-z]{2,10}|0x[0-9a-f]{40})(?:\s|$)/i
  );
  if (riskMatch && /\b(scan|risk|safe|rug|analyze|legit)\b/i.test(trimmed)) {
    const query = riskMatch[1].replace(/^\$/, "");
    const risk = await scanToken(query);
    if (risk) {
      const analysis = await generateDecisionAnalysis(buildTokenAnalysisPrompt(risk), tier, meterMeta);
      await recordSmart();
      return json({ type: "token_risk", risk, ...(analysis && { analysis }) });
    }
    return json({ type: "error", text: `Could not find token data for "${query}". Try a contract address or a well-known symbol.` });
  }

  // ── DeFi yield scanner ────────────────────────────────────────────────────
  // Intentionally runs after parseIntent so "bridge X for yield" resolves as bridge.
  const YIELD_TOKENS = ["USDC", "ETH", "WBTC", "DAI", "USDT", "WETH", "CBBTC", "GHO", "LUSD", "FRAX", "CRVUSD"];
  const yieldKeyword = /\b(yield|apy|apr|earn|interest|rate[s]?|return[s]?)\b/i.test(trimmed);
  const tokenInQuery = YIELD_TOKENS.find(t => new RegExp(`\\b${t}\\b`, "i").test(trimmed));
  const yieldSymbolMatch = trimmed.match(/\b(USDC|USDT|ETH|WETH|WBTC|DAI|GHO|FRAX|LUSD|CRVUSD|CBBTC)\b/i);

  if (yieldKeyword && (tokenInQuery ?? yieldSymbolMatch)) {
    const symbol = (tokenInQuery ?? yieldSymbolMatch![1]).toUpperCase();
    const chainMatch = trimmed.match(/\b(ethereum|base|arbitrum|arb|optimism|op|polygon|avalanche|bsc)\b/i);
    const yieldChain = chainMatch?.[1];
    const pools = await getTopYields(symbol, 10, yieldChain);
    if (pools.length === 0) {
      const where = yieldChain ? ` on ${yieldChain}` : "";
      return json({ type: "error", text: `No yield opportunities found for ${symbol}${where} in major protocols. Try another chain, or USDC, ETH, WBTC, DAI, or USDT.` });
    }
    const analysis = await generateDecisionAnalysis(buildYieldAnalysisPrompt(symbol, pools), tier, meterMeta);
    await recordSmart();
    return json({ type: "yield_pools", symbol, pools, ...(analysis && { analysis }) });
  }

  // Yield query with no recognized token — prompt for specifics
  if (queryType === "yield") {
    return json({ type: "text", text: "Which token do you want yield for? Try: 'find highest yield for USDC' or 'best ETH APY'." });
  }

  // Exec verb with no amount ("swap usdc to eth on base") is a clear execution
  // attempt missing its quantity — classifyIntent can't call this "execution"
  // without a number, so it falls through to here. Give a clean nudge instead of
  // letting the LLM improvise (it has invented placeholder text like "insert
  // current ETH price, which I don't have" for this exact case before).
  const EXEC_VERB_RE = /\b(swap|bridge|send|transfer|move|convert)\b/i;
  if (EXEC_VERB_RE.test(trimmed) && !/\d/.test(trimmed)) {
    const verb = trimmed.match(EXEC_VERB_RE)?.[1]?.toLowerCase() ?? "swap";
    return json({ type: "error", text: `Specify an amount — e.g. "${verb} 100 USDC to ETH on base".` });
  }

  // ── informational fallback — Smart grounds on live price when a token is named;
  //    Fast stays constrained (no live data, number-redacted) ──
  const liveData = tier === "smart" ? await gatherLiveData(trimmed) : null;
  const text = await getInformationalReply(message, history, tier, meterMeta, {
    ...(liveData ? { liveData } : {}),
  });
  await recordSmart();
  return json({ type: "text", text });
}
