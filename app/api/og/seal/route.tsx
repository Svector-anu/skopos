import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { getSeal, getInstantiationCount } from "@/lib/sealStore";
import { contraSymbolForChain, sealPolicyLine } from "@/lib/seal";

export const runtime = "edge";

// The share card for a Seal. Until this existed every Seal link previewed as
// the same generic Skopos banner, so the largest element of a link card carried
// nothing about the policy being shared — which is most of the point of a Seal.
//
// The use count is on the card deliberately. It is the one number that changes
// while the link travels: shared at zero, reposted at fourteen. A preview that
// updates as people act on it is a scoreboard rather than a logo.
//
// Written flat, with no fragments and no child components, because Satori lays
// those out as a row regardless of the parent's flexDirection. Every container
// here declares display:flex explicitly for the same reason — Satori requires
// it on anything with more than one child.

const W = 1200;
const H = 630;
const YELLOW = "#F5B800";
const FAINT = "rgba(255,255,255,0.40)";
const DIM = "rgba(255,255,255,0.66)";

const root: React.CSSProperties = {
  width: W, height: H, display: "flex", flexDirection: "column",
  justifyContent: "space-between", padding: 64,
  background: "#000", color: "#fff", fontFamily: "sans-serif",
};

function wordmark(sub: string) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
        <div
          style={{
            width: 32, height: 32, background: YELLOW, borderRadius: 8,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div style={{ width: 14, height: 14, background: "#000", transform: "rotate(45deg)", borderRadius: 3 }} />
        </div>
        <div style={{ display: "flex", fontSize: 24, fontWeight: 700, letterSpacing: 6, color: YELLOW }}>SEAL</div>
      </div>
      <div style={{ display: "flex", fontSize: 28, color: DIM }}>{sub}</div>
    </div>
  );
}

function render(children: React.ReactNode): ImageResponse {
  return new ImageResponse(<div style={root}>{children}</div>, { width: W, height: H });
}

export async function GET(req: NextRequest): Promise<ImageResponse | Response> {
  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  const read = await getSeal(id);

  // A missing or unreachable Seal still gets a card. A broken preview on a
  // shared link reads as a broken product, so it says what happened instead.
  if (!read.ok) {
    return render([
      wordmark("tryskopos.xyz"),
      <div key="msg" style={{ display: "flex", fontSize: 56, fontWeight: 700, maxWidth: 1000 }}>
        {read.reason === "unavailable" ? "Couldn't load this Seal" : "No Seal with that id"}
      </div>,
      <div key="foot" style={{ display: "flex", fontSize: 24, color: FAINT }}>a portable trading policy</div>,
    ]);
  }

  const p = read.policy;
  const uses = await getInstantiationCount(p.id);
  const contra = contraSymbolForChain(p.chain);
  const unit = p.side === "buy" ? contra : p.token.toUpperCase();
  // The page's sentence ends "— sized by you, in X"; the card says that on its
  // own line below, so the tail is trimmed rather than repeated.
  const line = sealPolicyLine(p, contra).replace(/\s*—\s*sized by you.*$/, "");
  // A bracketed policy on Robinhood Chain runs past 90 characters, which wraps
  // to four lines at the headline size and pushes the footer off the card.
  // Stepped rather than measured: Satori gives no text metrics, so the only
  // honest option is to be conservative about how much can fit.
  const lineSize = line.length > 78 ? 40 : line.length > 52 ? 50 : 62;

  return render([
    wordmark(p.title),

    <div key="policy" style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 1060 }}>
      <div style={{ display: "flex", fontSize: lineSize, fontWeight: 700, lineHeight: 1.15 }}>{line}</div>
      <div style={{ display: "flex", fontSize: 30, color: YELLOW }}>
        you pick your size · {p.sizing.min}–{p.sizing.max} {unit}
      </div>
    </div>,

    <div key="foot" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", width: W - 128 }}>
      <div style={{ display: "flex", fontSize: 27, color: DIM }}>
        {uses === 0 ? "be the first to use it" : `${uses} wallet${uses === 1 ? "" : "s"} used this`}
      </div>
      <div style={{ display: "flex", fontSize: 22, color: FAINT }}>
        your funds · your wallet signs
      </div>
    </div>,
  ]);
}
