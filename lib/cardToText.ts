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
import { getAeonRead, stripMarkdown, type AeonKind } from "./aeonFeed";

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

const ADVANCED_ORDER_HANDOFF_FIELDS = [
  "mode", "orderType", "side", "qty", "price", "duration", "token", "chain",
] as const;

// Text-mode responses normally collapse a card to { type, text, link }. Advanced
// orders are also useful to the calling agent as structured data, so copy only
// the inert intent fields. Keeping this allowlist here makes it impossible for a
// Flash quote, approval transaction, or EIP-712 payload to leak into headless
// mode if the browser card grows new signing fields later.
export function headlessHandoffFields(card: unknown): Record<string, string | number> {
  if (!card || typeof card !== "object") return {};
  const c = card as Record<string, unknown>;
  if (c.type !== "quote" || c.mode !== "handoff" || typeof c.orderType !== "string") return {};

  const fields: Record<string, string | number> = {};
  for (const key of ADVANCED_ORDER_HANDOFF_FIELDS) {
    const value = c[key];
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      fields[key] = value;
    }
  }
  return fields;
}

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
// External-data hygiene. Token names, market titles, wallet labels, and memos
// come from permissionless sources — anyone can launch a token or register an
// ENS name that reads like an instruction ("ignore previous instructions…"),
// and this text lands directly in a calling agent's context. Strip control and
// zero-width characters, collapse to one line, and cap length so external
// strings stay data-shaped, never instruction-shaped.
const clean = (v: unknown, max = 48): string =>
  str(v)
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

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
    return { label: clean(pickStr(r, ["address_label", "label"]), 32) || short(pickStr(r, ["address"]) ?? "wallet"), net };
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
    label: clean(pickStr(r, ["address_label", "label"]), 32) || short(pickStr(r, ["address"]) ?? "wallet"),
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
  const list = rows.map((p) => `$${clean(p.sym, 16)} (${clean(p.chain, 16)}) ${p.net !== null ? fmtUsd(p.net) : ""}${p.chg ? ` ${p.chg >= 0 ? "+" : ""}${p.chg.toFixed(1)}%` : ""}`).join(", ");
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
  //
  // The two reasons this refuses are not the same thing, and saying "limit
  // reached — try later" for both is wrong advice for one of them. A caller
  // with no anonId has spent nothing and waiting will never clear it: the id
  // IS the cap key, so without one there is nothing to count against and the
  // read fails closed by design. That caller is usually an agent developer on
  // their first request, told they are rate-limited before they have made one.
  if (!ctx.anonId) {
    return `Intel reads need an "anonId" in the request — it's the per-caller key these paid reads are capped against. Send any stable id for your conversation and retry. See ${SITE}/llms.txt`;
  }
  if (!(await checkAgentTextIntelCap(ctx.anonId))) {
    return `Daily intel limit reached — try later or open Skopos: ${SITE}`;
  }
  if (!(await checkIntelBudget())) {
    return `Smart-money reads are at today's limit — try tomorrow or open Skopos: ${SITE}`;
  }

  const t = c.token as { symbol?: string; address?: string; chain?: string } | undefined;
  const token = { symbol: t?.symbol ?? null, address: t?.address ?? null, chain: t?.chain ?? null };
  const sym = token.symbol ? `$${clean(token.symbol, 16)}` : "this token";
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
      const sym = clean(c.symbol, 16) || "?";
      const name = clean(c.name);
      const price = num(c.price), chg = num(c.change24h), mc = num(c.marketCap);
      const head = name ? `${sym} (${name})` : sym;
      const line = `${head}: ${price !== null ? fmtUsd(price) : "—"}${chg !== null ? ` · ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% 24h` : ""}${mc !== null ? ` · mcap ${fmtUsd(mc)}` : ""}`;
      const sp = ctx.sparkline === false ? null : sparkline(c.sparkline);
      if (!sp) return line;
      return `${line}\n${sp.bars}  7d ${sp.chg >= 0 ? "+" : ""}${sp.chg.toFixed(1)}% · ${fmtUsd(sp.lo)}–${fmtUsd(sp.hi)}`;
    }

    case "quote": {
      if (c.mode === "handoff" && typeof c.orderType === "string") {
        const side = clean(c.side, 8);
        const qty = clean(c.qty, 32);
        const token = clean(c.token, 16);
        const chain = clean(c.chain, 24);
        const price = clean(c.price, 32);
        const duration = num(c.duration);
        // A trigger order is not priced "at" its level — it fires when the
        // market reaches it. restate() has always said "if it drops below" /
        // "when it hits"; this surface said "at", which reads as a limit price
        // on an order that has none.
        const ot = clean(c.orderType, 16).toLowerCase();
        const detail = price
          ? ot === "stop-loss"   ? ` if it drops below $${price}`
          : ot === "take-profit" ? ` when it hits $${price}`
          : ` at $${price}`
          : duration !== null ? ` over ${duration} seconds` : "";
        const where = chain ? ` on ${chain}` : "";
        // Flash prices a BUY in the asset being spent, so qty on a buy is a
        // dollar amount and on a sell is a token count. Printing it bare read
        // "buy 140 ETH" for a $140 order — the same mistake restate() was
        // written to stop, on the one surface where the sentence IS the order.
        const amount = side === "buy" ? `$${qty} of ${token}` : `${qty} ${token}`;
        return `${ot} order ready: ${side} ${amount}${detail}${where}. Tap to review and sign in the Skopos app.`;
      }
      const qi = c.intent as { from?: { token?: string; amount?: string; chain?: string }; to?: { token?: string; chain?: string } } | undefined;
      const route = c.route as { outputAmount?: string; tool?: string } | undefined;
      const f = qi?.from, to = qi?.to;
      const dest = route?.outputAmount
        ? `~${str(route.outputAmount)} ${clean(to?.token, 16)} on ${clean(to?.chain, 24)}`
        : `${clean(to?.token, 16)} on ${clean(to?.chain, 24)}`;
      return `Swap ${str(f?.amount)} ${clean(f?.token, 16)} on ${clean(f?.chain, 24)} → ${dest}${route?.tool ? ` (via ${route.tool})` : ""}. Tap to sign in the Skopos app.`;
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
      const flagList = Array.isArray(risk?.flags) ? risk!.flags.map((f) => RISK_FLAG_LABELS[f] ?? clean(f, 32)) : [];
      const flags = flagList.length ? ` Flags: ${flagList.join(", ")}.` : "";
      const prefix = c.pick ? "Today's pick — not financial advice. " : "";
      return `${prefix}${clean(risk?.symbol, 16)} risk: ${str(risk?.label)} (${risk?.score ?? "?"}/4).${risk?.priceUsd ? ` $${risk.priceUsd}.` : ""}${flags}`;
    }

    case "yield_pools": {
      const pools = (Array.isArray(c.pools) ? c.pools : []) as Card[];
      if (!pools.length) return `No yield pools found for ${clean(c.symbol, 16)}.`;
      const top = pools.slice(0, 3).map((p) => `${clean(p.project, 32)} (${clean(p.chain, 16)}) ${num(p.apy)?.toFixed(1) ?? "?"}% APY, ${fmtUsd(num(p.tvlUsd) ?? 0)} TVL`).join("; ");
      return `Top yield for ${clean(c.symbol, 16)}: ${top}.`;
    }

    case "polymarket": {
      const events = (Array.isArray(c.markets) ? c.markets : []) as Card[];
      if (!events.length) return `No prediction markets found${c.topic ? ` for "${str(c.topic)}"` : ""}.`;
      const lines = events.slice(0, 3).map((e) => {
        const m = (Array.isArray(e.markets) ? e.markets[0] : undefined) as Card | undefined;
        const outs = Array.isArray(m?.outcomes) ? (m!.outcomes as string[]) : [];
        const prices = Array.isArray(m?.outcomePrices) ? (m!.outcomePrices as string[]) : [];
        const odds = outs.length && prices.length ? ` — ${clean(outs[0], 24)} ${(Number(prices[0]) * 100).toFixed(0)}%` : "";
        return `${clean(e.title, 80)}${odds}`;
      }).join(" · ");
      return `Prediction markets: ${lines}.`;
    }

    case "payments": {
      const pays = (Array.isArray(c.payments) ? c.payments : []) as Card[];
      if (!pays.length) return `No incoming payments found for ${short(str(c.address))}.`;
      const lines = pays.slice(0, 3).map((p) => `${str(p.amount)} ${clean(p.tokenSymbol, 16)} from ${short(str(p.from))}${p.memoText ? ` (${clean(p.memoText, 64)})` : ""}`).join("; ");
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
      const kind: AeonKind = (["defi", "narrative", "trending", "protocols", "fear", "x402", "tokenpick", "pickstracker"].includes(rawKind) ? rawKind : "defi") as AeonKind;
      const read = await getAeonRead(kind);
      if (read) return stripMarkdown(read);
      const label = { defi: "DeFi read", narrative: "narrative map", trending: "trending list", protocols: "top protocols", fear: "fear-divergence read", x402: "x402 pulse", tokenpick: "token pick", pickstracker: "picks scorecard" }[kind];
      return `Open Skopos for the ${label}: ${SITE}`;
    }

    case "paywall":
      return str(c.reason) === "connect"
        ? `Connect a wallet in Skopos to use the Smart tier: ${APP}`
        : `You've hit today's Smart limit. Subscribe to keep going: ${SITE}`;

    case "pay": {
      const amt = str(c.amountDisplay) || String(num(c.amountWei) ?? "");
      const sym = clean(c.tokenSymbol, 16) || "tokens";
      return `Ready: send ${amt} ${sym} to ${str(c.to)}${c.chainName ? ` on ${clean(c.chainName, 24)}` : ""}${c.memoText ? ` for "${clean(c.memoText, 64)}"` : ""}. Tap to sign in the Skopos app.`;
    }

    case "robinhood_launches": {
      const launches = (Array.isArray(c.launches) ? c.launches : []) as Card[];
      if (!launches.length) return `No Robinhood Chain launches found right now.`;
      const lines = launches.map((l) => {
        const creator = (l.creator ?? {}) as Card;
        const risk = l.risk as Card | null;
        const links = (l.links ?? {}) as Card;
        const ratio = num(l.volumeToMcapRatio);
        const mcap = num(l.marketCapUsd);
        const liq = num(risk?.totalLiquidityUsd);
        const repeat = num(creator.repeatLaunchCount) ?? 0;
        const parts = [
          `${l.hot ? "🔥 " : ""}${clean(l.symbol, 16)} (${clean(l.name)})`,
          `${num(l.ageMinutes) ?? "?"}m old`,
          mcap && mcap > 0 ? `${fmtUsd(mcap)} mcap` : "no trades yet",
          liq !== null ? `${fmtUsd(liq)} liq` : null,
          ratio !== null ? `${ratio.toFixed(1)}x vol/mcap` : null,
          `by @${clean(creator.xUsername, 24) || "unknown"}`,
          repeat > 1 ? `⚠️ ${repeat} launches this wallet — ${clean(creator.profileUrl, 96)}` : null,
          risk ? `${str(risk.label)} risk` : "not indexed yet",
          `CA ${str(l.address)}`,
          clean(links.geckoterminal, 96) || null,
        ].filter(Boolean);
        return parts.join(" · ");
      });
      const subtitle = str(c.subtitle);
      return `${str(c.heading)}${subtitle ? ` · ${subtitle}` : ""}:\n\n${lines.join("\n")}`;
    }

    case "stock_paired": {
      const items = (Array.isArray(c.items) ? c.items : []) as Card[];
      if (!items.length) return `Open Skopos for stock-paired token intel: ${SITE}`;
      const lines = items.map((it) => {
        const tok = clean(it.tokenSymbol, 16) || "?";
        const stock = clean(it.stockSymbol, 16) || "?";
        const verified = it.stockVerified ? "" : " (quote token NOT verified against Robinhood's registry)";
        const impersonation = it.tokenImpersonatesTicker
          ? ` WARNING: ${tok} is named after an equity ticker but is NOT the Robinhood-issued ${tok} token — verification covers the ${stock} quote side only`
          : "";
        const ratio = str(it.priceInStockTerms);
        const px = num(it.stockPriceUsd);
        const daily = num(it.dailyStockValueEstimate);
        const dailyTok = num(it.dailyStockTokensEstimate);
        const total = num(it.totalAccumulatedEstimate);
        const days = num(it.daysOld);
        const parts = [
          `${tok} is paired against ${stock}${verified}${impersonation}`,
          ratio ? `1 ${tok} = ${ratio} ${stock}` : null,
          px !== null ? `${stock} ${fmtUsd(px)}` : `no live ${stock} price feed`,
          daily !== null ? `est. fees to creator ~${fmtUsd(daily)}/day${dailyTok !== null ? ` (~${dailyTok.toFixed(2)} ${stock}/day)` : ""}` : null,
          total !== null && days !== null ? `~${fmtUsd(total)} since launch (${days.toFixed(1)}d)` : null,
        ].filter(Boolean);
        return parts.join(" · ");
      });
      return `${str(c.heading) || "Stock-paired"}:\n${lines.join("\n")}\nEstimates from trading volume (standard Doppler parameters), not exact balances.`;
    }

    case "approval_scan": {
      const rows = (Array.isArray(c.rows) ? c.rows : []) as Card[];
      const days = num(c.windowDays) ?? 90;
      if (!rows.length) return `No active token approvals found for ${short(str(c.address))} in the last ${days} days.`;
      const lines = rows.map((r) => {
        const allowance = r.unlimited ? "UNLIMITED" : str(r.allowanceDisplay);
        return `${clean(r.tokenSymbol, 16)} → ${short(str(r.spender))} on ${clean(r.chainName, 24)}: ${allowance} allowance${r.unlimited ? " ⚠️" : ""}`;
      });
      return `Active approvals for ${short(str(c.address))} (last ${days} days):\n\n${lines.join("\n")}`;
    }

    case "flash_orders": {
      const orders = (Array.isArray(c.orders) ? c.orders : []) as Card[];
      if (!orders.length) return `No Flash orders found for ${short(str(c.address))}.`;
      const lines = orders.map((o) => {
        const targetAsset = (o.targetAsset ?? {}) as Card;
        const contraAsset = (o.contraAsset ?? {}) as Card;
        const status = str(o.status).replace("ORDER_STATUS_", "").replace(/_/g, " ").toLowerCase() || "unknown";
        const qtyLine = o.side === "buy"
          ? `${str(o.qty)} ${clean(contraAsset.ticker, 16)} → ${clean(targetAsset.ticker, 16)}`
          : `${str(o.qty)} ${clean(targetAsset.ticker, 16)} → ${clean(contraAsset.ticker, 16)}`;
        // An attached pair is reported on its ENTRY until it activates, and
        // "pending" is the state most worth spelling out — an entry that never
        // fills means protection that never existed.
        const protection = o.orderType === "bracket" || o.sourceEntryOrderId
          ? ` · protection for order ${str(o.sourceEntryOrderId).slice(0, 8)}`
          : "";
        const ab = o.attachedBracket as Card | null;
        const legPrice = (leg: unknown) => {
          const l = (leg ?? {}) as Card;
          return str(l.notionalPrice) || str(l.crossPrice) || "?";
        };
        const bracket = ab
          ? str(ab.status) === "active" ? ` · protected: stop ${legPrice(ab.stopLoss)} / target ${legPrice(ab.takeProfit)}`
          : str(ab.status) === "pending_activation" ? ` · protection arms on first fill: stop ${legPrice(ab.stopLoss)} / target ${legPrice(ab.takeProfit)}`
          : " · protection never activated"
          : "";
        return `${str(o.side)} ${str(o.orderType)} · ${qtyLine} · ${status} · id ${str(o.orderId).slice(0, 8)}${protection}${bracket}`;
      });
      // Repricing and cancelling both need a wallet signature, which a
      // headless client cannot produce — say so rather than listing orders
      // that look actionable from here.
      return `Flash orders for ${short(str(c.address))}:\n\n${lines.join("\n")}\n\nTo reprice or cancel one, open ${APP}.`;
    }

    default:
      return `Open Skopos for this: ${SITE}`;
  }
}
