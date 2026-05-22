"use client";

import Link from "next/link";

export function OracleChip() {
  function handleEnter(e: React.MouseEvent<HTMLAnchorElement>) {
    e.currentTarget.style.color = "rgba(255,255,255,0.7)";
    e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
  }
  function handleLeave(e: React.MouseEvent<HTMLAnchorElement>) {
    e.currentTarget.style.color = "rgba(255,255,255,0.35)";
    e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)";
  }

  return (
    <Link
      href="/vara"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontSize: "0.65rem",
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.35)",
        textDecoration: "none",
        border: "1px solid rgba(255,255,255,0.07)",
        padding: "6px 14px",
        transition: "color 0.2s, border-color 0.2s",
      }}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "#22c55e",
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      Agents can query Skopos on-chain
    </Link>
  );
}
