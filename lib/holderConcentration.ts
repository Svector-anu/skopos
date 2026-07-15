import { fetchHoldersServer } from "./smartMoneyServer";
import { toNansenChain, isValidTokenTarget } from "./nansen";

// Holder concentration via Nansen Token God Mode's tgm/holders read (same
// paid rail as lib/smartMoneyServer.ts's other TGM calls, already live and
// paid for elsewhere in this repo). Originally speced against x402 Trading
// Hub's /api/holder/concentration, but that origin is confirmed dead (404
// DEPLOYMENT_NOT_FOUND straight from Vercel's edge, verified 2026-07-15 with
// a live-funded call — see docs/paid-data-sources.md). Nansen's holders rows
// already carry ownership_percentage per wallet, computed against real supply
// — summing the top 10 is more accurate than reconstructing a percentage from
// value_usd ÷ scanToken()'s market cap, which can disagree with Nansen's own
// denominator (FDV vs. circulating supply, staleness, etc).

export interface HolderConcentration {
  top10Pct: number;
}

function pickNum(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const v = (data as Record<string, unknown>).data;
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}

export async function getHolderConcentration(chainId: string, tokenAddress: string): Promise<HolderConcentration | null> {
  const nansenChain = toNansenChain(chainId);
  if (!nansenChain || !isValidTokenTarget(tokenAddress, chainId)) return null;

  const result = await fetchHoldersServer({ symbol: null, address: tokenAddress, chain: nansenChain });
  if (!result.ok) {
    console.error("[nansen-paid] holders (concentration) failed:", result.error);
    return null;
  }

  const rows = rowsOf(result.data)
    .map(r => ({
      valueUsd: pickNum(r, "value_usd") ?? 0,
      ownershipPct: (pickNum(r, "ownership_percentage") ?? 0) * 100,
    }))
    .sort((a, b) => b.valueUsd - a.valueUsd);

  if (!rows.length) return null;
  const top10Pct = rows.slice(0, 10).reduce((sum, r) => sum + r.ownershipPct, 0);
  return { top10Pct };
}
