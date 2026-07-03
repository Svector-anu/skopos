// Headless text projection of /api/chat cards. The card object stays the single
// source of truth; this renders it to a non-empty, plain-text (no-markdown, iMessage-
// friendly) string for agent/headless clients that send format:"text".
//
// Stage 1: simple types rendered; intel/aeon + richer cards degrade to a graceful
// "open Skopos" line (no x402 spend). Stage 2 adds per-type renderers + inline intel
// execution behind the per-anonId cap.

const APP = "https://www.tryskopos.xyz/app";
const SITE = "https://www.tryskopos.xyz";

export interface CardTextCtx {
  anonId?: string;
  senderAddress?: string;
}

type Card = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function fmtUsd(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${x.toFixed(2)}`;
  return `$${x.toPrecision(4)}`;
}

export async function cardToText(card: unknown, _ctx: CardTextCtx = {}): Promise<string> {
  if (!card || typeof card !== "object") return `Open Skopos: ${SITE}`;
  const c = card as Card;

  // Types that already carry human text.
  if (typeof c.text === "string" && c.text.trim()) return c.text.trim();
  if (typeof c.error === "string" && c.error.trim()) return c.error.trim();

  switch (str(c.type)) {
    case "price": {
      const sym = str(c.symbol) || "?";
      const name = str(c.name);
      const price = num(c.price);
      const chg = num(c.change24h);
      const mc = num(c.marketCap);
      const head = name ? `${sym} (${name})` : sym;
      const p = price !== null ? fmtUsd(price) : "—";
      const ch = chg !== null ? ` · ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% 24h` : "";
      const mcap = mc !== null ? ` · mcap ${fmtUsd(mc)}` : "";
      return `${head}: ${p}${ch}${mcap}`;
    }

    case "pay": {
      const amt = str(c.amountDisplay) || String(num(c.amountWei) ?? "");
      const sym = str(c.tokenSymbol) || "tokens";
      const to = str(c.to);
      const chain = str(c.chainName);
      const memo = str(c.memoText);
      // Never return a signable payload — headless clients can't sign.
      return `Ready: send ${amt} ${sym} to ${to}${chain ? ` on ${chain}` : ""}${memo ? ` for "${memo}"` : ""}. Sign in Skopos to execute: ${APP}`;
    }

    case "paywall":
      return str(c.reason) === "connect"
        ? `Connect a wallet in Skopos to use the Smart tier: ${APP}`
        : `You've hit today's Smart limit. Subscribe to keep going: ${SITE}`;

    // Stage 2 — execute the read inline (per-anonId capped) + render.
    case "intel":
    case "aeon":
      return `Open Skopos for the full read: ${SITE}`;

    // Stage 2 — per-type renderers.
    case "quote":
    case "rebalance":
    case "address":
    case "tx":
    case "yield":
    case "polymarket":
    case "payments":
    case "suggestions":
      return `Open Skopos for the full ${str(c.type)} view: ${SITE}`;

    default:
      return `Open Skopos for this: ${SITE}`;
  }
}
