import { NextRequest, NextResponse } from "next/server";
import { NATIVE_ADDRESS, resolveChainId, toWei } from "@/lib/chains";
import { getToken, getQuote, getChainById, solanaPlaceholder } from "@/lib/delora";
import {
  parseIntent,
  parseRebalanceIntent,
  looksLikeRebalance,
  streamSuggestion,
  generateTxSummary,
  generateAddressSummary,
  buildSuggestions,
  ParsedIntent,
} from "@/lib/parseIntent";
import { lookupTx, lookupAddress, resolveENS } from "@/lib/alchemy";
import { scanToken } from "@/lib/dexscreener";
import { getTopYields } from "@/lib/defillama";
import { getTopMarkets } from "@/lib/polymarket";

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

async function resolveLeg(intent: ParsedIntent, senderAddress?: string, slippage?: number): Promise<LegOk | LegErr> {
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
    const tokenData = await getToken(originChainId, intent.token);
    if (!tokenData) return { ok: false, text: `Could not find ${intent.token} on ${originChain?.name ?? originChainId}.` };
    originCurrency = tokenData.address;
    originDecimals = tokenData.decimals;
  }

  if (!isDestNative) {
    const tokenData = await getToken(destChainId, destToken);
    if (!tokenData) return { ok: false, text: `Could not find ${destToken} on ${destChain?.name ?? destChainId}.` };
    destCurrency = tokenData.address;
    destDecimals = tokenData.decimals;
  }

  const amountWei = toWei(intent.amount, originDecimals);

  let quote;
  try {
    quote = await getQuote({
      originChainId,
      destinationChainId: destChainId,
      amount: amountWei,
      originCurrency,
      destinationCurrency: destCurrency,
      senderAddress:   originChain?.chainType === "SVM" ? solanaPlaceholder("SVM") : senderAddress,
      receiverAddress: destChain?.chainType   === "SVM" ? solanaPlaceholder("SVM") : senderAddress,
      slippage,
    });
  } catch (err) {
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

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ type: "error", text: "Too many requests — slow down and try again in a minute." }, { status: 429 });
  }

  const { message, senderAddress, history, slippage } = await req.json();

  if (!message?.trim()) {
    return NextResponse.json({ error: "No message provided" }, { status: 400 });
  }

  const trimmed = message.trim();

  // ── explorer: ENS name (*.eth) — matches bare "vitalik.eth" or in a sentence ──
  // Character class must NOT include "." — otherwise the greedy * consumes ".eth"
  // before the literal \.eth suffix can match.
  const ensMatch = trimmed.match(/\b([a-z0-9][a-z0-9-]*)\.eth\b/i);
  if (ensMatch) {
    const ensName = (ensMatch[1] + ".eth").toLowerCase();
    const resolved = await resolveENS(ensName);
    if (!resolved) {
      return NextResponse.json({ type: "error", text: `Could not resolve ${ensName}. Make sure the ENS name is registered.` });
    }
    const data = await lookupAddress(resolved);
    const summary = await generateAddressSummary(data);
    return NextResponse.json({ type: "address", data, summary, ensName });
  }

  // ── portfolio: connected wallet ──────────────────────────────────────────
  if (/\b(my\s+)?(portfolio|wallet|balances?|holdings?)\b/i.test(trimmed)) {
    if (!senderAddress) {
      return NextResponse.json({ type: "text", text: "Connect your wallet first — I'll fetch your live balances across all supported chains." });
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
        return NextResponse.json({
          type: "text",
          text: `No assets found on ${label} for this wallet. Active balances are on: ${elsewhere}.`,
        });
      }

      const filteredData = { ...data, balances: filteredBalances, tokenBalances: filteredTokens };
      const summary = await generateAddressSummary(filteredData);
      return NextResponse.json({ type: "address", data: filteredData, summary });
    }

    const summary = await generateAddressSummary(data);
    return NextResponse.json({ type: "address", data, summary });
  }

  // ── explorer: tx hash (0x + 64 hex chars) ───────────────────────────────
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    const tx = await lookupTx(trimmed);
    if (tx) {
      const summary = await generateTxSummary(tx);
      return NextResponse.json({ type: "tx", tx, summary });
    }
    return NextResponse.json({ type: "error", text: "Transaction not found on any supported chain." });
  }

  // ── explorer: address (0x + 40 hex chars) ───────────────────────────────
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    const data = await lookupAddress(trimmed);
    const summary = await generateAddressSummary(data);
    return NextResponse.json({ type: "address", data, summary });
  }

  // ── multi-leg rebalance (checked before single-leg so "split X across Y and Z" isn't captured as a single bridge) ──
  if (looksLikeRebalance(message)) {
    const legs = await parseRebalanceIntent(message);
    if (legs && legs.length >= 2) {
      // Validate that legs are actually cross-chain — same-chain legs indicate the LLM couldn't infer origin
      const samechainLegs = legs.filter(l => resolveChainId(l.originChain) === resolveChainId(l.destinationChain));
      if (samechainLegs.length > 0) {
        return NextResponse.json({ type: "error", text: `Please specify the source chain. For example: "send 0.5 ETH from ethereum to base and 0.5 ETH from ethereum to arbitrum"` });
      }

      const results = await Promise.all(legs.map(leg => resolveLeg(leg, senderAddress, slippage)));

      const firstErr = results.find((r): r is LegErr => !r.ok);
      if (firstErr) {
        return NextResponse.json({ type: "error", text: `Rebalance aborted: ${firstErr.text}` });
      }

      const quotedAt = Date.now();
      return NextResponse.json({
        type: "rebalance",
        mode: "preview",
        quotedAt,
        legs: results.map(r => {
          const { ok: _ok, ...rest } = r as LegOk;
          return { type: "quote", mode: "preview", quotedAt, ...rest };
        }),
      });
    }
  }

  // ── missing-source guard: "bridge X TOKEN to CHAIN" with no "from" ─────────
  // Catch this before parseIntent so Groq never gets a chance to hallucinate a source.
  // Skip the guard when the token itself implies a source chain (e.g. SOL → Solana,
  // BNB → BSC) — the LLM can infer the origin without the user spelling it out.
  const TOKEN_IMPLIES_SOURCE: Record<string, string> = {
    SOL:  "solana",
    MATIC: "polygon",
    BNB:  "bsc",
    AVAX: "avalanche",
    FTM:  "fantom",
    CELO: "celo",
  };
  const missingSource = trimmed.match(
    /^(?:bridge|move|send|transfer|swap)\s+[\d.]+\s+([a-z]+)\s+to\s+([a-z][a-z\s]*?)(?:\s*[?.]?\s*)$/i
  );
  if (missingSource && !/\bfrom\b/i.test(trimmed) && !/\bon\b/i.test(trimmed)) {
    const token = missingSource[1].toUpperCase();
    if (!TOKEN_IMPLIES_SOURCE[token]) {
      // Take only the first word of the dest to avoid "base eth" appearing as a chain name
      const dest = missingSource[2].trim().split(/\s+/)[0];
      return NextResponse.json({
        type: "error",
        text: `Where are you bridging from? Specify the source chain — e.g. "bridge 100 ${token} from base to ${dest}" or "bridge 100 ${token} from arbitrum to ${dest}".`,
      });
    }
  }

  // ── single-leg intent (runs before scanners so "bridge X for yield" parses as bridge) ──
  const intent = await parseIntent(message);

  if (intent) {
    const result = await resolveLeg(intent, senderAddress, slippage);
    if (!result.ok) return NextResponse.json({ type: "error", text: result.text });
    const { ok: _ok, ...rest } = result;
    return NextResponse.json({ type: "quote", mode: "preview", quotedAt: Date.now(), ...rest });
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
    if (risk) return NextResponse.json({ type: "token_risk", risk });
    return NextResponse.json({ type: "error", text: `Could not find token data for "${query}". Try a contract address or a well-known symbol.` });
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
      return NextResponse.json({ type: "error", text: `No yield opportunities found for ${symbol} in major protocols. Try USDC, ETH, WBTC, DAI, or USDT.` });
    }
    return NextResponse.json({ type: "yield_pools", symbol, pools });
  }

  // ── Polymarket prediction markets ────────────────────────────────────────
  const polyKeyword = /\b(polymarket|prediction\s+market|odds|betting\s+odds|market\s+odds|chances?)\b/i.test(trimmed);
  if (polyKeyword) {
    // Only extract a topic when there's a clear subject.
    // Generic queries ("show polymarket markets", "top prediction markets") get no filter → top by volume24hr.
    const topicMatch = trimmed.match(
      /\b(?:odds\s+(?:on|for|of)|chances?\s+(?:of|for|that)|polymarket\s+(?:on|for)|market\s+(?:for|on))\s+([a-z0-9][a-z0-9 ]{2,39}?)(?:\s+(?:win|winning|happen|pass|lose|hit))?$/i
    );
    // Fallback: extract known crypto tickers for price-prediction queries ("odds ETH hits $5k")
    const cryptoMatch = trimmed.match(
      /\b(bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|avax|matic|dogecoin|doge|cardano|ada|chainlink|link)\b/i
    );
    const topic = topicMatch?.[1]?.trim() || cryptoMatch?.[1]?.trim() || undefined;
    const markets = await getTopMarkets(topic);
    if (markets.length === 0) {
      return NextResponse.json({ type: "error", text: `No active Polymarket markets found${topic ? ` for "${topic}"` : ""}. Try a broader topic like "odds on Bitcoin" or "show polymarket markets".` });
    }
    return NextResponse.json({ type: "polymarket", topic: topic ?? null, markets });
  }

  // ── keyword-aware suggestions (synchronous, before LLM fallback) ─────────
  // When the message has a recognisable token/chain/action but not enough
  // structure for parseIntent, return clickable prompt chips instead of
  // generic text so the user can immediately click to try something real.
  const suggestions = buildSuggestions(trimmed);
  if (suggestions && suggestions.length > 0) {
    return NextResponse.json({ type: "suggestions", prompts: suggestions });
  }

  // ── general chat — stream tokens back as plain text ─────────────────────
  return new Response(streamSuggestion(message, history, senderAddress), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
