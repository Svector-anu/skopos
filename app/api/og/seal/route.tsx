import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { getSeal, getInstantiationCount } from "@/lib/sealStore";
import { contraSymbolForChain, sealPolicyLine } from "@/lib/seal";

export const runtime = "edge";

// The share card for a Seal. Until this existed every Seal link rendered the
// same generic Skopos banner, so the largest element of a link preview carried
// nothing about the policy being shared — which is most of the point of a Seal.
//
// The use count is on the card deliberately. It is the one number that changes
// while the link travels: shared at zero, reposted at fourteen. A preview that
// updates as people act on it is the difference between an image and a
// scoreboard.

const W = 1200;
const H = 630;
const YELLOW = "#F5B800";
const FAINT = "rgba(255,255,255,0.42)";
const DIM = "rgba(255,255,255,0.68)";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: W, height: H, display: "flex", flexDirection: "column",
        justifyContent: "space-between", padding: 68,
        background: "#000", color: "#fff", fontFamily: "sans-serif",
      }}
    >
      {children}
    </div>
  );
}

function Wordmark() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div
        style={{
          width: 34, height: 34, background: YELLOW, borderRadius: 8,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <div style={{ width: 15, height: 15, background: "#000", transform: "rotate(45deg)", borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: 6, color: YELLOW }}>SEAL</span>
    </div>
  );
}

function card(children: React.ReactNode): ImageResponse {
  return new ImageResponse(<Shell>{children}</Shell>, { width: W, height: H });
}

export async function GET(req: NextRequest): Promise<ImageResponse | Response> {
  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  const read = await getSeal(id);

  // A missing or unreachable Seal still gets a card. A broken preview on a
  // shared link reads as a broken product, so it says what happened instead.
  if (!read.ok) {
    return card(
      <>
        <Wordmark />
        <span style={{ fontSize: 52, fontWeight: 700 }}>
          {read.reason === "unavailable" ? "Couldn't load this Seal" : "No Seal with that id"}
        </span>
        <span style={{ fontSize: 26, color: FAINT }}>tryskopos.xyz</span>
      </>,
    );
  }

  const p = read.policy;
  const uses = await getInstantiationCount(p.id);
  const contra = contraSymbolForChain(p.chain);
  const unit = p.side === "buy" ? contra : p.token.toUpperCase();
  const line = sealPolicyLine(p, contra).replace(/ — sized by you.*$/, "");

  return card(
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <Wordmark />
        <span style={{ fontSize: 30, color: DIM }}>{p.title}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {/* The policy, at the size the whole card exists to carry. */}
        <span style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.12, maxWidth: 1000 }}>{line}</span>
        <span style={{ fontSize: 32, color: YELLOW }}>
          you pick your size · {p.sizing.min}–{p.sizing.max} {unit}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 28, color: DIM }}>
          {uses === 0
            ? "be the first to use it"
            : `${uses} wallet${uses === 1 ? "" : "s"} used this`}
        </span>
        <span style={{ fontSize: 24, color: FAINT }}>
          your funds · your wallet signs · policy by {p.creator.slice(0, 6)}…{p.creator.slice(-4)}
        </span>
      </div>
    </>,
  );
}
