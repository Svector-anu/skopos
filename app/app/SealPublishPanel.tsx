"use client";

import { useState } from "react";
import { useSignMessage } from "@privy-io/react-auth";
import { sealPublishMessage, type SealDraft, type SealOrderType } from "@/lib/seal";

// "Share as Seal" — turns an advanced-order quote the creator just built into a
// reusable policy anyone can instantiate with their own wallet and their own
// size. The order is already parsed and priced on screen, so the only things
// asked for are a name and the bounds the creator will let other people size
// within.
//
// Kept in its own file rather than inline in page.tsx. That file is past 6,200
// lines with a single export, and issue #26 exists because of it — a new feature
// should not make the case worse while the extraction is still pending.
//
// Signing is not authorization: anyone may publish. It is because the Seal page
// shows a creator address to strangers, and an address nobody proved is an
// invitation to publish under someone else's name.

const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };

export interface SealSeed {
  side:             "buy" | "sell";
  orderType:        SealOrderType;
  token:            string;
  chain:            string;
  qty:              string;
  priceLevel?:      string;
  triggerType?:     "upper" | "lower";
  durationSeconds?: number;
  twapBucketCount?: number;
  bracket?:         SealDraft["bracket"];
}

function Field({ label, value, onChange, unit }: {
  label: string; value: string; onChange: (v: string) => void; unit?: string;
}) {
  const id = `seal-${label.replace(/\s+/g, "-")}`;
  return (
    <label htmlFor={id} style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 92 }}>
      <span style={{ ...MONO, fontSize: "0.55rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--card-text-faint)" }}>
        {label}{unit ? ` (${unit})` : ""}
      </span>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          ...MONO, fontSize: "0.76rem", padding: "7px 9px", borderRadius: 6, width: "100%",
          background: "var(--card-bg)", color: "var(--card-text)",
          border: "1px solid var(--card-border-faint)",
        }}
      />
    </label>
  );
}

export function SealPublishPanel({ seed, creator }: { seed: SealSeed; creator: string }) {
  const { signMessage } = useSignMessage();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  // Seeded from the order the creator actually built, so the common case is a
  // name and two taps rather than four numbers typed from nothing.
  const [min, setMin] = useState(() => String(Number(seed.qty) / 5 || seed.qty));
  const [max, setMax] = useState(() => String(Number(seed.qty) * 5 || seed.qty));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // qty is the asset being SPENT — dollars on a buy, tokens on a sell. Stated,
  // never implied: it is the field a stranger is most likely to misread.
  const unit = seed.side === "buy" ? "spend" : seed.token.toUpperCase();

  async function publish() {
    setErr(null);
    setBusy(true);
    try {
      const draft: SealDraft = {
        title, creator,
        side: seed.side, orderType: seed.orderType, token: seed.token, chain: seed.chain,
        ...(seed.priceLevel      !== undefined ? { priceLevel:      seed.priceLevel } : {}),
        ...(seed.triggerType     !== undefined ? { triggerType:     seed.triggerType } : {}),
        ...(seed.durationSeconds !== undefined ? { durationSeconds: seed.durationSeconds } : {}),
        ...(seed.twapBucketCount !== undefined ? { twapBucketCount: seed.twapBucketCount } : {}),
        ...(seed.bracket         !== undefined ? { bracket:         seed.bracket } : {}),
        sizing: { min, max, suggested: seed.qty },
      };

      // The same builder the server verifies against, so the bytes cannot drift
      // between what is signed and what is stored.
      const { signature } = await signMessage(
        { message: sealPublishMessage(draft) },
        { address: creator },
      );

      const res = await fetch("/api/seal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, signature }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Couldn't publish this Seal.");
      setUrl(data.url as string);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't publish this Seal.";
      setErr(/user rejected|denied/i.test(msg) ? "Signature declined — nothing was published." : msg);
    } finally {
      setBusy(false);
    }
  }

  if (url) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <span style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(245,184,0,0.9)" }}>
          Seal published
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <code style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {url}
          </code>
          <button
            type="button"
            onClick={() => { void navigator.clipboard.writeText(url); setCopied(true); }}
            style={{ ...MONO, fontSize: "0.62rem", padding: "5px 9px", borderRadius: 5, cursor: "pointer",
              background: "transparent", color: "var(--card-text-dim)", border: "1px solid var(--card-border-faint)" }}
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-faint)", margin: 0, lineHeight: 1.6 }}>
          Anyone who opens this prices it for their own wallet and signs their own order. You
          can&apos;t see, change or cancel what they do — and using it doesn&apos;t use up your Seal.
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ ...MONO, fontSize: "0.66rem", padding: "7px 11px", borderRadius: 6, cursor: "pointer",
          alignSelf: "flex-start", background: "transparent",
          color: "var(--card-text-dim)", border: "1px solid var(--card-border-faint)" }}
      >
        Share as Seal
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <Field label="name" value={title} onChange={setTitle} />
      <div style={{ display: "flex", gap: 8 }}>
        <Field label="min" value={min} onChange={setMin} unit={unit} />
        <Field label="max" value={max} onChange={setMax} unit={unit} />
      </div>
      <p style={{ ...MONO, fontSize: "0.61rem", color: "var(--card-text-faint)", margin: 0, lineHeight: 1.6 }}>
        Others pick their own size inside this range. Your {seed.qty} is the suggested one.
      </p>
      {err && <p style={{ ...MONO, fontSize: "0.64rem", color: "#ff6b6b", margin: 0 }}>{err}</p>}
      <div style={{ display: "flex", gap: 7 }}>
        <button
          type="button"
          disabled={busy || !title.trim()}
          onClick={() => void publish()}
          style={{ ...MONO, fontSize: "0.66rem", padding: "7px 12px", borderRadius: 6,
            cursor: busy || !title.trim() ? "not-allowed" : "pointer",
            background: "rgba(245,184,0,0.1)", color: "rgba(245,184,0,0.9)",
            border: "1px solid rgba(245,184,0,0.45)", opacity: busy || !title.trim() ? 0.5 : 1 }}
        >
          {busy ? "signing…" : "Sign & publish"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{ ...MONO, fontSize: "0.66rem", padding: "7px 12px", borderRadius: 6, cursor: "pointer",
            background: "transparent", color: "var(--card-text-dim)", border: "1px solid var(--card-border-faint)" }}
        >
          cancel
        </button>
      </div>
    </div>
  );
}
