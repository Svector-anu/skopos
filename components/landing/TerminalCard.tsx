"use client";

import { useTypewriter } from "@/hooks/useTypewriter";

const MONO: React.CSSProperties = {
  fontFamily: "var(--font-jetbrains-mono), monospace",
};

export function TerminalCard() {
  const { userText, aiText, phase } = useTypewriter();

  const showUser     = userText.length > 0;
  const showThinking = phase === "ai-thinking";
  const showAi       = aiText.length > 0;

  return (
    <div
      className="w-full max-w-xl mx-auto rounded-2xl overflow-hidden"
      style={{
        background: "#0A0A0A",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* Chrome bar */}
      <div
        className="flex items-center gap-2 px-4"
        style={{ height: 36, borderBottom: "1px solid rgba(255,255,255,0.04)" }}
      >
        <span className="w-3 h-3 rounded-full bg-[#FF5F57]" />
        <span className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
        <span className="w-3 h-3 rounded-full bg-[#28C840]" />
        <span style={{ ...MONO, marginLeft: 8, fontSize: "0.65rem", color: "rgba(255,255,255,0.2)", letterSpacing: "0.08em" }}>
          skopos — chat
        </span>
      </div>

      {/* Chat body */}
      <div
        className="flex flex-col gap-3 px-4 py-4"
        style={{
          minHeight: 148,
          opacity: phase === "clearing" ? 0 : 1,
          transition: phase === "clearing" ? "opacity 320ms ease" : "none",
        }}
      >
        {/* User bubble */}
        {showUser && (
          <div className="chat-reveal-user flex justify-end">
            <div
              style={{
                ...MONO,
                fontSize: "0.76rem",
                background: "rgba(245,184,0,0.07)",
                border: "1px solid rgba(245,184,0,0.16)",
                borderRadius: "14px 14px 4px 14px",
                padding: "9px 14px",
                color: "#ffffff",
                maxWidth: "85%",
                lineHeight: 1.4,
              }}
            >
              {userText}
            </div>
          </div>
        )}

        {/* AI thinking */}
        {showThinking && (
          <div className="chat-reveal flex items-center gap-2">
            <BotIcon />
            <ThinkingDots />
          </div>
        )}

        {/* AI response */}
        {showAi && (
          <div className="chat-reveal flex items-start gap-2">
            <BotIcon />
            <div
              style={{
                ...MONO,
                fontSize: "0.71rem",
                lineHeight: 1.65,
                color: "rgba(255,255,255,0.48)",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: "4px 14px 14px 14px",
                padding: "9px 13px",
              }}
            >
              {aiText.split("\n").map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              {phase === "ai-typing" && (
                <span
                  className="cursor-blink inline-block w-[2px] h-[11px] bg-[#F5B800] align-middle"
                  style={{ marginLeft: 2 }}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BotIcon() {
  return (
    <div
      style={{
        width: 26,
        height: 26,
        borderRadius: 7,
        background: "rgba(245,184,0,0.1)",
        border: "1px solid rgba(245,184,0,0.22)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        marginTop: 2,
        ...MONO,
        fontSize: "0.58rem",
        fontWeight: 700,
        color: "#F5B800",
        letterSpacing: "-0.02em",
      }}
    >
      S
    </div>
  );
}

function ThinkingDots() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "10px 14px",
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: "4px 14px 14px 14px",
      }}
    >
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="thinking-dot"
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.28)",
            animationDelay: `${i * 200}ms`,
          }}
        />
      ))}
    </div>
  );
}
