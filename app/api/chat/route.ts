import { NextRequest, NextResponse } from "next/server";
import {
  CHAIN_NAMES,
  NATIVE_ADDRESS,
  NATIVE_SYMBOLS,
  resolveChainId,
  toWei,
} from "@/lib/chains";
import { getToken, getQuote } from "@/lib/delora";
import {
  parseIntent,
  parseRebalanceIntent,
  looksLikeRebalance,
  getSuggestion,
  ParsedIntent,
} from "@/lib/parseIntent";

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

  const destToken      = intent.destinationToken;
  const originChainId  = resolveChainId(intent.originChain);
  const destChainId    = resolveChainId(intent.destinationChain);

  if (!originChainId || !destChainId) {
    const unknown = !originChainId ? intent.originChain : intent.destinationChain;
    return { ok: false, text: `Unknown chain: "${unknown}". Supported: ethereum, base, arbitrum, optimism, polygon, avalanche, bsc, and more.` };
  }

  const originNativeSymbol = NATIVE_SYMBOLS[originChainId];
  const destNativeSymbol   = NATIVE_SYMBOLS[destChainId];

  let originCurrency = NATIVE_ADDRESS;
  let destCurrency   = NATIVE_ADDRESS;
  let originDecimals = 18;
  let destDecimals   = 18;

  const isOriginNative =
    intent.token.toUpperCase() === originNativeSymbol?.toUpperCase() ||
    intent.token.toUpperCase() === "ETH";
  const isDestNative =
    destToken.toUpperCase() === destNativeSymbol?.toUpperCase() ||
    destToken.toUpperCase() === "ETH";

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
      senderAddress:   senderAddress ?? undefined,
      receiverAddress: senderAddress ?? undefined,
      slippage,
    });
  } catch (err) {
    const msg        = err instanceof Error ? err.message : "Unknown error";
    const noAdapters = msg.includes("No adapters available");
    return {
      ok: false,
      text: noAdapters
        ? `No route found for ${intent.amount} ${intent.token} — amount may be too small. Try at least 0.001 ETH or $1 worth.`
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
  const { message, senderAddress, history, slippage } = await req.json();

  if (!message?.trim()) {
    return NextResponse.json({ error: "No message provided" }, { status: 400 });
  }

  // ── single-leg intent ────────────────────────────────────────────────────
  const intent = await parseIntent(message);

  if (intent) {
    const result = await resolveLeg(intent, senderAddress, slippage);
    if (!result.ok) return NextResponse.json({ type: "error", text: result.text });
    const { ok: _ok, ...rest } = result;
    return NextResponse.json({ type: "quote", mode: "preview", ...rest });
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

      return NextResponse.json({
        type: "rebalance",
        mode: "preview",
        legs: results.map(r => {
          const { ok: _ok, ...rest } = r as LegOk;
          return { type: "quote", mode: "preview", ...rest };
        }),
      });
    }
  }

  // ── general chat ────────────────────────────────────────────────────────
  return NextResponse.json({
    type: "text",
    text: await getSuggestion(message, history, senderAddress),
  });
}
