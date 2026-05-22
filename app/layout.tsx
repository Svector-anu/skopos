import type { Metadata } from "next";
import { Source_Serif_4, Source_Sans_3, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import { PageTransitionWrapper } from "@/components/shared/PageTransitionWrapper";
import "./globals.css";

const sourceSerif = Source_Serif_4({
  weight: ["400", "600", "700"],
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const sourceSans = Source_Sans_3({
  weight: ["400", "600"],
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.tryskopos.xyz"),

  title: "Skopos",
  description: "Cross-chain intent execution. Say what you want, it executes.",

  icons: {
    icon: "/icon.png",
    apple: "/apple-touch-icon.png",
  },

  openGraph: {
    title: "Skopos",
    description: "Cross-chain intent execution. Say what you want, it executes.",
    url: "https://www.tryskopos.xyz",
    siteName: "Skopos",
    images: [
      {
        url: "/api/header",
        width: 1200,
        height: 630,
      },
    ],
    type: "website",
  },

  twitter: {
    card: "summary_large_image",
    title: "Skopos",
    description: "Cross-chain intent execution. Say what you want, it executes.",
    images: ["/api/header"],
  },

  viewport: {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
  },

  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sourceSerif.variable} ${sourceSans.variable} ${jetbrainsMono.variable} h-full`}
    >
      <head>
        <Script
          id="clear-theme"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `try{localStorage.removeItem('skopos-theme');}catch(e){}`,
          }}
        />
      </head>
      <body className="h-full antialiased">
        <PageTransitionWrapper>{children}</PageTransitionWrapper>
      </body>
    </html>
  );
}