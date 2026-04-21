import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 1500,
          height: 500,
          background: "#000000",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 120px",
          position: "relative",
        }}
      >
        {/* Dot grid */}
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          backgroundImage: "radial-gradient(circle, rgba(245,184,0,0.07) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }} />

        {/* Yellow glow */}
        <div style={{
          position: "absolute", left: -100, top: "50%",
          width: 600, height: 600,
          background: "radial-gradient(circle, rgba(245,184,0,0.08) 0%, transparent 70%)",
          display: "flex",
        }} />

        {/* Left — icon + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 40, zIndex: 1 }}>
          <div style={{
            width: 96, height: 96, background: "#F5B800",
            borderRadius: 20, display: "flex",
            alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <div style={{
              width: 44, height: 44, background: "#000000",
              transform: "rotate(45deg)", borderRadius: 5, display: "flex",
            }} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{
              fontSize: 110, fontWeight: 900, color: "#ffffff",
              letterSpacing: -4, lineHeight: 1, fontFamily: "sans-serif",
            }}>
              SKOPOS
            </span>
            <span style={{
              fontSize: 28, color: "#F5B800", letterSpacing: 3,
              fontFamily: "monospace", fontWeight: 400,
            }}>
              tryskopos.xyz
            </span>
          </div>
        </div>

        {/* Right — tagline + pills */}
        <div style={{
          display: "flex", flexDirection: "column",
          alignItems: "flex-end", gap: 14, zIndex: 1,
        }}>
          <span style={{
            fontSize: 22, color: "rgba(255,255,255,0.35)",
            fontFamily: "monospace", letterSpacing: 2, textTransform: "uppercase",
          }}>
            cross-chain intent execution
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {["bridge", "swap", "yield", "explore"].map((tag) => (
              <span key={tag} style={{
                fontSize: 16, color: "rgba(245,184,0,0.6)", fontFamily: "monospace",
                letterSpacing: 1, border: "1px solid rgba(245,184,0,0.2)",
                padding: "4px 14px", borderRadius: 4, display: "flex",
              }}>
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>
    ),
    { width: 1500, height: 500 }
  );
}
