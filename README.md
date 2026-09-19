# skopos

cross-chain defi copilot. say what you want, it routes and executes.

swap, bridge, place protected orders, check prices, scan tokens, and share trades — across 25+ chains from one chat box. your wallet signs every trade. skopos never holds your funds or your keys.

live at [tryskopos.xyz](https://www.tryskopos.xyz) · docs at [docs.tryskopos.xyz](https://docs.tryskopos.xyz)

## what it does

- swap and bridge across 25 evm chains plus solana, best route picked for you
- limit, stop-loss, take-profit and twap orders on 9 chains, with a stop and target attached to the entry in one message
- buy tokenized stocks on robinhood chain — nvda, aapl, tsla, spy and more
- live prices, fx, metals and equities
- smart-money reads: who is buying a token, and how much
- token safety: rug and honeypot scans, plus a scan for risky approvals you've left open
- yield scanning, polymarket odds, dao treasuries, portfolio lookups, price alerts

type it in plain english. no forms, no chain pickers.

## seal

share a trade without sharing the money.

publish a trade as a link — entry, stop-loss, take-profit, and a size range. anyone who opens it picks their own size and signs the order from their own wallet. the trade is shared; the funds never are. every take is a separate order under a separate wallet, and every one is listed on the seal's page.

built on [definitive flash](https://flash.definitive.fi).

## for agents

skopos works headless, so other agents can use it too.

- **mcp server** — `npx -y skopos-mcp`
- **agent skill** — [`skills/skopos/SKILL.md`](skills/skopos/SKILL.md)
- **paid api** — 10 endpoints agents pay for per call in usdc over x402. no key, no signup. [openapi.json](https://www.tryskopos.xyz/openapi.json)
- **for llms** — [llms.txt](https://www.tryskopos.xyz/llms.txt)

agents get quotes and links back, never a signable payload. a person still signs.

## agent-to-agent (a2a)

a gear oracle on vara mainnet exposes skopos as defi intelligence that other on-chain agents can query directly.

mention `@skopos-bridge` in the vara agent network chat to pull price, risk, yield, markets, quote, or portfolio data. a request emits an on-chain event, the skopos relay catches it within the next finalized block (about 6s), fetches live data, and writes the result back on-chain.

more at [tryskopos.xyz/vara](https://www.tryskopos.xyz/vara)

## stack

next.js, react, typescript. privy and wagmi for wallets. definitive flash for advanced orders, delora for routing. groq and the bankr llm gateway for language. non-custodial by design — the server never holds a user key.

## support skopos

back skopos on [bankr](https://bankr.bot/launches/0xf6ff51998a5ca004ace94f0035e3b6507ce3aba3). token: $skopos on base.

ca: `0xf6ff51998a5ca004ace94f0035e3b6507ce3aba3`

holding it raises your daily cap on the smart tier.

## links

- app — [tryskopos.xyz](https://www.tryskopos.xyz)
- docs — [docs.tryskopos.xyz](https://docs.tryskopos.xyz)
- x — [@tryskopos](https://x.com/tryskopos)
- mcp — [skopos-mcp on npm](https://www.npmjs.com/package/skopos-mcp)
- $skopos — [on bankr](https://bankr.bot/launches/0xf6ff51998a5ca004ace94f0035e3b6507ce3aba3)

## partnerships

reach out at anu@skopos.xyz.

## contributing

prs are welcome.

## license

[mit](LICENSE)
