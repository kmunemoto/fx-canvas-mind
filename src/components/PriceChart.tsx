import { useEffect, useMemo, useRef, useState } from "react";
import type { NumericCandle } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { formatCandleLabel, parseUtcCandleTime } from "@/lib/candleTime";

interface Level {
  label: string;
  value: number;
  kind: "entry" | "sl" | "tp";
}

// A moment on the chart worth pointing at: when the plan was made, when the
// entry filled, when it was settled
export interface ChartMarker {
  time: string; // ISO
  kind: "signal" | "fill" | "win" | "loss" | "end";
  label: string;
}

interface Props {
  candles: NumericCandle[];
  entry?: string;
  stopLoss?: string;
  takeProfits?: (string | undefined)[];
  pair: string;
  markers?: ChartMarker[];
  heading?: string;
  subtitle?: string;
}

// The SVG is drawn at one unit per CSS pixel, measured from its own
// container. Drawing at a fixed 660 and letting the browser scale it down
// shrank every label with it: on a 390px phone the price axis rendered at
// about 4.8px, which is not readable. Falling back to 660 keeps server-side
// and jsdom rendering (no ResizeObserver) exactly as it was.
const FALLBACK_W = 660;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;
const PAD_LEFT = 8;
// Two separate right-hand lanes: the price axis, then the level pills. They
// used to share one lane, so a level near a gridline covered its label.
// Narrow screens get narrower lanes so the candles keep some room.
const AXIS_W = 44;
const PILL_W = 84;
const NARROW_AXIS_W = 38;
const NARROW_PILL_W = 70;
const NARROW = 480;

const COLORS = {
  up: "hsl(var(--success))",
  down: "hsl(var(--destructive))",
  entry: "hsl(var(--primary))",
  sl: "hsl(var(--destructive))",
  tp: "hsl(var(--success))",
  grid: "hsl(var(--border))",
  text: "hsl(var(--muted-foreground))",
};

const MARKER_COLORS: Record<ChartMarker["kind"], string> = {
  signal: "hsl(var(--primary))",
  fill: "hsl(var(--warning))",
  win: "hsl(var(--success))",
  loss: "hsl(var(--destructive))",
  end: "hsl(var(--muted-foreground))",
};

