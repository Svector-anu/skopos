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
// Layer 2: Groq LLM fallback (free tier, ~200ms, handles edge cases)
// ---------------------------------------------------------------------------

let groqClient: Groq | null = null;

function getGroq(): Groq | null {
  if (!process.env.GROQ_API_KEY) return null;
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groqClient;
}

const GROQ_SYSTEM = `You are a DeFi intent parser. Extract swap/bridge intent from user messages into JSON.

Return ONLY a JSON object matching this schema (no markdown, no explanation):
{
  "originChain": "string (chain name lowercased, e.g. ethereum, base, arbitrum)",
  "destinationChain": "string (same format; equal to originChain for same-chain swaps)",
  "token": "string (symbol uppercased, e.g. ETH, USDC, WBTC)",
  "amount": "string (decimal number only, e.g. '1', '0.5', '100')",
  "destinationToken": "string (symbol uppercased; same as token if not specified)"
}

Aliases: ether/ETH → ETH, bitcoin/btc → WBTC, mainnet → ethereum, arb → arbitrum, poly/matic → polygon, avax → avalanche, sol → solana.

If the message is NOT a swap/bridge/transfer request, return: {"intent": null}`;

async function groqParse(input: string): Promise<ParsedIntent | null> {
  const groq = getGroq();
  if (!groq) return null;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      response_format: { type: "json_object" },
      max_tokens: 128,
      temperature: 0,
      messages: [
        { role: "system", content: GROQ_SYSTEM },
        { role: "user", content: input },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (parsed.intent === null) return null;

    const { originChain, destinationChain, token, amount, destinationToken } = parsed;
    if (!originChain || !destinationChain || !token || !amount) return null;

    return { originChain, destinationChain, token, amount, destinationToken: destinationToken ?? token };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function parseIntent(input: string): Promise<ParsedIntent | null> {
  return regexParse(input) ?? await groqParse(input);
}

export async function getSuggestion(_input: string): Promise<string> {
  return "Try: 'move 1 ETH from ethereum to base' or 'swap 100 USDC to ETH on arbitrum'";
}
