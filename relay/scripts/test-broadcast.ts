/**
 * Dry-run tester for the proactive broadcaster.
 * Hits the local /api/vara endpoint and prints what Skopos would post to VAN.
 * Does NOT write anything to the chain.
 *
 * Usage:  npx tsx scripts/test-broadcast.ts
 */

const BASE_URL = process.env.SKOPOS_BASE_URL ?? "http://localhost:3000";
const SECRET   = process.env.RELAY_SECRET      ?? "e2e-test-secret";

// Tokens to scan for biggest mover (price broadcast)
const PRICE_TOKENS = ["ETH", "BTC", "SOL", "ARB", "OP", "LINK"];

// Crypto-relevant Polymarket topic keywords (tried in order until results found)
const CRYPTO_TOPICS = [
  "Bitcoin", "Ethereum", "crypto", "Fed rate", "SEC", "stablecoin",
  "interest rate", "Trump tariff", "inflation",
];

// Bridge pairs to rotate through
const BRIDGE_PAIRS = [
  { from: "ethereum", to: "base",      token: "ETH",  destToken: "USDC", amount: "1" },
  { from: "ethereum", to: "arbitrum",  token: "ETH",  destToken: "USDC", amount: "1" },
  { from: "ethereum", to: "base",      token: "USDC", destToken: "USDC", amount: "500" },
];

// ── helpers ────────────────────────────────────────────────────────────────────

async function query(queryType: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/api/vara`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SECRET}`,
    },
    body: JSON.stringify({ queryType, params }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`${queryType} → HTTP ${res.status}: ${await res.text()}`);
  const { result, error } = await res.json() as { result?: string; error?: string };
  if (error) throw new Error(`${queryType} → ${error}`);
  return JSON.parse(result ?? "null");
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

// ── message generators ─────────────────────────────────────────────────────────

async function priceBroadcast(): Promise<string> {
  const results = await Promise.allSettled(
    PRICE_TOKENS.map(sym =>
      query("price", { symbol: sym }).then(d => ({ sym, ...(d as Record<string, unknown>) }))
    )
  );

  const prices = results
    .filter(r => r.status === "fulfilled")
    .map(r => (r as PromiseFulfilledResult<Record<string, unknown>>).value)
    .filter(d => typeof d.change24h === "number");

  if (prices.length === 0) throw new Error("no price data");

  // Pick the token with the largest absolute 24h move — most interesting signal
  prices.sort((a, b) => Math.abs(b.change24h as number) - Math.abs(a.change24h as number));
  const top = prices[0];
  const sym   = top.sym as string;
  const price = top.price as number;
  const chg   = top.change24h as number;
  const dir   = chg >= 0 ? "▲" : "▼";
  const sign  = chg >= 0 ? "+" : "";

  return `${sym} ${dir} ${sign}${fmt(chg, 2)}% in 24h — $${fmt(price)}. Bridge cross-chain at tryskopos.xyz`;
}

async function yieldBroadcast(): Promise<string> {
  const data = await query("yield", { symbol: "USDC", limit: 1 }) as { pools: Array<Record<string, unknown>> };
  const pool = data.pools?.[0];
  if (!pool) throw new Error("no yield data");

  const protocol = String(pool.protocol);
  const chain    = String(pool.chain);
  const apy      = fmt(Number(pool.apy), 2);
  const tvl      = Number(pool.tvlUsd);
  const tvlStr   = tvl >= 1e9
    ? `$${fmt(tvl / 1e9, 2)}B`
    : `$${fmt(tvl / 1e6, 0)}M`;

  return `Top USDC yield: ${protocol} on ${chain} at ${apy}% APY — ${tvlStr} TVL. Explore yields at tryskopos.xyz`;
}

async function quoteBroadcast(pairIdx: number): Promise<string> {
  const pair = BRIDGE_PAIRS[pairIdx % BRIDGE_PAIRS.length];
  const DUMMY_ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

  const data = await query("quote", {
    originChain:      pair.from,
    destinationChain: pair.to,
    token:            pair.token,
    destinationToken: pair.destToken,
    amount:           pair.amount,
    senderAddress:    DUMMY_ADDR,
    receiverAddress:  DUMMY_ADDR,
  }) as { outputAmount?: string; adapter?: string; feesUsd?: string };

  const outputRaw = Number(data.outputAmount ?? 0);
  // USDC has 6 decimals; ETH has 18
  const outDecimals = pair.destToken === "USDC" ? 6 : 18;
  const output = outputRaw / 10 ** outDecimals;
  const adapter = data.adapter ?? "bridge";
  const feesUsd = data.feesUsd ? `~$${fmt(Number(data.feesUsd), 2)} fees` : "";

  return `Live quote: ${pair.amount} ${pair.token} (${pair.from}) → ${fmt(output, 2)} ${pair.destToken} (${pair.to}) via ${adapter}${feesUsd ? `, ${feesUsd}` : ""}. Execute at tryskopos.xyz`;
}

async function marketBroadcast(): Promise<string> {
  for (const topic of CRYPTO_TOPICS) {
    try {
      const data = await query("markets", { topic, limit: 1 }) as { markets: Array<Record<string, unknown>> };
      const m = data.markets?.[0];
      if (!m) continue;

      const title = String(m.title);
      const prob  = fmt(Number(m.probability) * 100, 0);
      const vol   = Number(m.volume24h ?? 0);
      const volStr = vol >= 1e6
        ? `$${fmt(vol / 1e6, 1)}M vol`
        : vol >= 1e3
        ? `$${fmt(vol / 1e3, 0)}K vol`
        : "";

      return `Polymarket: "${title}" — ${prob}% odds${volStr ? `, ${volStr}` : ""}. More predictions at tryskopos.xyz`;
    } catch { /* try next topic */ }
  }
  throw new Error("no crypto markets found");
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nTesting proactive broadcast messages against ${BASE_URL}\n`);
  console.log("=".repeat(70));

  const tests: Array<{ name: string; fn: () => Promise<string> }> = [
    { name: "PRICE  (biggest 24h mover)",  fn: priceBroadcast },
    { name: "YIELD  (top USDC pool)",       fn: yieldBroadcast },
    { name: "QUOTE  (ETH→USDC ethereum→base)", fn: () => quoteBroadcast(0) },
    { name: "QUOTE  (ETH→USDC ethereum→arbitrum)", fn: () => quoteBroadcast(1) },
    { name: "MARKET (first crypto topic)",  fn: marketBroadcast },
  ];

  for (const { name, fn } of tests) {
    process.stdout.write(`\n[${name}]\n`);
    try {
      const msg = await fn();
      console.log(`  → "${msg}"`);
      console.log(`  ✓ length: ${msg.length} chars (limit: 450)`);
      if (msg.length > 450) console.warn("  ⚠️  OVER 450 chars — will be truncated on VAN");
    } catch (err) {
      console.error(`  ✗ ERROR: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("Dry-run complete. Nothing was posted to VAN.\n");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
