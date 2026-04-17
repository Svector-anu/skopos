import type { Metadata } from "next";
import { Source_Serif_4, Source_Sans_3, JetBrains_Mono } from "next/font/google";
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
  title: "Skopos",
  description: "Cross-chain intent execution. Say what you want, it executes.",
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
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sourceSerif.variable} ${sourceSans.variable} ${jetbrainsMono.variable} h-full`}
    >
      <head>
        {/* Apply saved theme before first paint to prevent flash */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('skopos-theme');if(t==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}` }} />
      </head>
      <body className="h-full antialiased">
        <PageTransitionWrapper>{children}</PageTransitionWrapper>
      </body>
    </html>
  );
}
