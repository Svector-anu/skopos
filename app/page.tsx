"use client";

import { useState, useEffect } from "react";
import { CornerBrackets } from "@/components/landing/CornerBrackets";
import { HeaderIcons } from "@/components/landing/HeaderIcons";
import { HeroTitle } from "@/components/landing/HeroTitle";
import { TerminalCard } from "@/components/landing/TerminalCard";
import { ActionButtons } from "@/components/landing/ActionButtons";

const D = {
  bg:     "#000000",
  text:   "#ffffff",
  border: "rgba(255,255,255,0.2)",
  btnTxt: "rgba(255,255,255,0.7)",
};
const L = {
  bg:     "#f5f5f0",
  text:   "#0a0a0a",
  border: "rgba(0,0,0,0.2)",
  btnTxt: "rgba(0,0,0,0.6)",
};

export default function LandingPage() {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("skopos-theme");
    const dark = stored !== "light";
    setIsDark(dark);
    sync(dark);
  }, []);

  function sync(dark: boolean) {
    if (dark) {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", "light");
    }
  }

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    sync(next);
    localStorage.setItem("skopos-theme", next ? "dark" : "light");
  }

  const C = isDark ? D : L;

  return (
    <main
      className="relative min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: C.bg, color: C.text, transition: "background 0.3s, color 0.3s" }}
    >
      <CornerBrackets />

      {/* Header */}
      <div className="absolute top-6 left-1/2 -translate-x-1/2">
        <HeaderIcons />
      </div>

      {/* Theme toggle */}
      <button
        onClick={toggle}
        aria-label="Toggle theme"
        style={{
          position: "fixed",
          top: 20,
          right: 24,
          zIndex: 50,
          background: "none",
          border: `1px solid ${C.border}`,
          color: C.btnTxt,
          borderRadius: 8,
          padding: "6px 12px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: "0.65rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontFamily: "var(--font-jetbrains-mono), monospace",
          opacity: 0.7,
          transition: "opacity 0.2s, border-color 0.3s, color 0.3s",
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = "1"; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = "0.7"; }}
      >
        {isDark ? <SunIcon /> : <MoonIcon />}
        {isDark ? "Light" : "Dark"}
      </button>

      {/* Center content */}
      <div className="flex flex-col items-center gap-8 w-full max-w-xl">
        <HeroTitle />
        <TerminalCard />
        <ActionButtons />
      </div>
    </main>
  );
}

function SunIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
