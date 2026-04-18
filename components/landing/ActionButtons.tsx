"use client";

import Link from "next/link";

interface ButtonProps {
  href: string;
  label: string;
  icon: React.ReactNode;
  external?: boolean;
}

const btnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 20px",
  fontSize: "0.7rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "rgba(255,255,255,0.7)",
  background: "transparent",
  cursor: "pointer",
  textDecoration: "none",
  transition: "color 0.2s, border-color 0.2s",
};

function OutlineButton({ href, label, icon, external }: ButtonProps) {
  function handleEnter(e: React.MouseEvent<HTMLElement>) {
    e.currentTarget.style.color = "#ffffff";
    e.currentTarget.style.borderColor = "rgba(255,255,255,0.4)";
  }
  function handleLeave(e: React.MouseEvent<HTMLElement>) {
    e.currentTarget.style.color = "rgba(255,255,255,0.7)";
    e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)";
  }

  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={btnStyle}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {icon}
        {label}
      </a>
    );
  }

  return (
    <Link
      href={href}
      style={btnStyle}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {icon}
      {label}
    </Link>
  );
}

export function ActionButtons() {
  return (
    <div className="flex items-center gap-3 flex-wrap justify-center">
      <OutlineButton
        href="/app"
        label="Open App"
        icon={
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      />
      <OutlineButton
        href="https://docs.delora.build"
        label="Read Docs"
        external
        icon={
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9 12h6M9 16h6M7 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" strokeLinecap="round" />
            <rect x="7" y="2" width="10" height="4" rx="1" />
          </svg>
        }
      />
    </div>
  );
}
