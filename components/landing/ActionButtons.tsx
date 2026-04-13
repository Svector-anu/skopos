"use client";

import Link from "next/link";

interface ButtonProps {
  href: string;
  label: string;
  icon: React.ReactNode;
  external?: boolean;
}

function OutlineButton({ href, label, icon, external }: ButtonProps) {
  const cls =
    "flex items-center gap-2 px-5 py-2.5 text-xs tracking-widest uppercase transition-all duration-200 " +
    "border text-white/70 hover:text-white hover:border-white/40 " +
    "border-white/20 bg-transparent cursor-pointer";

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {icon}
        {label}
      </a>
    );
  }

  return (
    <Link href={href} className={cls}>
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
