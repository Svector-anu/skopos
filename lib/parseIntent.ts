export interface ParsedIntent {
  originChain: string;
  destinationChain: string;
  token: string;
  amount: string;
  destinationToken: string;
}

const AMOUNT_RE = /(\d+(?:\.\d+)?)/;
const TOKEN_RE = /([A-Za-z]{2,10})/;

// Supported token symbols (for matching)
const KNOWN_TOKENS = new Set([
  "ETH", "WETH", "USDC", "USDT", "DAI", "WBTC", "BTC",
  "BNB", "MATIC", "POL", "AVAX", "SOL", "OP", "ARB",
  "LINK", "UNI", "AAVE", "MKR", "SNX", "CRV", "GRT",
  "LDO", "RPL", "RETH", "CBETH", "STETH", "WSTETH",
  "PEPE", "SHIB", "DOGE", "MON", "BERA", "S", "MNT",
  "CELO", "CRO", "HYPE", "METIS", "XPL",
]);

function normalizeToken(t: string): string {
  return t.toUpperCase();
}

// Parses: "move/bridge/swap/send/transfer X TOKEN from CHAIN to CHAIN"
// Also:   "swap X TOKEN to TOKEN on CHAIN"
// Also:   "swap X TOKEN to TOKEN from CHAIN to CHAIN"
export function parseIntent(input: string): ParsedIntent | null {
  const s = input.trim().toLowerCase();

  // Pattern 1: "... X TOKEN from ORIGIN to DEST"
  const p1 = /(?:move|bridge|send|transfer|swap|convert)\s+(\d+(?:\.\d+)?)\s+([a-z]+)\s+from\s+([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s*$|\s+(?:using|via|with))/i;
  const m1 = p1.exec(s);
  if (m1) {
    const [, amount, token, origin, dest] = m1;
    return {
      amount,
      token: normalizeToken(token),
      originChain: origin.trim(),
      destinationChain: dest.trim(),
      destinationToken: normalizeToken(token),
    };
  }

  // Pattern 2: "swap X TOKEN to DESTTOKEN from ORIGIN to DEST"
  const p2 = /swap\s+(\d+(?:\.\d+)?)\s+([a-z]+)\s+to\s+([a-z]+)\s+from\s+([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s*$)/i;
  const m2 = p2.exec(s);
  if (m2) {
    const [, amount, token, destToken, origin, dest] = m2;
    return {
      amount,
      token: normalizeToken(token),
      originChain: origin.trim(),
      destinationChain: dest.trim(),
      destinationToken: normalizeToken(destToken),
    };
  }

  // Pattern 3: "swap X TOKEN to DESTTOKEN on CHAIN" (same chain swap)
  const p3 = /swap\s+(\d+(?:\.\d+)?)\s+([a-z]+)\s+(?:to|for)\s+([a-z]+)\s+on\s+([a-z\s]+?)(?:\s*$)/i;
  const m3 = p3.exec(s);
  if (m3) {
    const [, amount, token, destToken, chain] = m3;
    return {
      amount,
      token: normalizeToken(token),
      originChain: chain.trim(),
      destinationChain: chain.trim(),
      destinationToken: normalizeToken(destToken),
    };
  }

  // Pattern 4: "X TOKEN from ORIGIN to DEST" (no verb)
  const p4 = /(\d+(?:\.\d+)?)\s+([a-z]+)\s+from\s+([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s*$)/i;
  const m4 = p4.exec(s);
  if (m4) {
    const [, amount, token, origin, dest] = m4;
    return {
      amount,
      token: normalizeToken(token),
      originChain: origin.trim(),
      destinationChain: dest.trim(),
      destinationToken: normalizeToken(token),
    };
  }

  return null;
}

// Suggests what format to use when parsing fails
export function getSuggestion(input: string): string {
  const hasAmount = AMOUNT_RE.test(input);
  const hasToken = [...KNOWN_TOKENS].some((t) =>
    input.toUpperCase().includes(t)
  );

  if (!hasAmount) return "Include an amount, e.g. '1 ETH' or '100 USDC'";
  if (!hasToken) return "Include a token symbol, e.g. ETH, USDC, USDT";
  return "Try: 'move 1 ETH from ethereum to base' or 'swap 100 USDC from arbitrum to polygon'";
}

// Suppress unused import warning
void AMOUNT_RE;
void TOKEN_RE;
