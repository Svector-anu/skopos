"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslations } from "next-intl";

const DEFAULT_KEY     = "skopos-whatsnew-v2";
const TTL_MS          = 3 * 24 * 60 * 60 * 1000;

const DEFAULT_CHANGES = [
  "Ask Skopos anything — bridges, swaps, gas, yields, market odds",
  "Live prediction market odds directly in chat",
  "Responses are 2× faster",
];

interface WhatsNewToastProps {
  storageKey?: string;
  changes?: string[];
}

export function WhatsNewToast({ storageKey = DEFAULT_KEY, changes = DEFAULT_CHANGES }: WhatsNewToastProps) {
  const t = useTranslations("app.whatsNew");
  const [isMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 600 : false
  );
  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === "dismissed") return false;
      if (raw) {
        if (Date.now() - Number(raw) > TTL_MS) { localStorage.removeItem(storageKey); return false; }
        return true;
      }
      localStorage.setItem(storageKey, String(Date.now()));
      return true;
    } catch {
      return false;
    }
  });

  function dismiss() {
    localStorage.setItem(storageKey, "dismissed");
    setVisible(false);
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0,  scale: 1     }}
          exit={{    opacity: 0, y: 16, scale: 0.97  }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          style={{
            position:     "fixed",
            bottom:       isMobile ? 80 : 24,
            right:        isMobile ? 12 : 24,
            left:         isMobile ? 12 : "auto",
            zIndex:       50,
            width:        isMobile ? "auto" : 320,
            background:   "#F5B800",
            borderRadius: 18,
            padding:      "18px 20px",
            boxShadow:    "0 12px 36px rgba(245,184,0,0.22), 0 4px 16px rgba(0,0,0,0.35)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ color: "#000000", fontSize: "0.75rem" }}>✦</span>
              <span style={{ color: "#000000", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>
                {t("title")}
              </span>
            </div>
            <button
              onClick={dismiss}
              style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(0,0,0,0.45)", padding: 2, lineHeight: 1 }}
              aria-label={t("dismiss")}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M1 1l10 10M11 1L1 11" strokeLinecap="round"/>
              </svg>
            </button>
          </div>

          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
            {changes.map((c, i) => (
              <li key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                <span style={{ color: "rgba(0,0,0,0.55)", fontSize: "0.65rem", marginTop: 3, flexShrink: 0 }}>→</span>
                <span style={{ color: "rgba(0,0,0,0.82)", fontSize: "0.78rem", lineHeight: 1.5, fontWeight: 500 }}>{c}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
