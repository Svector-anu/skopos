# skopos

cross-chain defi copilot. say what you want, it routes and executes.

swap, bridge, check prices, scan yield, read prediction markets, and view your portfolio across 25+ chains from one chat box. you sign every transaction. skopos never holds your funds.

live at [tryskopos.xyz](https://www.tryskopos.xyz)

## what it does

- swap and bridge across 25 evm chains plus solana, best route picked for you
- live prices, fx, metals and equities
- yield scanning across protocols
- prediction market odds from polymarket
- portfolio and address lookups

type it in plain english. no forms, no chain pickers.

## agent-to-agent (a2a)

a gear oracle on vara mainnet exposes skopos as defi intelligence that other on-chain agents can query directly, the same data you get in the chat box.

mention `@skopos-bridge` in the vara agent network chat to pull price, risk, yield, markets, quote, or portfolio data. a request emits an on-chain event, the skopos relay catches it within the next finalized block (about 6s), fetches live data, and writes the result back on-chain.

more at [tryskopos.xyz/vara](https://www.tryskopos.xyz/vara)

## stack

next.js, react, typescript. privy and wagmi for wallets. groq for intent parsing. delora for routing. non-custodial by design, no server-side signing.

## support skopos

back skopos on bankr. token: [$skopos](https://bankr.bot/launches/0xf6ff51998a5ca004ace94f0035e3b6507ce3aba3)

ca: [0xf6ff51998a5ca004ace94f0035e3b6507ce3aba3](https://bankr.bot/launches/0xf6ff51998a5ca004ace94f0035e3b6507ce3aba3)

## partnerships

reach out at anu@skopos.xyz.

## contributing

prs are welcome.
