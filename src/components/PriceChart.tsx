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
  // #115: the scalping indicator's drawing, for the live chart. `positions`:
  // each signal's position as a box — green from entry to target, red from
  // entry to stop — running to the bar that settled it, a dashed line from
  // the entry to where it settled (to the price now while open) with an ×
  // there, and a faint vertical line on the bar it fired on. `sarStyle`: the
  // SAR as dots, as a band reaching away from price by part of the ATR
  // (green under price, red over it), or both.
  positions?: boolean;
  sarStyle?: "dots" | "cloud" | "both";
}

// #104: up to this many signals carry a TP/SL box beside their label, the
// way the reference indicator shows them — the newest first, skipping any
// box that would land on one already drawn. The rest keep the label and say
// their levels on hover. More boxes than this on a phone is a wall.
const LEVEL_BOXES = 3;

// How far past the flagged bar the stop and target segments reach: to the
// bar that settled the signal, or a few bars when nothing has yet.
const OPEN_SEGMENT_BARS = 6;

// #115: how many signals, newest first, get a position box. Each can run
// for 48 bars, so more than this on 120 bars is one wash of colour.
const POSITION_BOXES = 8;
// Bars a signal is followed for before it is called expired — both rules'
// (analyze/rsisar.ts HORIZON_BARS, which the GA-style rule shares)
const SIGNAL_HORIZON_BARS = 48;
// #115: the SAR band's width, in ATR(14) of the candles on screen
const CLOUD_ATR = 1;

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

// Wilder's ATR(14) of the candles given; the first bars, before there are
// 14 ranges, take the mean of those there are
const atrOf = (candles: NumericCandle[], n = 14): number[] => {
  const out: number[] = [];
  let atr = 0;
  candles.forEach((c, i) => {
    const prev = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    atr = i < n ? (atr * i + tr) / (i + 1) : (atr * (n - 1) + tr) / n;
    out.push(atr);
  });
  return out;
};

