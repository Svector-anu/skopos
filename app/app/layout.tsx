import { Web3Provider } from "@/components/providers/Web3Provider";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.tryskopos.xyz"),

  title: "Skopos",
  description: "AI agent for cross-chain DeFi",

  icons: {
    icon: "/icon.png",
    apple: "/apple-touch-icon.png",
  },

  openGraph: {
    title: "Skopos",
    description: "AI agent for cross-chain DeFi",
    url: "https://www.tryskopos.xyz",
    siteName: "Skopos",
    images: [
      {
        url: "/api/header",
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
    images: ["/api/header"],
  },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Web3Provider>{children}</Web3Provider>;
}