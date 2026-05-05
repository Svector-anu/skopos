import { NextRequest, NextResponse } from "next/server";
import { NATIVE_ADDRESS, resolveChainId, toWei } from "@/lib/chains";
import { getToken, getQuote, getChainById,} from "@/lib/delora";
import {
  parseIntent,
  parseRebalanceIntent,
  looksLikeRebalance,
  getGroqInformationalReply,
  generateTxSummary,
  generateAddressSummary,
  buildSuggestions,
  classifyIntent,
  ParsedIntent,
} from "@/lib/parseIntent";
import { lookupTx, lookupAddress, resolveENS } from "@/lib/alchemy";
import { scanToken } from "@/lib/dexscreener";
import { getTopYields } from "@/lib/defillama";
import { getTopMarkets } from "@/lib/polymarket";
import { generateDepositAddress, getDepositStatus, getPolymarketBalance } from "@/lib/polymarket-bridge";
import { getPrice } from "@/lib/priceCache";

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

  // EVM → Solana: receiverAddress must be a valid base58 Solana pubkey
  if (isSolanaDest && (!solanaAddress || !SOLANA_PUBKEY_RE.test(solanaAddress))) {
    return {
      ok: false,
      text: "To bridge to Solana you need a Phantom wallet connected. Connect Phantom first, then try again.",
    };
  }

  // Solana → EVM: senderAddress must be a valid base58 Solana pubkey
  if (isSolanaOrigin && (!solanaAddress || !SOLANA_PUBKEY_RE.test(solanaAddress))) {
    return {
      ok: false,
      text: "Connect your Phantom wallet to bridge from Solana.",
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
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!checkRateLimit(ip)) {
    return json({ type: "error", text: "Too many requests — slow down and try again in a minute." }, { status: 429 });
  }

  const { message, senderAddress, solanaAddress, history, slippage } = await req.json();

  if (!message?.trim()) {
    return json({ error: "No message provided" }, { status: 400 });
  }

  const trimmed = message.trim();

  if (trimmed.length > 2000) {
    return json({ type: "error", text: "Message too long." }, { status: 400 });
  }

  const rawSlip = typeof slippage === "number" ? slippage : parseFloat(String(slippage ?? ""));
  const safeSlippage = Number.isFinite(rawSlip) && rawSlip >= 0 && rawSlip <= 0.1 ? rawSlip : 0.005;

  const queryType = classifyIntent(trimmed);
  console.log(`[chat] ip=${ip} type=${queryType} len=${trimmed.length}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // PRICE FAST-PATH
  // Runs before structural checks — a classified "price" query must never fall
  // through to address/ENS lookups. Structural layer assumes input is unclassified.
  // ═══════════════════════════════════════════════════════════════════════════

  if (queryType === "price") {
    const tokenMatch = trimmed.match(PRICE_TOKEN_RE);
    const rawSymbol  = tokenMatch?.[1] ?? "";
    const symbol     = (TOKEN_NAME_TO_SYMBOL[rawSymbol.toLowerCase()] ?? rawSymbol).toUpperCase();
    const result     = await getPrice(symbol);
    if (!result || result.price <= 0) {
      return json({ type: "error", text: "Unable to fetch reliable data right now." });
    }
    const { price, change24h, source } = result;
    console.log(`[price] query symbol=${symbol} price=${price} source=${source}`);
    const fmtPrice  = price >= 1000
      ? `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : price >= 1 ? `$${price.toFixed(4)}` : `$${price.toPrecision(4)}`;
    const fmtChange = change24h != null
      ? ` (${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}% 24h)`
      : "";
    return json({ type: "text", text: `${symbol} is ${fmtPrice}${fmtChange}.` });
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
  if (/\b(my\s+)?(portfolio|wallet|balances?|holdings?)\b/i.test(trimmed)) {
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
    SOL:  "solana",
    MATIC: "polygon",
    BNB:  "bsc",
    AVAX: "avalanche",
    FTM:  "fantom",
    CELO: "celo",
    BASE: "base",
  };
  const missingSource = trimmed.match(
    /^(?:bridge|move|send|transfer|swap)\s+[\d.]+\s+([a-z]+)\s+to\s+([a-z][a-z\s]*?)(?:\s*[?.]?\s*)$/i
  );
  if (missingSource && !/\bfrom\b/i.test(trimmed) && !/\bon\b/i.test(trimmed)) {
    const token = missingSource[1].toUpperCase();
    if (!TOKEN_IMPLIES_SOURCE[token]) {
      const dest = missingSource[2].trim().split(/\s+/)[0];
      return json({
        type: "error",
        text: `Where are you bridging from? Specify the source chain — e.g. "bridge 100 ${token} from base to ${dest}" or "bridge 100 ${token} from arbitrum to ${dest}".`,
      });
    }
  }

  // Prediction → Polymarket (single entry point via classifyIntent)
  if (queryType === "prediction") {
    const isBetIntent = /\b(bet|wager|buy\s+(?:yes|no)|place\s+(?:a\s+)?bet|take\s+(?:a\s+)?position\s+on)\b/i.test(trimmed);
    if (isBetIntent) {
      const betTopicMatch = trimmed.match(
        /(?:bet\s+(?:\$?\d[\d.,]*\s+)?on|buy\s+(?:yes|no)\s+on|wager\s+(?:\$?\d[\d.,]*\s+)?on|position\s+on)\s+([a-z0-9$][a-z0-9$\s]{1,50}?)(?:\s+(?:to\s+hit|hitting|winning|passing|losing|going)|\s*[?.]?\s*$)/i
      );
      const cryptoMatch = trimmed.match(
        /\b(bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|avax|matic|dogecoin|doge|cardano|ada|chainlink|link)\b/i
      );
      const betAmountMatch = trimmed.match(/\$(\d[\d.,]*)/);
      const topic = betTopicMatch?.[1]?.trim() || cryptoMatch?.[1]?.trim() || undefined;
      const amount = betAmountMatch?.[1]?.replace(/,/g, "") ?? undefined;

      if (!senderAddress) {
        return json({ type: "error", text: "Connect your wallet — I need your address to generate a Polymarket deposit address." });
      }

      try {
        const [markets, depositAddresses] = await Promise.all([
          getTopMarkets(topic, 3),
          generateDepositAddress(senderAddress),
        ]);
        if (markets.length === 0) {
          return json({ type: "error", text: "Unable to fetch prediction market data right now." });
        }
        return json({
          type: "polymarket",
          topic: topic ?? null,
          markets,
          deposit: depositAddresses
            ? { evm: depositAddresses.evm, svm: depositAddresses.svm, btc: depositAddresses.btc, amount }
            : null,
        });
      } catch {
        return json({ type: "error", text: "Unable to fetch prediction market data right now." });
      }
    }

    // View-only: show markets / odds
    const topicMatch = trimmed.match(
      /\b(?:odds\s+(?:on|for|of)|chances?\s+(?:of|for|that)|polymarket\s+(?:on|for)|market\s+(?:for|on))\s+([a-z0-9][a-z0-9 ]{2,39}?)(?:\s+(?:win|winning|happen|pass|lose|hit))?$/i
    );
    const cryptoMatch = trimmed.match(
      /\b(bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|avax|matic|dogecoin|doge|cardano|ada|chainlink|link)\b/i
    );
    const topic = topicMatch?.[1]?.trim() || cryptoMatch?.[1]?.trim() || undefined;
    try {
      const markets = await getTopMarkets(topic);
      if (markets.length === 0) {
        return json({ type: "error", text: "Unable to fetch prediction market data right now." });
      }
      return json({ type: "polymarket", topic: topic ?? null, markets, deposit: null });
    } catch {
      return json({ type: "error", text: "Unable to fetch prediction market data right now." });
    }
  }

  // ── informational — handled before parseIntent to avoid a wasted Groq call ──
  if (queryType === "informational") {
    const text = await getGroqInformationalReply(message, history);
    return json({ type: "text", text });
  }

  // ── single-leg intent (runs before scanners so "bridge X for yield" parses as bridge) ──
  const intent = await parseIntent(message);

  if (intent) {
    const result = await resolveLeg(intent, senderAddress, safeSlippage, solanaAddress);
    if (!result.ok) return json({ type: "error", text: result.text });
    const { intent: legIntent, route, approval, calldata, raw } = result as LegOk;
    return json({ type: "quote", mode: "preview", quotedAt: Date.now(), intent: legIntent, route, approval, calldata, raw });
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
    if (risk) return json({ type: "token_risk", risk });
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
    return json({ type: "yield_pools", symbol, pools });
  }

  // Yield query with no recognized token — prompt for specifics
  if (queryType === "yield") {
    return json({ type: "text", text: "Which token do you want yield for? Try: 'find highest yield for USDC' or 'best ETH APY'." });
  }

  // ── keyword-aware suggestions — only for execution/unknown intents ────────
  if (queryType === "execution" || queryType === "unknown") {
    const suggestions = buildSuggestions(trimmed);
    if (suggestions && suggestions.length > 0) {
      return json({ type: "text", text: "To bridge or swap, include an amount, source chain, and destination — or pick one of these:", suggestions });
    }
  }

  // ── constrained informational fallback — no live data, no transaction suggestions ──
  const text = await getGroqInformationalReply(message, history);
  return json({ type: "text", text });
}
