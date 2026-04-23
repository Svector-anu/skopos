import { Web3Provider } from "@/components/providers/Web3Provider";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Skopos",
  description: "AI agent for cross-chain DeFi",
  openGraph: {
    title: "Skopos",
    description: "AI agent for cross-chain DeFi",
    url: "https://tryskopos.xyz",
    siteName: "Skopos",
    images: [
      {
        url: "https://tryskopos.xyz/api/header",
        width: 1500,
        height: 500,
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Skopos",
    description: "AI agent for cross-chain DeFi",
    images: ["https://tryskopos.xyz/api/header"],
  },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Web3Provider>{children}</Web3Provider>;
}