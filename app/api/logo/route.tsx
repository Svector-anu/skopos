import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 180,
          height: 90,
          background: "#000000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 36,
            height: 36,
            background: "#F5B800",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 16,
              height: 16,
              background: "#000000",
              transform: "rotate(45deg)",
              borderRadius: 2,
            }}
          />
        </div>

        {/* Wordmark */}
        <span
          style={{
            color: "#ffffff",
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: 3,
          }}
        >
          SKOPOS
        </span>
      </div>
    ),
    { width: 180, height: 90 }
  );
}
