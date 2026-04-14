import { createConfig } from "@privy-io/wagmi";
import {
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  bsc,
} from "wagmi/chains";
import { http } from "viem";

export const wagmiConfig = createConfig({
  chains: [mainnet, base, arbitrum, optimism, polygon, avalanche, bsc],
  transports: {
    [mainnet.id]: http(),
    [base.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [avalanche.id]: http(),
    [bsc.id]: http(),
  },
});
