import type { Metadata } from "next";
import Link from "next/link";
import { CornerBrackets } from "@/components/landing/CornerBrackets";
import { HeaderIcons } from "@/components/landing/HeaderIcons";
import { CHANGELOG_ENTRIES as ENTRIES, type Entry } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Changelog — Skopos",
  description:
    "What's shipping on Skopos: market alerts, Aeon intelligence reads, DAO treasury lookups, B20 memo payments, and safer execution — the non-custodial, cross-chain crypto copilot, everywhere you already work.",
};

const MONO = "var(--font-jetbrains-mono), monospace";
const SERIF = "var(--font-display), serif";
const YELLOW = "#F5B800";


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
            Notable updates to Skopos, newest first. Building the non-custodial, cross-chain crypto
            copilot toward an agentic payment rail on Base.
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
              Skopos — non-custodial, cross-chain copilot
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
