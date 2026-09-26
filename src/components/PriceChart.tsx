import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChartSignalMark, ChartTrendLine, NumericCandle } from "@/lib/types";
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

// A level the judgement rests on, drawn so it can be checked against the
// picture. Two registers, and the difference is the point:
//
//   "computed" — the server measured it from the candles on screen (a
//   confirmed swing, a level a close settled through, the cloud). Solid-ish,
//   labelled with its own number.
//
//   "cited" — the model named it. It may be right; nothing measured it. Drawn
//   dotted and dimmer, so "price is below the cloud" and "a sweep is coming"
//   cannot look alike on the same chart.
export interface ChartOverlay {
  label: string;
  value: number;
  register: "computed" | "cited";
}

export interface ChartBand {
  top: number;
  bottom: number;
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
  overlays?: ChartOverlay[];
  band?: ChartBand | null;
  // #99: the bounce conditions the server counted on these candles, drawn
  // as a flag on the bar they fired on with the stop and target they were
  // settled against, and the lines through the last two swings. A mark
  // whose bar is not among `candles` is not drawn.
  marks?: ChartSignalMark[];
  lines?: ChartTrendLine[];
  // #104: RSI(14) and the Parabolic SAR, one value per candle. The SAR is
  // drawn as dots on the price chart (green under price, red over it), RSI
  // in its own strip under it with its 30 and 70 lines.
  rsi?: Array<number | null>;
  sar?: Array<number | null>;
  sarBelow?: Array<boolean | null>;
  // #114: how the GA-style rule's flags are drawn — outlined beside RSI/SAR
  // (the default), or as the chart's own filled BUY/SELL labels when it is
  // the only rule on it; and the legend to say instead of RSI/SAR's
  gaStyle?: "outline" | "filled";
  signalLegend?: string;
}

// #104: up to this many signals carry a TP/SL box beside their label, the
// way the reference indicator shows them — the newest first, skipping any
// box that would land on one already drawn. The rest keep the label and say
// their levels on hover. More boxes than this on a phone is a wall.
const LEVEL_BOXES = 3;