// Entry/SL/TP drawn as labeled horizontal lines over the candles, the way a
// trader would mark up the chart (labels carry identity, color is secondary)
const PriceChart = ({
  candles, entry, stopLoss, takeProfits = [], pair, markers = [], heading, subtitle,
  overlays = [], band = null, marks = [], lines = [], rsi, sar, sarBelow, gaStyle = "outline", signalLegend,
  positions = false, sarStyle = "dots",
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

  // #115: the SAR band, one piece per run of bars with the SAR on the same
  // side of price, with the ATR that sets its width
  const cloud = useMemo(() => {
    if (sarStyle === "dots" || !sar || !sarBelow || sar.length !== candles.length || sarBelow.length !== candles.length) {
      return { runs: [], atr: [] };
    }
    const runs: Array<{ below: boolean; from: number; to: number }> = [];
    sar.forEach((v, i) => {
      const below = sarBelow[i];
      if (v === null || !Number.isFinite(v) || below === null) return;
      const last = runs[runs.length - 1];
      if (last && last.below === below && last.to === i - 1) last.to = i;
      else runs.push({ below, from: i, to: i });
    });
    return { runs, atr: atrOf(candles) };
  }, [sarStyle, sar, sarBelow, candles]);

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
  // #115: each label is kept inside the plot sideways as well (one on the
  // first or last bars was cut in half), and one that would land on a label
  // already placed is moved a row away from the price, or toward it when
  // the plot's edge is in the way — two signals near a high both pushed to
  // the top edge used to print one label over the other
  const flagLayout: Array<{ top: number; left: number; w: number }> = [];
  for (const f of flags) {
    const c = candles[f.idx];
    const buy = f.side === "BUY";
    const w = f.ga && gaStyle !== "filled" ? gaLabelW : labelW;
    const left = Math.min(Math.max(x(f.idx) - w / 2, PAD_LEFT), W - PAD_RIGHT - w);
    const away = 5 + f.row * (labelH + 2);
    const rawTop = buy ? y(c.low) + away + 4 : y(c.high) - away - 4 - labelH;
    const clampTop = (v: number) => Math.min(Math.max(v, plotTop), plotBottom - labelH);
    const free = (top: number) =>
      !flagLayout.some((o) => left < o.left + o.w + 1 && o.left < left + w + 1 && top < o.top + labelH + 1 && o.top < top + labelH + 1);
    const outward = buy ? 1 : -1;
    const tries = [0, 1, 2, -1, -2, 3, -3].map((k) => clampTop(rawTop + k * outward * (labelH + 2)));
    flagLayout.push({ top: tries.find(free) ?? tries[0], left, w });
  }
  const boxAt = new Map<number, { left: number; top: number }>();
  {
    // #115: the flags' own labels are in the way too — a box pushed against
    // the plot's edge used to cover its own label or a neighbour's
    const placed: Array<{ left: number; top: number; w: number; h: number }> = flagLayout.map((o) => ({ ...o, h: labelH }));
    const gap = 2;
    for (let n = flags.length - 1; n >= 0 && boxAt.size < LEVEL_BOXES; n--) {
      const f = flags[n];
      const first = f.marks[0];
      if (first.target === null || first.stop === null) continue;
      const label = flagLayout[n];
      const clampLeft = (v: number) => Math.min(Math.max(v, PAD_LEFT), W - PAD_RIGHT - boxW);
      const clampTop = (v: number) => Math.min(Math.max(v, plotTop), plotBottom - boxH);
      // beyond the label, away from price; failing that, beside it
      const beside = clampTop(label.top + labelH / 2 - boxH / 2);
      const spots = [
        { left: clampLeft(x(f.idx) - boxW / 2), top: clampTop(f.side === "BUY" ? label.top + labelH + 2 : label.top - 2 - boxH) },
        { left: clampLeft(label.left + label.w + 3), top: beside },
        { left: clampLeft(label.left - 3 - boxW), top: beside },
      ];
      const spot = spots.find(({ left, top }) => !placed.some((b) =>
        left < b.left + b.w + gap && b.left < left + boxW + gap && top < b.top + b.h + gap && b.top < top + boxH + gap));
      if (!spot) continue;
      placed.push({ ...spot, w: boxW, h: boxH });
      boxAt.set(n, spot);
    }
  }

  // #115: the position each of the newest few signals opened, from the bar
  // it fired on to the bar that settled it — the 48th bar when neither level
  // was reached, the newest bar while it is open — and where it ended: the
  // target, the stop (also when one bar reached both), the close it expired
  // at, or the price now
  const lastIdx = candles.length - 1;
  const positionRows = (() => {
    if (!positions) return [];
    const out: Array<{
      key: string; side: "BUY" | "SELL"; outcome: ChartSignalMark["outcome"];
      from: number; to: number; entry: number; stop: number; target: number; exit: number;
    }> = [];
    for (let n = flags.length - 1; n >= 0 && out.length < POSITION_BOXES; n--) {
      const f = flags[n];
      const m = f.marks[0];
      if (m.entry === null || m.stop === null || m.target === null) continue;
      const settled = m.outcome === "win" || m.outcome === "loss" || m.outcome === "ambiguous";
      const to = Math.min(lastIdx, m.outcome === "open"
        ? lastIdx
        : settled && m.bars !== null ? f.idx + m.bars : f.idx + SIGNAL_HORIZON_BARS);
      const exit = m.outcome === "win" ? m.target : settled ? m.stop : candles[to].close;
      out.push({ key: `${f.side}-${f.idx}-${f.ga ? "ga" : "base"}`, side: f.side, outcome: m.outcome, from: f.idx, to, entry: m.entry, stop: m.stop, target: m.target, exit });
    }
    return out.reverse();
  })();
  const exitColor = (o: ChartSignalMark["outcome"]) => (o === "win" ? COLORS.tp : o === "loss" ? COLORS.sl : COLORS.text);

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
      {(positionRows.length > 0 || cloud.runs.length > 0) && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-position-legend">
          {t.chart.positionLegend(positionRows.length > 0, cloud.runs.length > 0)}
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

        {/* #115: the SAR as a band — from the SAR outward, away from
            price — green while it is under price, red while over it */}
        {cloud.runs.length > 0 && sar && (
          <g data-testid="chart-cloud" clipPath={`url(#${clipId})`}>
            {cloud.runs.map((r) => {
              const away = r.below ? -1 : 1;
              // half a bar past each end, so a run of one bar still shows
              const cols: Array<[number, number]> = [[x(r.from) - slot / 2, r.from]];
              for (let i = r.from; i <= r.to; i++) cols.push([x(i), i]);
              cols.push([x(r.to) + slot / 2, r.to]);
              const inner = cols.map(([cx, i]) => `${cx.toFixed(1)},${y(sar[i] as number).toFixed(1)}`);
              const outer = cols.map(([cx, i]) => `${cx.toFixed(1)},${y((sar[i] as number) + away * CLOUD_ATR * cloud.atr[i]).toFixed(1)}`).reverse();
              const color = r.below ? COLORS.up : COLORS.down;
              return (
                <g key={`cloud-${r.from}`} data-side={r.below ? "below" : "above"}>
                  <polygon points={[...inner, ...outer].join(" ")} fill={color} opacity="0.16" />
                  <polyline points={inner.join(" ")} fill="none" stroke={color} strokeWidth="1.1" opacity="0.55" />
                </g>
              );
            })}
          </g>
        )}

        {/* #115: each position, green from entry to target and red from
            entry to stop, with its entry line; and a faint line on the bar
            each signal fired on */}
        {positionRows.map((p) => {
          const x0 = x(p.from);
          const w = Math.max(1, x(p.to) - x0);
          const open = p.outcome === "open";
          return (
            <g key={`pos-${p.key}`} data-testid={`chart-position-${p.side}-${p.outcome}`} clipPath={`url(#${clipId})`}>
              <rect x={x0} y={Math.min(y(p.entry), y(p.target))} width={w} height={Math.abs(y(p.entry) - y(p.target))} fill={COLORS.tp} opacity={open ? 0.24 : 0.16} />
              <rect x={x0} y={Math.min(y(p.entry), y(p.stop))} width={w} height={Math.abs(y(p.entry) - y(p.stop))} fill={COLORS.sl} opacity={open ? 0.24 : 0.16} />
              <line x1={x0} x2={x0 + w} y1={y(p.target)} y2={y(p.target)} stroke={COLORS.tp} strokeWidth="0.8" opacity="0.6" />
              <line x1={x0} x2={x0 + w} y1={y(p.stop)} y2={y(p.stop)} stroke={COLORS.sl} strokeWidth="0.8" opacity="0.6" />
              <line x1={x0} x2={x0 + w} y1={y(p.entry)} y2={y(p.entry)} stroke={COLORS.text} strokeWidth="0.8" opacity="0.7" />
            </g>
          );
        })}
        {positions && flags.map((f) => (
          <line
            key={`sig-${f.side}-${f.idx}-${f.ga ? "ga" : "base"}`}
            data-testid="chart-signal-line"
            x1={x(f.idx)} x2={x(f.idx)}
            y1={PAD_TOP} y2={H - PAD_BOTTOM}
            stroke={f.side === "BUY" ? COLORS.up : COLORS.down}
            strokeWidth="1"
            opacity="0.22"
          />
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

        {/* #115: from the entry to where each position ended (the price
            now while it is open), and an × there: TP, SL, or neither */}
        {positionRows.map((p) => {
          const x0 = x(p.from);
          const x1 = x(p.to);
          const ex = y(p.exit);
          const color = exitColor(p.outcome);
          const s = narrow ? 3 : 3.5;
          // the label on the far side of the × from the entry
          const ty = p.exit >= p.entry ? ex - s - 2 : ex + s + 7;
          return (
            <g key={`exit-${p.key}`} data-testid={`chart-exit-${p.outcome}`} clipPath={`url(#${clipId})`}>
              <line x1={x0} y1={y(p.entry)} x2={x1} y2={ex} stroke={color} strokeWidth="1" strokeDasharray="3 2" opacity="0.8" />
              {p.outcome !== "open" && (
                <>
                  <path d={`M${x1 - s},${ex - s} L${x1 + s},${ex + s} M${x1 - s},${ex + s} L${x1 + s},${ex - s}`} stroke={color} strokeWidth="1.6" />
                  <text x={x1} y={ty} fontSize={narrow ? 6.5 : 7.5} fontWeight="700" fontFamily="monospace" textAnchor="middle" fill={color}>
                    {t.chart.exitMark[p.outcome]}
                  </text>
                </>
              )}
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
        {sar && sar.length === candles.length && sarStyle !== "cloud" && (
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
          const { left, w } = flagLayout[n];
          return (
            <g key={`flag-${f.side}-${f.idx}-${f.ga ? "ga" : "base"}`} data-testid={`chart-signal-${f.side}-${f.outcome}`} data-rule={f.ga ? "gainz" : "rsi_sar"}>
              <title>{f.ga ? `GA ${tip}` : tip}</title>
              {/* the position box draws these levels when there is one */}
              {!positions && segment(first.target, COLORS.tp)}
              {!positions && segment(first.stop, COLORS.sl)}
              <polygon
                points={buy
                  ? `${fx},${pointerTip} ${fx - 3.5},${top} ${fx + 3.5},${top}`
                  : `${fx},${pointerTip} ${fx - 3.5},${top + labelH} ${fx + 3.5},${top + labelH}`}
                fill={color}
                opacity={lost ? 0.55 : 0.95}
              />
              <rect
                x={left}
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
                x={left + w / 2}
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
