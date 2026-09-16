const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };

export default function SealNotFound() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "var(--background)", color: "var(--foreground)" }}>
      <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
        <p style={{ ...MONO, fontSize: "0.6rem", letterSpacing: "0.16em", textTransform: "uppercase", color: "rgba(245,184,0,0.9)", margin: 0 }}>
          Skopos Seal
        </p>
        <h1 style={{ fontSize: "1.2rem", fontWeight: 600, margin: 0 }}>No Seal with that id</h1>
        <p style={{ ...MONO, fontSize: "0.78rem", color: "var(--card-text-dim)", margin: 0, lineHeight: 1.6 }}>
          The link may be mistyped. Seal ids are 12 characters.
        </p>
        <a href="/app" style={{ ...MONO, fontSize: "0.76rem", color: "rgba(245,184,0,0.95)" }}>Open Skopos →</a>
      </div>
    </main>
  );
}