// How far past the flagged bar the stop and target segments reach: to the
// bar that settled the signal, or a few bars when nothing has yet.
const OPEN_SEGMENT_BARS = 6;

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
const PriceChart = ({
  candles, entry, stopLoss, takeProfits = [], pair, markers = [], heading, subtitle,
  overlays = [], band = null, marks = [], lines = [], rsi, sar, sarBelow, gaStyle = "outline", signalLegend,
}: Props) => {
  const t = useT();
  const clipId = useId();
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

  // Deliberately NOT part of the price domain below. A confirmed swing well
  // above the window would stretch the scale until every candle was a flat
  // line — the overlay would have made the chart worse at the one job it
  // already did. Levels outside the drawn range are counted, not drawn.
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
    // #104: the SAR dots are part of the picture, so they are in the range
    if (sar && sar.length === candles.length) {
      for (const v of sar) {
        if (v === null || !Number.isFinite(v)) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    // #104: signal labels and their TP/SL boxes stand above the highs and
    // hang below the lows, so a chart that has any gets more room at both
    // ends — otherwise a signal at the window's extreme is pushed onto the
    // candles it points at.
    const pad = (max - min) * (marks.length > 0 ? 0.16 : 0.06) || Math.abs(max) * 0.001 || 1;
    min -= pad;
    max += pad;

    const plotW = W - PAD_LEFT - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const slot = plotW / candles.length;
    const bodyW = Math.max(2, Math.min(9, slot * 0.62));
    const y = (price: number) => PAD_TOP + ((max - price) / (max - min)) * plotH;
    const x = (i: number) => PAD_LEFT + slot * i + slot / 2;

    return { min, max, y, x, slot, bodyW };
  }, [candles, levels, W, H, PAD_RIGHT, sar, marks.length]);

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

  // Overlays live on the LEFT edge, never in the right-hand pill lane. The
  // lane belongs to the plan — entry, stop, targets — and adding a dozen
  // market levels to it pushed those labels off-canvas on a phone, which is
  // the one thing a trader must be able to read.
  const drawnOverlays = useMemo(() => {
    if (!geometry) return { rows: [], hidden: 0 };
    const inside = overlays.filter((o) =>
      Number.isFinite(o.value) && o.value >= geometry.min && o.value <= geometry.max);
    return { rows: inside, hidden: overlays.length - inside.length };
  }, [overlays, geometry]);

  // One flag per bar and side. Two conditions firing on the same bar are one
  // flag (the panel lists them both); the flag reads as won if any of them
  // won, lost if any lost, and hollow otherwise.
  const flags = useMemo(() => {
    if (marks.length === 0 || candles.length === 0) return [];
    const at = new Map<number, number>();
    candles.forEach((c, i) => {
      const ms = parseUtcCandleTime(c.datetime);
      if (Number.isFinite(ms)) at.set(ms, i);
    });
    // #112: the GA-style rule's signals get flags of their own, beside the
    // RSI/SAR ones, so the two are never merged into one label
    const groups = new Map<string, { idx: number; side: "BUY" | "SELL"; ga: boolean; marks: ChartSignalMark[] }>();
    for (const m of marks) {
      const idx = at.get(parseUtcCandleTime(m.datetime));
      if (idx === undefined) continue;
      const ga = m.rule === "gainz";
      const k = `${idx}:${m.side}:${ga ? "ga" : "base"}`;
      const g = groups.get(k) ?? { idx, side: m.side, ga, marks: [] };
      g.marks.push(m);
      groups.set(k, g);
    }
    const rows: Record<"BUY" | "SELL", number> = { BUY: 0, SELL: 0 };
    return [...groups.values()]
      .sort((a, b) => a.idx - b.idx)
      .map((g) => {
        const outcome = g.marks.some((m) => m.outcome === "win")
          ? "win"
          : g.marks.some((m) => m.outcome === "loss")
            ? "loss"
            : g.marks[0].outcome;
        // Neighbouring flags on one side alternate rows so their labels do
        // not sit on top of each other
        const row = rows[g.side]++ % 2;
        return { ...g, outcome, row };
      });
  }, [marks, candles]);

  const trendLines = useMemo(() => {
    if (lines.length === 0 || candles.length === 0) return [];
    const at = new Map<number, number>();
    candles.forEach((c, i) => {
      const ms = parseUtcCandleTime(c.datetime);
      if (Number.isFinite(ms)) at.set(ms, i);
    });
    return lines.flatMap((l) => {
      if (l.slope_per_bar === null) return [];
      // Anchor on the older swing when it is on screen, else the newer one;
      // a line whose both swings are off screen is not drawn
      const fromIdx = at.get(parseUtcCandleTime(l.from.datetime));
      const toIdx = at.get(parseUtcCandleTime(l.to.datetime));
      const anchor = fromIdx !== undefined && l.from.price !== null
        ? { idx: fromIdx, price: l.from.price }
        : toIdx !== undefined && l.to.price !== null
          ? { idx: toIdx, price: l.to.price }
          : null;
      if (anchor === null) return [];
      return [{ kind: l.kind, idx: anchor.idx, price: anchor.price, slope: l.slope_per_bar }];
    });
  }, [lines, candles]);

  if (!geometry || candles.length === 0) return null;

  const { y, x, slot, bodyW } = geometry;
  const inDomain = (v: number | null): v is number =>
    v !== null && Number.isFinite(v) && v >= geometry.min && v <= geometry.max;
  const hovered = hover !== null ? candles[hover] : null;

  // #104: where each signal's label goes, and which of them get a TP/SL box.
  // Boxes are handed out newest first, up to LEVEL_BOXES, and a box that
  // would sit on one already placed is not drawn — two signals a few bars
  // apart used to print their levels on top of each other. A flag without a
  // box still names its levels on hover.
  const labelH = narrow ? 12 : 13;
  const labelW = narrow ? 32 : 38;
  const boxW = narrow ? 66 : 78;
  const boxH = narrow ? 20 : 22;
  const plotTop = PAD_TOP + 1;
  const plotBottom = H - PAD_BOTTOM - 1;
  const gaLabelW = narrow ? 44 : 54;
  const flagLayout = flags.map((f) => {
    const c = candles[f.idx];
    const buy = f.side === "BUY";
    const away = 5 + f.row * (labelH + 2);
    const rawTop = buy ? y(c.low) + away + 4 : y(c.high) - away - 4 - labelH;
    return { top: Math.min(Math.max(rawTop, plotTop), plotBottom - labelH) };
  });
  const boxAt = new Map<number, { left: number; top: number }>();
  {
    const placed: Array<{ left: number; top: number }> = [];
    const gap = 2;
    for (let n = flags.length - 1; n >= 0 && boxAt.size < LEVEL_BOXES; n--) {
      const f = flags[n];
      const first = f.marks[0];
      if (first.target === null || first.stop === null) continue;
      const fx = x(f.idx);
      const left = Math.min(Math.max(fx - boxW / 2, PAD_LEFT), W - PAD_RIGHT - boxW);
      const lt = flagLayout[n].top;
      const rawTop = f.side === "BUY" ? lt + labelH + 2 : lt - 2 - boxH;
      const top = Math.min(Math.max(rawTop, plotTop), plotBottom - boxH);
      const clash = placed.some((b) =>
        left < b.left + boxW + gap && b.left < left + boxW + gap && top < b.top + boxH + gap && b.top < top + boxH + gap);
      if (clash) continue;
      placed.push({ left, top });
      boxAt.set(n, { left, top });
    }
  }

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
    <div ref={boxRef} className="glass rounded-xl border border-border p-3">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <span className="text-xs font-semibold text-foreground shrink-0">{heading ?? t.chart.title}</span>
        <span className="text-[10px] text-muted-foreground font-mono truncate text-right">
          {hovered
            ? `O ${hovered.open.toFixed(decimals)} H ${hovered.high.toFixed(decimals)} L ${hovered.low.toFixed(decimals)} C ${hovered.close.toFixed(decimals)}`
            : subtitle ?? t.chart.recentBars(pair, candles.length)}
        </span>
      </div>
      {/* Said once, under the chart, so the two registers can be told apart
          without hovering anything. Only shown when there is something drawn
          in them. */}
      {/* Shown whenever there is anything to say, INCLUDING when every level
          fell outside the visible range — dropping them silently would read
          as "there were none". */}
      {(drawnOverlays.rows.length > 0 || drawnOverlays.hidden > 0 || band) && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-legend">
          {t.chart.legend}
          {drawnOverlays.hidden > 0 ? ` · ${t.chart.hiddenLevels(drawnOverlays.hidden)}` : ""}
        </p>
      )}
      {(flags.length > 0 || trendLines.length > 0 || (sar !== undefined && sar.length === candles.length)) && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-signal-legend">
          {signalLegend ?? t.chart.signalLegend}
        </p>
      )}
      {gaStyle !== "filled" && flags.some((f) => f.ga) && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-gainz-legend">
          {t.chart.gainzLegend}
        </p>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={t.chart.ariaLabel(pair)}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD_LEFT} y={PAD_TOP} width={Math.max(0, W - PAD_RIGHT - PAD_LEFT)} height={Math.max(0, H - PAD_TOP - PAD_BOTTOM)} />
          </clipPath>
        </defs>
        {/* The cloud price is actually inside, as a band rather than a line —
            a zone drawn as a rule reads as a level, which it is not. */}
        {band && Number.isFinite(band.top) && Number.isFinite(band.bottom) && (
          <rect
            x={PAD_LEFT}
            y={Math.min(y(band.top), y(band.bottom))}
            width={Math.max(0, W - PAD_RIGHT - PAD_LEFT)}
            height={Math.abs(y(band.top) - y(band.bottom))}
            fill={COLORS.text}
            opacity="0.09"
          />
        )}

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

        {/* #99: the lines through the last two swings, extended to the right
            edge and clipped to the plot. Labelled at the swing they start
            from, in the same register as the measured levels. */}
        {trendLines.map((l) => {
          const x1 = x(l.idx);
          const last = candles.length - 1;
          const x2 = x(last);
          const y1 = y(l.price);
          const y2 = y(l.price + l.slope * (last - l.idx));
          return (
            <g key={`trend-${l.kind}`} data-testid={`chart-trend-${l.kind}`} clipPath={`url(#${clipId})`} opacity="0.6">
              <line x1={x1} x2={x2} y1={y1} y2={y2} stroke={COLORS.text} strokeWidth="0.9" strokeDasharray="4 2" />
              <text x={x1 + 2} y={y1 + (l.kind === "lows" ? 8 : -3)} fontSize={labelSize - 1} fill={COLORS.text} fontFamily="monospace">
                {t.chart.trend[l.kind]}
              </text>
            </g>
          );
        })}

        {/* #104: the Parabolic SAR, one dot per bar — green under price
            (the buy side), red over it (the sell side). */}
        {sar && sar.length === candles.length && (
          <g data-testid="chart-sar" clipPath={`url(#${clipId})`}>
            {sar.map((v, i) =>
              v !== null && Number.isFinite(v)
                ? (
                  <circle
                    key={`sar-${i}`}
                    cx={x(i)}
                    cy={y(v)}
                    r={narrow ? 1.3 : 1.6}
                    fill={sarBelow?.[i] === false ? COLORS.down : COLORS.up}
                    opacity="0.9"
                  />
                )
                : null
            )}
          </g>
        )}

        {/* One flag per bar the rule fired on (#99 drew bounce conditions
            here; #104 draws the RSI/SAR rule). SELL stands over the high,
            BUY hangs under the low, as a filled label with a pointer; the
            newest few also carry a box with the TP and SL the signal was
            settled against, and the short dotted segments are those same two
            levels, reaching the bar that settled it. */}
        {flags.map((f, n) => {
          const c = candles[f.idx];
          const buy = f.side === "BUY";
          const color = buy ? COLORS.up : COLORS.down;
          const fx = x(f.idx);
          // the label's top edge, kept inside the plot
          const top = flagLayout[n].top;
          const pointerTip = buy ? Math.min(y(c.low) + 1, top) : Math.max(y(c.high) - 1, top + labelH);
          const lost = f.outcome === "loss";
          const first = f.marks[0];
          const reach = Math.min(candles.length - 1, f.idx + Math.max(1, first.bars ?? OPEN_SEGMENT_BARS));
          const segment = (v: number | null, stroke: string) =>
            inDomain(v) && reach > f.idx
              ? <line x1={fx} x2={x(reach)} y1={y(v)} y2={y(v)} stroke={stroke} strokeWidth="0.8" strokeDasharray="2 2" opacity="0.75" />
              : null;
          const tip = f.marks.map((m) => `${m.side} ${m.outcome}${m.entry !== null ? ` @ ${m.entry.toFixed(decimals)}` : ""}${m.target !== null ? ` TP ${m.target.toFixed(decimals)}` : ""}${m.stop !== null ? ` SL ${m.stop.toFixed(decimals)}` : ""}`).join(" / ");
          // the TP/SL box, where one was handed out above
          const box = boxAt.get(n) ?? null;
          const boxed = box !== null;
          const boxLeft = box?.left ?? 0;
          const boxTop = box?.top ?? 0;
          const textSize = narrow ? 7 : 8;
          // #112: a GA-style flag is outlined, not filled, and says GA —
          // unless it is the chart's only rule (#114)
          const outlined = f.ga && gaStyle !== "filled";
          const w = outlined ? gaLabelW : labelW;
          return (
            <g key={`flag-${f.side}-${f.idx}-${f.ga ? "ga" : "base"}`} data-testid={`chart-signal-${f.side}-${f.outcome}`} data-rule={f.ga ? "gainz" : "rsi_sar"}>
              <title>{f.ga ? `GA ${tip}` : tip}</title>
              {segment(first.target, COLORS.tp)}
              {segment(first.stop, COLORS.sl)}
              <polygon
                points={buy
                  ? `${fx},${pointerTip} ${fx - 3.5},${top} ${fx + 3.5},${top}`
                  : `${fx},${pointerTip} ${fx - 3.5},${top + labelH} ${fx + 3.5},${top + labelH}`}
                fill={color}
                opacity={lost ? 0.55 : 0.95}
              />
              <rect
                x={fx - w / 2}
                y={top}
                width={w}
                height={labelH}
                rx="2"
                fill={outlined ? "hsl(var(--background))" : color}
                stroke={outlined ? color : "none"}
                strokeWidth={outlined ? 1 : 0}
                opacity={lost ? 0.55 : 0.95}
              />
              <text
                x={fx}
                y={top + labelH - (narrow ? 3 : 3.5)}
                fontSize={narrow ? 7.5 : 8.5}
                fontWeight="800"
                fontFamily="monospace"
                textAnchor="middle"
                fill={outlined ? color : "hsl(var(--background))"}
              >
                {outlined ? "GA " : ""}{f.side}{t.chart.outcomeMark[f.outcome]}
              </text>
              {boxed && (
                <g data-testid="chart-signal-levels">
                  <rect
                    x={boxLeft}
                    y={boxTop}
                    width={boxW}
                    height={boxH}
                    rx="2"
                    fill="hsl(var(--background))"
                    stroke={COLORS.text}
                    strokeWidth="0.6"
                    opacity="0.92"
                  />
                  <text x={boxLeft + 3} y={boxTop + boxH / 2 - 1.5} fontSize={textSize} fontFamily="monospace" fill={COLORS.tp}>
                    {`TP: ${first.target!.toFixed(decimals)}`}
                  </text>
                  <text x={boxLeft + 3} y={boxTop + boxH - 3} fontSize={textSize} fontFamily="monospace" fill={COLORS.sl}>
                    {`SL: ${first.stop!.toFixed(decimals)}`}
                  </text>
                </g>
              )}
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

        {/* The levels the judgement rests on. Two registers, and the whole
            point is that they do not look alike: a measured swing is drawn
            as a dashed rule with its own number, a level the model merely
            named is dotted, dimmer, and marked. Labels sit on the LEFT so
            they never crowd the plan's lane on the right. */}
        {drawnOverlays.rows.map((o, i) => {
          const oy = y(o.value);
          const computed = o.register === "computed";
          return (
            <g key={`ov-${i}-${o.value}`} opacity={computed ? 0.55 : 0.34}>
              <line
                x1={PAD_LEFT} x2={W - PAD_RIGHT}
                y1={oy} y2={oy}
                stroke={COLORS.text}
                strokeWidth="0.8"
                strokeDasharray={computed ? "5 3" : "1.5 3"}
              />
              <text
                x={PAD_LEFT + 2} y={oy - 2}
                fontSize={labelSize - 0.5} fill={COLORS.text} fontFamily="monospace"
              >
                {computed ? o.label : `${o.label} ${t.chart.citedMark}`}
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
      {/* #104: RSI(14) under the price, on the same x scale so a bar here is
          the bar above it. The 30 and 70 lines are the rule's levels. */}
      {rsi && rsi.length === candles.length && rsi.some((v) => v !== null && Number.isFinite(v)) && (() => {
        const RH = narrow ? 56 : 64;
        const top = 8;
        const bottom = RH - 6;
        const ry = (v: number) => top + ((100 - v) / 100) * (bottom - top);
        let path = "";
        let pen = false;
        rsi.forEach((v, i) => {
          if (v === null || !Number.isFinite(v)) {
            pen = false;
            return;
          }
          path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${ry(v).toFixed(1)} `;
          pen = true;
        });
        const last = [...rsi].reverse().find((v): v is number => v !== null && Number.isFinite(v)) ?? null;
        return (
          <svg
            viewBox={`0 0 ${W} ${RH}`}
            className="w-full h-auto mt-1"
            role="img"
            aria-label={t.chart.rsiLabel}
            data-testid="chart-rsi"
            onMouseMove={handleMove}
            onMouseLeave={() => setHover(null)}
          >
            {[70, 50, 30].map((lv) => (
              <g key={lv}>
                <line
                  x1={PAD_LEFT} x2={W - PAD_RIGHT}
                  y1={ry(lv)} y2={ry(lv)}
                  stroke={lv === 50 ? COLORS.grid : lv === 70 ? COLORS.down : COLORS.up}
                  strokeWidth="0.6"
                  strokeDasharray={lv === 50 ? "2 3" : "4 3"}
                  opacity={lv === 50 ? 0.5 : 0.75}
                />
                <text x={AXIS_X} y={ry(lv) + 3} fontSize={labelSize} fill={COLORS.text} fontFamily="monospace">{lv}</text>
              </g>
            ))}
            {hover !== null && (
              <line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} stroke={COLORS.text} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.7" />
            )}
            <path d={path} fill="none" stroke={COLORS.entry} strokeWidth="1.2" />
            <text x={PAD_LEFT + 2} y={top + 2} fontSize={labelSize} fill={COLORS.text} fontFamily="monospace">
              {`${t.chart.rsiLabel} ${hover !== null && rsi[hover] !== null ? (rsi[hover] as number).toFixed(1) : last === null ? "—" : last.toFixed(1)}`}
            </text>
          </svg>
        );
      })()}
    </div>
  );
};

export default PriceChart;
