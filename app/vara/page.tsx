"use client";

import Link from "next/link";
import { WhatsNewToast } from "@/components/shared/WhatsNewToast";

const ORACLE_PROGRAM_ID =
  "0x422d323915e5d3ac00a41138da14d6a13bccf753407bf6fc0079ff746ae5ce8b";

const STEPS = [
  "Your Gear program calls request_data(payload) with a JSON query payload and 1 VARA fee.",
  "The bridge emits a RequestPending event. The Skopos relay picks it up within the next finalized block (~6s).",
  "Skopos processes the query against live data sources and the relay submits fulfill_request on-chain.",
  "Your program receives the result asynchronously via a Gear message — typically 14–16s end-to-end.",
];

const QUERY_TYPES = [
  { type: "price", desc: "Spot price for any crypto asset" },
  { type: "risk", desc: "Token risk score and liquidity flags" },
  { type: "yield", desc: "Top yield pools across DeFi protocols" },
  { type: "markets", desc: "Prediction market probabilities" },
  { type: "quote", desc: "Cross-chain bridge quote and calldata" },
  { type: "portfolio", desc: "Address token balances across chains" },
];

const dim: React.CSSProperties = { color: "rgba(255,255,255,0.4)" };
const faint: React.CSSProperties = { color: "rgba(255,255,255,0.2)" };

export default function VaraPage() {
  return (
    <>
    <WhatsNewToast
      storageKey="skopos-whatsnew-vara-v1"
      changes={[
        "Skopos oracle is live on Vara mainnet",
        "Mention @skopos-bridge in the Vara Agent Network chat",
        "6 query types: price, risk, yield, markets, quote, portfolio",
      ]}
    />
    <main
      style={{
        background: "#000000",
        color: "#ffffff",
        minHeight: "100vh",
        padding: "60px 24px 80px",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      }}
    >
      <div style={{ maxWidth: 620, margin: "0 auto" }}>
        <Link
          href="/"
          style={{
            fontSize: "0.65rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            textDecoration: "none",
            ...dim,
          }}
        >
          ← tryskopos.xyz
        </Link>

        {/* Status + title */}
        <div style={{ marginTop: 48 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 20,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "#22c55e",
                display: "inline-block",
              }}
            />
            <span
              style={{
                fontSize: "0.65rem",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "#22c55e",
              }}
            >
              Live on Vara Mainnet
            </span>
          </div>
          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 400,
              letterSpacing: "-0.02em",
              margin: "0 0 20px",
            }}
          >
            Skopos Oracle
          </h1>
          <p
            style={{
              ...dim,
              lineHeight: 1.75,
              fontSize: "0.875rem",
              margin: 0,
            }}
          >
            Any on-chain Gear program can submit a DeFi query to Skopos and
            receive an async result. Price, risk, yield, cross-chain quotes,
            prediction markets, and portfolio data — callable from a single
            Gear message.
          </p>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.07)", margin: "48px 0" }} />

        {/* How it works */}
        <section>
          <h2
            style={{
              fontSize: "0.65rem",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              margin: "0 0 24px",
              ...dim,
            }}
          >
            How it works
          </h2>
          <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 18 }}>
            {STEPS.map((step, i) => (
              <li
                key={i}
                style={{
                  display: "flex",
                  gap: 16,
                  fontSize: "0.85rem",
                  lineHeight: 1.65,
                  color: "rgba(255,255,255,0.65)",
                }}
              >
                <span style={{ ...faint, minWidth: 18 }}>{i + 1}.</span>
                {step}
              </li>
            ))}
          </ol>
        </section>

        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.07)", margin: "48px 0" }} />

        {/* Query types */}
        <section>
          <h2
            style={{
              fontSize: "0.65rem",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              margin: "0 0 20px",
              ...dim,
            }}
          >
            Query types
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {QUERY_TYPES.map(({ type, desc }) => (
              <div
                key={type}
                style={{ display: "flex", gap: 20, fontSize: "0.82rem", lineHeight: 1.5 }}
              >
                <code
                  style={{
                    color: "rgba(255,255,255,0.8)",
                    minWidth: 80,
                    flexShrink: 0,
                  }}
                >
                  {type}
                </code>
                <span style={dim}>{desc}</span>
              </div>
            ))}
          </div>
        </section>

        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.07)", margin: "48px 0" }} />

        {/* Payload schema */}
        <section>
          <h2
            style={{
              fontSize: "0.65rem",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              margin: "0 0 16px",
              ...dim,
            }}
          >
            Payload
          </h2>
          <pre
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.07)",
              padding: "20px 24px",
              fontSize: "0.78rem",
              lineHeight: 1.75,
              color: "rgba(255,255,255,0.75)",
              overflowX: "auto",
              margin: 0,
            }}
          >{`{
  "v": "1",
  "type": "price" | "risk" | "yield" | "markets" | "quote" | "portfolio",
  "params": { ... }
}`}</pre>
          <p
            style={{
              marginTop: 12,
              fontSize: "0.75rem",
              lineHeight: 1.6,
              ...faint,
            }}
          >
            Fee: 1 VARA per query · Max payload: 4KB · Results delivered async
            to your program&apos;s message handler
          </p>
        </section>

        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.07)", margin: "48px 0" }} />

        {/* Chat handle */}
        <section>
          <h2
            style={{
              fontSize: "0.65rem",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              margin: "0 0 16px",
              ...dim,
            }}
          >
            Talk to Skopos
          </h2>
          <p style={{ fontSize: "0.85rem", lineHeight: 1.7, color: "rgba(255,255,255,0.65)", margin: "0 0 16px" }}>
            Any agent on the Vara Agent Network can mention{" "}
            <code style={{ color: "rgba(255,255,255,0.85)" }}>@skopos-bridge</code>{" "}
            in chat to ask DeFi questions. Skopos replies with live data.
          </p>
          <a
            href="https://agents.vara.network/chat"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontSize: "0.75rem",
              letterSpacing: "0.07em",
              color: "rgba(255,255,255,0.5)",
              textDecoration: "none",
              border: "1px solid rgba(255,255,255,0.08)",
              padding: "8px 16px",
              transition: "color 0.2s, border-color 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "rgba(255,255,255,0.85)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "rgba(255,255,255,0.5)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
            }}
          >
            Open Vara Agent Network →
          </a>
        </section>

        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.07)", margin: "48px 0" }} />

        {/* Oracle address */}
        <section>
          <h2
            style={{
              fontSize: "0.65rem",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              margin: "0 0 12px",
              ...dim,
            }}
          >
            Oracle program ID
          </h2>
          <code
            style={{
              fontSize: "0.75rem",
              color: "rgba(255,255,255,0.55)",
              wordBreak: "break-all",
              lineHeight: 1.6,
            }}
          >
            {ORACLE_PROGRAM_ID}
          </code>
        </section>

        {/* Footer */}
        <div
          style={{
            marginTop: 64,
            paddingTop: 32,
            borderTop: "1px solid rgba(255,255,255,0.07)",
            display: "flex",
            gap: 28,
          }}
        >
          <a
            href="https://agents.vara.network/chat"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: "0.65rem",
              letterSpacing: "0.09em",
              textTransform: "uppercase",
              textDecoration: "none",
              ...dim,
            }}
          >
            Vara Agent Network →
          </a>
          <Link
            href="/"
            style={{
              fontSize: "0.65rem",
              letterSpacing: "0.09em",
              textTransform: "uppercase",
              textDecoration: "none",
              ...dim,
            }}
          >
            tryskopos.xyz →
          </Link>
        </div>
      </div>
    </main>
    </>
  );
}
