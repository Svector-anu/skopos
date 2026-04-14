import { NextRequest, NextResponse } from "next/server";
import {
  CHAIN_NAMES,
  NATIVE_ADDRESS,
  NATIVE_SYMBOLS,
  resolveChainId,
  toWei,
} from "@/lib/chains";
import { getToken, getQuote } from "@/lib/delora";
import { parseIntent, getSuggestion } from "@/lib/parseIntent";

export async function POST(req: NextRequest) {
  const { message, senderAddress } = await req.json();

  if (!message?.trim()) {
    return NextResponse.json({ error: "No message provided" }, { status: 400 });
  }

  const intent = await parseIntent(message);

  if (!intent) {
    return NextResponse.json({
      type: "text",
      text: await getSuggestion(message),
    });
  }

  const destToken = intent.destinationToken;

  const originChainId = resolveChainId(intent.originChain);
  const destChainId = resolveChainId(intent.destinationChain);

  if (!originChainId || !destChainId) {
    const unknown = !originChainId ? intent.originChain : intent.destinationChain;
    return NextResponse.json({
      type: "error",
      text: `Unknown chain: "${unknown}". Supported: ethereum, base, arbitrum, optimism, polygon, avalanche, bsc, and more.`,
    });
  }

  const originNativeSymbol = NATIVE_SYMBOLS[originChainId];
  const destNativeSymbol = NATIVE_SYMBOLS[destChainId];

  let originCurrency = NATIVE_ADDRESS;
  let destCurrency = NATIVE_ADDRESS;
  let originDecimals = 18;
  let destDecimals = 18;

  const isOriginNative =
    intent.token.toUpperCase() === originNativeSymbol?.toUpperCase() ||
    intent.token.toUpperCase() === "ETH";
  const isDestNative =
    destToken.toUpperCase() === destNativeSymbol?.toUpperCase() ||
    destToken.toUpperCase() === "ETH";

  if (!isOriginNative) {
    const tokenData = await getToken(originChainId, intent.token);
    if (!tokenData) {
      return NextResponse.json({
        type: "error",
        text: `Could not find ${intent.token} on ${CHAIN_NAMES[originChainId]}. Check the symbol and try again.`,
      });
    }
    originCurrency = tokenData.address;
    originDecimals = tokenData.decimals;
  }

  if (!isDestNative) {
    const tokenData = await getToken(destChainId, destToken);
    if (!tokenData) {
      return NextResponse.json({
        type: "error",
        text: `Could not find ${destToken} on ${CHAIN_NAMES[destChainId]}.`,
      });
    }
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
      senderAddress: senderAddress ?? undefined,
      receiverAddress: senderAddress ?? undefined,
    });
  } catch (err) {
    return NextResponse.json({
      type: "error",
      text: `Could not get a quote: ${err instanceof Error ? err.message : "Unknown error"}`,
    });
  }

  const rawOut = quote.outputAmount;
  const outputFormatted = rawOut
    ? (Number(rawOut) / 10 ** destDecimals).toFixed(6)
    : "unknown";

  const tool = quote.adapter ?? "best route";

  const feeBreakdown = quote.fees?.breakdown ?? [];
  const gasFee = feeBreakdown.find((f) => f.type === "gas");
  const totalFeesUSD = quote.fees?.totalUsd ?? null;
  const gasUSD = gasFee?.amountUsd ?? null;

  return NextResponse.json({
    type: "quote",
    intent: {
      from: { chain: CHAIN_NAMES[originChainId], chainId: originChainId, token: intent.token, amount: intent.amount },
      to: { chain: CHAIN_NAMES[destChainId], chainId: destChainId, token: destToken },
    },
    route: {
      tool,
      outputAmount: outputFormatted,
      feesUSD: totalFeesUSD,
      gasUSD,
    },
    approval: isOriginNative ? null : {
      tokenAddress: originCurrency,
      spender: quote.calldata?.to ?? null,
      amount: amountWei,
    },
    calldata: quote.calldata ?? null,
    raw: quote,
  });
}