const parseLevel = (v: string | undefined): number | null => {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Entry/SL/TP drawn as labeled horizontal lines over the candles, the way a
// trader would mark up the chart (labels carry identity, color is secondary)
const PriceChart = ({ candles, entry, stopLoss, takeProfits = [], pair, markers = [], heading, subtitle }: Props) => {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setMeasured(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const W = measured && measured > 0 ? measured : FALLBACK_W;
  const narrow = W < NARROW;
  // Squarer on a phone, wider on a desktop, so neither wastes the space it
  // has: the ratio is what keeps the candles readable at both ends.
  const H = Math.round(Math.min(300, Math.max(200, W * (narrow ? 0.72 : 0.45))));
  const axisW = narrow ? NARROW_AXIS_W : AXIS_W;
  const pillW = narrow ? NARROW_PILL_W : PILL_W;
  const PAD_RIGHT = axisW + pillW;
  const AXIS_X = W - PAD_RIGHT + 4;
  const PILL_X = W - pillW + 2;
  const labelSize = narrow ? 8 : 9;
  const pillSize = narrow ? 7.5 : 8.5;

  const decimals = pair.toUpperCase().includes("JPY") ? 3 : 5;

  const levels = useMemo<Level[]>(() => {
    const out: Level[] = [];
    const e = parseLevel(entry);
    const s = parseLevel(stopLoss);
    if (e !== null) out.push({ label: "ENTRY", value: e, kind: "entry" });
    if (s !== null) out.push({ label: "SL", value: s, kind: "sl" });
    takeProfits.forEach((tp, i) => {
      const v = parseLevel(tp);
      if (v !== null) out.push({ label: `TP${i + 1}`, value: v, kind: "tp" });
    });
    return out;
  }, [entry, stopLoss, takeProfits]);

  const geometry = useMemo(() => {
    if (candles.length === 0) return null;

    let min = Infinity;
    let max = -Infinity;
    for (const c of candles) {
      min = Math.min(min, c.low);
      max = Math.max(max, c.high);
    }
    for (const l of levels) {
      min = Math.min(min, l.value);
      max = Math.max(max, l.value);
    }
    const pad = (max - min) * 0.06 || Math.abs(max) * 0.001 || 1;
    min -= pad;
    max += pad;

    const plotW = W - PAD_LEFT - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const slot = plotW / candles.length;
    const bodyW = Math.max(2, Math.min(9, slot * 0.62));
    const y = (price: number) => PAD_TOP + ((max - price) / (max - min)) * plotH;
    const x = (i: number) => PAD_LEFT + slot * i + slot / 2;

    return { min, max, y, x, slot, bodyW };
  }, [candles, levels, W, H, PAD_RIGHT]);

  // Pills are anchored to their price, then pushed apart just enough that two
  // nearby levels stay readable instead of stacking on top of each other.
  const pillRows = useMemo(() => {
    if (!geometry) return [];
    const PILL_H = 15;
    const rows = levels
      .map((l) => ({ level: l, y: geometry.y(l.value) }))
      .sort((a, b) => a.y - b.y);

    for (let i = 1; i < rows.length; i++) {
      const minY = rows[i - 1].y + PILL_H;
      if (rows[i].y < minY) rows[i].y = minY;
    }
    const overflow = rows.length > 0 ? rows[rows.length - 1].y - (H - PAD_BOTTOM) : 0;
    if (overflow > 0) {
      for (const r of rows) r.y -= overflow;
    }
    return rows;
  }, [geometry, levels, H]);

  // Each marker sits on the last candle that opened at or before its time;
  // one dated before the first candle is not drawn rather than pinned to it
  const markerCols = useMemo(() => {
    if (markers.length === 0 || candles.length === 0) return [];
    const opens = candles.map((c) => parseUtcCandleTime(c.datetime));
    const firstOpen = opens.find((o) => Number.isFinite(o));
    return markers.flatMap((m, row) => {
      const ms = Date.parse(m.time);
      if (!Number.isFinite(ms) || firstOpen === undefined || ms < firstOpen) return [];
      let idx = 0;
      for (let i = 0; i < opens.length; i++) {
        if (Number.isFinite(opens[i]) && opens[i] <= ms) idx = i;
      }
      return [{ ...m, idx, row }];
    });
  }, [markers, candles]);

  if (!geometry || candles.length === 0) return null;

  const { y, x, slot, bodyW } = geometry;
  const hovered = hover !== null ? candles[hover] : null;

  const gridLines = 4;
  const gridPrices = Array.from({ length: gridLines + 1 }, (_, i) =>
    geometry.min + ((geometry.max - geometry.min) * i) / gridLines,
  );

  const handleMove = (evt: React.MouseEvent<SVGSVGElement>) => {
    const rect = evt.currentTarget.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    const idx = Math.floor((px - PAD_LEFT) / slot);
    setHover(idx >= 0 && idx < candles.length ? idx : null);
  };

  return (
    <div ref={boxRef} className="glass rounded-xl border border-border p-3 border-glow">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <span className="text-xs font-semibold text-foreground shrink-0">{heading ?? t.chart.title}</span>
        <span className="text-[10px] text-muted-foreground font-mono truncate text-right">
          {hovered
            ? `O ${hovered.open.toFixed(decimals)} H ${hovered.high.toFixed(decimals)} L ${hovered.low.toFixed(decimals)} C ${hovered.close.toFixed(decimals)}`
            : subtitle ?? t.chart.recentBars(pair, candles.length)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={t.chart.ariaLabel(pair)}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* recessive grid + price axis */}
        {gridPrices.map((p, i) => (
          <g key={i}>
            <line
              x1={PAD_LEFT} x2={W - PAD_RIGHT}
              y1={y(p)} y2={y(p)}
              stroke={COLORS.grid} strokeWidth="0.5" opacity="0.5"
            />
            <text
              x={AXIS_X} y={y(p) + 3}
              fontSize={labelSize} fill={COLORS.text} fontFamily="monospace"
            >
              {p.toFixed(decimals)}
            </text>
          </g>
        ))}

        {/* crosshair */}
        {hover !== null && (
          <line
            x1={x(hover)} x2={x(hover)}
            y1={PAD_TOP} y2={H - PAD_BOTTOM}
            stroke={COLORS.text} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.7"
          />
        )}

        {/* candles */}
        {candles.map((c, i) => {
          const up = c.close >= c.open;
          const color = up ? COLORS.up : COLORS.down;
          const bodyTop = y(Math.max(c.open, c.close));
          const bodyH = Math.max(1, Math.abs(y(c.open) - y(c.close)));
          return (
            <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" />
              <rect
                x={x(i) - bodyW / 2} y={bodyTop}
                width={bodyW} height={bodyH}
                fill={color} rx="1"
              />
            </g>
          );
        })}

        {/* event markers: vertical rule + label, labels alternate rows */}
        {markerCols.map((m) => {
          const color = MARKER_COLORS[m.kind];
          const mx = x(m.idx);
          const labelY = PAD_TOP + 9 + (m.row % 2) * 11;
          return (
            <g key={`${m.kind}-${m.time}`} data-testid={`chart-marker-${m.kind}`}>
              <line
                x1={mx} x2={mx}
                y1={PAD_TOP} y2={H - PAD_BOTTOM}
                stroke={color} strokeWidth="1" strokeDasharray="3 2" opacity="0.85"
              />
              <text
                x={mx + 3} y={labelY}
                fontSize={pillSize} fontWeight="700" fontFamily="monospace" fill={color}
              >
                {m.label}
              </text>
            </g>
          );
        })}

        {/* trade levels: line at the true price, pill in its own lane */}
        {pillRows.map(({ level, y: pillY }) => {
          const trueY = y(level.value);
          const color = COLORS[level.kind];
          return (
            <g key={`${level.label}-${level.value}`}>
              <line
                x1={PAD_LEFT} x2={W - PAD_RIGHT}
                y1={trueY} y2={trueY}
                stroke={color} strokeWidth="1.2" strokeDasharray="5 3" opacity="0.9"
              />
              {/* connector when the pill had to be nudged off its price */}
              <line
                x1={W - PAD_RIGHT} x2={PILL_X}
                y1={trueY} y2={pillY}
                stroke={color} strokeWidth="0.75" opacity="0.55"
              />
              <rect
                x={PILL_X} y={pillY - 7.5}
                width={pillW - 4} height={15} rx="4"
                fill={color} opacity="0.92"
              />
              <text
                x={PILL_X + 4} y={pillY + 3}
                fontSize={pillSize} fontWeight="700" fontFamily="monospace"
                fill="hsl(var(--background))"
              >
                {level.label} {level.value.toFixed(decimals)}
              </text>
            </g>
          );
        })}

        {/* time axis (JST): first / middle / last labels only. The outer two
            are anchored to the plot edges rather than centred on their
            candle, which would hang half the label off the canvas. */}
        {[0, Math.floor(candles.length / 2), candles.length - 1].map((i, n) => {
          const anchor = n === 0 ? "start" : n === 2 ? "end" : "middle";
          const tx = n === 0 ? PAD_LEFT : n === 2 ? W - PAD_RIGHT : x(i);
          return (
            <text
              key={i}
              x={tx} y={H - 8}
              fontSize={labelSize} fill={COLORS.text} fontFamily="monospace" textAnchor={anchor}
            >
              {formatCandleLabel(candles[i].datetime, t.intlLocale)}
            </text>
          );
        })}
      </svg>
    </div>
  );
};

export default PriceChart;
