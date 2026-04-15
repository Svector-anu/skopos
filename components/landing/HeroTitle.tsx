"use client";

import { useEffect, useRef } from "react";

// ── constants ────────────────────────────────────────────────────────────────
const CHARS       = "AX70BZ91CY80xEFG2H3IJ4KL5MN6OP";
const BASE_OP     = 0.78;   // particles are the primary visual
const ACTIVE_OP   = 1.0;    // peak near cursor
const RADIUS      = 110;    // mouse influence px
const SCATTER     = 32;     // max displacement on hover
const PSIZE       = 12;     // particle character size
const STEP        = 5;      // sample grid (lower = more particles)
const EASE        = 0.1;
const FLOAT_X     = 3;      // ambient drift amplitude x
const FLOAT_Y     = 2;      // ambient drift amplitude y

interface P {
  x: number; y: number;   // current position
  ox: number; oy: number; // rest position
  ch: string;
  op: number;
  sc: number;
  ph: number;             // individual phase offset for ambient drift
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

    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    let alive = true;

    async function build() {
      const w = wrap!.offsetWidth  || 800;
      const h = wrap!.offsetHeight || 160;

      canvas!.width  = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width  = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx.scale(dpr, dpr);

      // Match CSS clamp(5rem, 14vw, 10rem)
      const fontSize = Math.max(80, Math.min(160, window.innerWidth * 0.14));

      // Wait for font before sampling — with a 1s safety fallback
      await Promise.race([
        document.fonts.load(`400 ${Math.round(fontSize)}px "Bebas Neue"`),
        new Promise(r => setTimeout(r, 1000)),
      ]);

      // Draw text invisibly on offscreen canvas, sample filled pixels
      const off    = document.createElement("canvas");
      off.width    = w;
      off.height   = h;
      const offCtx = off.getContext("2d")!;
      offCtx.font         = `400 ${fontSize}px "Bebas Neue", sans-serif`;
      offCtx.fillStyle    = "#fff";
      offCtx.textAlign    = "center";
      offCtx.textBaseline = "middle";
      offCtx.fillText("SKOPOS", w / 2, h / 2);

      const { data } = offCtx.getImageData(0, 0, w, h);
      const ps: P[] = [];

      for (let py = 0; py < h; py += STEP) {
        for (let px = 0; px < w; px += STEP) {
          if (data[(py * w + px) * 4 + 3] > 80) {
            const jx = px + (Math.random() - 0.5) * STEP * 0.6;
            const jy = py + (Math.random() - 0.5) * STEP * 0.6;
            ps.push({
              x: jx, y: jy, ox: jx, oy: jy,
              ch: CHARS[Math.floor(Math.random() * CHARS.length)],
              op: BASE_OP, sc: 1,
              ph: Math.random() * Math.PI * 2,   // random phase per particle
            });
          }
        }
      }
      particles.current = ps;

      // ── render loop ──────────────────────────────────────────────────────
      function tick() {
        if (!alive) return;

        const t  = performance.now();
        ctx.clearRect(0, 0, w, h);

        const { x: mx, y: my } = mouse.current;
        ctx.fillStyle    = "#EAC45A";
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";

        for (const p of particles.current) {
          // Effect 1 — ambient drift: each particle floats around its origin
          // using unique phase so they move independently (looks alive at rest)
          const floatX = p.ox + Math.sin(t * 0.0007 + p.ph)        * FLOAT_X;
          const floatY = p.oy + Math.cos(t * 0.0009 + p.ph * 1.37) * FLOAT_Y;

          // Effect 2 — mouse scatter: repel outward from cursor
          const dx    = p.ox - mx;
          const dy    = p.oy - my;
          const dist2 = dx * dx + dy * dy;

          if (dist2 < RADIUS * RADIUS) {
            const str      = 1 - Math.sqrt(dist2) / RADIUS;
            const angle    = Math.atan2(dy, dx);
            // scatter from the float position (not raw origin)
            const targetX  = floatX + Math.cos(angle) * SCATTER * str;
            const targetY  = floatY + Math.sin(angle) * SCATTER * str;
            p.x  += (targetX - p.x) * EASE * 2.4;
            p.y  += (targetY - p.y) * EASE * 2.4;
            p.op += (BASE_OP + (ACTIVE_OP - BASE_OP) * str - p.op) * EASE * 2;
            p.sc += (1 + 0.55 * str - p.sc) * EASE * 2;
          } else {
            // ease back toward the drifting float position
            p.x  += (floatX - p.x) * EASE;
            p.y  += (floatY - p.y) * EASE;
            p.op += (BASE_OP - p.op) * EASE * 1.6;
            p.sc += (1 - p.sc)       * EASE * 1.6;
          }

          if (p.op < 0.01) continue;

          ctx.globalAlpha = p.op;
          ctx.font        = `${PSIZE * p.sc}px "JetBrains Mono", monospace`;
          ctx.fillText(p.ch, p.x, p.y);
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

    window.addEventListener("mousemove", onMove);
    return () => {
      alive = false;
      cancelAnimationFrame(raf.current);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="text-center leading-none select-none"
      style={{ position: "relative" }}
    >
      {/* Particle canvas — pointer-events off, sits above text */}
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", zIndex: 2 }}
      />
      {/* Base text — always solid and readable */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          fontFamily: "var(--font-bebas-neue), sans-serif",
          fontSize: "clamp(5rem, 14vw, 10rem)",
          letterSpacing: "0.02em",
          lineHeight: 1,
          color: "rgba(234,196,90,0.07)",
        }}
      >
        SKOPOS
      </div>
    </div>
  );
}
