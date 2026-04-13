export function HeroTitle() {
  return (
    <div className="text-center leading-none select-none">
      <div
        className="text-white block"
        style={{
          fontFamily: "var(--font-bebas-neue), sans-serif",
          fontSize: "clamp(5rem, 14vw, 10rem)",
          letterSpacing: "0.02em",
          lineHeight: 1,
        }}
      >
        DELORA
      </div>
      <div
        className="block"
        style={{
          fontFamily: "var(--font-bebas-neue), sans-serif",
          fontSize: "clamp(5rem, 14vw, 10rem)",
          letterSpacing: "0.02em",
          lineHeight: 1,
          color: "#F5B800",
        }}
      >
        COPILOT
      </div>
    </div>
  );
}
