import { useMemo, useState } from "react";
import type { NumericCandle } from "@/lib/types";

interface Level {
  label: string;
  value: number;
  kind: "entry" | "sl" | "tp";
}

interface Props {
  candles: NumericCandle[];
  entry?: string;
  stopLoss?: string;
  takeProfits?: (string | undefined)[];
  pair: string;
}

const W = 660;
const H = 300;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;
const PAD_LEFT = 8;
// Right margin reserved for the level pills so they never cover candles
const PAD_RIGHT = 86;

const COLORS = {
  up: "hsl(var(--success))",
  down: "hsl(var(--destructive))",
  entry: "hsl(var(--primary))",
  sl: "hsl(var(--destructive))",
  tp: "hsl(var(--success))",
  grid: "hsl(var(--border))",
  text: "hsl(var(--muted-foreground))",
};

const parseLevel = (v: string | undefined): number | null => {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Entry/SL/TP drawn as labeled horizontal lines over the candles, the way a
// trader would mark up the chart (labels carry identity, color is secondary)
const PriceChart = ({ candles, entry, stopLoss, takeProfits = [], pair }: Props) => {
  const [hover, setHover] = useState<number | null>(null);

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
    const pad = (max - min) * 0.06 || max * 0.001 || 1;
    min -= pad;
    max += pad;

    const plotW = W - PAD_LEFT - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const slot = plotW / candles.length;
    const bodyW = Math.max(2, Math.min(9, slot * 0.62));
    const y = (price: number) => PAD_TOP + ((max - price) / (max - min)) * plotH;
    const x = (i: number) => PAD_LEFT + slot * i + slot / 2;

    return { min, max, y, x, slot, bodyW, plotW, plotH };
  }, [candles, levels]);

  if (!geometry || candles.length === 0) return null;

  const { y, x, slot, bodyW } = geometry;
  const hovered = hover !== null ? candles[hover] : null;

  const gridLines = 4;
  const gridPrices = Array.from({ length: gridLines + 1 }, (_, i) =>
    geometry.min + ((geometry.max - geometry.min) * i) / gridLines,
  );

  const levelColor = (kind: Level["kind"]) => COLORS[kind];

  const handleMove = (evt: React.MouseEvent<SVGSVGElement>) => {
    const rect = evt.currentTarget.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    const idx = Math.floor((px - PAD_LEFT) / slot);
    setHover(idx >= 0 && idx < candles.length ? idx : null);
  };

  return (
    <div className="glass rounded-xl border border-border p-3 border-glow">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-semibold text-foreground">プライスチャート</span>
        <span className="text-[10px] text-muted-foreground font-mono">
          {hovered
            ? `O ${hovered.open.toFixed(decimals)} H ${hovered.high.toFixed(decimals)} L ${hovered.low.toFixed(decimals)} C ${hovered.close.toFixed(decimals)}`
            : `${pair} 直近${candles.length}本`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`${pair} のローソク足チャートとトレードプラン水準`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* recessive grid */}
        {gridPrices.map((p, i) => (
          <g key={i}>
            <line
              x1={PAD_LEFT} x2={W - PAD_RIGHT}
              y1={y(p)} y2={y(p)}
              stroke={COLORS.grid} strokeWidth="0.5" opacity="0.5"
            />
            <text
              x={W - PAD_RIGHT + 4} y={y(p) + 3}
              fontSize="9" fill={COLORS.text} fontFamily="monospace"
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

        {/* trade levels: dashed line + right-side pill with text identity */}
        {levels.map((l) => {
          const ly = y(l.value);
          const color = levelColor(l.kind);
          return (
            <g key={`${l.label}-${l.value}`}>
              <line
                x1={PAD_LEFT} x2={W - PAD_RIGHT}
                y1={ly} y2={ly}
                stroke={color} strokeWidth="1.2" strokeDasharray="5 3" opacity="0.9"
              />
              <rect
                x={W - PAD_RIGHT + 2} y={ly - 8}
                width={PAD_RIGHT - 6} height={16} rx="4"
                fill={color} opacity="0.92"
              />
              <text
                x={W - PAD_RIGHT + 6} y={ly + 3}
                fontSize="8.5" fontWeight="700" fontFamily="monospace"
                fill="hsl(var(--background))"
              >
                {l.label} {l.value.toFixed(decimals)}
              </text>
            </g>
          );
        })}

        {/* time axis: first / middle / last labels only */}
        {[0, Math.floor(candles.length / 2), candles.length - 1].map((i) => (
          <text
            key={i}
            x={x(i)} y={H - 8}
            fontSize="8.5" fill={COLORS.text} fontFamily="monospace" textAnchor="middle"
          >
            {candles[i].datetime.slice(5, 16)}
          </text>
        ))}
      </svg>
    </div>
  );
};

export default PriceChart;
