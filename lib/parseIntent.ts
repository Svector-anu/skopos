import Anthropic from "@anthropic-ai/sdk";

export interface ParsedIntent {
  originChain: string;
  destinationChain: string;
  token: string;
  amount: string;
  destinationToken: string;
}

const client = new Anthropic();

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "extract_swap_intent",
  description:
    "Extract the cross-chain or same-chain swap/bridge intent from a user message. " +
    "Only call this tool when the message clearly describes a token swap, bridge, or transfer. " +
    "Do not call it for greetings, questions, or unrelated requests.",
  input_schema: {
    type: "object" as const,
    properties: {
      originChain: {
        type: "string",
        description:
          "The source blockchain name, lowercased. E.g. 'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche', 'bsc', 'solana', 'monad', 'berachain', 'sonic', 'blast', 'scroll', 'linea'.",
      },
      destinationChain: {
        type: "string",
        description:
          "The destination blockchain name, lowercased. Same format as originChain. If same-chain swap, identical to originChain.",
      },
      token: {
        type: "string",
        description:
          "The token symbol to send, uppercased. E.g. 'ETH', 'USDC', 'USDT', 'WBTC', 'SOL'. Resolve common aliases: 'bitcoin' → 'WBTC', 'ether' → 'ETH'.",
      },
      amount: {
        type: "string",
        description:
          "The numeric amount as a decimal string. E.g. '1', '0.5', '100'. Must be a concrete number — do not infer 'all' or 'half' without explicit context.",
      },
      destinationToken: {
        type: "string",
        description:
          "The token to receive on the destination chain, uppercased. If not specified by the user, use the same value as 'token'.",
      },
    },
    required: [
      "originChain",
      "destinationChain",
      "token",
      "amount",
      "destinationToken",
    ],
  },
};

const SYSTEM = `You are a cross-chain swap intent parser for a DeFi copilot.
Your job is to extract structured swap/bridge intent from user messages.
Only call the extract_swap_intent tool when the message contains a clear swap or bridge request with a specific numeric amount.
If the message is ambiguous, a greeting, a question about the product, or missing a concrete amount, do NOT call the tool — instead respond with a short helpful message.`;

export async function parseIntent(
  input: string
): Promise<ParsedIntent | null> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    messages: [{ role: "user", content: input }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;

  const input_data = toolUse.input as Record<string, string>;
  return {
    originChain: input_data.originChain,
    destinationChain: input_data.destinationChain,
    token: input_data.token,
    amount: input_data.amount,
    destinationToken: input_data.destinationToken,
  };
}

export async function getSuggestion(input: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 128,
    system:
      "You are a helpful assistant for a cross-chain DeFi copilot. " +
      "The user typed something that isn't a valid swap request. " +
      "Give a single short sentence guiding them toward a valid command. " +
      "Examples of valid commands: 'move 1 ETH from ethereum to base', 'swap 100 USDC from arbitrum to polygon'.",
    messages: [{ role: "user", content: input }],
  });

  const text = response.content.find((b) => b.type === "text");
  return text?.type === "text"
    ? text.text
    : "Try: 'move 1 ETH from ethereum to base'";
}
