"use client";

import { useRef, useEffect, useState } from "react";
import Link from "next/link";

type QuoteResult = {
  type: "quote";
  intent: {
    from: { chain: string; token: string; amount: string };
    to: { chain: string; token: string };
  };
  route: {
    tool: string;
    outputAmount: string;
    feesUSD: string | null;
    gasUSD: string | null;
  };
  calldata: { to: string; value: string; data: string } | null;
};

type TextResult = { type: "text"; text: string };
type ErrorResult = { type: "error"; text: string };
type Result = QuoteResult | TextResult | ErrorResult;

const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
const BEBAS: React.CSSProperties = { fontFamily: "var(--font-bebas-neue), sans-serif" };

export default function AppPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit() {
    const msg = value.trim();
    if (!msg || loading) return;
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const data: Result = await res.json();
      setResult(data);
    } catch {
      setResult({ type: "error", text: "Network error. Is the server running?" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-black flex flex-col items-center justify-center px-4">
      <Link
        href="/"
        className="absolute top-6 left-6 text-white/30 hover:text-white/60 transition-colors text-xs tracking-widest uppercase"
        style={MONO}
      >
        ← back
      </Link>

      <div className="flex flex-col items-center gap-6 w-full max-w-lg">
        <h1
          className="text-white text-center leading-none"
          style={{ ...BEBAS, fontSize: "clamp(2.5rem, 6vw, 3.5rem)", letterSpacing: "0.02em" }}
        >
          What do you want to do?
        </h1>

        <div
          className="w-full flex items-center gap-3 px-4 py-3"
          style={{ background: "#0A0A0A", border: "1px solid rgba(255,255,255,0.12)" }}
        >
          <span className="text-sm shrink-0" style={{ color: "#F5B800", ...MONO }}>{">"}</span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="move 1 eth from ethereum to base"
            className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-white/20"
            style={MONO}
          />
          {loading ? (
            <span className="text-white/30 text-xs shrink-0 animate-pulse" style={MONO}>…</span>
          ) : (
            value.trim() && (
              <button
                onClick={submit}
                className="text-xs shrink-0 px-3 py-1 border border-white/20 text-white/50 hover:text-white hover:border-white/40 transition-colors"
                style={MONO}
              >
                run
              </button>
            )
          )}
        </div>

        {result && (
          <div
            className="w-full"
            style={{ background: "#0A0A0A", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            {result.type === "quote" && <QuoteDisplay result={result} />}
            {(result.type === "text" || result.type === "error") && (
              <div className="px-4 py-3">
                <p
                  className="text-sm"
                  style={{ ...MONO, color: result.type === "error" ? "#ff4444" : "rgba(255,255,255,0.6)" }}
                >
                  {result.text}
                </p>
              </div>
            )}
          </div>
        )}

        {!result && !loading && (
          <p className="text-xs text-white/20 text-center" style={MONO}>
            press enter or click run
          </p>
        )}
      </div>
    </main>
  );
}

function QuoteDisplay({ result }: { result: QuoteResult }) {
  const { intent, route, calldata } = result;

  const rows: [string, string][] = [
    ["route", `${intent.from.chain} → ${route.tool} → ${intent.to.chain}`],
    ["send", `${intent.from.amount} ${intent.from.token}`],
    ["receive", `~${route.outputAmount} ${intent.to.token}`],
    ...(route.feesUSD ? [["fees", `~$${Number(route.feesUSD).toFixed(4)}`] as [string, string]] : []),
    ...(route.gasUSD ? [["gas", `~$${Number(route.gasUSD).toFixed(4)}`] as [string, string]] : []),
  ];

  return (
    <div className="px-4 py-3 flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {rows.map(([label, val]) => (
          <div key={label} className="flex items-start gap-3">
            <span className="text-xs w-16 shrink-0" style={{ ...MONO, color: "#F5B800" }}>
              {label}
            </span>
            <span className="text-xs text-white/70" style={MONO}>
              {val}
            </span>
          </div>
        ))}
      </div>

      <button
        disabled={!calldata}
        className="w-full py-2.5 text-xs tracking-widest uppercase border transition-colors"
        style={{
          ...MONO,
          borderColor: calldata ? "rgba(245,184,0,0.4)" : "rgba(255,255,255,0.1)",
          color: calldata ? "#F5B800" : "rgba(255,255,255,0.2)",
          cursor: calldata ? "not-allowed" : "not-allowed",
          background: "transparent",
        }}
        title="Wallet connection coming in Phase 3"
      >
        {calldata ? "execute → (connect wallet to sign)" : "no calldata available"}
      </button>
    </div>
  );
}
