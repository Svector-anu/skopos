import type { Metadata } from "next";
import Link from "next/link";
import { CornerBrackets } from "@/components/landing/CornerBrackets";
import { HeaderIcons } from "@/components/landing/HeaderIcons";

export const metadata: Metadata = {
  title: "Docs — Skopos",
  description:
    "How to use Skopos: chat commands for swaps, bridges, prices, yield, prediction markets and portfolio across 25+ chains. Non-custodial by design.",
};

const MONO = "var(--font-jetbrains-mono), monospace";
const SERIF = "var(--font-display), serif";
const YELLOW = "#F5B800";

interface Command {
  prompt: string;
  desc: string;
}

interface Section {
  id: string;
  title: string;
  lede: string;
  commands?: Command[];
  note?: string;
}

const SECTIONS: Section[] = [
  {
    id: "overview",
    title: "What Skopos is",
    lede: "Skopos is a non-custodial crypto copilot — live at tryskopos.xyz, and embeddable anywhere else you work via one API, an Agent Skill, or MCP. Type what you want in plain English: prices, smart-money intel, market reads, alerts, token safety, prediction markets, or a swap/bridge/payment — Skopos pulls live data or hands your wallet a transaction to sign. It never holds your funds or your keys.",
    note: "Open the app, connect a wallet, and type into the chat. No forms, no chain pickers — just describe the move.",
  },
  {
    id: "swap",
    title: "Swap",
    lede: "Trade one token for another on the same chain. Skopos quotes the route and returns calldata your wallet signs.",
    commands: [
      { prompt: "swap 0.1 ETH to USDC on base", desc: "Same-chain swap with explicit chain" },
      { prompt: "swap 100 USDC to ETH on arbitrum", desc: "Reverse direction, any pair" },
    ],
  },
  {
    id: "bridge",
    title: "Bridge",
    lede: "Move a token from one chain to another. Skopos compares bridges and picks the cheapest path, then returns the transaction.",
    commands: [
      { prompt: "bridge 0.1 ETH from ethereum to base", desc: "Cross-chain transfer, same token" },
      { prompt: "bridge 100 USDC from base to polygon", desc: "Stablecoin across chains" },
    ],
  },
  {
    id: "buy-sell",
    title: "Buy & sell",
    lede: "Shorthand for an execution. Skopos asks for the amount, then builds the quote.",
    commands: [
      { prompt: "buy ETH on base", desc: "Guided buy — Skopos prompts for the amount" },
      { prompt: "sell ETH", desc: "Guided sell — chain inferred where possible" },
    ],
  },
  {
    id: "price",
    title: "Prices & rates",
    lede: "Spot crypto prices come from CoinGecko with a DexScreener fallback. FX, metals and equities come from Pyth. The AI never invents a number — every price is live or it says it can't fetch one.",
    commands: [
      { prompt: "price of eth", desc: "Crypto spot price + 7-day sparkline" },
      { prompt: "usd to eur", desc: "FX conversion via Pyth" },
      { prompt: "gold price", desc: "Metals via Pyth" },
    ],
  },
  {
    id: "portfolio",
    title: "Portfolio & lookups",
    lede: "Check balances across chains, or paste any address, ENS name or transaction hash to inspect it.",
    commands: [
      { prompt: "show my portfolio", desc: "Token balances across your connected wallet" },
      { prompt: "vitalik.eth", desc: "Resolve an ENS name to an address card" },
      { prompt: "0x… (address or tx hash)", desc: "Address balances, or transaction status" },
    ],
  },
  {
    id: "yield",
    title: "Yield",
    lede: "Scan live yield pools from DeFiLlama across a curated set of protocols. Outlier APYs from dead incentive pools are filtered out.",
    commands: [
      { prompt: "best yield on usdc", desc: "Top pools for a token" },
      { prompt: "find the highest yield for my USDC across all chains", desc: "Cross-chain scan" },
    ],
  },
  {
    id: "prediction",
    title: "Prediction markets",
    lede: "Read live Polymarket odds and generate a deposit address. V1 is read and deposit only — Skopos does not place orders, which keeps your keys off our servers.",
    commands: [
      { prompt: "what are people betting on", desc: "Top markets and odds" },
      { prompt: "odds ETH hits $5k this year", desc: "Specific market lookup" },
    ],
  },
  {
    id: "ask",
    title: "Ask anything",
    lede: "General questions route to a constrained model that explains concepts but never fabricates live prices or yields. Opinion questions get an answer, not a price.",
    commands: [
      { prompt: "what is ethereum", desc: "Plain-language explanation" },
      { prompt: "what chains do you support?", desc: "Capability questions" },
    ],
  },
];

