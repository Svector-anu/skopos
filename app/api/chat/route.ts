import { NextRequest, NextResponse } from "next/server";
import { NATIVE_ADDRESS, resolveChainId, toWei } from "@/lib/chains";
import { getToken, getQuote, getChainById,} from "@/lib/delora";
import {
  parseIntent,
  parseRebalanceIntent,
  looksLikeRebalance,
  getGroqInformationalReply,
  generateDecisionAnalysis,
  generateTxSummary,
  generateAddressSummary,
  classifyIntent,
  ParsedIntent,
} from "@/lib/parseIntent";
import { lookupTx, lookupAddress, resolveENS } from "@/lib/alchemy";
import { scanToken, type TokenRisk } from "@/lib/dexscreener";
import { getTopYields, type YieldPool } from "@/lib/defillama";
import { getTopMarkets, PolymarketEvent } from "@/lib/polymarket";
import { generateDepositAddress, getDepositStatus, getPolymarketBalance } from "@/lib/polymarket-bridge";
import { getPrice, getPriceChart } from "@/lib/priceCache";
import { getPythRates, getPythRate, toUSDRate, type PythFeedKey } from "@/lib/pyth";

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
    `\nGive a directional take: who does this setup favor — buyers, sellers, or neither? What is the key risk?`,
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

  return `${symbol} yield opportunities:\n${lines}\n\nClassify each as sustainable real yield or an emission-funded coordination game. Give a directional take on which pool structurally favors LPs vs. which extracts from them.`;
}

