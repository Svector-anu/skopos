import type { Metadata } from "next";
import Link from "next/link";
import { CornerBrackets } from "@/components/landing/CornerBrackets";
import { HeaderIcons } from "@/components/landing/HeaderIcons";

export const metadata: Metadata = {
  title: "Changelog — Skopos",
  description:
    "What's shipping on Skopos: B20 memo payments, the $skopos holder perk, and safer execution across the cross-chain DeFi copilot.",
};

const MONO = "var(--font-jetbrains-mono), monospace";
const SERIF = "var(--font-display), serif";
const YELLOW = "#F5B800";

interface Entry {
  date: string;
  title: string;
  lede: string;
  highlights?: string[];
}

const ENTRIES: Entry[] = [
  {
    date: "Jul 1, 2026",
    title: "Read the smart money — we cover the bill",
    lede:
      "Ask what the smart money is doing on almost any token and just see the answer — no wallet, no signing. Skopos fronts the tiny x402 data fee itself. \"who's dumping $PEPE\", \"who holds $ARB\", \"what's smart money buying\" — you ask, it pays, you read.",
    highlights: [
      "Five reads on one rail: who's buying or selling, top holders, the accumulation trend over time, where a token is flowing (wallet segments vs exchanges), and a cross-chain screener of what smart money is buying right now.",
      "Named wallets, not 0x… — paid Nansen access surfaces real entities: market makers, funds, top-PnL traders.",
      "No wallet connect, no chain switch, no signature — Skopos's own wallet settles the x402 micropayment server-side.",
      "Powered by Nansen Token God Mode over x402 — the same HTTP-native settlement rail that underpins agent-to-agent payments.",
    ],
  },
  {
    date: "Jun 29, 2026",
    title: "B20 payments on Base",
    lede:
      "Pay anyone on Base in plain English, with a memo that lands on-chain — then watch it reconcile itself. \"pay 10 USDC to 0x… for order-1024\" → the memo is the reference; the receiver's inbox matches it automatically. Non-custodial: Skopos builds the payment, you sign, it never holds your funds.",
    highlights: [
      "Tagged, on-chain memos via Base's native B20 standard — the agentic-commerce primitive.",
      "Self-reconciling: \"show my payments\" surfaces incoming tagged payments matched to their reference (order-1024 → paid). No middleman, no database.",
      "Pay by token symbol or address. B20 tokens carry the memo; plain ERC-20s send a normal transfer.",
      "Live on Base Sepolia to test today, and activates on Base mainnet with the Beryl upgrade.",
    ],
  },
  {
    date: "Jun 29, 2026",
    title: "A verifiable financial identity",
    lede:
      "Skopos now declares its treasury on-chain through the Zetta agent wallet manifest — a public, verifiable financial identity in the autonomous-agent registry. Transparency for an agent that earns and settles on-chain.",
  },
  {
    date: "Jun 28, 2026",
    title: "Hold $skopos, unlock more Smart",
    lede:
      "Holding $skopos now raises your daily allowance on the ✨ Smart tier, in tiers — the more you hold, the higher your cap. Real utility for the token, wired straight into the product.",
  },
  {
    date: "Jun 28, 2026",
    title: "Safer execution, end to end",
    lede:
      "Every route is re-simulated the moment before you sign, and a route that would revert is stopped before it costs you gas — across single swaps, multi-leg rebalances, and Solana. Failed transactions surface clearly with a one-tap retry.",
  },
  {
    date: "Jun 26, 2026",
    title: "Skopos got a sharper brain",
    lede:
      "A new ✨ Smart tier brings a frontier model for deeper, genuinely useful answers — grounded analysis on real market data instead of generic takes. Toggle Fast or Smart right in the composer.",
  },
  {
    date: "Jun 25, 2026",
    title: "Smart-money intel, paid per call",
    lede:
      "Ask what the smart money is doing and Skopos settles a tiny x402 micropayment to pull live institutional flow data — you sign the payment, Skopos reads the intel. The same HTTP-native payment rail that underpins agent-to-agent settlement.",
  },
  {
    date: "May 17, 2026",
    title: "Agents reach Skopos over Vara",
    lede:
      "An off-chain relay bridges the Vara network to Skopos: agents request prices, risk, yield, markets, quotes and portfolios through a single secured endpoint, with crash-safe delivery and no double-spend.",
  },
];

