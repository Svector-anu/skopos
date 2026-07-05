# Skopos skills

Portable [Agent Skills](https://agentskills.io/specification) that let any
SKILL.md-compatible agent use Skopos. Same file works in Claude Code, Cursor, and
other agents that follow the standard — only the install directory differs.

Available skills:

- **`skopos/`** — the Skopos DeFi copilot (prices, smart-money intel, yields,
  swaps, payments, lookups) over Skopos's headless API.

## Install

A skill is just a folder with a `SKILL.md`. Copy the `skopos/` folder into your
agent's skills directory, then reload.

### Claude Code

Personal (all projects):

```bash
mkdir -p ~/.claude/skills && cp -R skopos ~/.claude/skills/skopos
```

Project-scoped instead: copy into `.claude/skills/skopos/` inside the project.
Invoke with `/skopos`, or Claude loads it automatically when a request matches its
`description`.

### Cursor

Cursor uses the same SKILL.md format, but skills are project-scoped:

```bash
mkdir -p .cursor/skills && cp -R skopos .cursor/skills/skopos
```

Global instead: `~/.cursor/skills/skopos/`. Reload the workspace, then type
`/skopos` in chat (or `@skopos` to attach it as context).

### Cross-tool (`.agents/skills`)

Agents that read the shared convention auto-load from `.agents/skills/` (project)
or `~/.agents/skills/` (global):

```bash
mkdir -p ~/.agents/skills && cp -R skopos ~/.agents/skills/skopos
```

## Notes

- The skill is **self-contained** — it calls Skopos's public API directly; no key,
  wallet, or SDK.
- Point it at a local/dev Skopos with the `SKOPOS_API_URL` env var (default
  `https://www.tryskopos.xyz/api/chat`).
- Prefer a running tool instead of a loaded skill? Use the MCP server in
  [`../mcp`](../mcp) (`skopos-mcp`) for MCP-native clients.
