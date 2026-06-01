import { NextRequest, NextResponse } from "next/server";
import { parseUnits } from "viem";
import { getPrice } from "@/lib/priceCache";
import { scanToken } from "@/lib/dexscreener";
import { getTopYields } from "@/lib/defillama";
import { getTopMarkets } from "@/lib/polymarket";
import { getQuote, getToken } from "@/lib/delora";
import { lookupAddress } from "@/lib/alchemy";
import { CHAIN_IDS } from "@/lib/chains";
import { classifyIntent } from "@/lib/parseIntent";

const RELAY_SECRET = process.env.RELAY_SECRET;
if (!RELAY_SECRET) {
  console.error("[/api/vara] RELAY_SECRET is not set — all requests will be rejected with 401");
}

function respond(data: unknown): NextResponse {
  return NextResponse.json({ result: JSON.stringify(data) });
}

function fail(msg: string, status: number): NextResponse {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!RELAY_SECRET || auth !== `Bearer ${RELAY_SECRET}`) {
    return fail("unauthorized", 401);
  }

  let body: { queryType?: string; params?: Record<string, unknown> };
  try {
    body = await req.json() as { queryType?: string; params?: Record<string, unknown> };
  } catch {
    return fail("invalid JSON body", 400);
  }

  const { queryType, params = {} } = body;

  try {
    switch (queryType) {
      case "price": {
        const symbol = String(params.symbol ?? "ETH").toUpperCase();
        const result = await getPrice(symbol);
        if (!result) return fail(`no price data for ${symbol}`, 400);
        return respond({
          symbol: result.symbol,
          price: result.price,
          change24h: result.change24h,
          source: result.source,
        });
      }

      case "risk": {
        const token = String(params.token ?? "");
        const chain = String(params.chain ?? "ethereum");
        if (!token) return fail("params.token is required", 400);
        const result = await scanToken(token);
        if (!result) return fail(`no risk data for ${token}`, 400);
        return respond({
          token: result.symbol,
          chain,
          score: result.score,
          flags: result.flags,
          liquidityUsd: result.totalLiquidityUsd,
        });
      }

      case "yield": {
        const protocol = params.protocol ? String(params.protocol) : undefined;
        const chain = params.chain ? String(params.chain).toLowerCase() : undefined;
        const symbol = params.symbol ? String(params.symbol).toUpperCase() : "";
        const limit = Math.min(Number(params.limit ?? 5), 20);
        let pools = await getTopYields(symbol, 500);
        if (protocol) pools = pools.filter(p => p.project === protocol);
        if (chain) pools = pools.filter(p => p.chain.toLowerCase() === chain);
        // Sort by TVL descending (most liquid first) within a sane APY band;
        // deduplicate by protocol+chain+symbol so the same vault doesn't repeat
        const seen = new Set<string>();
        pools = pools
          .filter(p => p.apy >= 0.5 && p.apy <= 30 && p.tvlUsd >= 1_000_000)
          .sort((a, b) => b.tvlUsd - a.tvlUsd)
          .filter(p => {
            const key = `${p.project}/${p.chain}/${p.symbol}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, limit);
        return respond({
          pools: pools.map(p => ({
            protocol: p.project,
            chain: p.chain,
            symbol: p.symbol,
            apy: p.apy,
            tvlUsd: p.tvlUsd,
          })),
        });
      }

      case "markets": {
        const topic = params.topic ? String(params.topic) : undefined;
        const limit = Math.min(Number(params.limit ?? 5), 10);
        const events = await getTopMarkets(topic, limit * 2);
        const markets = events
          .flatMap(e =>
            e.markets.map(m => ({
              title: m.question,
              probability: m.outcomePrices[0] != null ? parseFloat(m.outcomePrices[0]) : 0.5,
              volume24h: m.volume,
              endDate: m.endDate ?? undefined,
            }))
          )
          .slice(0, limit);
        return respond({ markets });
      }

      case "quote": {
        const originChain = String(params.originChain ?? "");
        const destinationChain = String(params.destinationChain ?? "");
        const token = String(params.token ?? "");
        const destinationToken = String(params.destinationToken ?? token);
        const amount = String(params.amount ?? "");
        const senderAddress = String(params.senderAddress ?? "");
        const receiverAddress = String(params.receiverAddress ?? "");
        const slippage = params.slippage != null ? Number(params.slippage) : undefined;

        if (!originChain || !destinationChain || !token || !amount || !senderAddress || !receiverAddress) {
          return fail("quote requires: originChain, destinationChain, token, amount, senderAddress, receiverAddress", 400);
        }

        const originChainId = CHAIN_IDS[originChain.toLowerCase()];
        const destinationChainId = CHAIN_IDS[destinationChain.toLowerCase()];
        if (!originChainId) return fail(`unknown originChain: ${originChain}`, 400);
        if (!destinationChainId) return fail(`unknown destinationChain: ${destinationChain}`, 400);

        const [originTok, destTok] = await Promise.all([
          getToken(originChainId, token),
          getToken(destinationChainId, destinationToken),
        ]);
        if (!originTok) return fail(`token ${token} not found on ${originChain}`, 400);
        if (!destTok) return fail(`token ${destinationToken} not found on ${destinationChain}`, 400);

        // Delora expects amount as a raw integer string (in token's smallest unit).
        // The oracle payload carries human-readable amounts (e.g. "0.1"), so convert here.
        let amountWei: string;
        try {
          amountWei = parseUnits(amount, originTok.decimals).toString();
        } catch {
          return fail(`invalid amount: ${amount}`, 400);
        }

        const quote = await getQuote({
          originChainId,
          destinationChainId,
          amount: amountWei,
          originCurrency: originTok.address,
          destinationCurrency: destTok.address,
          senderAddress,
          receiverAddress,
          slippage,
        });

        return respond({
          outputAmount: quote.outputAmount ?? "0",
          outputDecimals: destTok.decimals,
          token,
          destinationToken,
          originChain,
          destinationChain,
          adapter: quote.adapter ?? "unknown",
          feesUsd: quote.fees?.totalUsd ?? quote.fees?.total?.amountUsd,
          calldata: quote.calldata,
        });
      }

      case "portfolio": {
        const address = String(params.address ?? "");
        if (!address) return fail("params.address is required", 400);
        const data = await lookupAddress(address);
        const balances = [
          ...data.balances.map(b => ({
            symbol: b.nativeSymbol,
            amount: b.native,
            usdValue: b.usdValue,
            chainId: b.chainId,
          })),
          ...data.tokenBalances.map(b => ({
            symbol: b.symbol,
            amount: b.balance,
            usdValue: b.usdValue,
            chainId: b.chainId,
          })),
        ].filter(b => parseFloat(b.amount) > 0);
        return respond({ address: data.address, balances });
      }

      case "text": {
        const rawBody = String(params.body ?? "");
        if (!rawBody) return fail("params.body is required", 400);

        // Strip VAN @mentions (handles can contain hyphens, e.g. @skopos-bridge)
        const cleanBody = rawBody.replace(/@[\w-]+/g, "").trim();
        const intent = classifyIntent(cleanBody);
        const lower = cleanBody.toLowerCase();

        if (intent === "price") {
          const PRICE_SKIP = new Set(["the", "a", "an", "my", "your", "its", "our", "this", "that"]);
          const priceRaw =
            lower.match(/\bprice\s+of\s+([a-z0-9]+)/)?.[1] ??
            lower.match(/\bhow\s+much\s+(?:is|does)\s+([a-z0-9]+)/)?.[1] ??
            lower.match(/\b([a-z0-9]{2,10})\s+price\b/)?.[1] ??
            lower.match(/\b(eth|weth|btc|wbtc|sol|bnb|matic|pol|avax|usdc|usdt|dai|doge|shib|pepe|link|uni|aave|xrp|ada|dot|op|arb|mkr|crv|ldo|snx|comp|frax|trump|wif|bonk|jup|pyth|jto|render|sui|apt|sei|tia|inj|atom|near|ftm|ton|not|hmstr|melania)\b/)?.[1];

          if (!priceRaw || PRICE_SKIP.has(priceRaw))
            return respond({ intent, noLiveData: true });

          const symbol = priceRaw.toUpperCase();
          const result = await getPrice(symbol);
          if (!result) return respond({ intent, noLiveData: true });
          return respond({ symbol: result.symbol, price: result.price, change24h: result.change24h, source: result.source });
        }

        if (intent === "yield") {
          const yieldToken =
            lower.match(/\b(usdt|dai|eth|weth|btc|wbtc|sol|bnb|usdc)\b/)?.[1]?.toUpperCase() ?? "USDC";
          let pools = await getTopYields(yieldToken, 500);
          const seen = new Set<string>();
          pools = pools
            .filter(p => p.apy >= 0.5 && p.apy <= 30 && p.tvlUsd >= 1_000_000)
            .sort((a, b) => b.tvlUsd - a.tvlUsd)
            .filter(p => {
              const key = `${p.project}/${p.chain}/${p.symbol}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .slice(0, 5);
          return respond({ pools: pools.map(p => ({ protocol: p.project, chain: p.chain, symbol: p.symbol, apy: p.apy, tvlUsd: p.tvlUsd })) });
        }

        if (intent === "prediction") {
          const topic = cleanBody
            .replace(/\b(hey|hi|what|are|the|odds|chance|will|does|is|a|an|of|for|on|to|you|me|tell|give|polymarket|prediction|markets?|betting|winning|happening|hit|reach|by|in|on)\b/gi, " ")
            .replace(/\?/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);

          // getTopMarkets does phrase matching — fall back to first word if full phrase misses
          let events = await getTopMarkets(topic || undefined, 10);
          if (events.length === 0 && topic) {
            const firstWord = topic.split(/\s+/)[0];
            if (firstWord && firstWord.length > 2) events = await getTopMarkets(firstWord, 10);
          }

          const markets = events
            .flatMap(e => e.markets.map(m => ({
              title: m.question,
              probability: m.outcomePrices[0] != null ? parseFloat(m.outcomePrices[0]) : 0.5,
              volume24h: m.volume,
              endDate: m.endDate ?? undefined,
            })))
            .slice(0, 3);
          return respond({ markets });
        }

        // informational, execution, analysis, fx, metal, equity, unknown — no live data
        return respond({ intent, noLiveData: true });
      }

      default:
        return fail(`unknown queryType: ${queryType}`, 400);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout")) {
      return fail("upstream timeout", 504);
    }
    console.error(`[/api/vara] ${queryType} error:`, e);
    return fail("internal error", 500);
  }
}
