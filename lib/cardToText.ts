// Headless text projection of /api/chat cards. The card object stays the single
// source of truth; this renders it to a non-empty, plain-text (no-markdown,
// iMessage-friendly) string for agent/headless clients that send format:"text".
//
// intel cards execute the paid read INLINE (browser does this on "Reveal"), gated by
// a per-anonId fail-closed cap + the global budget. aeon stays a fallback line (60s
// inline is unreliable on serverless).

import {
  fetchSmartMoneyServer, fetchHoldersServer, fetchFlowsServer,
  fetchFlowIntelServer, fetchScreenerServer,
} from "./smartMoneyServer";
import { checkAgentTextIntelCap, incrAgentTextIntel, checkIntelBudget, incrIntel } from "./usage";
import { isTimeframe } from "./timeframe";
import { getAeonRead, type AeonKind } from "./aeonFeed";

const APP = "https://www.tryskopos.xyz/app";
const SITE = "https://www.tryskopos.xyz";

export interface CardTextCtx {
  anonId?: string;
  senderAddress?: string;
  sparkline?: boolean; // default true; set false to omit the ASCII price sparkline
}

// Execution deep-link for headless clients. Reuses the web app's ?q= auto-submit
// (app/app/page.tsx) so opening it re-runs the original intent and stages the
// signable card — no dedicated /swap or /pay route needed. Only for intents that
// need a signature; headless clients get this link instead of a signable payload.
const EXECUTE_LINK_TYPES = new Set(["quote", "rebalance", "pay"]);

export function executeLinkFor(card: unknown, message: string | undefined): string | undefined {
  if (!message || !message.trim()) return undefined;
  if (!card || typeof card !== "object") return undefined;
  const type = (card as { type?: unknown }).type;
  if (typeof type !== "string" || !EXECUTE_LINK_TYPES.has(type)) return undefined;
  return `${APP}?q=${encodeURIComponent(message.trim())}`;
}

// Chart PNG url for price cards (the `image` response field). Self-contained: the
// route (/api/og/chart) re-fetches its own data, so the url is all a client needs.
// Only emitted when the card has real 7d data, so clients never get a blank chart.
export function chartImageFor(card: unknown): string | undefined {
  if (!card || typeof card !== "object") return undefined;
  const c = card as { type?: unknown; symbol?: unknown; sparkline?: unknown };
  if (c.type !== "price") return undefined;
  const symbol = typeof c.symbol === "string" ? c.symbol.trim() : "";
  if (!symbol) return undefined;
  if (!Array.isArray(c.sparkline) || c.sparkline.length < 2) return undefined;
  return `${SITE}/api/og/chart?token=${encodeURIComponent(symbol)}`;
}

const RISK_FLAG_LABELS: Record<string, string> = {
  NO_LIQUIDITY: "no meaningful liquidity",
  VOLUME_SPIKE: "abnormal volume spike",
  SINGLE_POOL: "only 1 liquidity pool",
  NEW_TOKEN: "token < 7 days old",
  HIGH_VOLATILITY: "price moved >50% in 24h",
  HEAVY_SELLING: "heavy sell pressure",
  POSSIBLE_HONEYPOT: "buys but no sells — possible honeypot",
};

