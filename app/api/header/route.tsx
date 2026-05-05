import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          background: "#000000",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        {/* Dot grid */}
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          backgroundImage: "radial-gradient(circle, rgba(245,184,0,0.08) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }} />

        {/* Center glow */}
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          width: 800, height: 800,
          background: "radial-gradient(circle, rgba(245,184,0,0.07) 0%, transparent 65%)",
          transform: "translate(-50%, -50%)",
          display: "flex",
        }} />

        {/* Icon */}
        <div style={{
          width: 72, height: 72, background: "#F5B800",
          borderRadius: 16, display: "flex",
          alignItems: "center", justifyContent: "center",
          marginBottom: 28, zIndex: 1,
        }}>
          <div style={{
            width: 34, height: 34, background: "#000000",
            transform: "rotate(45deg)", borderRadius: 4, display: "flex",
          }} />
        </div>

        {/* Wordmark */}
        <span style={{
          fontSize: 128, fontWeight: 900, color: "#ffffff",
          letterSpacing: -6, lineHeight: 1, fontFamily: "sans-serif",
          zIndex: 1,
        }}>
          SKOPOS
        </span>

        {/* Tagline */}
        <span style={{
          fontSize: 20, color: "rgba(255,255,255,0.38)",
          fontFamily: "monospace", letterSpacing: 5,
          textTransform: "uppercase", marginTop: 22, zIndex: 1,
        }}>
          cross-chain intent execution
        </span>

        {/* Pills */}
        <div style={{ display: "flex", gap: 10, marginTop: 32, zIndex: 1 }}>
          {["bridge", "swap", "yield", "explore"].map((tag) => (
            <span key={tag} style={{
              fontSize: 15, color: "rgba(245,184,0,0.65)", fontFamily: "monospace",
              letterSpacing: 1, border: "1px solid rgba(245,184,0,0.22)",
              padding: "5px 18px", borderRadius: 4, display: "flex",
            }}>
              {tag}
            </span>
          ))}
        </div>

        {/* URL */}
        <span style={{
          fontSize: 18, color: "#F5B800", letterSpacing: 3,
          fontFamily: "monospace", marginTop: 40, zIndex: 1,
          opacity: 0.8,
        }}>
          tryskopos.xyz
        </span>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
