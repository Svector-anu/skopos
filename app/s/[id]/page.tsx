import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSeal, getInstantiationCount } from "@/lib/sealStore";
import { sizeUnitLabel, isSizeInContraUnits, contraSymbolForChain, sealPolicyLine } from "@/lib/seal";
import { SealSizePanel } from "./SealSizePanel";

// A Seal's public face. Server-rendered on purpose: it must be readable with no
// wallet, no JavaScript and no Flash request — it is a document until somebody
// chooses to act on it, and the wallet only enters the story on /app.
//
// This is also the repo's first dynamic page that renders data (the only other
// one, /address/[addr], is a ten-line redirect) and its first generateMetadata,
// so a shared Seal link finally has a title worth reading in a preview.

const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const read = await getSeal(id);
  if (!read.ok) return { title: "Seal not found — Skopos" };

  const p = read.policy;
  const line = sealPolicyLine(p, contraSymbolForChain(p.chain));
  // Per-Seal card, not the site banner every other page falls back to. The use
  // count on it moves while the link travels, so a preview shared at zero and
  // reposted later shows the difference — the image is a scoreboard.
  const card = `/api/og/seal?id=${encodeURIComponent(p.id)}`;
  return {
    title: `${p.title} — a Skopos Seal`,
    description: line,
    openGraph: { title: p.title, description: line, images: [{ url: card, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title: p.title, description: line, images: [card] },
  };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "7px 0", borderTop: "1px solid var(--card-bg)" }}>
      <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-dim)" }}>{label}</span>
      <span style={{ ...MONO, fontSize: "0.74rem", color: "var(--card-text)", fontWeight: 500, textAlign: "right", wordBreak: "break-word" }}>{value}</span>
    </div>
  );
}

export default async function SealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const read = await getSeal(id);

  if (!read.ok) {
    // A store that is merely unreachable must not read as "the creator deleted
    // it" — that is a different, permanent-sounding thing.
    if (read.reason === "unavailable") {
      return (
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "var(--background)", color: "var(--foreground)" }}>
          <p style={{ ...MONO, fontSize: "0.85rem" }}>Couldn&apos;t load this Seal right now. Try again in a moment.</p>
        </main>
      );
    }
    notFound();
  }

  const p = read.policy;
  const uses = await getInstantiationCount(p.id);
  const contra = contraSymbolForChain(p.chain);
  const unit = sizeUnitLabel(p, contra);

  return (
    <main style={{ minHeight: "100vh", padding: "48px 20px 80px", background: "var(--background)", color: "var(--foreground)" }}>
      <div style={{ maxWidth: 620, margin: "0 auto", display: "flex", flexDirection: "column", gap: 22 }}>

        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <span style={{ ...MONO, fontSize: "0.6rem", letterSpacing: "0.16em", textTransform: "uppercase", color: "rgba(245,184,0,0.9)" }}>
            Skopos Seal
          </span>
          <h1 style={{ fontSize: "1.65rem", fontWeight: 600, margin: 0, lineHeight: 1.2 }}>{p.title}</h1>
          <p style={{ ...MONO, fontSize: "0.82rem", color: "var(--card-text-dim)", margin: 0, lineHeight: 1.6 }}>
            {sealPolicyLine(p, contraSymbolForChain(p.chain))}
          </p>
        </div>

        <section style={{ border: "1px solid var(--card-border-faint)", borderRadius: 12, padding: "14px 16px", background: "var(--card-bg)" }}>
          <p style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--card-text-faint)", margin: "0 0 4px" }}>
            The policy
          </p>
          <Row label="side" value={p.side} />
          <Row label="order type" value={p.orderType} />
          <Row label="token" value={p.token.toUpperCase()} />
          <Row label="chain" value={p.chain} />
          {p.priceLevel && <Row label={p.orderType === "limit" ? "limit price" : "trigger price"} value={`$${p.priceLevel}`} />}
          {p.durationSeconds !== undefined && <Row label="duration" value={`${p.durationSeconds}s`} />}
          {p.bracket && <Row label="stop-loss" value={`$${p.bracket.stopLoss.price}`} />}
          {p.bracket && <Row label="take-profit" value={`$${p.bracket.takeProfit.price}`} />}
          <Row label="your size" value={`${p.sizing.min}–${p.sizing.max} ${unit}`} />
        </section>

        <section style={{ border: "1px solid var(--card-border-faint)", borderRadius: 12, padding: "16px", background: "var(--card-bg)" }}>
          <SealSizePanel
            id={p.id}
            unit={unit}
            spending={isSizeInContraUnits(p)}
            min={p.sizing.min}
            max={p.sizing.max}
            suggested={p.sizing.suggested}
            retired={p.retired === true}
          />
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Row label="published by" value={`${p.creator.slice(0, 6)}…${p.creator.slice(-4)}`} />
          <Row label="published" value={new Date(p.createdAt).toISOString().slice(0, 10)} />
          <Row label="wallets that used it" value={String(uses)} />
        </section>

        {/* Said plainly, because the person reading this did not write it. */}
        <p style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text-faint)", lineHeight: 1.7, margin: 0 }}>
          A Seal is a policy, not advice and not an offer. It holds no funds and gives nobody access
          to yours. When you use it, Skopos prices it fresh for your wallet and you sign your own
          order — the creator cannot see it, change it or cancel it, and nothing about your order
          touches anyone else&apos;s.
        </p>

      </div>
    </main>
  );
}
