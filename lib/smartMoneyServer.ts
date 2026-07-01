import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { type Timeframe, timeframeMs, toScreenerTimeframe, toFlowIntelTimeframe } from "./timeframe";

// Server-signed x402 settlement for Nansen Token God Mode reads. Skopos's own Base
// wallet fronts the ~$0.01 USDC micropayment, so the browser needs no wallet, no
// chain switch, and no signature — the user just asks and gets the answer. Gated on
// SKOPOS_X402_PRIVATE_KEY; unset falls back to the user-signed path in
// lib/smartMoneyClient.ts. The wallet pays in USDC only (EIP-3009 is gasless for
// the payer — the facilitator submits), so it needs USDC on Base, no ETH.

const BASE_NETWORK = "eip155:8453";
const NANSEN_BASE = "https://api.nansen.ai/api/v1";
const LOOKBACK_DAYS = 30;
const SETTLEMENT_TIMEOUT_MS = 60_000;

export interface SmartMoneyResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function agentKey(): `0x${string}` | null {
  const raw = process.env.SKOPOS_X402_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as `0x${string}`) : null;
}

export function agentPaidEnabled(): boolean {
  return agentKey() !== null;
}

function isoNoMillis(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Shared paid fetch — signs the x402 payment with the agent key and calls one TGM
// endpoint. Every TGM read is x402-priced with the same auth, so callers only vary
// the endpoint path and body.
async function paidTgmFetch(endpoint: string, body: Record<string, unknown>): Promise<SmartMoneyResponse> {
  const key = agentKey();
  if (!key) return { ok: false, error: "Agent payments are not configured." };

  const account = privateKeyToAccount(key);
  const signer = toClientEvmSigner({
    address: account.address,
    signTypedData: (message) =>
      account.signTypedData({
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      } as Parameters<typeof account.signTypedData>[0]),
  });

  const client = new x402Client().register(BASE_NETWORK, new ExactEvmScheme(signer));
  const payFetch = wrapFetchWithPayment(globalThis.fetch, client);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTLEMENT_TIMEOUT_MS);
  try {
    const res = await payFetch(`${NANSEN_BASE}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[nansen-paid] ${endpoint} ${res.status}`);
      return { ok: false, error: `Request failed (${res.status}).` };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    console.error(
      `[nansen-paid] ${endpoint} threw:`,
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    return { ok: false, error: "The read failed to settle." };
  } finally {
    clearTimeout(timer);
  }
}

type Token = { symbol: string | null; address: string | null; chain?: string | null };

// from/to window for the date-range endpoints. No timeframe → the default 30d.
function rangeFor(tf?: Timeframe): { from: string; to: string } {
  const now = new Date();
  const ms = tf ? timeframeMs(tf) : LOOKBACK_DAYS * 86_400_000;
  return { from: isoNoMillis(new Date(now.getTime() - ms)), to: isoNoMillis(now) };
}

export async function fetchSmartMoneyServer(
  token: Token,
  direction: "BUY" | "SELL" = "BUY",
  timeframe?: Timeframe,
): Promise<SmartMoneyResponse> {
  if (!token.address || !token.chain) {
    return { ok: false, error: "Couldn't locate this token on a supported chain." };
  }
  return paidTgmFetch("tgm/who-bought-sold", {
    chain: token.chain,
    token_address: token.address,
    buy_or_sell: direction,
    date: rangeFor(timeframe),
  });
}

export async function fetchHoldersServer(token: Token): Promise<SmartMoneyResponse> {
  if (!token.address || !token.chain) {
    return { ok: false, error: "Couldn't locate this token on a supported chain." };
  }
  return paidTgmFetch("tgm/holders", {
    chain: token.chain,
    token_address: token.address,
    order_by: [{ field: "value_usd", direction: "DESC" }],
    pagination: { page: 1, per_page: 20 },
  });
}

// Accumulation trend over time by wallet label (smart money by default).
export async function fetchFlowsServer(token: Token, timeframe?: Timeframe): Promise<SmartMoneyResponse> {
  if (!token.address || !token.chain) {
    return { ok: false, error: "Couldn't locate this token on a supported chain." };
  }
  return paidTgmFetch("tgm/flows", {
    chain: token.chain,
    token_address: token.address,
    label: "smart_money",
    date: rangeFor(timeframe),
    pagination: { page: 1, per_page: 60 },
  });
}

// Net flow per wallet segment (smart traders, whales, exchanges, fresh wallets):
// where the token is moving right now.
export async function fetchFlowIntelServer(token: Token, timeframe?: Timeframe): Promise<SmartMoneyResponse> {
  if (!token.address || !token.chain) {
    return { ok: false, error: "Couldn't locate this token on a supported chain." };
  }
  return paidTgmFetch("tgm/flow-intelligence", {
    chain: token.chain,
    token_address: token.address,
    timeframe: timeframe ? toFlowIntelTimeframe(timeframe) : "7d",
  });
}

// Discovery — tokens smart money is buying right now. Not token-scoped; lives at
// /token-screener (no tgm/ prefix). Optional chain narrows the screen.
export async function fetchScreenerServer(opts: { chain?: string | null; timeframe?: Timeframe } = {}): Promise<SmartMoneyResponse> {
  return paidTgmFetch("token-screener", {
    timeframe: opts.timeframe ? toScreenerTimeframe(opts.timeframe) : "24h",
    chains: opts.chain ? [opts.chain] : ["ethereum", "base", "solana", "arbitrum"],
    filters: { only_smart_money: true },
    order_by: [{ field: "netflow", direction: "DESC" }],
    pagination: { page: 1, per_page: 15 },
  });
}
