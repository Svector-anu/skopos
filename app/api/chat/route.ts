import { NextRequest, NextResponse } from "next/server";
import {
  CHAIN_NAMES,
  NATIVE_ADDRESS,
  NATIVE_DECIMALS,
  NATIVE_SYMBOLS,
  resolveChainId,
  toWei,
} from "@/lib/chains";

const SOLANA_CHAIN_ID    = 1000000001;
const SOLANA_SOL_ADDRESS = "11111111111111111111111111111111";
const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111"; // system program — valid Solana placeholder
import { getToken, getQuote } from "@/lib/delora";
import {
  parseIntent,
  parseRebalanceIntent,
  looksLikeRebalance,
  streamSuggestion,
  generateTxSummary,
  generateAddressSummary,
  ParsedIntent,
} from "@/lib/parseIntent";
import { lookupTx, lookupAddress, resolveENS } from "@/lib/alchemy";

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
  // Rule 3: validate amount before touching the API
  const parsedAmount = parseFloat(intent.amount);
  if (!isFinite(parsedAmount) || parsedAmount <= 0) {
    return { ok: false, text: `Invalid amount "${intent.amount}". Amount must be greater than 0.` };
  }

  const originChainId  = resolveChainId(intent.originChain);
  const destChainId    = resolveChainId(intent.destinationChain);

  if (!originChainId || !destChainId) {
    const unknown = !originChainId ? intent.originChain : intent.destinationChain;
    return { ok: false, text: `Unknown chain: "${unknown}". Supported: ethereum, base, arbitrum, optimism, polygon, avalanche, bsc, and more.` };
  }

  const originNativeSymbol = NATIVE_SYMBOLS[originChainId];
  const destNativeSymbol   = NATIVE_SYMBOLS[destChainId];

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

  let originCurrency = NATIVE_ADDRESS;
  let destCurrency   = NATIVE_ADDRESS;
  let originDecimals = NATIVE_DECIMALS[originChainId] ?? 18;
  let destDecimals   = NATIVE_DECIMALS[destChainId]   ?? 18;

  const isOriginNative =
    intent.token.toUpperCase() === originNativeSymbol?.toUpperCase();
  const isDestNative =
    destToken.toUpperCase() === destNativeSymbol?.toUpperCase();

  // Solana native SOL: address is a fixed base58 system program, not EVM zero address
  if (isOriginNative && originChainId === SOLANA_CHAIN_ID) {
    originCurrency = SOLANA_SOL_ADDRESS;
    originDecimals = 9;
  } else if (isOriginNative && NATIVE_DECIMALS[originChainId] !== undefined) {
    const tokenData = await getToken(originChainId, originNativeSymbol ?? intent.token);
    if (!tokenData) return { ok: false, text: `${intent.token} on ${CHAIN_NAMES[originChainId]} is not yet supported. Try an EVM-to-EVM route instead.` };
    originCurrency = tokenData.address;
    originDecimals = tokenData.decimals;
  }

  if (isDestNative && destChainId === SOLANA_CHAIN_ID) {
    destCurrency = SOLANA_SOL_ADDRESS;
    destDecimals = 9;
  } else if (isDestNative && NATIVE_DECIMALS[destChainId] !== undefined) {
    const tokenData = await getToken(destChainId, destNativeSymbol ?? destToken);
    if (!tokenData) return { ok: false, text: `${destToken} on ${CHAIN_NAMES[destChainId]} is not yet supported as a destination.` };
    destCurrency = tokenData.address;
    destDecimals = tokenData.decimals;
  }

  if (!isOriginNative) {
    const tokenData = await getToken(originChainId, intent.token);
    if (!tokenData) return { ok: false, text: `Could not find ${intent.token} on ${CHAIN_NAMES[originChainId]}.` };
    originCurrency = tokenData.address;
    originDecimals = tokenData.decimals;
  }

  if (!isDestNative) {
    const tokenData = await getToken(destChainId, destToken);
    if (!tokenData) return { ok: false, text: `Could not find ${destToken} on ${CHAIN_NAMES[destChainId]}.` };
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
      senderAddress:   originChainId === SOLANA_CHAIN_ID ? SOLANA_SYSTEM_PROGRAM : senderAddress,
      receiverAddress: destChainId   === SOLANA_CHAIN_ID ? SOLANA_SYSTEM_PROGRAM : senderAddress,
      slippage,
    });
  } catch (err) {
    const msg        = err instanceof Error ? err.message : "Unknown error";
    const noAdapters = msg.includes("No adapters available");
    const isSolana   = originChainId === 1000000001 || destChainId === 1000000001;
    return {
      ok: false,
      text: noAdapters
        ? isSolana
          ? `No route found for ${intent.amount} ${intent.token} on Solana. Solana cross-chain routes require Mayan bridge — try a larger amount (≥0.1 SOL) or check back as liquidity improves.`
          : `No route found for ${intent.amount} ${intent.token} — amount may be too small. Try at least 0.001 ETH or $1 worth.`
        : `Could not get a quote: ${msg}`,
    };
  }

  const outputFormatted = quote.outputAmount
    ? (Number(quote.outputAmount) / 10 ** destDecimals).toFixed(6)
    : "unknown";

  const tool           = quote.adapter ?? "best route";
  const feeBreakdown   = quote.fees?.breakdown ?? [];
  const gasFee         = feeBreakdown.find((f) => f.type === "gas");
  const totalFeesUSD   = quote.fees?.totalUsd ?? null;
  const gasUSD         = gasFee?.amountUsd ?? null;

  return {
    ok: true,
    intent: {
      from: { chain: CHAIN_NAMES[originChainId], chainId: originChainId, token: intent.token, amount: intent.amount },
      to:   { chain: CHAIN_NAMES[destChainId],   chainId: destChainId,   token: destToken },
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

  // ── explorer: ENS name (*.eth) ──────────────────────────────────────────
  if (/^[a-z0-9][a-z0-9-_.]*\.eth$/i.test(trimmed)) {
    const resolved = await resolveENS(trimmed);
    if (!resolved) {
      return NextResponse.json({ type: "error", text: `Could not resolve ${trimmed}. Make sure the ENS name is registered.` });
    }
    const data = await lookupAddress(resolved);
    const summary = await generateAddressSummary(data);
    return NextResponse.json({ type: "address", data, summary, ensName: trimmed });
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
        const label = requestedChainId ? (CHAIN_NAMES[requestedChainId] ?? requestedChain) : requestedChain;
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

  // ── single-leg intent ────────────────────────────────────────────────────
  const intent = await parseIntent(message);

  if (intent) {
    const result = await resolveLeg(intent, senderAddress, slippage);
    if (!result.ok) return NextResponse.json({ type: "error", text: result.text });
    const { ok: _ok, ...rest } = result;
    return NextResponse.json({ type: "quote", mode: "preview", quotedAt: Date.now(), ...rest });
  }

  // ── multi-leg rebalance ──────────────────────────────────────────────────
  if (looksLikeRebalance(message)) {
    const legs = await parseRebalanceIntent(message);
    if (legs && legs.length >= 2) {
      const results = await Promise.all(legs.map(leg => resolveLeg(leg, senderAddress, slippage)));

      // Rule 4: fail fast — if any leg errored, surface the first failure
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

  // ── general chat — stream tokens back as plain text ─────────────────────
  return new Response(streamSuggestion(message, history, senderAddress), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
