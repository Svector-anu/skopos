import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { getPrice, getPriceChart } from "@/lib/priceCache";

export const runtime = "edge";

const W = 1200;
const H = 630;
const PAD = 64;
const CHART_W = W - PAD * 2;
const CHART_H = 250;

const YELLOW = "#F5B800";
const UP = "#22c55e";
const DOWN = "#ef4444";
const FAINT = "rgba(255,255,255,0.42)";

function fmtUsd(x: number): string {
  const abs = Math.abs(x);
  if (abs >= 1_000_000_000) return `$${(x / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(x / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${x.toFixed(2)}`;
  if (abs > 0) return `$${x.toPrecision(3)}`;
  return "$0";
}

function downsample(data: number[], n: number): number[] {
  if (data.length <= n) return data;
  const step = (data.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => data[Math.round(i * step)]);
}

function polyPoints(series: number[]): { line: string; area: string; lo: number; hi: number } {
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = hi - lo || 1;
  const yPad = 24;
  const usable = CHART_H - yPad * 2;
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * CHART_W;
    const y = yPad + (1 - (v - lo) / span) * usable;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = pts.join(" ");
  const area = `0,${CHART_H} ${line} ${CHART_W},${CHART_H}`;
  return { line, area, lo, hi };
}

function fallback(title: string, sub: string): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: W,
          height: H,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          background: "#000",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 40,
              height: 40,
              background: YELLOW,
              borderRadius: 9,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ width: 18, height: 18, background: "#000", transform: "rotate(45deg)", borderRadius: 3 }} />
          </div>
          <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: 3 }}>SKOPOS</span>
        </div>
        <span style={{ fontSize: 44, fontWeight: 700 }}>{title}</span>
        <span style={{ fontSize: 24, color: FAINT }}>{sub}</span>
      </div>
    ),
    { width: W, height: H }
  );
}

export async function GET(req: NextRequest): Promise<ImageResponse | Response> {
  const token = req.nextUrl.searchParams.get("token")?.trim();
  if (!token) return fallback("Chart", "pass ?token=eth");

  const symbol = token.toUpperCase();
  const [result, chart] = await Promise.all([getPrice(symbol), getPriceChart(symbol)]);

  if (!chart || chart.sparkline.length < 2) {
    return fallback(symbol, "no chart data — open tryskopos.xyz");
  }

  const series = downsample(chart.sparkline, 72);
  const { line, area, lo, hi } = polyPoints(series);
  const first = series[0];
  const last = series[series.length - 1];
  const chg7d = first > 0 ? ((last - first) / first) * 100 : 0;
  const positive = chg7d >= 0;
  const color = positive ? UP : DOWN;

  const price = result?.price ?? last;
  const change24h = result?.change24h ?? null;
  const name = chart.name || symbol;

  return new ImageResponse(
    (
      <div
        style={{
          width: W,
          height: H,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: PAD,
          background: "#000",
          backgroundImage: `radial-gradient(50% 42% at 78% -8%, ${color}22, transparent 70%)`,
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 44, fontWeight: 700 }}>{name}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ fontSize: 24, color: FAINT, letterSpacing: 2 }}>{symbol}</span>
              <span style={{ fontSize: 24, color, fontWeight: 700 }}>
                {positive ? "▲" : "▼"} {positive ? "+" : ""}
                {chg7d.toFixed(1)}% · 7d
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 40,
                height: 40,
                background: YELLOW,
                borderRadius: 9,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div style={{ width: 18, height: 18, background: "#000", transform: "rotate(45deg)", borderRadius: 3 }} />
            </div>
            <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: 3 }}>SKOPOS</span>
          </div>
        </div>

        {/* price */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
          <span style={{ fontSize: 88, fontWeight: 700 }}>{fmtUsd(price)}</span>
          {change24h !== null && (
            <span style={{ fontSize: 28, color: change24h >= 0 ? UP : DOWN, fontWeight: 700 }}>
              {change24h >= 0 ? "+" : ""}
              {change24h.toFixed(2)}% 24h
            </span>
          )}
        </div>

        {/* chart */}
        <div style={{ display: "flex" }}>
          <svg width={CHART_W} height={CHART_H} viewBox={`0 0 ${CHART_W} ${CHART_H}`}>
            <polygon points={area} fill={color} fillOpacity={0.13} />
            <polyline points={line} fill="none" stroke={color} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />
          </svg>
        </div>

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 24, color: FAINT }}>
            7d range {fmtUsd(lo)} – {fmtUsd(hi)}
          </span>
          <span style={{ fontSize: 24, color: YELLOW, fontWeight: 700 }}>tryskopos.xyz</span>
        </div>
      </div>
    ),
    {
      width: W,
      height: H,
      headers: { "cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600" },
    }
  );
}
