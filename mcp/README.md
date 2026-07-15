# skopos-mcp

![skopos-mcp](https://www.tryskopos.xyz/skopos-mcp-banner.png)

Skopos — the non-custodial, cross-chain crypto copilot — as an installable **agent skill** over MCP.

One tool, `skopos_ask`, lets any MCP-compatible agent (Claude, Cursor, Zero, Aeon…)
ask Skopos in plain English and get a text answer back: token/stock prices, live
smart-money intel (who's buying/holding/dumping), Aeon market reads, token picks,
DAO treasury lookups, standing alerts, and yields. Swaps, bridges and payments
come back as a **link to sign in the Skopos app** — execution stays non-custodial;
no wallet or keys touch the agent.

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
- `who is buying $pepe?`
- `give me a token pick`
- `treasury of uniswap`
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
- More at [tryskopos.xyz](https://www.tryskopos.xyz).