type Card = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const short = (a: string): string => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function fmtUsd(x: number): string {
  const a = Math.abs(x);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M`
    : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a >= 1 ? a.toFixed(2) : a.toPrecision(3);
  return `${x < 0 ? "-" : ""}$${s}`;
}

// Compact unicode sparkline from a price series — renders in plain text (iMessage),
// no image, no endpoint. Downsamples to `width` bars scaled to the true low/high.
const SPARK_TICKS = "▁▂▃▄▅▆▇█";
function downsample(data: number[], n: number): number[] {
  if (data.length <= n) return data;
  const out: number[] = [];
  const step = data.length / n;
  for (let i = 0; i < n; i++) {
    const slice = data.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1));
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}
function sparkline(raw: unknown, width = 24): { bars: string; lo: number; hi: number; chg: number } | null {
  if (!Array.isArray(raw)) return null;
  const data = raw.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (data.length < 2) return null;
  const lo = Math.min(...data), hi = Math.max(...data), range = hi - lo || 1;
  const bars = downsample(data, width)
    .map((v) => SPARK_TICKS[Math.max(0, Math.min(7, Math.round(((v - lo) / range) * 7)))])
    .join("");
  const first = data[0];
  const chg = first ? ((data[data.length - 1] - first) / first) * 100 : 0;
  return { bars, lo, hi, chg };
}

// ── shared Nansen row helpers ────────────────────────────────────────────────
function rowsOf(data: unknown): Card[] {
  if (Array.isArray(data)) return data as Card[];
  if (data && typeof data === "object") {
    const v = (data as Card).data;
    if (Array.isArray(v)) return v as Card[];
  }
  return [];
}
function pickStr(r: Card, keys: string[]): string | null {
  for (const k of keys) { const v = r[k]; if (typeof v === "string" && v) return v; }
  return null;
}
function pickNum(r: Card, keys: string[]): number | null {
  for (const k of keys) { const v = r[k]; const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN; if (Number.isFinite(n)) return n; }
  return null;
}

// ── intel renderers ──────────────────────────────────────────────────────────
function renderSmartMoney(data: unknown, sym: string, direction: string): string {
  const rows = rowsOf(data);
  if (!rows.length) return `No smart-money trades for ${sym} in the last window.`;
  const parsed = rows.map((r) => {
    let net = pickNum(r, ["trade_volume_usd", "net_flow_usd", "net_usd"]);
    if (net === null) net = (pickNum(r, ["bought_volume_usd"]) ?? 0) - (pickNum(r, ["sold_volume_usd"]) ?? 0);
    return { label: pickStr(r, ["address_label", "label"]) ?? short(pickStr(r, ["address"]) ?? "wallet"), net };
  });
  parsed.sort((a, b) => b.net - a.net);
  const top = parsed.slice(0, 3).map((p) => `${p.label} ${p.net >= 0 ? "+" : ""}${fmtUsd(p.net)}`).join(", ");
  const total = parsed.reduce((s, p) => s + p.net, 0);
  const verb = direction === "SELL" ? "sellers" : "buyers";
  return `${sym} — top ${verb}: ${top}. Net ${total >= 0 ? "accumulating" : "exiting"} ${fmtUsd(Math.abs(total))}.`;
}
function renderHolders(data: unknown, sym: string): string {
  const rows = rowsOf(data);
  if (!rows.length) return `No holder data for ${sym}.`;
  const parsed = rows.map((r) => ({
    label: pickStr(r, ["address_label", "label"]) ?? short(pickStr(r, ["address"]) ?? "wallet"),
    own: (pickNum(r, ["ownership_percentage"]) ?? 0) * 100,
    val: pickNum(r, ["value_usd"]) ?? 0,
    chg: pickNum(r, ["balance_change_7d"]) ?? 0,
  })).sort((a, b) => b.val - a.val);
  const top = parsed.slice(0, 3).map((p) => `${p.label} ${p.own.toFixed(1)}%${p.chg >= 0 ? " ▲" : " ▼"}`).join(", ");
  const share = parsed.slice(0, 6).reduce((s, p) => s + p.own, 0);
  return `${sym} holders: ${top}. Top ${Math.min(6, parsed.length)} hold ${share.toFixed(1)}% of supply.`;
}
function renderScreener(data: unknown): string {
  const rows = rowsOf(data).map((r) => ({
    sym: pickStr(r, ["token_symbol"]), chain: pickStr(r, ["chain"]),
    net: pickNum(r, ["netflow"]), chg: (pickNum(r, ["price_change"]) ?? 0) * 100,
  })).filter((p) => p.sym).slice(0, 5);
  if (!rows.length) return `No screener results right now.`;
  const list = rows.map((p) => `$${p.sym} (${p.chain}) ${p.net !== null ? fmtUsd(p.net) : ""}${p.chg ? ` ${p.chg >= 0 ? "+" : ""}${p.chg.toFixed(1)}%` : ""}`).join(", ");
  return `Smart money buying now: ${list}.`;
}
function renderFlows(data: unknown, sym: string): string {
  const rows = rowsOf(data)
    .map((r) => ({ date: pickStr(r, ["date"]), amt: pickNum(r, ["token_amount"]), val: pickNum(r, ["value_usd"]) }))
    .filter((p) => p.val !== null).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  if (rows.length < 2) return `Not enough flow history for ${sym}.`;
  const first = rows[0], last = rows[rows.length - 1];
  const base = first.amt ?? 0;
  const chg = base > 0 ? (((last.amt ?? 0) - base) / base) * 100 : 0;
  return `${sym} smart-money holdings: ${fmtUsd(last.val ?? 0)} now, ${chg >= 0 ? "accumulating" : "distributing"} ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% over the window.`;
}
function renderFlowIntel(data: unknown, sym: string): string {
  const obj = (rowsOf(data)[0] ?? (data && typeof data === "object" ? data : {})) as Card;
  const seg = (k: string) => pickNum(obj, [`${k}_net_flow_usd`]);
  const parts: string[] = [];
  const st = seg("smart_trader"); if (st) parts.push(`smart traders ${st >= 0 ? "+" : ""}${fmtUsd(st)}`);
  const wh = seg("whale"); if (wh) parts.push(`whales ${wh >= 0 ? "+" : ""}${fmtUsd(wh)}`);
  const fr = seg("fresh_wallets"); if (fr) parts.push(`fresh ${fr >= 0 ? "+" : ""}${fmtUsd(fr)}`);
  const ex = seg("exchange"); if (ex) parts.push(`exchanges ${ex >= 0 ? "+" : ""}${fmtUsd(ex)} (${ex < 0 ? "leaving = bullish" : "inflow = sell pressure"})`);
  if (!parts.length) return `No segment flows for ${sym}.`;
  return `${sym} flows: ${parts.join(", ")}.`;
}

async function renderIntel(c: Card, ctx: CardTextCtx): Promise<string> {
  const read = str(c.read) || "smart-money";
  const premium = c.premium as { available?: boolean; note?: string } | undefined;
  if (!premium?.available) return premium?.note || "Not available for this token yet.";

  // Spend guards — per-anonId (fail-closed) then global.
  if (!(await checkAgentTextIntelCap(ctx.anonId))) {
    return `Daily intel limit reached — try later or open Skopos: ${SITE}`;
  }
  if (!(await checkIntelBudget())) {
    return `Smart-money reads are at today's limit — try tomorrow or open Skopos: ${SITE}`;
  }

  const t = c.token as { symbol?: string; address?: string; chain?: string } | undefined;
  const token = { symbol: t?.symbol ?? null, address: t?.address ?? null, chain: t?.chain ?? null };
  const sym = token.symbol ? `$${token.symbol}` : "this token";
  const tf = isTimeframe(c.timeframe) ? c.timeframe : undefined;

  let res: { ok: boolean; data?: unknown; error?: string };
  switch (read) {
    case "holders":    res = await fetchHoldersServer(token); break;
    case "flows":      res = await fetchFlowsServer(token, tf); break;
    case "flow-intel": res = await fetchFlowIntelServer(token, tf); break;
    case "screener":   res = await fetchScreenerServer({ chain: str(c.screenChain) || undefined, timeframe: tf }); break;
    default:           res = await fetchSmartMoneyServer(token, c.direction === "SELL" ? "SELL" : "BUY", tf);
  }
  if (!res.ok) return res.error || "Couldn't fetch that read right now.";

  // Charge only a settled read.
  if (ctx.anonId) await incrAgentTextIntel(ctx.anonId);
  await incrIntel();

  switch (read) {
    case "holders":    return renderHolders(res.data, sym);
    case "flows":      return renderFlows(res.data, sym);
    case "flow-intel": return renderFlowIntel(res.data, sym);
    case "screener":   return renderScreener(res.data);
    default:           return renderSmartMoney(res.data, sym, c.direction === "SELL" ? "SELL" : "BUY");
  }
}