const EVM_CHAINS = [
  "Ethereum", "Optimism", "Cronos", "BNB Chain", "Gnosis", "Unichain",
  "Polygon", "Monad", "Sonic", "World Chain", "Metis", "Soneium",
  "Mantle", "Base", "Plasma", "Arbitrum", "Celo", "Avalanche",
  "Ink", "Linea", "Berachain", "Blast", "Scroll", "HyperEVM", "MegaETH",
];

const SAFETY = [
  {
    title: "Non-custodial by design",
    body: "Skopos never touches your private keys or moves funds on its own. Every swap and bridge returns calldata that your own wallet signs. There is no server-side signing.",
  },
  {
    title: "Connect how you want",
    body: "Sign in with email, Google, X, Discord, or any wallet via Privy. Skopos works with both embedded and external wallets, plus Solana for cross-chain routes.",
  },
  {
    title: "Live data, no hallucinated numbers",
    body: "Prices, rates and yields come from real sources — CoinGecko, DexScreener, Pyth, DeFiLlama and Polymarket. The model is fenced off from inventing prices.",
  },
  {
    title: "Prediction markets stay read-only",
    body: "You can read Polymarket odds and deposit, but Skopos will not place or cancel orders. Order signing would require custody of your key, so it is out of scope.",
  },
];

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: "0.72rem",
        color: "rgba(255,255,255,0.7)",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.09)",
        borderRadius: 8,
        padding: "6px 12px",
      }}
    >
      {children}
    </span>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      style={{
        fontFamily: MONO,
        fontSize: "0.76rem",
        lineHeight: 1.65,
        color: "rgba(255,255,255,0.85)",
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.09)",
        borderRadius: 12,
        padding: "16px 18px",
        overflowX: "auto",
        margin: 0,
        whiteSpace: "pre",
      }}
    >
      <code>{children}</code>
    </pre>
  );
}

function FieldRow({ name, desc }: { name: string; desc: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "9px 0",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <code
        style={{
          fontFamily: MONO,
          fontSize: "0.74rem",
          color: YELLOW,
          minWidth: 132,
          flexShrink: 0,
        }}
      >
        {name}
      </code>
      <span style={{ fontFamily: MONO, fontSize: "0.74rem", lineHeight: 1.6, color: "rgba(255,255,255,0.5)" }}>
        {desc}
      </span>
    </div>
  );
}

function CommandRow({ prompt, desc }: Command) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "12px 14px",
        background: "rgba(245,184,0,0.04)",
        border: "1px solid rgba(245,184,0,0.16)",
        borderRadius: 12,
      }}
    >
      <code style={{ fontFamily: MONO, fontSize: "0.8rem", color: "#ffffff" }}>
        <span style={{ color: YELLOW }}>&gt;</span> {prompt}
      </code>
      <span style={{ fontFamily: MONO, fontSize: "0.68rem", color: "rgba(255,255,255,0.38)" }}>
        {desc}
      </span>
    </div>
  );
}

