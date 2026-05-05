export interface Command {
  cmd: string;
  response: string;
}

export const COMMANDS: Command[] = [
  {
    cmd: "move 2 eth from ethereum to base",
    response: "Routed — ETH to Base via best path\nOptimized for cost and speed · ready when you are",
  },
  {
    cmd: "swap 500 usdc to eth on base",
    response: "Best execution path found on Base\nSwapping USDC to ETH with minimal slippage",
  },
  {
    cmd: "what's sol looking like right now",
    response: "Live SOL market data pulled\nAggregated across major venues for accuracy",
  },
  {
    cmd: "any good yield on usdc rn",
    response: "Scanning stable yield across chains\nFound pools with strong liquidity and consistent performance",
  },
  {
    cmd: "what's my wallet looking like",
    response: "Synced your positions across chains\nTokens, balances, and recent activity all mapped",
  },
  {
    cmd: "bridge 1 sol to ethereum",
    response: "Cross-chain route ready — Solana to Ethereum\nHandling liquidity and compatibility behind the scenes",
  },
];
