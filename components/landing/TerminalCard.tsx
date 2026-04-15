"use client";

import { useTypewriter } from "@/hooks/useTypewriter";

export function TerminalCard() {
  const { displayText, showPreview, previewText, previewVisible } =
    useTypewriter();

  return (
    <div
      className="w-full max-w-xl mx-auto rounded-2xl overflow-hidden"
      style={{
        background: "#0A0A0A",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {/* Traffic lights */}
      <div
        className="flex items-center gap-2 px-4"
        style={{ height: 36, borderBottom: "1px solid rgba(255,255,255,0.05)" }}
      >
        <span className="w-3 h-3 rounded-full bg-[#FF5F57]" />
        <span className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
        <span className="w-3 h-3 rounded-full bg-[#28C840]" />
      </div>

      {/* Terminal body */}
      <div className="px-5 py-4 min-h-[88px] flex flex-col justify-center gap-3">
        {/* Command line */}
        <div
          className="flex items-center gap-2 text-sm leading-none"
          style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}
        >
          <span style={{ color: "#F5B800" }}>{">"}</span>
          <span className="text-white">{displayText}</span>
          <span
            className="cursor-blink inline-block w-[2px] h-[14px] bg-white"
            style={{ marginLeft: 1 }}
          />
        </div>

        {/* Response preview */}
        {showPreview && (
          <div
            className="text-xs leading-relaxed pl-4"
            style={{
              fontFamily: "var(--font-jetbrains-mono), monospace",
              color: "rgba(255,255,255,0.45)",
              opacity: previewVisible ? 1 : 0,
              transition: "opacity 300ms ease",
              whiteSpace: "pre-line",
              borderLeft: "1px solid rgba(245,184,0,0.3)",
            }}
          >
            {previewText
              .split("\n")
              .map((line, i) => (
                <div key={i}>
                  <span style={{ color: "#F5B800", marginRight: 4 }}>{"→"}</span>
                  {line}
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
