import Groq from "groq-sdk";

export interface ParsedIntent {
  originChain: string;
  destinationChain: string;
  token: string;
  amount: string;
  destinationToken: string;
}

// ---------------------------------------------------------------------------
// Layer 1: Regex (instant, free, covers ~90% of inputs)
// ---------------------------------------------------------------------------

function normalizeToken(t: string): string {
  const aliases: Record<string, string> = {
    ether: "ETH", ethereum: "ETH", btc: "WBTC", bitcoin: "WBTC",
    wrapped_bitcoin: "WBTC", sol: "SOL", matic: "POL", poly: "POL",
  };
  const upper = t.toUpperCase();
  return aliases[t.toLowerCase()] ?? upper;
}

function regexParse(input: string): ParsedIntent | null {
  const s = input.trim();

  // "move/bridge/send/transfer/swap/convert X TOKEN from ORIGIN to DEST"
  const p1 = /(?:move|bridge|send|transfer|swap|convert)\s+(\d+(?:\.\d+)?)\s+([a-z]+)\s+from\s+([a-z][a-z\s]*?)\s+to\s+([a-z][a-z\s]*?)(?:\s*$|\s+(?:using|via|with))/i;
  const m1 = p1.exec(s);
  if (m1) {
    const [, amount, token, origin, dest] = m1;
    const tok = normalizeToken(token);
    return { amount, token: tok, originChain: origin.trim().toLowerCase(), destinationChain: dest.trim().toLowerCase(), destinationToken: tok };
  }

  // "swap X TOKEN to DESTTOKEN from ORIGIN to DEST"
  const p2 = /swap\s+(\d+(?:\.\d+)?)\s+([a-z]+)\s+to\s+([a-z]+)\s+from\s+([a-z][a-z\s]*?)\s+to\s+([a-z][a-z\s]*?)(?:\s*$)/i;
  const m2 = p2.exec(s);
  if (m2) {
    const [, amount, token, destToken, origin, dest] = m2;
    return { amount, token: normalizeToken(token), originChain: origin.trim().toLowerCase(), destinationChain: dest.trim().toLowerCase(), destinationToken: normalizeToken(destToken) };
  }

  // "swap X TOKEN to DESTTOKEN on CHAIN" (same-chain)
  const p3 = /swap\s+(\d+(?:\.\d+)?)\s+([a-z]+)\s+(?:to|for)\s+([a-z]+)\s+on\s+([a-z][a-z\s]*?)(?:\s*$)/i;
  const m3 = p3.exec(s);
  if (m3) {
    const [, amount, token, destToken, chain] = m3;
    const c = chain.trim().toLowerCase();
    return { amount, token: normalizeToken(token), originChain: c, destinationChain: c, destinationToken: normalizeToken(destToken) };
  }

  // "X TOKEN from ORIGIN to DEST" (no verb)
  const p4 = /(\d+(?:\.\d+)?)\s+([a-z]+)\s+from\s+([a-z][a-z\s]*?)\s+to\s+([a-z][a-z\s]*?)(?:\s*$)/i;
  const m4 = p4.exec(s);
  if (m4) {
    const [, amount, token, origin, dest] = m4;
    const tok = normalizeToken(token);
    return { amount, token: tok, originChain: origin.trim().toLowerCase(), destinationChain: dest.trim().toLowerCase(), destinationToken: tok };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Layer 2: Groq LLM — intent extraction + general chat
// ---------------------------------------------------------------------------

let groqClient: Groq | null = null;

function getGroq(): Groq | null {
  if (!process.env.GROQ_API_KEY) return null;
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groqClient;
}

const GROQ_INTENT_SYSTEM = `You are a DeFi intent parser. Extract swap/bridge intent from user messages into JSON.

Return ONLY a JSON object matching this schema (no markdown, no explanation):
{
  "originChain": "string (chain name lowercased, e.g. ethereum, base, arbitrum)",
  "destinationChain": "string (same format; equal to originChain for same-chain swaps)",
  "token": "string (symbol uppercased, e.g. ETH, USDC, WBTC)",
  "amount": "string (decimal number only, e.g. '1', '0.5', '100')",
  "destinationToken": "string (symbol uppercased; same as token if not specified)"
}

Aliases: ether/ETH → ETH, bitcoin/btc → WBTC, mainnet → ethereum, arb → arbitrum, poly/matic → polygon, avax → avalanche, sol/solana → solana (chain), SOL → SOL (token), op → optimism.

IMPORTANT: Only return the JSON object if ALL of the following are clearly present in the message:
- A source chain (originChain)
- A destination chain or "on CHAIN" for same-chain swaps (destinationChain)
- A token symbol or name (token)
- A numeric amount (amount)

SPECIAL CASE — Solana origin: if the token is SOL or the origin chain is solana, set originChain: "solana". If no destination chain is specified, default to destinationChain: "ethereum" and destinationToken: "ETH".

If any required field is still missing or ambiguous after applying the above, return: {"intent": null}

If the message is NOT a swap/bridge/transfer request at all, return: {"intent": null}`;

const GROQ_CHAT_SYSTEM = `You are Skopos, a cross-chain DeFi copilot powered by the Delora protocol. You ONLY answer questions about DeFi, crypto, blockchain, bridging, swapping, wallets, and on-chain transactions.

WHAT SKOPOS CAN DO RIGHT NOW (these all work — tell users exactly how to trigger them):
- Bridge tokens across 25+ chains → "bridge 0.1 ETH from ethereum to base"
- Swap tokens on any supported chain → "swap 100 USDC to ETH on arbitrum"
- DeFi yield scanner → "find highest yield for USDC" or "best USDC APY" or "where can I earn on ETH" — shows live APY from Aave, Morpho, Compound, Moonwell, Uniswap via DeFiLlama
- Token risk scanner → "scan PEPE risk" or "analyze 0x... token" — shows liquidity, volume, market cap, risk score from DexScreener
- Wallet portfolio → "show my portfolio" — live balances across all chains
- Look up any transaction hash or wallet address — just paste it
- Multi-leg rebalance → "split 1 ETH across base and arbitrum"
- Fund wallet → connect wallet → expand sidebar → "Fund Wallet"
- Solana: bridge SOL cross-chain or swap Solana tokens — connect Phantom wallet

COMING SOON (do NOT pretend these work today):
- Agent mode / DCA: recurring strategies. Not live yet.
- Limit orders: price-triggered swaps. Not live yet.
- Off-ramp to card: USDC → bank. Not live yet.
- Whale signals / Polymarket. Not live yet.

CRITICAL RULES:

- If the message is NOT related to DeFi, crypto, blockchain, wallets, or on-chain activity:
  → respond only with: "I'm a DeFi copilot — I can help you bridge, swap, or manage assets across chains. What would you like to do?"

- NEVER invent balances, rates, APYs, token prices, or fees. If the user asks for live data, tell them exactly what to type to trigger the real scanner. e.g. for yield: tell them to type "find highest yield for USDC" — do NOT make up numbers.
- NEVER say a transaction completed unless a tx hash was returned.
- If asked about Jupiter, Uniswap, 1inch, etc. — explain Skopos uses Delora which aggregates across bridges and DEXs including those, and the user can just describe what they want in plain English.
- If the user asks for balances → say "type 'show my portfolio' and I'll fetch live balances".
- If the user asks how to get crypto → connect wallet → sidebar → "Fund Wallet".
- If the request is unclear → ask one clarifying question, don't guess.

Keep responses:
- under 3 sentences
- plain text only
- clear and honest`;

async function groqParseIntent(input: string): Promise<ParsedIntent | null> {
  // A transaction intent requires a numeric amount — skip LLM for purely textual messages
  if (!/\d/.test(input)) return null;

  const groq = getGroq();
  if (!groq) return null;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      response_format: { type: "json_object" },
      max_tokens: 128,
      temperature: 0,
      messages: [
        { role: "system", content: GROQ_INTENT_SYSTEM },
        { role: "user", content: input },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (parsed.intent === null) return null;

    const { originChain, destinationChain, token, amount, destinationToken } = parsed;
    if (!originChain || !destinationChain || !token || !amount) return null;

    // Sanity-check: at least one chain name must appear somewhere in the input.
    // Prevents the model from fabricating chains for inputs like "send 5 somewhere".
    const lower = input.toLowerCase();
    const chainMentioned =
      lower.includes(originChain.toLowerCase()) ||
      lower.includes(destinationChain.toLowerCase());
    if (!chainMentioned) return null;

    return { originChain, destinationChain, token, amount, destinationToken: destinationToken ?? token };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layer 3: Groq LLM — multi-leg rebalance extraction
// ---------------------------------------------------------------------------

const GROQ_REBALANCE_SYSTEM = `You are a DeFi multi-leg rebalance intent parser.

Users describe assets they hold on various chains and a destination, like:
- "I have 1 ETH on ethereum and 200 USDC on arbitrum, consolidate to base"
- "move 0.5 ETH from optimism and 100 USDC from polygon both to base"
- "rebalance: 1 ETH mainnet + 50 USDC arbitrum → base"

Return ONLY a raw JSON array (no markdown, no wrapper object):
[
  { "originChain": "ethereum", "destinationChain": "base", "token": "ETH", "amount": "1", "destinationToken": "ETH" },
  { "originChain": "arbitrum", "destinationChain": "base", "token": "USDC", "amount": "200", "destinationToken": "USDC" }
]

Rules:
- One object per asset/leg
- If a destination is stated once ("consolidate to base"), apply it to ALL legs
- destinationToken equals token unless user explicitly says "swap X to Y"
- Aliases: ether→ETH, mainnet→ethereum, arb→arbitrum, poly/matic→polygon, op→optimism, avax→avalanche
- Return {"legs":null} if fewer than 2 clear legs or intent is ambiguous

CRITICAL — data integrity:
- Extract ONLY what is explicitly stated in the message. NEVER infer, assume, or fabricate chain names, token symbols, or amounts that are not literally present.
- If a chain name is ambiguous or not mentioned for a leg, omit that leg entirely.
- If an amount is missing or unclear for a leg, omit that leg entirely.
- Every field must be traceable to a word or number in the user's message.`;

export function looksLikeRebalance(input: string): boolean {
  const lower = input.toLowerCase();
  if (
    lower.includes("rebalance") ||
    lower.includes("consolidate") ||
    lower.includes("move everything") ||
    lower.includes("move all my")
  ) return true;
  // Multiple "from" mentions + at least 2 amounts = multi-leg bridge
  const fromCount  = (lower.match(/\bfrom\b/g) || []).length;
  const numCount   = (input.match(/\d+(?:\.\d+)?/g) || []).length;
  return fromCount >= 2 && numCount >= 2;
}

export async function parseRebalanceIntent(input: string): Promise<ParsedIntent[] | null> {
  const groq = getGroq();
  if (!groq) return null;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      response_format: { type: "json_object" },
      max_tokens: 512,
      temperature: 0,
      messages: [
        { role: "system", content: GROQ_REBALANCE_SYSTEM },
        { role: "user", content: input },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw);

    // Model may return the array directly or wrap it; handle both
    const legs: unknown[] = Array.isArray(parsed) ? parsed : parsed.legs;
    if (!Array.isArray(legs) || legs.length < 2) return null;

    const lower = input.toLowerCase();
    const results: ParsedIntent[] = [];
    for (const leg of legs) {
      if (!leg || typeof leg !== "object") continue;
      const { originChain, destinationChain, token, amount, destinationToken } = leg as Record<string, string>;
      if (!originChain || !destinationChain || !token || !amount) continue;
      // Sanity-check: at least one chain in this leg must appear in the original input
      const chainMentioned =
        lower.includes(originChain.toLowerCase()) ||
        lower.includes(destinationChain.toLowerCase());
      if (!chainMentioned) continue;
      results.push({
        originChain:        originChain.trim().toLowerCase(),
        destinationChain:   destinationChain.trim().toLowerCase(),
        token:              token.trim().toUpperCase(),
        amount:             amount.trim(),
        destinationToken:   (destinationToken ?? token).trim().toUpperCase(),
      });
    }

    return results.length >= 2 ? results : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function parseIntent(input: string): Promise<ParsedIntent | null> {
  return regexParse(input) ?? await groqParseIntent(input);
}

export async function generateTxSummary(tx: import("./alchemy").TxData): Promise<string> {
  const groq = getGroq();
  if (!groq) return "";
  const prompt = [
    `Chain: ${tx.chainName}`,
    `Status: ${tx.status}`,
    `Value: ${tx.valueEth} ${tx.chainId === 137 ? "POL" : "ETH"}`,
    `Gas cost: ${tx.gasCostEth} ETH`,
    tx.method ? `Method: ${tx.method}` : null,
    `Log events: ${tx.logCount}`,
    tx.timestamp ? `Time: ${new Date(tx.timestamp * 1000).toUTCString()}` : null,
  ].filter(Boolean).join("\n");
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      max_tokens: 80,
      temperature: 0.1,
      messages: [
        { role: "system", content: "You are a blockchain transaction analyst. In 1–2 sentences describe what this transaction likely did. Use only the data provided. Never invent details." },
        { role: "user", content: prompt },
      ],
    });
    return completion.choices[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}

export async function generateAddressSummary(data: import("./alchemy").AddressData): Promise<string> {
  const groq = getGroq();
  if (!groq) return "";
  const nativeBalances = data.balances.length > 0
    ? data.balances.map(b => `${b.native} ${b.nativeSymbol} on ${b.chainName}`).join(", ")
    : "none";
  const tokenBalances = data.tokenBalances.length > 0
    ? data.tokenBalances.slice(0, 8).map(t => `${t.balance} ${t.symbol} on ${t.chainName}`).join(", ")
    : "none";
  const recent = data.recentTransfers.slice(0, 5)
    .map(t => `${t.direction === "out" ? "sent" : "received"} ${t.value} ${t.asset}`)
    .join(", ");
  const prompt = `Address: ${data.address}\nNative balances: ${nativeBalances}\nToken balances: ${tokenBalances}\nRecent: ${recent || "none"}`;
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      max_tokens: 80,
      temperature: 0.1,
      messages: [
        { role: "system", content: "You are a blockchain wallet analyst. In 1 sentence, summarise what this wallet holds. If there are actionable options (swap, bridge), mention one concisely. Use only the data provided. Never invent details." },
        { role: "user", content: prompt },
      ],
    });
    return completion.choices[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}

export function streamSuggestion(
  input: string,
  history?: { role: "user" | "assistant"; content: string }[],
  senderAddress?: string,
): ReadableStream<Uint8Array> {
  const groq = getGroq();
  const encoder = new TextEncoder();
  const FALLBACK = "Try: 'move 1 ETH from ethereum to base' or 'swap 100 USDC to ETH on arbitrum'";
  const walletCtx = senderAddress
    ? `\n\nUser's connected wallet address: ${senderAddress}.`
    : "";

  return new ReadableStream({
    async start(controller) {
      if (!groq) {
        controller.enqueue(encoder.encode(FALLBACK));
        controller.close();
        return;
      }
      try {
        const stream = await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          max_tokens: 256,
          temperature: 0.2,
          stream: true,
          messages: [
            { role: "system", content: GROQ_CHAT_SYSTEM + walletCtx },
            ...(history?.slice(-6) ?? []),
            { role: "user", content: input },
          ],
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) controller.enqueue(encoder.encode(delta));
        }
      } catch {
        controller.enqueue(encoder.encode(FALLBACK));
      }
      controller.close();
    },
  });
}

export async function getSuggestion(
  input: string,
  history?: { role: "user" | "assistant"; content: string }[],
  senderAddress?: string,
): Promise<string> {
  const FALLBACK = "Try: 'move 1 ETH from ethereum to base' or 'swap 100 USDC to ETH on arbitrum'";
  const groq = getGroq();
  if (!groq) return FALLBACK;

  const walletCtx = senderAddress
    ? `\n\nUser's connected wallet address: ${senderAddress}. If the user mentions "this address", "my address", "my wallet", or pastes this exact address, it is their own wallet — not a third party. Answer accordingly (e.g. yes they can receive tokens there, guide them to fund it).`
    : "";

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      max_tokens: 256,
      temperature:0.2,
      messages: [
        { role: "system", content: GROQ_CHAT_SYSTEM + walletCtx },
        ...(history?.slice(-6) ?? []),
        { role: "user", content: input },
      ],
    });
    return completion.choices[0]?.message?.content?.trim() ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}
