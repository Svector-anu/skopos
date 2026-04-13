export interface Command {
  cmd: string;
  preview: string;
}

export const COMMANDS: Command[] = [
  {
    cmd: "move 1 eth from ethereum to base",
    preview: "route: Ethereum → Relay → Base\noutput: ~0.998 ETH · fees: ~$0.05",
  },
  {
    cmd: "swap usdc to sol on solana",
    preview: "route: Arbitrum → Mayan → Solana\noutput: ~12.4 SOL · fees: ~$0.12",
  },
  {
    cmd: "rebalance my portfolio across chains",
    preview: "analyzing holdings across 4 chains…",
  },
  {
    cmd: "send funds to lowest fee route",
    preview: "route: Base → GasZip → Polygon\noutput: ~99.8 USDC · fees: ~$0.01",
  },
];
