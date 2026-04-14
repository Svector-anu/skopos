import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  bsc,
} from "wagmi/chains";

export const wagmiConfig = getDefaultConfig({
  appName: "Delora Copilot",
  projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "placeholder",
  chains: [mainnet, base, arbitrum, optimism, polygon, avalanche, bsc],
  ssr: true,
});
