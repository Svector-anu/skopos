---
name: skopos
description: Cross-chain DeFi copilot. Use whenever the user asks anything crypto/web3/DeFi — token or stock prices, smart-money intel (who is buying / holding / dumping a token), yields/APY, swaps, bridges, portfolios, or market reads. Skopos routes the request, pulls live data, and returns a concise plain-text answer. Execution stays non-custodial: swaps and payments come back as a link the user signs in the Skopos app.
---

# Skopos — DeFi copilot

When the user asks something crypto/DeFi related, do **not** guess or invent numbers.
Ask Skopos and relay its answer. Skopos does the routing, live data, smart-money
intel, and cost-fronting; you just call it and pass the reply through.

## When to use this skill

Trigger on requests about:
- **Prices** — tokens *and* stocks/ETFs ("eth price", "hood price", "mstr")
- **Smart-money intel** — "who is buying/dumping $X", "who holds $X", flows, screener
- **Yields** — "best yield for usdc", APY/APR
- **Swaps / bridges** — "swap 1 eth to usdc on base", "bridge 100 usdc to arbitrum"
- **Market reads, portfolios, gas, prediction markets**, memecoins, on-chain questions

## How to call it

One HTTP POST — no key, no wallet, no SDK. Use your shell/fetch tool:

```bash
curl -s -X POST https://www.tryskopos.xyz/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"<the user's request, verbatim>","anonId":"<stable conversation id>","format":"text"}'
```

Response shape:

```json
{ "text": "<the answer, ready to relay>", "link": "<optional — sign-in URL for execute intents>" }
```

- `text` is always populated and already concise/plain-text.
- `link` appears for **swaps, bridges, and payments** — it is a tap-to-sign deep-link.
- Keep `anonId` stable across a conversation (it drives Skopos's rate/cost caps).

## How to respond

1. Relay `text` to the user as-is. It's already formatted for chat (plain text, no markdown needed).
2. If `link` is present, include it — tell the user to open it to sign. It pre-fills the intent in the Skopos app.
3. **Never sign or execute anything yourself, and never expect a signable payload.** Skopos is non-custodial by design; signing only happens in the app via the link.
4. Never substitute your own prices/figures for Skopos's answer.

## Examples

| User says | You call Skopos with `message` | Skopos returns |
|---|---|---|
| "what's eth at?" | `eth price` | `ETH (Ethereum): $1.8K · +1.9% 24h …` + 7d sparkline |
| "who's buying $aero?" | `who is buying $aero` | named smart-money wallets + net flow |
| "best yield for usdc" | `best yield for usdc` | top pools with APY + TVL |
| "swap 1 eth to usdc on base" | `swap 1 eth to usdc on base` | route summary + a sign-in `link` |

## Config

- Endpoint: `https://www.tryskopos.xyz/api/chat` (override with the env var `SKOPOS_API_URL` if pointing at a local/dev instance).
- Full API contract: https://github.com/Svector-anu/skopos/blob/main/docs/headless-text-mode.md