function TimelineEntry({ entry, last }: { entry: Entry; last: boolean }) {
  return (
    <div className="cl-entry" style={{ display: "grid", gridTemplateColumns: "132px 1fr", gap: 0 }}>
      {/* Date */}
      <div
        className="cl-date"
        style={{
          fontFamily: MONO,
          fontSize: "0.74rem",
          color: "rgba(255,255,255,0.4)",
          textAlign: "right",
          paddingRight: 28,
          paddingTop: 4,
          whiteSpace: "nowrap",
        }}
      >
        {entry.date}
      </div>

      {/* Line + dot + content */}
      <div
        style={{
          position: "relative",
          paddingLeft: 34,
          paddingBottom: last ? 8 : 56,
          borderLeft: last ? "1px solid transparent" : "1px dashed rgba(255,255,255,0.14)",
        }}
      >
        <span
          style={{
            position: "absolute",
            left: -6,
            top: 5,
            width: 11,
            height: 11,
            borderRadius: "50%",
            background: YELLOW,
            boxShadow: "0 0 0 4px #000000, 0 0 12px rgba(245,184,0,0.5)",
          }}
        />
        <h2
          style={{
            fontFamily: SERIF,
            fontWeight: 700,
            fontSize: "clamp(1.5rem, 3.5vw, 2.1rem)",
            lineHeight: 1.15,
            margin: "0 0 12px",
          }}
        >
          {entry.title}
        </h2>
        <p
          style={{
            fontFamily: MONO,
            fontSize: "0.82rem",
            lineHeight: 1.7,
            color: "rgba(255,255,255,0.55)",
            maxWidth: 680,
            margin: 0,
          }}
        >
          {entry.lede}
        </p>

        {entry.highlights && (
          <div
            style={{
              marginTop: 18,
              padding: "16px 18px",
              background: "rgba(245,184,0,0.04)",
              border: "1px solid rgba(245,184,0,0.16)",
              borderRadius: 14,
              maxWidth: 680,
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: "0.6rem",
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: YELLOW,
              }}
            >
              Highlights
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 12 }}>
              {entry.highlights.map((h, i) => (
                <div key={i} style={{ display: "flex", gap: 10 }}>
                  <span style={{ color: YELLOW, fontFamily: MONO, flexShrink: 0 }}>&gt;</span>
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: "0.76rem",
                      lineHeight: 1.6,
                      color: "rgba(255,255,255,0.6)",
                    }}
                  >
                    {h}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChangelogPage() {
  return (
    <main style={{ minHeight: "100vh", background: "#000000", color: "#ffffff" }}>
      <style>{`
        @media (max-width: 640px) {
          .cl-entry { grid-template-columns: 1fr !important; }
          .cl-date {
            text-align: left !important;
            padding-right: 0 !important;
            padding-left: 34px !important;
            padding-bottom: 6px !important;
          }
          .cl-header { padding-left: 16px !important; padding-right: 16px !important; }
          .cl-wrap { padding-left: 16px !important; padding-right: 16px !important; }
        }
      `}</style>
      <CornerBrackets />

      <header
        className="cl-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 24px",
          maxWidth: 1080,
          margin: "0 auto",
        }}
      >
        <Link
          href="/"
          style={{
            fontFamily: SERIF,
            fontWeight: 700,
            fontSize: "1.1rem",
            letterSpacing: "0.12em",
            color: "#ffffff",
            textDecoration: "none",
          }}
        >
          SKOPOS
        </Link>
        <HeaderIcons />
      </header>

      <div className="cl-wrap" style={{ maxWidth: 1080, margin: "0 auto", padding: "0 24px 96px" }}>
        {/* Hero */}
        <section style={{ padding: "48px 0 40px" }}>
          <span
            style={{
              fontFamily: MONO,
              fontSize: "0.7rem",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: YELLOW,
            }}
          >
            Changelog
          </span>
          <h1
            style={{
              fontFamily: SERIF,
              fontWeight: 700,
              fontSize: "clamp(2.4rem, 7vw, 4rem)",
              letterSpacing: "0.02em",
              margin: "12px 0 16px",
            }}
          >
            What&apos;s shipping.
          </h1>
          <p
            style={{
              fontFamily: MONO,
              fontSize: "0.86rem",
              lineHeight: 1.7,
              color: "rgba(255,255,255,0.5)",
              maxWidth: 620,
            }}
          >
            Notable updates to Skopos, newest first. Building the cross-chain DeFi copilot toward an
            agentic payment rail on Base.
          </p>
        </section>

        {/* Timeline */}
        <section style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 48 }}>
          {ENTRIES.map((entry, i) => (
            <TimelineEntry key={entry.title} entry={entry} last={i === ENTRIES.length - 1} />
          ))}
        </section>

        {/* Footer */}
        <footer
          style={{
            paddingTop: 36,
            borderTop: "1px solid rgba(255,255,255,0.06)",
            marginTop: 16,
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          <p
            style={{
              fontFamily: MONO,
              fontSize: "0.78rem",
              lineHeight: 1.7,
              color: "rgba(255,255,255,0.45)",
              maxWidth: 620,
              margin: 0,
            }}
          >
            Want a deeper walkthrough of any of this — the routing waterfall, the B20 payment flow,
            the agentic-payments direction? Reach out on X{" "}
            <a
              href="https://x.com/tryskopos"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: YELLOW, textDecoration: "none" }}
            >
              @tryskopos
            </a>
            . Happy to go deep.
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <span style={{ fontFamily: MONO, fontSize: "0.7rem", color: "rgba(255,255,255,0.3)" }}>
              Skopos — cross-chain DeFi copilot
            </span>
            <Link
              href="/app"
              style={{
                fontFamily: MONO,
                fontSize: "0.7rem",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: YELLOW,
                textDecoration: "none",
              }}
            >
              Open App →
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
