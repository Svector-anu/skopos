"use client";

import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmi";
import { useState } from "react";
import {
  ConnectionProvider as SolanaConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import type { WalletAdapter } from "@solana/wallet-adapter-base";

const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";
const SOLANA_WALLETS: WalletAdapter[] = [];
const PRIVY_CONFIG: PrivyClientConfig = {
  loginMethods: ["google", "twitter", "discord", "email", "wallet"],
  appearance: {
    theme: "#000000",
    accentColor: "#F5B800",
    landingHeader: "Sign in to Skopos",
  },
  embeddedWallets: {
    ethereum: {
      createOnLogin: "users-without-wallets",
    },
  },
};

export function Web3Provider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <SolanaConnectionProvider endpoint={SOLANA_RPC}>
      {/* Pass empty wallets array — Phantom self-registers via Wallet Standard */}
      <SolanaWalletProvider wallets={SOLANA_WALLETS} autoConnect>
        <PrivyProvider
          appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? ""}
          clientId={process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID}
          config={PRIVY_CONFIG}
        >
          <QueryClientProvider client={queryClient}>
            <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
          </QueryClientProvider>
        </PrivyProvider>
      </SolanaWalletProvider>
    </SolanaConnectionProvider>
  );
}
