// Natural-language time windows for intel reads. Parsed from the query, threaded
// through the card → client → API → the paid Nansen call. Date-range endpoints
// (who-bought-sold, flows) take an exact from/to; enum endpoints (screener,
// flow-intelligence) take Nansen's own timeframe strings, so we map to the
// nearest supported value.

export type Timeframe = "30m" | "1h" | "4h" | "24h" | "7d" | "30d";

const MS: Record<Timeframe, number> = {
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export const TIMEFRAMES = Object.keys(MS) as Timeframe[];

export function isTimeframe(v: unknown): v is Timeframe {
  return typeof v === "string" && (TIMEFRAMES as string[]).includes(v);
}

// Ordered longest-token-first so "24 hours" doesn't get caught by the "hour"
// pattern and "7 days" doesn't get caught by "day".
export function parseTimeframe(text: string): Timeframe | null {
  const t = text.toLowerCase();
  if (/\b(30\s*m(?:in(?:ute)?s?)?|half\s+an?\s+hour)\b/.test(t)) return "30m";
  if (/\b(7\s*d(?:ays?)?|1\s*w(?:eek)?|weekly|(?:this|past|last)\s+week)\b/.test(t)) return "7d";
  if (/\b(30\s*d(?:ays?)?|1\s*mo(?:nth)?|monthly|(?:this|past|last)\s+month)\b/.test(t)) return "30d";
  if (/\b(24\s*h(?:ours?)?|1\s*d(?:ay)?|daily|today|(?:past|last)\s+day)\b/.test(t)) return "24h";
  if (/\b(4\s*h(?:ours?)?)\b/.test(t)) return "4h";
  if (/\b(1\s*h(?:our|r)?|an?\s+hour|(?:past|last)\s+hour|hourly)\b/.test(t)) return "1h";
  return null;
}

export function timeframeMs(tf: Timeframe): number {
  return MS[tf];
}

// Screener enum: 5m, 10m, 1h, 6h, 24h, 7d, 30d.
const SCREENER_ENUM: Record<Timeframe, string> = {
  "30m": "1h", "1h": "1h", "4h": "6h", "24h": "24h", "7d": "7d", "30d": "30d",
};
export function toScreenerTimeframe(tf: Timeframe): string {
  return SCREENER_ENUM[tf];
}

// Flow-intelligence only accepts 1d / 7d (30d returns 422). Sub-day collapses to
// 1d; anything a week or longer is capped at 7d.
const FLOW_INTEL_ENUM: Record<Timeframe, string> = {
  "30m": "1d", "1h": "1d", "4h": "1d", "24h": "1d", "7d": "7d", "30d": "7d",
};
export function toFlowIntelTimeframe(tf: Timeframe): string {
  return FLOW_INTEL_ENUM[tf];
}

export function timeframeLabel(tf: Timeframe): string {
  return tf.toUpperCase();
}
