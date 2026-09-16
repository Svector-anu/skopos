"use client";

import { useState } from "react";

// The consumer's only input. Deliberately a plain client island with no wallet
// context: /s/ is a document, and Web3Provider is mounted only under /app
// (app/app/layout.tsx), so this collects a number and hands off rather than
// duplicating a connect flow that already exists and works.
//
// Validation here is a courtesy. The bounds are re-checked server-side at quote
// AND again at submit, because by then the number has made a round trip through
// a browser nobody controls.

const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };

export function SealSizePanel({
  id, unit, spending, min, max, suggested, retired,
}: {
  id: string;
  unit: string;
  /** True when qty is a contra amount — a buy spends dollars, a sell sends tokens. */
  spending: boolean;
  min: string;
  max: string;
  suggested: string;
  retired: boolean;
}) {
  const [size, setSize] = useState(suggested);

  const n = Number(size);
  const valid = Number.isFinite(n) && n > 0 && n >= Number(min) && n <= Number(max);
  const hint = !Number.isFinite(n) || n <= 0
    ? "Enter an amount."
    : n < Number(min) ? `This Seal starts at ${min} ${unit}.`
    : n > Number(max) ? `This Seal caps at ${max} ${unit}.`
    : null;

  if (retired) {
    return (
      <p style={{ ...MONO, fontSize: "0.8rem", color: "var(--card-text-dim)", margin: 0 }}>
        This Seal was retired by its creator. Existing orders are unaffected.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label htmlFor="seal-size" style={{ ...MONO, fontSize: "0.62rem", letterSpacing: "0.1em", color: "var(--card-text-faint)", textTransform: "uppercase" }}>
        {/* Never a bare number: qty flips unit between sides, and this is the
            field a stranger is most likely to misread. */}
        {spending ? `You're spending — ${unit}` : `You're selling — ${unit}`}
      </label>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          id="seal-size"
          inputMode="decimal"
          value={size}
          onChange={(e) => setSize(e.target.value.replace(/[^\d.]/g, ""))}
          style={{
            ...MONO, fontSize: "1rem", padding: "10px 12px", borderRadius: 8, width: 160,
            background: "var(--card-bg)", color: "var(--card-text)",
            border: "1px solid var(--card-border-faint)",
          }}
        />
        <span style={{ ...MONO, fontSize: "0.8rem", color: "var(--card-text-dim)" }}>{unit}</span>

        <a
          href={valid ? `/app?seal=${encodeURIComponent(id)}&size=${encodeURIComponent(size)}` : undefined}
          aria-disabled={!valid}
          style={{
            ...MONO, fontSize: "0.78rem", padding: "11px 18px", borderRadius: 8,
            textDecoration: "none", marginLeft: "auto",
            background: valid ? "rgba(245,184,0,0.12)" : "transparent",
            border: `1px solid ${valid ? "rgba(245,184,0,0.45)" : "var(--card-border-faint)"}`,
            color: valid ? "rgba(245,184,0,0.95)" : "var(--card-text-faint)",
            pointerEvents: valid ? "auto" : "none",
          }}
        >
          Connect wallet &amp; get quote →
        </a>
      </div>

      <p style={{ ...MONO, fontSize: "0.68rem", color: hint ? "var(--card-text-dim)" : "var(--card-text-faint)", margin: 0 }}>
        {hint ?? `Creator's range: ${min}–${max} ${unit}. Priced fresh when you use it, never before.`}
      </p>
    </div>
  );
}