function buildBridgeAnalysisPrompt(
  intent: ParsedIntent,
  route: { tool: string; outputAmount: string; feesUSD: string | null; gasUSD: string | null },
): string {
  const inputAmt  = parseFloat(intent.amount);
  const outputAmt = parseFloat(route.outputAmount);
  const sameToken = intent.token.toUpperCase() === intent.destinationToken.toUpperCase();
  const efficiencyPct = sameToken && inputAmt > 0
    ? ((outputAmt / inputAmt) * 100).toFixed(2)
    : null;

  return [
    `Bridge: ${intent.amount} ${intent.token} from ${intent.originChain} → ${intent.destinationChain}, receiving ${intent.destinationToken}`,
    `Adapter: ${route.tool}`,
    `Output: ${route.outputAmount} ${intent.destinationToken}`,
    efficiencyPct ? `Route efficiency: ${efficiencyPct}% (${(100 - parseFloat(efficiencyPct)).toFixed(2)}% lost)` : null,
    route.feesUSD ? `Total fees: $${route.feesUSD}` : null,
    route.gasUSD  ? `Gas: $${route.gasUSD}` : null,
    `\nGive a directional take: is this route worth executing at these costs, or should the user reconsider? Flag anything worth knowing about the adapter or route.`,
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

type LegOk = {
  ok: true;
  intent: {
    from: { chain: string; chainId: number; token: string; amount: string };
    to:   { chain: string; chainId: number; token: string };
  };
  route: { tool: string; outputAmount: string; feesUSD: string | null; gasUSD: string | null };
  approval: { tokenAddress: string; spender: string; amount: string } | null;
  calldata: { to: string; value: string; data: string } | null;
  raw: unknown;
};

type LegErr = { ok: false; text: string };

const SOLANA_CHAIN_ID = 1000000001;

async function resolveLeg(intent: ParsedIntent, senderAddress?: string, slippage?: number, solanaAddress?: string): Promise<LegOk | LegErr> {
  const parsedAmount = parseFloat(intent.amount);
  if (!isFinite(parsedAmount) || parsedAmount <= 0) {
    return { ok: false, text: `Invalid amount "${intent.amount}". Amount must be greater than 0.` };
  }

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
    let tokenData = await getToken(originChainId, intent.token);
    // ETH on non-ETH chains (Polygon, BSC, etc.) is listed as WETH — fall back transparently
    if (!tokenData && intent.token.toUpperCase() === "ETH" && originNativeSymbol?.toUpperCase() !== "ETH") {
      tokenData = await getToken(originChainId, "WETH");
    }
    if (!tokenData) return { ok: false, text: `Could not find ${intent.token} on ${originChain?.name ?? originChainId}.` };
    originCurrency = tokenData.address;
    originDecimals = tokenData.decimals;
  }

  if (!isDestNative) {
    let tokenData = await getToken(destChainId, destToken);
    // ETH on non-ETH chains — same fallback as origin
    if (!tokenData && destToken.toUpperCase() === "ETH" && destNativeSymbol?.toUpperCase() !== "ETH") {
      tokenData = await getToken(destChainId, "WETH");
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

  const outputFormatted = quote.outputAmount
    ? (Number(quote.outputAmount) / 10 ** destDecimals).toFixed(6)
    : "unknown";

  const tool         = quote.adapter ?? "best route";
  const feeBreakdown = quote.fees?.breakdown ?? [];
  const gasFee       = feeBreakdown.find((f) => f.type === "gas");
  const totalFeesUSD = quote.fees?.totalUsd ?? null;
  const gasUSD       = gasFee?.amountUsd ?? null;

  return {
    ok: true,
    intent: {
      from: { chain: originChain?.name ?? String(originChainId), chainId: originChainId, token: intent.token, amount: intent.amount },
      to:   { chain: destChain?.name   ?? String(destChainId),   chainId: destChainId,   token: destToken },
    },
    route:    { tool, outputAmount: outputFormatted, feesUSD: totalFeesUSD, gasUSD },
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

export async function POST(req: NextRequest) {
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

  const { message, senderAddress, solanaAddress: rawSolanaAddress, history, slippage } = await req.json();

  if (!message?.trim()) {
    return json({ error: "No message provided" }, { status: 400, headers: corsHeaders });
  }

  const trimmed = message.trim();

  // Length check runs before any regex to prevent adversarial ReDoS inputs
  if (trimmed.length > 2000) {
    return json({ type: "error", text: "Message too long." }, { status: 400, headers: corsHeaders });
  }

  // If Phantom isn't connected, the user can paste their Solana address inline.
  // Extract it so EVM→Solana bridges can proceed without Phantom.
  const SOLANA_INLINE_RE = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/;
  const inlineSolanaAddr  = !rawSolanaAddress ? trimmed.match(SOLANA_INLINE_RE)?.[1] : undefined;
  const solanaAddress     = rawSolanaAddress ?? inlineSolanaAddr;

  const rawSlip = typeof slippage === "number" ? slippage : parseFloat(String(slippage ?? ""));
  const safeSlippage = Number.isFinite(rawSlip) && rawSlip >= 0 && rawSlip <= 0.1 ? rawSlip : 0.005;

  const queryType = classifyIntent(trimmed);
  console.log(`[chat] ip=${ip} type=${queryType} len=${trimmed.length}`);

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

  // ═══════════════════════════════════════════════════════════════════════════
  // PRICE FAST-PATH
  // Runs before structural checks — a classified "price" query must never fall
  // through to address/ENS lookups. Structural layer assumes input is unclassified.
  // ═══════════════════════════════════════════════════════════════════════════

  if (queryType === "price") {
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
    const isMSFT = /\b(msft|microsoft)\b/i.test(trimmed);
    const key: PythFeedKey  = isMSFT ? "MSFT" : "AAPL";
    const ticker = isMSFT ? "MSFT" : "AAPL";
    const name   = isMSFT ? "Microsoft" : "Apple";

    const rate = await getPythRate(key);
    if (!rate || rate.price <= 0) {
      return json({ type: "error", text: `Unable to fetch ${name} price right now.` });
    }

    const fmt = rate.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const staleNote = rate.stale
      ? " (US markets closed — last close price)"
      : " (live — US market hours)";
    return json({
      type: "text",
      text: `${name} (${ticker}): $${fmt}${staleNote}`,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 1 — STRUCTURAL
  // Format-based detection: ENS names, addresses, tx hashes.
  // No intent classification. No wallet required.
  // ═══════════════════════════════════════════════════════════════════════════

  // ENS name (*.eth) — character class must NOT include "." or the greedy * eats ".eth"
  const ensMatch = trimmed.match(/\b([a-z0-9][a-z0-9-]*)\.eth\b/i);
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

  // Address embedded in a sentence ("analyze wallet 0x…", "check 0x…")
  const embeddedAddrMatch = trimmed.match(/\b(0x[0-9a-fA-F]{40})\b/);
  if (embeddedAddrMatch && !/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    const data = await lookupAddress(embeddedAddrMatch[1]);
    const summary = await generateAddressSummary(data);
    return json({ type: "address", data, summary });
  }

  // TX hash — exactly 0x + 64 hex chars
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    const tx = await lookupTx(trimmed);
    if (tx) {
      const summary = await generateTxSummary(tx);
      return json({ type: "tx", tx, summary });
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

  // Multi-leg rebalance — must run before single-leg so "split X across Y and Z" isn't parsed as one bridge
  if (looksLikeRebalance(message)) {
    const legs = await parseRebalanceIntent(message);
    if (legs && legs.length >= 2) {
      // Validate that legs are actually cross-chain — same-chain legs indicate the LLM couldn't infer origin
      const samechainLegs = legs.filter(l => resolveChainId(l.originChain) === resolveChainId(l.destinationChain));
      if (samechainLegs.length > 0) {
        return json({ type: "error", text: `Please specify the source chain. For example: "send 0.5 ETH from ethereum to base and 0.5 ETH from ethereum to arbitrum"` });
      }

      const results = await Promise.all(legs.map(leg => resolveLeg(leg, senderAddress, safeSlippage, solanaAddress)));

      const firstErr = results.find((r): r is LegErr => !r.ok);
      if (firstErr) {
        return json({ type: "error", text: `Rebalance aborted: ${firstErr.text}` });
      }

      const quotedAt = Date.now();
      return json({
        type: "rebalance",
        mode: "preview",
        quotedAt,
        legs: results.map(r => {
          const { intent, route, approval, calldata, raw } = r as LegOk;
          return { type: "quote", mode: "preview", quotedAt, intent, route, approval, calldata, raw };
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
        // Known token (ETH, BTC…) — live price inline, no Groq needed
        const rawToken    = tokenMatch[1].toLowerCase();
        const symbol      = TOKEN_NAME_TO_SYMBOL[rawToken] ?? rawToken.toUpperCase();
        const priceResult = await getPrice(symbol);
        if (priceResult) {
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
            const analysis = await generateDecisionAnalysis(buildTokenAnalysisPrompt(risk));
            return json({ type: "token_risk", risk, ...(analysis && { analysis }) });
          }
        }
      }
    }

    const text = await getGroqInformationalReply(message, history);
    return json({ type: "text", text });
  }

  // ── single-leg intent (runs before scanners so "bridge X for yield" parses as bridge) ──
  const intent = await parseIntent(message);

  if (intent) {
    const result = await resolveLeg(intent, senderAddress, safeSlippage, solanaAddress);
    if (!result.ok) return json({ type: "error", text: result.text });
    const { intent: legIntent, route, approval, calldata, raw } = result as LegOk;
    const bridgeAnalysis = await generateDecisionAnalysis(buildBridgeAnalysisPrompt(intent, route));
    return json({ type: "quote", mode: "preview", quotedAt: Date.now(), intent: legIntent, route, approval, calldata, raw, ...(bridgeAnalysis && { analysis: bridgeAnalysis }) });
  }

  // ── token risk scanner ────────────────────────────────────────────────────
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
      const analysis = await generateDecisionAnalysis(buildTokenAnalysisPrompt(risk));
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
    const pools = await getTopYields(symbol);
    if (pools.length === 0) {
      return json({ type: "error", text: `No yield opportunities found for ${symbol} in major protocols. Try USDC, ETH, WBTC, DAI, or USDT.` });
    }
    const analysis = await generateDecisionAnalysis(buildYieldAnalysisPrompt(symbol, pools));
    return json({ type: "yield_pools", symbol, pools, ...(analysis && { analysis }) });
  }

  // Yield query with no recognized token — prompt for specifics
  if (queryType === "yield") {
    return json({ type: "text", text: "Which token do you want yield for? Try: 'find highest yield for USDC' or 'best ETH APY'." });
  }

  // ── constrained informational fallback — no live data, no transaction suggestions ──
  const text = await getGroqInformationalReply(message, history);
  return json({ type: "text", text });
}
