#!/usr/bin/env node
// Skopos MCP server — exposes the Skopos cross-chain DeFi copilot as a single
// installable skill for any MCP-compatible agent (Claude, Cursor, Zero, Aeon…).
// It is a thin wrapper over Skopos's headless text API: POST /api/chat
// { message, anonId, format:"text" } -> { text, link? }. No wallet, no keys —
// execution stays non-custodial: swaps/pays come back as a link to sign in the app.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.SKOPOS_API_URL ?? "https://www.tryskopos.xyz/api/chat";
const TIMEOUT_MS = 30_000;

const server = new McpServer({ name: "skopos", version: "0.1.0" });

server.tool(
  "skopos_ask",
  "Ask Skopos, a cross-chain DeFi copilot, anything in plain English and get a concise text answer. Handles: token/stock/currency/metal prices (with a 7d trend on tokens), smart-money intel (who is buying/holding/dumping a token, accumulation flows, cross-chain screener, via Nansen), yields, token safety/rug checks, wallet/ENS/transaction lookups, prediction markets, and general crypto questions. For swaps, bridges and payments it returns a link the user opens to sign in the Skopos app (execution is non-custodial — never a signable payload here).",
  {
    message: z
      .string()
      .describe(
        'The natural-language request, e.g. "eth price", "who is buying $aero", "best yield for usdc", or "swap 1 eth to usdc on base".',
      ),
    anonId: z
      .string()
      .optional()
      .describe("Stable per-conversation id used for Skopos rate/cost caps. Reuse it across a conversation."),
  },
  async ({ message, anonId }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, anonId: anonId ?? "skopos-mcp", format: "text" }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { content: [{ type: "text", text: `Skopos request failed (HTTP ${res.status}).` }], isError: true };
      }
      const data = await res.json();
      const text = typeof data.text === "string" ? data.text : "";
      const withLink = data.link ? `${text}\n\n${data.link}` : text;
      return { content: [{ type: "text", text: withLink || "No answer returned." }] };
    } catch (err) {
      const reason = err instanceof Error && err.name === "AbortError" ? "timed out" : "failed";
      return { content: [{ type: "text", text: `Skopos request ${reason}.` }], isError: true };
    } finally {
      clearTimeout(timer);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
