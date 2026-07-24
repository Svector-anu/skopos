// Single source of truth for the public changelog at tryskopos.xyz/changelog.
// Edit HERE to update the website — app/changelog/page.tsx renders this array.
// (The repo-root CHANGELOG.md is the separate, more technical developer log.)

export interface Entry {
  date: string;
  title: string;
  lede: string;
  highlights?: string[];
}

export const CHANGELOG_ENTRIES: Entry[] = [
  {
    date: "Jul 22, 2026",
    title: "Advanced orders, trustworthy end to end",
    lede:
      "Limit, stop-loss, take-profit, and TWAP in plain English — now across Robinhood Chain and 7 EVM chains — and you can track them after they're created, cancel anytime, and see what you'll receive before they execute.",
    highlights: [
      "Track and cancel: your standing orders show status and fill progress, with a cancel button on anything still open.",
      "Previews show what the trigger price actually implies, labeled apart from the current-price quote — no more mistaking a market quote for trigger proceeds.",
      "Orders land on the chain that already holds your funds, chosen from your balances — never a default that can't fill.",
      "Phrasings the strict patterns miss now parse through a checked LLM layer that can never place a number you didn't type.",
    ],
  },
  {
    date: "Jul 21, 2026",
    title: "Stock-paired token intelligence",
    lede:
      "A category native to Robinhood Chain: tokens that trade against a tokenized stock instead of a stablecoin, so their fees accrue to the creator in stock. Skopos now reads the whole category — the pairing, the ratio, and the fee flywheel — and warns you when a token is named after a ticker it isn't. Built with Bankr.",
    highlights: [
      "\"price of $REAL vs NVDA\", \"show stock-paired tokens\", \"fee flywheel for $REAL\" — priced in stock terms, with a registry-verified badge a copycat can't earn.",
      "Ticker-impersonation warnings catch a token dressed as a stock it has no connection to, before you trade.",
    ],
  },
  {
    date: "Jul 20, 2026",
    title: "A security pass: approvals, alerts, and metadata",
    lede:
      "Skopos now scans your wallet for risky token approvals across every chain it tracks, proves wallet ownership before it sends you alerts, and hardens how it handles attacker-chosen token names.",
    highlights: [
      "\"scan my wallet for risky approvals\" reads ~90 days of allowances across 10 chains, flags the unlimited ones, and revokes with one tap.",
      "Alert delivery now requires a signature, so nobody can hijack your notifications by claiming your address.",
      "Token names, ENS labels, and memos are sanitized before any agent reads them as context.",
    ],
  },
  {
    date: "Jul 18, 2026",
    title: "Skopos now speaks Chinese and Vietnamese",
    lede:
      "Skopos auto-detects your browser's language and responds in it — no toggle, no settings to find. Chat replies, the whole app, even the landing page adapt to 中文 or Tiếng Việt on their own. Token names, chain names, and addresses always stay in their original form.",
    highlights: [
      "Auto-detected from your browser — nothing to switch on, nothing to configure.",
      "Covers real conversation and the full app: wallet connection, swap and bridge cards, error states, all of it.",
      "Numbers, tickers, and addresses never get lost in translation — only the words around them do.",
    ],
  },
  {
    date: "Jul 17, 2026",
    title: "Portfolio and tx lookups now reach Robinhood Chain",
    lede:
      "Paste a Robinhood Chain address or transaction hash and Skopos reads it now — balances, holdings, and tx details, on a chain no major indexer covered before. Eight more chains came along for the ride: Unichain, World Chain, HyperEVM, Soneium, MegaETH, Celo, Ink, and Scroll.",
    highlights: [
      "Transaction summaries are now grounded in the real decoded on-chain trace, not a guess from sparse metadata.",
      "Wallet lookups surface known-entity tags (like a labeled exchange wallet) when there's a real match — never a guess.",
    ],
  },
  {
    date: "Jul 16, 2026",
    title: "Buy real, tokenized stocks on Robinhood Chain",
    lede:
      "\"buy $10 of NVDA on robinhood\" now works like any other trade. Skopos resolves the ticker against Robinhood's own official contract registry first — AAPL, NVDA, TSLA, GOOGL, AMZN, MSFT, and 18 more, plus a handful of ETFs — so a copycat token with the same symbol can't get matched by accident.",
    highlights: [
      "Official registry, checked first — not a generic DEX search that a look-alike token could win.",
      "Same non-custodial flow as any other Robinhood Chain trade: you sign, Skopos never holds the funds.",
    ],
  },
  {
    date: "Jul 15, 2026",
    title: "Robinhood Chain, natively — swaps, limit orders, and bridging",
    lede:
      "Robinhood Chain isn't supported by Skopos's usual quote provider, so it got its own execution path. Swap natively on the chain, set a limit, stop-loss, take-profit, or TWAP order, or bridge funds on and off — all through the same non-custodial sign flow as everywhere else.",
    highlights: [
      "Market swaps (\"swap 0.01 USDG to ETH on robinhood\") settle through Definitive's Flash API.",
      "Limit, stop-loss, take-profit, and TWAP orders — \"sell 2 ETH if it drops below $2000\", \"buy $500 of ETH over 7 days\" — same sign flow as a market order, the trigger or schedule shown clearly before you sign.",
      "Bridge onto or off the chain in either direction via Relay — the only way to get funds there before trading.",
    ],
  },
  {
    date: "Jul 14, 2026",
    title: "See what's launching on Robinhood Chain",
    lede:
      "\"what's launching on robinhood chain\" returns a real feed — every new token risk-scored and color-coded by liquidity, with the deployer's full launch history one tap away, so a serial-launcher pattern is obvious before you touch anything.",
    highlights: [
      "Liquidity color-coded at a glance: red under $5K, green over $50K.",
      "Every deployer links to their full on-chain launch history — repeat launches flagged, not hidden.",
      "Honest about scope: the chain launches a token every 1–2 minutes, so \"25 most recent\" is really the last half hour, not a curated \"best of the week.\"",
    ],
  },
  {
    date: "Jul 11, 2026",
    title: "Pay any x402 endpoint yourself",
    lede:
      "Paste \"check <url>\" on anything behind an x402 paywall — not just sources Skopos already knows — and see the price before you decide. If you want it, your own wallet pays directly.",
    highlights: [
      "Works on any x402 endpoint — a free, safety-checked probe finds the price first, so you never pay blind.",
      "Your own wallet signs, not Skopos's — the one payment path where you're paying a third party directly, not us fronting it.",
    ],
  },
  {
    date: "Jul 11, 2026",
    title: "Token pick and picks tracker, now on Aeon's real engine",
    lede:
      "The daily token pick and its scorecard now run on Aeon's actual skill — a 7-day dedup gate and real signal scoring, so the same trending coin can't get re-served every day, and a skip means nothing genuinely cleared the bar.",
    highlights: [
      "Real conviction levels — HIGH, MEDIUM, or an honest SKIP.",
      "\"picks tracker\" grades every past pick — win, hold, or loss, weekly, no cherry-picked dates.",
    ],
  },
  {
    date: "Jul 10, 2026",
    title: "Other agents can now pay Skopos directly",
    lede:
      "Skopos is now a paid, agent-discoverable API — 8 endpoints for price, swap quotes, token risk, whale activity, yield, prediction markets, market reads, and DAO treasuries, each settled with a real x402 micropayment. Listed on x402scan.",
    highlights: [
      "Same brain, agent-priced — every paid route reuses the exact function its free chat command already calls.",
      "Discoverable via /openapi.json and /llms.txt, so any agent can find and call it with no human in the loop.",
    ],
  },
  {
    date: "Jul 9, 2026",
    title: "Skopos now watches, not just answers",
    lede:
      "Set a standing watch and Skopos reaches back out on its own — \"alert me when eth hits $5000\", \"monitor polymarket trump 2028\", \"watch 0x… for activity\" — delivered by push notification.",
    highlights: [
      "Three watch types: price alerts (one-shot), Polymarket volume moves, and on-chain wallet activity (both recurring).",
      "No new account needed — push notifications work the moment you grant permission in the app.",
    ],
  },
  {
    date: "Jul 9, 2026",
    title: "A treasury lookup for real DAOs",
    lede:
      "Ask \"treasury of uniswap\" and get the real, live, multi-chain number — computed on the spot from actual on-chain holdings, not a stale dashboard. Uniswap, ENS, and Arbitrum today.",
  },
  {
    date: "Jul 8, 2026",
    title: "Two more daily reads: fear divergence and the x402 pulse",
    lede:
      "\"Fear and greed divergence\" surfaces what's holding up while the rest of the market is scared — or an honest \"nothing today\" when there's genuinely no signal. \"x402 pulse\" tracks weekly adoption in the agentic-payments protocol Skopos itself settles through.",
  },
  {
    date: "Jul 7, 2026",
    title: "Spot a drainer before you sign",
    lede:
      "Paste any transaction hash and Skopos reads it back in plain English — and flags the dangerous parts. Unlimited token approvals (the setup behind most wallet drains) and honeypot tokens (you can buy but you can't sell) now get a clear warning, across 10 chains, not just one.",
    highlights: [
      "Unlimited-approval warning — catch the \"approve everything\" that lets a contract move a token out of your wallet anytime.",
      "Honeypot flag — a token with buys but zero sells is marked CRITICAL before you ape in.",
      "Multi-chain by default: Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, and more, in one read.",
    ],
  },
  {
    date: "Jul 6, 2026",
    title: "The market read, now instant and everywhere",
    lede:
      "The daily market reads got wider and faster. Alongside the narrative map and DeFi regime, ask \"what's trending\" or \"top DeFi protocols\" — and every read now answers instantly, in the app and over iMessage and Telegram.",
    highlights: [
      "Two new reads: what's trending on CoinGecko, and the biggest protocols by TVL with their weekly move.",
      "Instant — served from a live feed that refreshes on its own, no waiting on an agent.",
      "Everywhere — the same reads now land in iMessage and Telegram, not just the app.",
    ],
  },
  {
    date: "Jul 3, 2026",
    title: "Skopos, embeddable anywhere",
    lede:
      "Skopos's crypto brain now runs headless — any bot, app, or agent can ask it in plain English and get a plain-text answer back. The whole copilot — prices, swaps, portfolios, live smart-money intel — over a single call. First up: an iMessage agent that texts you what the smart money is doing.",
    highlights: [
      "Bring Skopos into iMessage, Telegram, a CLI, or an MCP agent with one request.",
      "Full copilot in text: prices + stocks, swap quotes, portfolios, yields, and live smart-money intel.",
      "Skopos fronts the data costs on integrations, capped per caller so they stay safe by default.",
    ],
  },
  {
    date: "Jul 2, 2026",
    title: "Live stock prices, in chat",
    lede:
      "Ask for a stock the way you ask for a token — \"HOOD price\", \"MSTR price\", \"NVDA price\" — and Skopos returns a live quote. 29 stocks and ETFs, the TradFi names crypto actually watches, right next to your crypto, yields, and cross-chain swaps.",
    highlights: [
      "29 tickers: crypto proxies (MSTR, COIN, HOOD, MARA, RIOT), AI + chips (NVDA, AMD, AVGO, PLTR), indices (SPY, QQQ), and big tech.",
      "Real quotes via Pyth — live during US market hours, last-close after.",
      "One box: crypto, stocks, FX, gold, prediction odds, and cross-chain execution, all in the same chat.",
    ],
  },
  {
    date: "Jul 1, 2026",
    title: "The market's narrative, in chat",
    lede:
      "Ask \"what's the narrative today\" or \"defi read today\" and Skopos runs a Bankr agent to hand you the daily map — the hot narratives, each with a front-run / ride / fade / skip call, and the DeFi regime with real-vs-emissions yield. Agentic market reads, right in the chat. No wallet, no signing.",
    highlights: [
      "Narrative map: what's hot in crypto and AI right now, each with a clear front-run / ride / fade / skip call.",
      "DeFi read: risk-on / risk-off regime, top movers with a one-line reason, and where yield is real vs just emissions.",
      "Powered by a Bankr agent through its Agent API — Skopos asks, the agent runs, you read the result.",
      "Skopos covers the cost; you never connect a wallet or sign anything.",
    ],
  },
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
      "Live on Base mainnet — Beryl activated June 25, 2026 — and on Base Sepolia for testing.",
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
