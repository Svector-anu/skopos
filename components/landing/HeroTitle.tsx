"use client";

import { useEffect, useRef } from "react";

// ── config ────────────────────────────────────────────────────────────────────
const CHARS = "AX70BZ91CY80xEFG2H3IJ4KL5MN6OP";
const PSIZE  = 11;
const RADIUS = 120;

const FG = {
  step: 4, baseOp: 0.85, peakOp: 1.0,
  scatter: 28, ease: 0.12, floatX: 2.5, floatY: 1.5,
} as const;

const BG = {
  step: 8, baseOp: 0.35, peakOp: 0.55,
  scatter: 6,  ease: 0.04, floatX: 1.0, floatY: 0.6,
} as const;

const INTERIOR_KEEP = 0.12;

interface P {
  x: number; y: number;
  ox: number; oy: number;
  ch: string;
  op: number;
  sc: number;
  ph: number;
  bg: boolean;
}

export function HeroTitle() {
  const wrapRef   = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particles = useRef<P[]>([]);
  const mouse     = useRef({ x: -9999, y: -9999 });
  const raf       = useRef(0);

  useEffect(() => {
    const wrap   = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const ctx     = canvas.getContext("2d")!;
    const dpr     = window.devicePixelRatio || 1;
    const mobile  = window.innerWidth < 768;
    // On mobile: coarser grid → fewer particles → less GPU load
    const fgStep  = mobile ? 7 : FG.step;
    const bgStep  = mobile ? 14 : BG.step;
    let alive = true;

    async function build() {
      const w = wrap!.offsetWidth  || (mobile ? window.innerWidth : 800);
      const h = wrap!.offsetHeight || 160;

      canvas!.width  = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width  = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx.scale(dpr, dpr);

      const fontSize = mobile
        ? Math.max(60, window.innerWidth * 0.185)
        : Math.max(80, Math.min(160, window.innerWidth * 0.14));
      const spacing  = `${Math.round(fontSize * 0.08)}px`;

      await Promise.race([
        document.fonts.load(`700 ${Math.round(fontSize)}px "Source Serif 4"`),
        new Promise(r => setTimeout(r, 1000)),
      ]);

      // ── offscreen pixel sampling ──────────────────────────────────────────
      const off = document.createElement("canvas");
      off.width  = w;
      off.height = h;
      const oCtx = off.getContext("2d")!;
      oCtx.font          = `700 ${fontSize}px "Source Serif 4", serif`;
      oCtx.letterSpacing = spacing;
      oCtx.fillStyle     = "#fff";
      oCtx.textAlign     = "center";
      oCtx.textBaseline  = "middle";
      oCtx.fillText("SKOPOS", w / 2, h / 2);

      const { data } = oCtx.getImageData(0, 0, w, h);
      const textW    = oCtx.measureText("SKOPOS").width;
      const textLeft = w / 2 - textW / 2;

      function alpha(px: number, py: number): number {
        if (px < 0 || px >= w || py < 0 || py >= h) return 0;
        return data[(py * w + px) * 4 + 3];
      }

      function isEdge(px: number, py: number): boolean {
        return alpha(px - 4, py) < 40 || alpha(px + 4, py) < 40 ||
               alpha(px, py - 4) < 40 || alpha(px, py + 4) < 40;
      }

      function letterPhase(px: number): number {
        const idx = Math.max(0, Math.min(5, Math.floor((px - textLeft) / textW * 6)));
        return idx * (Math.PI / 3);
      }

      const ps: P[] = [];

      // FG pass
      for (let py = 0; py < h; py += fgStep) {
        for (let px = 0; px < w; px += fgStep) {
          if (alpha(px, py) <= 80) continue;
          if (!isEdge(px, py) && Math.random() > INTERIOR_KEEP) continue;
          const jx = px + (Math.random() - 0.5) * fgStep * 0.4;
          const jy = py + (Math.random() - 0.5) * fgStep * 0.4;
          ps.push({
            x: jx, y: jy, ox: jx, oy: jy,
            ch: CHARS[Math.floor(Math.random() * CHARS.length)],
            op: FG.baseOp, sc: 1,
            ph: letterPhase(px) + Math.random() * 0.6,
            bg: false,
          });
        }
      }

      // BG pass
      for (let py = 0; py < h; py += bgStep) {
        for (let px = 0; px < w; px += bgStep) {
          if (alpha(px, py) <= 80) continue;
          if (isEdge(px, py)) continue;
          if (Math.random() > 0.45) continue;
          const jx = px + (Math.random() - 0.5) * bgStep * 0.4;
          const jy = py + (Math.random() - 0.5) * bgStep * 0.4;
          ps.push({
            x: jx, y: jy, ox: jx, oy: jy,
            ch: CHARS[Math.floor(Math.random() * CHARS.length)],
            op: BG.baseOp, sc: 1,
            ph: letterPhase(px) + Math.random() * 0.6,
            bg: true,
          });
        }
      }

      particles.current = ps;

      // ── render loop ───────────────────────────────────────────────────────
      function tick() {
        if (!alive) return;
        const t = performance.now();
        ctx.clearRect(0, 0, w, h);

        // Yellow stroke outline
        ctx.save();
        ctx.font          = `700 ${fontSize}px "Source Serif 4", serif`;
        ctx.letterSpacing = spacing;
        ctx.textAlign     = "center";
        ctx.textBaseline  = "middle";
        ctx.strokeStyle   = "#F5B800";
        ctx.lineWidth     = 1.5;
        ctx.globalAlpha   = 0.35;
        ctx.shadowColor   = "#F5B800";
        ctx.shadowBlur    = 24;
        ctx.strokeText("SKOPOS", w / 2, h / 2);
        ctx.restore();

        const { x: mx, y: my } = mouse.current;

        for (const drawBg of [true, false]) {
          ctx.fillStyle    = "#F5B800";
          ctx.textAlign    = "center";
          ctx.textBaseline = "middle";

          for (const p of particles.current) {
            if (p.bg !== drawBg) continue;
            const cfg = p.bg ? BG : FG;

            const spd    = p.bg ? 0.0003 : 0.0006;
            const floatX = p.ox + Math.sin(t * spd       + p.ph) * cfg.floatX;
            const floatY = p.oy + Math.cos(t * spd * 1.4 + p.ph * 1.3) * cfg.floatY;

            // Skip repel physics on mobile — no cursor
            if (!mobile) {
              const dx    = p.ox - mx;
              const dy    = p.oy - my;
              const dist2 = dx * dx + dy * dy;

              if (dist2 < RADIUS * RADIUS) {
                const str   = 1 - Math.sqrt(dist2) / RADIUS;
                const angle = Math.atan2(dy, dx);
                p.x  += (floatX + Math.cos(angle) * cfg.scatter * str - p.x) * cfg.ease * 2.5;
                p.y  += (floatY + Math.sin(angle) * cfg.scatter * str - p.y) * cfg.ease * 2.5;
                p.op += (cfg.baseOp + (cfg.peakOp - cfg.baseOp) * str - p.op) * cfg.ease * 2;
                p.sc += (1 + (p.bg ? 0.15 : 0.45) * str - p.sc) * cfg.ease * 2;
              } else {
                p.x  += (floatX - p.x) * cfg.ease;
                p.y  += (floatY - p.y) * cfg.ease;
                p.op += (cfg.baseOp - p.op) * cfg.ease * 1.5;
                p.sc += (1 - p.sc)           * cfg.ease * 1.5;
              }
            } else {
              // Mobile: pure ambient float only
              p.x  += (floatX - p.x) * cfg.ease;
              p.y  += (floatY - p.y) * cfg.ease;
            }

            if (p.op < 0.01) continue;
            ctx.globalAlpha = p.op;
            ctx.font        = `${PSIZE * p.sc}px "JetBrains Mono", monospace`;
            ctx.fillText(p.ch, p.x, p.y);
          }
        }

        ctx.globalAlpha = 1;
        raf.current = requestAnimationFrame(tick);
      }

      tick();
    }

    build();

    function onMove(e: MouseEvent) {
      const r = wrap!.getBoundingClientRect();
      mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    if (!mobile) window.addEventListener("mousemove", onMove);
    return () => {
      alive = false;
      cancelAnimationFrame(raf.current);
      if (!mobile) window.removeEventListener("mousemove", onMove);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="text-center leading-none select-none"
      style={{ position: "relative", width: "100%" }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", zIndex: 2 }}
      />
      {/* Invisible spacer — gives wrapper its dimensions for canvas sizing */}
      <div
        aria-hidden="true"
        style={{
          fontFamily: "var(--font-display), serif",
          fontWeight: 700,
          fontSize: "clamp(4rem, 18vw, 10rem)",
          letterSpacing: "0.08em",
          lineHeight: 1.1,
          opacity: 0,
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        SKOPOS
      </div>
    </div>
  );
}