// ── the dispatcher ────────────────────────────────────────────────────────────
export async function cardToText(card: unknown, ctx: CardTextCtx = {}): Promise<string> {
  if (!card || typeof card !== "object") return `Open Skopos: ${SITE}`;
  const c = card as Card;

  if (typeof c.text === "string" && c.text.trim()) return c.text.trim().replace(/\*\*(.+?)\*\*/g, "$1"); // strip bold markers — headless renders plain
  if (typeof c.error === "string" && c.error.trim()) return c.error.trim();
  if (typeof c.summary === "string" && c.summary.trim()) return c.summary.trim(); // address, tx

  switch (str(c.type)) {
    case "price": {
      const sym = str(c.symbol) || "?";
      const name = str(c.name);
      const price = num(c.price), chg = num(c.change24h), mc = num(c.marketCap);
      const head = name ? `${sym} (${name})` : sym;
      const line = `${head}: ${price !== null ? fmtUsd(price) : "—"}${chg !== null ? ` · ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% 24h` : ""}${mc !== null ? ` · mcap ${fmtUsd(mc)}` : ""}`;
      const sp = ctx.sparkline === false ? null : sparkline(c.sparkline);
      if (!sp) return line;
      return `${line}\n${sp.bars}  7d ${sp.chg >= 0 ? "+" : ""}${sp.chg.toFixed(1)}% · ${fmtUsd(sp.lo)}–${fmtUsd(sp.hi)}`;
    }

    case "quote": {
      const qi = c.intent as { from?: { token?: string; amount?: string; chain?: string }; to?: { token?: string; chain?: string } } | undefined;
      const route = c.route as { outputAmount?: string; tool?: string } | undefined;
      const f = qi?.from, to = qi?.to;
      const dest = route?.outputAmount
        ? `~${str(route.outputAmount)} ${str(to?.token)} on ${str(to?.chain)}`
        : `${str(to?.token)} on ${str(to?.chain)}`;
      return `Swap ${str(f?.amount)} ${str(f?.token)} on ${str(f?.chain)} → ${dest}${route?.tool ? ` (via ${route.tool})` : ""}. Tap to sign in the Skopos app.`;
    }

    case "rebalance": {
      const legs = Array.isArray(c.legs) ? c.legs : [];
      const ok = legs.filter((l) => (l as Card)?.type === "quote").length;
      return ok > 0
        ? `Rebalance preview — ${ok} legs routed. Tap to sign in the Skopos app.`
        : `Rebalance ready. Tap to sign in the Skopos app.`;
    }

    case "token_risk": {
      const risk = c.risk as { symbol?: string; label?: string; score?: number; priceUsd?: string; flags?: string[] } | undefined;
      const flagList = Array.isArray(risk?.flags) ? risk!.flags.map((f) => RISK_FLAG_LABELS[f] ?? f) : [];
      const flags = flagList.length ? ` Flags: ${flagList.join(", ")}.` : "";
      const prefix = c.pick ? "Today's pick — not financial advice. " : "";
      return `${prefix}${str(risk?.symbol)} risk: ${str(risk?.label)} (${risk?.score ?? "?"}/4).${risk?.priceUsd ? ` $${risk.priceUsd}.` : ""}${flags}`;
    }

    case "yield_pools": {
      const pools = (Array.isArray(c.pools) ? c.pools : []) as Card[];
      if (!pools.length) return `No yield pools found for ${str(c.symbol)}.`;
      const top = pools.slice(0, 3).map((p) => `${str(p.project)} (${str(p.chain)}) ${num(p.apy)?.toFixed(1) ?? "?"}% APY, ${fmtUsd(num(p.tvlUsd) ?? 0)} TVL`).join("; ");
      return `Top yield for ${str(c.symbol)}: ${top}.`;
    }

    case "polymarket": {
      const events = (Array.isArray(c.markets) ? c.markets : []) as Card[];
      if (!events.length) return `No prediction markets found${c.topic ? ` for "${str(c.topic)}"` : ""}.`;
      const lines = events.slice(0, 3).map((e) => {
        const m = (Array.isArray(e.markets) ? e.markets[0] : undefined) as Card | undefined;
        const outs = Array.isArray(m?.outcomes) ? (m!.outcomes as string[]) : [];
        const prices = Array.isArray(m?.outcomePrices) ? (m!.outcomePrices as string[]) : [];
        const odds = outs.length && prices.length ? ` — ${outs[0]} ${(Number(prices[0]) * 100).toFixed(0)}%` : "";
        return `${str(e.title)}${odds}`;
      }).join(" · ");
      return `Prediction markets: ${lines}.`;
    }

    case "payments": {
      const pays = (Array.isArray(c.payments) ? c.payments : []) as Card[];
      if (!pays.length) return `No incoming payments found for ${short(str(c.address))}.`;
      const lines = pays.slice(0, 3).map((p) => `${str(p.amount)} ${str(p.tokenSymbol)} from ${short(str(p.from))}${p.memoText ? ` (${str(p.memoText)})` : ""}`).join("; ");
      return `Recent payments: ${lines}.`;
    }

    case "suggestions": {
      const prompts = (Array.isArray(c.prompts) ? c.prompts : []) as Card[];
      const labels = prompts.slice(0, 4).map((p) => str(p.label)).filter(Boolean);
      return labels.length ? `Try: ${labels.join(" · ")}` : `Ask Skopos anything — swaps, prices, intel: ${SITE}`;
    }

    case "intel":
      return renderIntel(c, ctx);

    case "aeon": {
      const rawKind = str(c.kind);
      const kind: AeonKind = (["defi", "narrative", "trending", "protocols", "fear", "x402"].includes(rawKind) ? rawKind : "defi") as AeonKind;
      const read = await getAeonRead(kind);
      if (read) return read;
      const label = { defi: "DeFi read", narrative: "narrative map", trending: "trending list", protocols: "top protocols", fear: "fear-divergence read", x402: "x402 pulse" }[kind];
      return `Open Skopos for the ${label}: ${SITE}`;
    }

    case "paywall":
      return str(c.reason) === "connect"
        ? `Connect a wallet in Skopos to use the Smart tier: ${APP}`
        : `You've hit today's Smart limit. Subscribe to keep going: ${SITE}`;

    case "pay": {
      const amt = str(c.amountDisplay) || String(num(c.amountWei) ?? "");
      const sym = str(c.tokenSymbol) || "tokens";
      return `Ready: send ${amt} ${sym} to ${str(c.to)}${c.chainName ? ` on ${str(c.chainName)}` : ""}${c.memoText ? ` for "${str(c.memoText)}"` : ""}. Tap to sign in the Skopos app.`;
    }

    default:
      return `Open Skopos for this: ${SITE}`;
  }
}
