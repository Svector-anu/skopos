# skopos-mcp

Skopos — the cross-chain DeFi copilot — as an installable **agent skill** over MCP.

One tool, `skopos_ask`, lets any MCP-compatible agent (Claude, Cursor, Zero, Aeon…)
ask Skopos in plain English and get a text answer back: token/stock prices, live
smart-money intel (who's buying/holding/dumping), yields, and market reads. Swaps,
bridges and payments come back as a **link to sign in the Skopos app** — execution
stays non-custodial; no wallet or keys touch the agent.

It's a thin wrapper over Skopos's headless API (`POST /api/chat` with
`format:"text"`).

## Use it

Run directly:

```bash
npx skopos-mcp
```

### Claude Desktop / Cursor (MCP config)

```json
{
  "mcpServers": {
    "skopos": {
      "command": "npx",
      "args": ["-y", "skopos-mcp"]
    }
  }
}
```

### Zero

```bash
zero mcp add skopos -- npx -y skopos-mcp
```

Then just ask your agent things like:

- `what's the price of eth?`
- `who is buying $aero?`
- `best yield for usdc`
- `swap 1 eth to usdc on base` → returns a link to sign in Skopos

## Tool

`skopos_ask({ message, anonId? })` → text answer (plus a sign-in link for execute
intents).

- `message` — the natural-language request
- `anonId` — optional stable per-conversation id (used for Skopos rate/cost caps)

## Config

| Env | Default | Purpose |
|---|---|---|
| `SKOPOS_API_URL` | `https://www.tryskopos.xyz/api/chat` | override the endpoint (e.g. local dev) |

## Notes

- Non-custodial: the agent never gets a signable payload. Anything requiring a
  signature returns a link the user opens in the Skopos web app.
- Full API contract: [`docs/headless-text-mode.md`](https://github.com/Svector-anu/skopos/blob/main/docs/headless-text-mode.md).
