export function CornerBrackets() {
  const size = 24;
  const thickness = 1.5;
  const color = "rgba(255,255,255,0.1)";
  const style = { position: "fixed" as const, pointerEvents: "none" as const };

  return (
    <>
      {/* Top-left */}
      <div style={{ ...style, top: 24, left: 24 }}>
        <svg width={size} height={size} fill="none">
          <line x1="0" y1={size} x2="0" y2="0" stroke={color} strokeWidth={thickness} />
          <line x1="0" y1="0" x2={size} y2="0" stroke={color} strokeWidth={thickness} />
        </svg>
      </div>
      {/* Top-right */}
      <div style={{ ...style, top: 24, right: 24 }}>
        <svg width={size} height={size} fill="none">
          <line x1={size} y1={size} x2={size} y2="0" stroke={color} strokeWidth={thickness} />
          <line x1={size} y1="0" x2="0" y2="0" stroke={color} strokeWidth={thickness} />
        </svg>
      </div>
      {/* Bottom-left */}
      <div style={{ ...style, bottom: 24, left: 24 }}>
        <svg width={size} height={size} fill="none">
          <line x1="0" y1="0" x2="0" y2={size} stroke={color} strokeWidth={thickness} />
          <line x1="0" y1={size} x2={size} y2={size} stroke={color} strokeWidth={thickness} />
        </svg>
      </div>
      {/* Bottom-right */}
      <div style={{ ...style, bottom: 24, right: 24 }}>
        <svg width={size} height={size} fill="none">
          <line x1={size} y1="0" x2={size} y2={size} stroke={color} strokeWidth={thickness} />
          <line x1={size} y1={size} x2="0" y2={size} stroke={color} strokeWidth={thickness} />
        </svg>
      </div>
    </>
  );
}
