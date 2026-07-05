---
name: skopos
description: Cross-chain DeFi copilot for chat surfaces (Telegram, WhatsApp, iMessage, or any agent). Use whenever the user asks anything crypto/web3/DeFi — token or stock prices, currency/metal rates, smart-money intel (who is buying/holding/dumping a token), yields, token safety, swaps, bridges, payments, wallet/ENS/tx lookups, prediction markets, or general crypto questions. Skopos routes the request, pulls live data, and returns a concise plain-text answer. Execution stays non-custodial: swaps and payments come back as a link the user signs in the Skopos app.
---

# Skopos — DeFi copilot (text)

When the user asks something crypto/DeFi related, **do not guess or invent numbers** —
ask Skopos and relay its answer. Skopos handles routing, live data, smart-money
intel, and cost-fronting. You call one endpoint and pass the reply through as text.
This surface is text-only (no cards/buttons), which is exactly what Skopos returns
here.

## When to use this skill

Route to Skopos for any of these:

- **Prices**
  - crypto tokens — "eth price", "price of $aero"
  - stocks & ETFs (29 supported) — "hood price", "mstr", "nvda", "spy"
  - currency conversion — "100 usd to eur", "gbp to usd"
  - gold & silver — "gold price", "silver"
- **Smart-money intel** (live, named wallets)
  - who's buying/selling — "who is buying $aero", "who's dumping $pepe"
  - top holders — "who holds $arb", "top holders of $x"
  - accumulation flows — "is $x being accumulated", flow over time
  - exchange/segment flows & sell pressure — "cex outflows for $x", "where is $x flowing"
  - cross-chain screener — "what is smart money buying" (no token needed)
  - optional time windows — "…in the last hour / today / this week"
- **Yields** — "best yield for usdc", APY/APR questions
- **Token safety** — "is $x a rug", "is $x safe", "scan $x", "risk of $x"
- **Swaps & bridges** — "swap 1 eth to usdc on base", "bridge 100 usdc to arbitrum", "buy eth on base" → returns a **sign-in link**
- **Payments** — "pay 10 usdc to 0x… for order-1024", "show my payments" (incoming inbox) → sends return a **sign-in link**
- **Lookups** — wallet portfolio ("what's in 0x…"), ENS ("vitalik.eth"), tx status (a `0x…` hash)
- **Prediction markets** — "polymarket odds on …"
- **General crypto Q&A** — "what is a rollup", "explain eip-4337", "difference between …"

If a request is clearly crypto/DeFi but not listed above, still try Skopos — it
covers most crypto asks.

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
- `link` appears for **swaps, bridges, and payments** — a tap-to-sign deep-link.
- Keep `anonId` stable across a conversation (it drives Skopos's rate/cost caps, and
  is required for the smart-money intel reads Skopos pays for).

## How to respond

1. Relay `text` to the user as-is. It's already formatted for chat — plain text, no markdown or cards needed.
2. If `link` is present, include it and tell the user to open it to sign. It pre-fills the intent in the Skopos app.
3. **Never sign or execute anything yourself, and never expect a signable payload.** Skopos is non-custodial; signing only happens in the app via the link.
4. Never substitute your own prices/figures for Skopos's answer.

## Known limits (be honest)

- **Execution (swaps/bridges/payments) finishes in the app**, via the `link` — it does not complete in the chat. That's the non-custodial design.
- **Market narrative / DeFi "regime" reads** ("what's the narrative today", "risk on or off") currently return a pointer to open the Skopos app in text mode, rather than the full read.

## Examples

| User says | `message` you send | Skopos returns |
|---|---|---|
| "what's eth at?" | `eth price` | `ETH (Ethereum): $1.8K · +1.9% 24h …` + 7d sparkline |
| "hood stock?" | `hood price` | `Robinhood Markets (HOOD): $112.77 …` |
| "100 usd in eur?" | `100 usd to eur` | converted rate |
| "who's buying $aero?" | `who is buying $aero` | named smart-money wallets + net flow |
| "best yield for usdc" | `best yield for usdc` | top pools with APY + TVL |
| "is $pepe a rug?" | `is $pepe a rug` | risk label + flags |
| "swap 1 eth to usdc on base" | `swap 1 eth to usdc on base` | route summary + a sign-in `link` |
| "pay 10 usdc to 0x… for order-1" | `pay 10 usdc to 0x… for order-1` | payment summary + a sign-in `link` |

## Config

- Endpoint: `https://www.tryskopos.xyz/api/chat` (override with `SKOPOS_API_URL` for a local/dev instance).
- Full API contract: https://github.com/Svector-anu/skopos/blob/main/docs/headless-text-mode.md
