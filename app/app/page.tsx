"use client";

import { useRef, useEffect } from "react";
import Link from "next/link";

export default function AppPage() {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <main className="min-h-screen bg-black flex flex-col items-center justify-center px-4">
      {/* Back link */}
      <Link
        href="/"
        className="absolute top-6 left-6 text-white/30 hover:text-white/60 transition-colors text-xs tracking-widest uppercase"
        style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}
      >
        ← back
      </Link>

      <div className="flex flex-col items-center gap-8 w-full max-w-lg">
        {/* Prompt */}
        <h1
          className="text-white text-center leading-none"
          style={{
            fontFamily: "var(--font-bebas-neue), sans-serif",
            fontSize: "clamp(2.5rem, 6vw, 3.5rem)",
            letterSpacing: "0.02em",
          }}
        >
          What do you want to do?
        </h1>

        {/* Input */}
        <div
          className="w-full flex items-center gap-3 px-4 py-3"
          style={{
            background: "#0A0A0A",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          <span
            className="text-sm shrink-0"
            style={{
              color: "#F5B800",
              fontFamily: "var(--font-jetbrains-mono), monospace",
            }}
          >
            {">"}
          </span>
          <input
            ref={inputRef}
            type="text"
            placeholder="move 1 eth from ethereum to base"
            className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-white/20"
            style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}
          />
        </div>

        <p
          className="text-xs text-white/20 text-center"
          style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}
        >
          execution engine coming soon
        </p>
      </div>
    </main>
  );
}