export default function DocsPage() {
  return (
    <main style={{ minHeight: "100vh", background: "#000000", color: "#ffffff", textTransform: "lowercase" }}>
      <CornerBrackets />

      <header
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

      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "0 24px 96px",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 0,
        }}
      >
        {/* Hero */}
        <section style={{ padding: "48px 0 32px" }}>
          <span
            style={{
              fontFamily: MONO,
              fontSize: "0.7rem",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: YELLOW,
            }}
          >
            Documentation
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
            Talk to your money.
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
            Skopos turns plain-English requests into on-chain action across 25+ chains. Swap,
            bridge, check prices, scan yield, read prediction markets and view your portfolio — all
            from one chat box. You sign every transaction; Skopos never holds your funds.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
            <Link
              href="/app"
              style={{
                fontFamily: MONO,
                fontSize: "0.72rem",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "#000000",
                background: YELLOW,
                borderRadius: 8,
                padding: "10px 20px",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Open App →
            </Link>
            <a
              href="#commands"
              style={{
                fontFamily: MONO,
                fontSize: "0.72rem",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.7)",
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 8,
                padding: "10px 20px",
                textDecoration: "none",
              }}
            >
              Browse Commands
            </a>
            <a
              href="#build"
              style={{
                fontFamily: MONO,
                fontSize: "0.72rem",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.7)",
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 8,
                padding: "10px 20px",
                textDecoration: "none",
              }}
            >
              Build on Skopos
            </a>
          </div>
        </section>

        {/* Commands */}
        <section id="commands" style={{ paddingTop: 24 }}>
          {SECTIONS.map(section => (
            <div
              key={section.id}
              id={section.id}
              style={{
                padding: "28px 0",
                borderTop: "1px solid rgba(255,255,255,0.06)",
                scrollMarginTop: 24,
              }}
            >
              <h2
                style={{
                  fontFamily: SERIF,
                  fontWeight: 700,
                  fontSize: "1.6rem",
                  margin: "0 0 10px",
                }}
              >
                {section.title}
              </h2>
              <p
                style={{
                  fontFamily: MONO,
                  fontSize: "0.8rem",
                  lineHeight: 1.7,
                  color: "rgba(255,255,255,0.5)",
                  maxWidth: 660,
                  margin: "0 0 18px",
                }}
              >
                {section.lede}
              </p>
              {section.commands && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                    gap: 10,
                  }}
                >
                  {section.commands.map(cmd => (
                    <CommandRow key={cmd.prompt} {...cmd} />
                  ))}
                </div>
              )}
              {section.note && (
                <p
                  style={{
                    fontFamily: MONO,
                    fontSize: "0.74rem",
                    lineHeight: 1.6,
                    color: "rgba(255,255,255,0.35)",
                    marginTop: 14,
                  }}
                >
                  {section.note}
                </p>
              )}
            </div>
          ))}
        </section>

        {/* Build on Skopos — headless API for bots/agents */}
        <section
          id="build"
          style={{ padding: "28px 0", borderTop: "1px solid rgba(255,255,255,0.06)", scrollMarginTop: 24 }}
        >
          <h2 style={{ fontFamily: SERIF, fontWeight: 700, fontSize: "1.6rem", margin: "0 0 10px" }}>
            Build on Skopos
          </h2>
          <p
            style={{
              fontFamily: MONO,
              fontSize: "0.8rem",
              lineHeight: 1.7,
              color: "rgba(255,255,255,0.5)",
              maxWidth: 660,
              margin: "0 0 18px",
            }}
          >
            The same copilot — prices, swaps, portfolios, live smart-money intel — over one HTTP
            call. Opt in with <code style={{ color: YELLOW }}>format:&quot;text&quot;</code> and get
            a plain-text answer back instead of a UI card. No SDK, no API key, no card knowledge
            required — this is what an iMessage bot uses today.
          </p>

          <CodeBlock>{`curl -sX POST https://www.tryskopos.xyz/api/chat \\
  -H "Content-Type: application/json" \\
  -d '{"message":"who is buying $pepe","format":"text","anonId":"chat-123"}'

# → { "type": "intel",
#     "text": "$PEPE — top buyers: Wintermute Market Making +$10.69M, … Net accumulating $15.54M." }`}</CodeBlock>

          <p
            style={{
              fontFamily: MONO,
              fontSize: "0.74rem",
              color: "rgba(255,255,255,0.35)",
              margin: "14px 0 24px",
            }}
          >
            Relay <code style={{ color: "rgba(255,255,255,0.55)" }}>text</code> verbatim. Your
            client needs zero card knowledge.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "0 32px" }}>
            <div>
              <h3 style={{ fontFamily: MONO, fontSize: "0.78rem", letterSpacing: "0.04em", color: "rgba(255,255,255,0.7)", margin: "0 0 4px" }}>
                Request
              </h3>
              <FieldRow name="message" desc="required — the user's text, verbatim" />
              <FieldRow name="format" desc={'"text" | "card" — default "card". The browser uses "card"; headless clients send "text".'} />
              <FieldRow name="anonId" desc="required for text-mode intel reads — a stable per-conversation id (drives the cost cap)" />
              <FieldRow name="senderAddress" desc="optional — a connected wallet unlocks that address's tier" />
              <FieldRow name="sparkline" desc="optional, default true — set false to omit the ASCII price chart" />
            </div>
            <div>
              <h3 style={{ fontFamily: MONO, fontSize: "0.78rem", letterSpacing: "0.04em", color: "rgba(255,255,255,0.7)", margin: "0 0 4px" }}>
                Response
              </h3>
              <FieldRow name="type" desc="the card type — branch on it if you want, or ignore it" />
              <FieldRow name="text" desc="always populated, plain text, ready to relay" />
              <FieldRow name="link" desc="on swap / bridge / pay — a tap-to-sign url. Skopos is non-custodial, so execution always finishes in the app, never in your bot" />
              <FieldRow name="image" desc="on price replies — a chart PNG url" />
            </div>
          </div>

          <div style={{ marginTop: 28 }}>
            <h3 style={{ fontFamily: MONO, fontSize: "0.78rem", letterSpacing: "0.04em", color: "rgba(255,255,255,0.7)", margin: "0 0 12px" }}>
              Same API, three shapes
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
              {/* Lane 1 — raw API, live now */}
              <div style={{ padding: "14px 16px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12 }}>
                <p style={{ fontFamily: MONO, fontSize: "0.76rem", fontWeight: 700, color: "#ffffff", margin: "0 0 6px" }}>
                  Your own bot or app
                </p>
                <p style={{ fontFamily: MONO, fontSize: "0.72rem", lineHeight: 1.6, color: "rgba(255,255,255,0.45)", margin: 0 }}>
                  Call the endpoint above directly — this is exactly how an iMessage bot uses Skopos today.
                </p>
              </div>

              {/* Lane 2 — Agent Skills, real download today */}
              <div style={{ padding: "14px 16px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, display: "flex", flexDirection: "column" }}>
                <p style={{ fontFamily: MONO, fontSize: "0.76rem", fontWeight: 700, color: "#ffffff", margin: "0 0 6px" }}>
                  An agent that loads skills
                </p>
                <p style={{ fontFamily: MONO, fontSize: "0.72rem", lineHeight: 1.6, color: "rgba(255,255,255,0.45)", margin: "0 0 12px" }}>
                  Drop this file in for Claude, Cursor, or any Agent Skills–compatible agent.
                </p>
                <a
                  href="/skopos-skill.md"
                  download
                  style={{
                    fontFamily: MONO, fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.04em",
                    textTransform: "uppercase", color: "#000000", background: YELLOW,
                    borderRadius: 8, padding: "9px 14px", textDecoration: "none",
                    textAlign: "center", marginTop: "auto",
                  }}
                >
                  Download SKILL.md →
                </a>
              </div>

              {/* Lane 3 — MCP, real package on npm */}
              <div style={{ padding: "14px 16px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, display: "flex", flexDirection: "column" }}>
                <p style={{ fontFamily: MONO, fontSize: "0.76rem", fontWeight: 700, color: "#ffffff", margin: "0 0 6px" }}>
                  An MCP client
                </p>
                <p style={{ fontFamily: MONO, fontSize: "0.72rem", lineHeight: 1.6, color: "rgba(255,255,255,0.45)", margin: "0 0 12px" }}>
                  <code style={{ color: "rgba(255,255,255,0.6)" }}>npx -y skopos-mcp</code> — an MCP server wrapping the same call. Works in Claude Desktop, Cursor, Zero, or any MCP client.
                </p>
                <a
                  href="https://www.npmjs.com/package/skopos-mcp"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontFamily: MONO, fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.04em",
                    textTransform: "uppercase", color: "#000000", background: YELLOW,
                    borderRadius: 8, padding: "9px 14px", textDecoration: "none",
                    textAlign: "center", marginTop: "auto",
                  }}
                >
                  View on npm →
                </a>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <p style={{ fontFamily: MONO, fontSize: "0.72rem", color: "rgba(255,255,255,0.35)", margin: "0 0 8px" }}>
              Or place it yourself:
            </p>
            <CodeBlock>{`curl -o SKILL.md https://www.tryskopos.xyz/skopos-skill.md
mkdir -p ~/.claude/skills/skopos && mv SKILL.md ~/.claude/skills/skopos/`}</CodeBlock>
          </div>

          <p
            style={{
              fontFamily: MONO,
              fontSize: "0.74rem",
              lineHeight: 1.6,
              color: "rgba(255,255,255,0.35)",
              marginTop: 20,
            }}
          >
            No versioning — the request shape is stable, and the response is a discriminated union
            keyed by <code style={{ color: "rgba(255,255,255,0.55)" }}>type</code> that grows over
            time. Branch on <code style={{ color: "rgba(255,255,255,0.55)" }}>type</code> and handle
            unknown values gracefully; relaying <code style={{ color: "rgba(255,255,255,0.55)" }}>text</code>{" "}
            verbatim is always safe.
          </p>
        </section>

        {/* Supported chains */}
        <section
          id="chains"
          style={{ padding: "28px 0", borderTop: "1px solid rgba(255,255,255,0.06)", scrollMarginTop: 24 }}
        >
          <h2 style={{ fontFamily: SERIF, fontWeight: 700, fontSize: "1.6rem", margin: "0 0 10px" }}>
            Supported chains
          </h2>
          <p
            style={{
              fontFamily: MONO,
              fontSize: "0.8rem",
              lineHeight: 1.7,
              color: "rgba(255,255,255,0.5)",
              maxWidth: 660,
              margin: "0 0 18px",
            }}
          >
            25 EVM networks are wired into the connected wallet for signing, plus Solana for
            cross-chain swaps and bridges.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {EVM_CHAINS.map(chain => (
              <Pill key={chain}>{chain}</Pill>
            ))}
            <Pill>Solana</Pill>
          </div>
        </section>

        {/* Wallet & safety */}
        <section
          id="safety"
          style={{ padding: "28px 0", borderTop: "1px solid rgba(255,255,255,0.06)", scrollMarginTop: 24 }}
        >
          <h2 style={{ fontFamily: SERIF, fontWeight: 700, fontSize: "1.6rem", margin: "0 0 18px" }}>
            Wallet & safety
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: 12,
            }}
          >
            {SAFETY.map(item => (
              <div
                key={item.title}
                style={{
                  padding: "16px 18px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 14,
                }}
              >
                <h3
                  style={{
                    fontFamily: MONO,
                    fontSize: "0.8rem",
                    letterSpacing: "0.04em",
                    color: YELLOW,
                    margin: "0 0 8px",
                  }}
                >
                  {item.title}
                </h3>
                <p
                  style={{
                    fontFamily: MONO,
                    fontSize: "0.74rem",
                    lineHeight: 1.65,
                    color: "rgba(255,255,255,0.5)",
                    margin: 0,
                  }}
                >
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <footer
          style={{
            paddingTop: 36,
            borderTop: "1px solid rgba(255,255,255,0.06)",
            marginTop: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: "0.7rem", color: "rgba(255,255,255,0.3)" }}>
            Skopos — non-custodial crypto copilot
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
        </footer>
      </div>
    </main>
  );
}
