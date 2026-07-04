# Headless text mode — `/api/chat` for agents & bots

Skopos's `/api/chat` normally returns **UI cards** for the browser (with panels, a
wallet, and a "Reveal" button for paid reads). Headless clients — iMessage/Telegram
bots, CLIs, MCP servers — can't render cards or tap buttons. **Text mode** is an
opt-in projection that returns a single plain-text answer instead.

- Endpoint: `POST https://www.tryskopos.xyz/api/chat`
- Opt in with `"format": "text"`. Omit it (or send `"card"`) for the unchanged card API.
- The card object stays the single source of truth; text is an additive projection
  (`lib/cardToText.ts`). The browser never sends the flag, so its behavior is
  identical.

---

## Quick start

```bash
curl -sX POST https://www.tryskopos.xyz/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"who is buying $aero","format":"text","anonId":"chat-123"}'
# → { "type":"intel",
#     "text":"$AERO — top buyers: 🤖 Wintermute Market Making +$10.69M, … Net accumulating $15.54M." }
```

Relay `text` verbatim. Your client needs **zero card knowledge**.

---

## Request

```jsonc
{
  "message": "<the user's text>",          // required
  "format": "text",                          // "text" | "card" (default "card")
  "anonId": "<stable per-conversation id>",  // REQUIRED for text-mode intel (cost cap key)
  "senderAddress": "0x…",                    // optional — unlocks that address's tier
  "solanaAddress": "…",                      // optional — Solana leg
  "history": [{ "role": "user"|"assistant", "content": "…" }],  // optional, last ~6 used
  "slippage": 0.5,                           // optional
  "llmTier": "fast"                          // "fast" | "smart"; Smart needs a wallet/tier
}
```

- Max body 64 KB; over-long messages are rejected.
- `history` is trimmed to the last 4–6 turns internally.

## Response (`format:"text"`)

Always `{ type, text }` where **`text` is a non-empty plain-text string** (no
markdown — targets iMessage). `type` is kept so you can still branch if you want.
Execute intents also carry an optional **`link`** (see below). A future `image`
field will carry a chart PNG url; clients should ignore fields they don't handle.

| Card `type` | Text you get |
|---|---|
| `text`, `error` | passthrough of the existing message |
| `price` | `ETH (Ethereum): $1.6K · -1.05% 24h · mcap $196.96B` |
| `intel` (smart-money / holders / screener / flows / flow-intel) | executes the read inline (see **Cost**) → named-wallet summary |
| `quote` (swap/bridge) | route summary + a **`link`** to sign (never a signable payload) |
| `rebalance` | multi-leg summary + a **`link`** to sign |
| `pay` | intent explanation + a **`link`** to sign — **never a signable payload** |
| `address`, `tx` | the card's existing `summary` |
| `yield_pools` | top 3 pools with APY + TVL |
| `polymarket` | top markets with odds |
| `payments` | recent incoming memo payments |
| `token_risk` | risk label/score + flags |
| `rebalance`, `suggestions` | short summary |
| `aeon` (narrative / defi read) | **fallback line** → "open Skopos" (60s inline is unreliable on serverless; not executed headless yet) |
| `paywall` | "connect a wallet" / "subscribe" line |
| unknown / new | graceful "open Skopos for this: <link>" — never blank, never throws |

---

## Execution handoff (`link`)

Skopos is non-custodial, so headless clients never get a signable payload. Instead,
execute intents (`quote`, `rebalance`, `pay`) return a **`link`**:

```
https://www.tryskopos.xyz/app?q=<url-encoded original message>
```

Opening it drops the user into the Skopos web app, which auto-submits the query and
re-produces the card **staged to sign** — reusing the normal chat + wallet flow, with
no dedicated `/swap` or `/pay` route. Execution only ever happens on Skopos; the intent
syncs through the link. A client appends `link` to its reply (imessage-i already does
this, so it lights up with no client change).

---

## Cost & caps (read this before shipping)

Only **text-mode intel reads** spend money (an x402 USDC micropayment fronted by
Skopos, ~$0.01 each). Everything else is free. Card-mode requests spend **nothing**
(they return a card; the paid read happens later, in the browser).

Text-mode intel is bounded by **two** caps:

1. **Per-anonId:** `AGENT_TEXT_INTEL_DAILY_CAP` (default **15/day**). **Fails closed** —
   no `anonId`, or the metering store (Upstash) unavailable → the read is **refused,
   not spent**. So a busy group chat can't drain the budget, and a metering outage
   can't cause runaway spend.
2. **Global:** `SMART_MONEY_AGENT_DAILY_CAP` (default 200/day) across all callers.

Over either cap → a plain-text "daily intel limit reached — try later or open
Skopos" line (no spend). **Always send a stable `anonId`** (e.g. the conversation id)
or intel is refused.

`aeon` reads are not executed headless in v1 (they take ~60s), so they never spend.

---

## Tiers, rate limits, transport

- **Tier:** `senderAddress` alone unlocks that address's tier — **no signed session**
  (the address is trusted as-is). Smart-LLM daily caps: anon **2** → wallet **20** →
  `$skopos` holder **100** (if the holder gate is enabled). Intel is global-capped
  regardless of tier.
- **Rate limit:** **30 requests/min per IP** (`route.ts`, in-memory sliding window →
  soft/per-instance). All your group chats share your server's IP — pace accordingly.
- **Server-to-server:** fine. CORS is browser-only; an empty-`Origin` server call is
  not rejected (it just gets no CORS headers back, which a server doesn't need).
- **Non-custodial:** Skopos never executes swaps or pays. `quote`/`pay` return an
  explanation + a link to sign in the Skopos app. A headless client cannot complete
  a swap or a send — surface the link.

## Contract stability

No API versioning — `/api/chat` auto-deploys from `main`. The **request** shape is
stable. The **response** is a discriminated union keyed by `type` that **grows** as
features ship (new card types appear over time). Don't pin a version (there isn't
one): **branch on `type`, and handle unknown types gracefully** — text mode already
degrades unknown types to a safe line, so relaying `text` verbatim is future-proof.

---

## Minimal client (the imessage-i pattern)

```ts
async function askSkopos(message: string, conversationId: string): Promise<string> {
  const res = await fetch("https://www.tryskopos.xyz/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, format: "text", anonId: conversationId }),
  });
  const { text } = await res.json();      // always non-empty
  return text;                             // relay verbatim
}
```

Route only crypto/web3 messages here; keep everything else on your own LLM.

## Env (Skopos side)

| Var | Default | Effect |
|---|---|---|
| `AGENT_TEXT_INTEL_DAILY_CAP` | 15 | per-anonId text-mode intel reads/day; **fails closed** |
| `SMART_MONEY_AGENT_DAILY_CAP` | 200 | global intel reads/day |
| `SKOPOS_X402_PRIVATE_KEY` | — | the wallet that fronts intel x402 fees; unset → intel not offered |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | — | metering store; absent → text-mode intel fails closed |

## Source

`app/api/chat/route.ts` (the `POST` wrapper peeks `format`, projects via `cardToText`)
· `lib/cardToText.ts` (the projection + inline intel) · `lib/usage.ts`
(`checkAgentTextIntelCap`, fail-closed).
