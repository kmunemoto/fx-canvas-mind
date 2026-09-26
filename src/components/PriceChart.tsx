import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Maximize2, Moon, RotateCcw, Settings2, SlidersHorizontal, Sun, X, ZoomIn, ZoomOut } from "lucide-react";
import type { ChartSignalMark, ChartTrendLine, NumericCandle } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { formatCandleLabel, parseUtcCandleTime } from "@/lib/candleTime";
import { MIN_VISIBLE_BARS, WHEEL_STEP, ZOOM_STEP, panView, visibleRange, zoomView, type ChartView } from "@/lib/chartView";
import { setChartPrefs, useChartPrefs } from "@/lib/chartPrefs";
import { STOCH_DEFAULTS, STOCH_LEVELS, STOCH_MAX, stochastic, type StochParams } from "@/lib/stochastic";

interface Level {
  label: string;
  value: number;
  kind: "entry" | "sl" | "tp";
}

// #118: a button in full screen's bottom bar and the sheet it opens
export interface FullscreenMenu {
  label: string;
  title: string;
  render: (close: () => void) => ReactNode;
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
  // #116: zoom and pan — the ＋/− buttons, a pinch, a drag, the wheel (with
  // Ctrl, or plain in full screen: on the page it scrolls), a double click
  // back to every bar — and full screen. The price scale fits the bars on
  // screen. On unless turned off.
  interactive?: boolean;
  // #118: in full screen, the pair and timeframe buttons at the bottom (as
  // TradingView's app has them) and what their sheets hold — the live chart's
  // pairs and timeframes, so they can be changed without leaving it — and a
  // line under the price (its bid, ask and spread; a new signal)
  fullscreenMenus?: {
    symbol: FullscreenMenu;
    interval: FullscreenMenu;
  };
  fullscreenStatus?: ReactNode;
  // #116: when this changes (another pair or timeframe) the view goes back
  // to the newest bars, at the same zoom
  seriesKey?: string;
  // #116: said in full screen while there are no bars (the next pair
  // loading): full screen stays open through it
  emptyText?: string;
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
// #117: the gap above each strip
const STRIP_GAP = 4;

const COLORS = {
  up: "hsl(var(--success))",
  down: "hsl(var(--destructive))",
  entry: "hsl(var(--primary))",
  sl: "hsl(var(--destructive))",
  tp: "hsl(var(--success))",
  grid: "hsl(var(--border))",
  text: "hsl(var(--muted-foreground))",
  // #117: TradingView's own colours for the stochastic's two lines and band
  stochK: "#2962FF",
  stochD: "#FF6D00",
  stochBand: "#2196F3",
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
  positions = false, sarStyle = "dots", interactive = true, fullscreenMenus, fullscreenStatus, seriesKey, emptyText,
}: Props) => {
  const t = useT();
  const clipId = useId();
  const [hover, setHover] = useState<number | null>(null);
  // #118: where the crosshair's level line is, in the drawing's units
  const [hoverY, setHoverY] = useState<number | null>(null);
  // #116: the element measured — the card, or in full screen the area the
  // chart has — as state, so the observer follows it from one to the other
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<ChartView | null>(null);
  const [full, setFull] = useState(false);
  // #118: the bottom sheet open in full screen, if any
  const [sheet, setSheet] = useState<null | "symbol" | "interval" | "settings">(null);
  const sheetOpen = useRef(false);
  sheetOpen.current = sheet !== null;
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // the pointers down on the chart, and the gesture they started
  const pointers = useRef(new Map<number, number>());
  const gesture = useRef<{ kind: "pan" | "pinch"; view: ChartView | null; x: number; dist: number; at: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (!boxEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      const w = Math.round(r?.width ?? 0);
      if (w > 0) setMeasured({ w, h: Math.round(r?.height ?? 0) });
    });
    observer.observe(boxEl);
    return () => observer.disconnect();
  }, [boxEl]);

  // #116: another pair or timeframe starts at its newest bars
  const lastKey = useRef(seriesKey);
  useEffect(() => {
    if (lastKey.current === seriesKey) return;
    lastKey.current = seriesKey;
    setView((v) => (v ? { ...v, offset: 0 } : v));
    setHover(null);
  }, [seriesKey]);

  // #116: full screen stops the page behind it scrolling, closes on Esc, and
  // asks the browser for its own full screen where it has one (not on an
  // iPhone: there the layer is the full screen)
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Esc closes an open sheet first, then full screen
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (sheetOpen.current) setSheet(null);
      else setFull(false);
    };
    // the browser's full screen ended (Esc, the back gesture): so does ours
    let native = false;
    const onChange = () => {
      if (document.fullscreenElement) native = true;
      else if (native) setFull(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onChange);
    const el = overlayRef.current;
    if (el && typeof el.requestFullscreen === "function" && !document.fullscreenElement) {
      el.requestFullscreen().catch(() => undefined);
    }
    return () => {
      setSheet(null);
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
        document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [full]);

  // #116: the wheel, listened for directly: React's own wheel listener
  // cannot stop the page scrolling. What it does is set on each render.
  const wheel = useRef<(e: WheelEvent) => void>(() => undefined);
  useEffect(() => {
    if (!svgEl) return;
    const onWheel = (e: WheelEvent) => wheel.current(e);
    svgEl.addEventListener("wheel", onWheel, { passive: false });
    return () => svgEl.removeEventListener("wheel", onWheel);
  }, [svgEl]);

  const W = measured && measured.w > 0 ? measured.w : FALLBACK_W;
  const narrow = W < NARROW;
  const hasRsi = !!rsi && rsi.length === candles.length && rsi.some((v) => v !== null && Number.isFinite(v));
  // #117: the strips under the price — RSI when the chart has it, and the
  // stochastic, each as chosen (for every chart, kept in this browser)
  const prefs = useChartPrefs();
  const stoch = useMemo(() => stochastic(candles, prefs.stochParams), [candles, prefs.stochParams]);
  const [stochSettings, setStochSettings] = useState(false);
  const showRsi = hasRsi && prefs.rsi;
  const showStoch = prefs.stoch && stoch.k.some((v) => v !== null);
  const strips = (showRsi ? 1 : 0) + (showStoch ? 1 : 0);
  // In full screen the strips take a share of the height and the price the
  // rest (#118: the switches live in the settings sheet there); on a short
  // screen (a phone on its side) the strips give way first, so all of it fits
  const fitted = full && measured !== null && measured.h > 0;
  let RH = narrow ? 56 : 64;
  // Squarer on a phone, wider on a desktop, so neither wastes the space it
  // has: the ratio is what keeps the candles readable at both ends.
  let H = Math.round(Math.min(300, Math.max(200, W * (narrow ? 0.72 : 0.45))));
  if (fitted) {
    const avail = measured.h;
    RH = Math.min(160, Math.max(44, Math.round(measured.h * 0.22)));
    if (strips > 0) RH = Math.min(RH, Math.max(36, Math.floor((avail - 120) / strips) - STRIP_GAP));
    H = Math.max(100, avail - strips * (RH + STRIP_GAP));
  }
  // #118: larger print in full screen, where it is read at arm's length
  const labelSize = full ? (narrow ? 10.5 : 11.5) : narrow ? 8 : 9;
  const pillSize = full ? (narrow ? 9.5 : 10.5) : narrow ? 7.5 : 8.5;
  const decimals = pair.toUpperCase().includes("JPY") ? 3 : 5;
  // #116: the bars on screen
  const n = candles.length;
  const { from, to } = visibleRange(n, interactive ? view : null);

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

  // The price axis is as wide as its longest price in the print used; the
  // pill lane for the plan's levels only when there are levels (#118: an
  // empty lane was a strip of nothing beside every live chart)
  const priceChars = n > 0 ? Math.max(candles[n - 1].high.toFixed(decimals).length, 6) : 7;
  const axisW = Math.max(narrow ? NARROW_AXIS_W : AXIS_W, Math.ceil(priceChars * labelSize * 0.6 + 8));
  const pillW = levels.length > 0 ? (narrow ? NARROW_PILL_W : PILL_W) : 0;
  const PAD_RIGHT = axisW + pillW;
  const AXIS_X = W - PAD_RIGHT + 4;
  const PILL_X = W - pillW + 2;

  // Deliberately NOT part of the price domain below. A confirmed swing well
  // above the window would stretch the scale until every candle was a flat
  // line — the overlay would have made the chart worse at the one job it
  // already did. Levels outside the drawn range are counted, not drawn.
  const geometry = useMemo(() => {
    if (candles.length === 0) return null;

    // #116: the price scale fits the bars on screen
    let min = Infinity;
    let max = -Infinity;
    for (let i = from; i < to; i++) {
      min = Math.min(min, candles[i].low);
      max = Math.max(max, candles[i].high);
    }
    for (const l of levels) {
      min = Math.min(min, l.value);
      max = Math.max(max, l.value);
    }
    // #104: the SAR dots are part of the picture, so they are in the range
    if (sar && sar.length === candles.length) {
      for (let i = from; i < to; i++) {
        const v = sar[i];
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
    const slot = plotW / (to - from);
    // wider candles when zoomed in, up to a point
    const bodyW = Math.max(2, Math.min(interactive && view ? 18 : 9, slot * 0.62));
    const y = (price: number) => PAD_TOP + ((max - price) / (max - min)) * plotH;
    const x = (i: number) => PAD_LEFT + slot * (i - from) + slot / 2;

    return { min, max, y, x, slot, bodyW, plotW };
  }, [candles, levels, W, H, PAD_RIGHT, sar, marks.length, from, to, interactive, view]);

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

  // #116: whether bar i is on screen, and the bar hovered (or tapped)
  const onScreen = (i: number) => i >= from && i < to;
  const hovered = hover !== null && onScreen(hover) ? candles[hover] : null;
  const count = to - from;
  const zoomed = interactive && view !== null;
  // #118: the chart's background, as chosen
  const themeClass = prefs.theme === "light" ? "chart-light" : "";
  const iconBtn = "p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-30";
  const themeToggle = (
    <button
      type="button"
      onClick={() => setChartPrefs({ theme: prefs.theme === "light" ? "dark" : "light" })}
      aria-label={prefs.theme === "light" ? t.chart.themeDark : t.chart.themeLight}
      title={prefs.theme === "light" ? t.chart.themeDark : t.chart.themeLight}
      data-testid="chart-theme-toggle"
      className={iconBtn}
    >
      {prefs.theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  );
  const zoomButtons = interactive && (
    <>
      <button
        type="button"
        onClick={() => setView((v) => zoomView(n, v, 1 / ZOOM_STEP, 1))}
        disabled={!zoomed}
        aria-label={t.chart.zoomOut}
        title={t.chart.zoomOut}
        data-testid="chart-zoom-out"
        className={iconBtn}
      >
        <ZoomOut className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => setView((v) => zoomView(n, v, ZOOM_STEP, 1))}
        disabled={n === 0 || count <= Math.min(MIN_VISIBLE_BARS, n)}
        aria-label={t.chart.zoomIn}
        title={t.chart.zoomIn}
        data-testid="chart-zoom-in"
        className={iconBtn}
      >
        <ZoomIn className="h-4 w-4" />
      </button>
      {zoomed && (
        <button
          type="button"
          onClick={() => setView(null)}
          aria-label={t.chart.zoomReset}
          title={t.chart.zoomReset}
          data-testid="chart-zoom-reset"
          className={iconBtn}
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      )}
    </>
  );

  // #117: the stochastic's three lengths, and back to TradingView's
  const stochForm = (
    <div className="flex flex-wrap items-end gap-2 rounded border border-border p-2 text-[11px]" data-testid="chart-stoch-form">
      {([
        ["kLength", t.chart.stoch.kLength],
        ["kSmoothing", t.chart.stoch.kSmoothing],
        ["dSmoothing", t.chart.stoch.dSmoothing],
      ] as Array<[keyof StochParams, string]>).map(([key, label]) => (
        <label key={key} className="flex flex-col gap-0.5 text-muted-foreground">
          {label}
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={STOCH_MAX}
            step={1}
            value={prefs.stochParams[key]}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 1) setChartPrefs({ stochParams: { ...prefs.stochParams, [key]: v } });
            }}
            data-testid={`chart-stoch-${key}`}
            className="w-16 rounded border border-border bg-background px-1 py-0.5 font-mono text-foreground"
          />
        </label>
      ))}
      <button
        type="button"
        onClick={() => setChartPrefs({ stochParams: STOCH_DEFAULTS })}
        data-testid="chart-stoch-reset"
        className="px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground"
      >
        {t.chart.stoch.reset}
      </button>
      <p className="w-full text-muted-foreground">{t.chart.stoch.note}</p>
    </div>
  );
  const switchBtn = (on: boolean) =>
    `px-3 py-1.5 rounded-lg border text-sm ${on ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`;

  // #118: full screen as TradingView's app lays it out — the pair, its
  // price and move at the top, the chart and its strips filling the rest,
  // and the pair, timeframe and settings behind buttons at the bottom that
  // open sheets. The card's legends and switches stay in the card.
  const last = n > 0 ? candles[n - 1] : null;
  const prev = n > 1 ? candles[n - 2] : null;
  const move = last && prev ? last.close - prev.close : null;
  const moveColor = move === null || move === 0 ? "hsl(var(--foreground))" : move > 0 ? "hsl(var(--success))" : "hsl(var(--destructive))";
  const signed = (v: number, d: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
  const sheetTitle = sheet === "symbol" ? fullscreenMenus?.symbol.title : sheet === "interval" ? fullscreenMenus?.interval.title : t.chart.settingsTitle;
  const closeSheet = () => setSheet(null);
  const sheetBody = sheet === "symbol"
    ? fullscreenMenus?.symbol.render(closeSheet)
    : sheet === "interval"
      ? fullscreenMenus?.interval.render(closeSheet)
      : sheet === "settings"
        ? (
          <div className="space-y-4" data-testid="chart-settings">
            <section className="space-y-2">
              <h4 className="text-xs text-muted-foreground">{t.chart.indicators}</h4>
              <div className="flex flex-wrap gap-2">
                {hasRsi && (
                  <button type="button" aria-pressed={prefs.rsi} onClick={() => setChartPrefs({ rsi: !prefs.rsi })} data-testid="chart-sheet-rsi" className={switchBtn(prefs.rsi)}>
                    {t.chart.rsiLabel}
                  </button>
                )}
                <button type="button" aria-pressed={prefs.stoch} onClick={() => setChartPrefs({ stoch: !prefs.stoch })} data-testid="chart-sheet-stoch" className={switchBtn(prefs.stoch)}>
                  {t.chart.stoch.name} {prefs.stochParams.kLength} {prefs.stochParams.kSmoothing} {prefs.stochParams.dSmoothing}
                </button>
              </div>
              {stochForm}
            </section>
            <section className="space-y-2">
              <h4 className="text-xs text-muted-foreground">{t.chart.background}</h4>
              <div className="flex gap-2">
                <button type="button" aria-pressed={prefs.theme === "dark"} onClick={() => setChartPrefs({ theme: "dark" })} data-testid="chart-sheet-theme-dark" className={switchBtn(prefs.theme === "dark")}>
                  {t.chart.themeNames.dark}
                </button>
                <button type="button" aria-pressed={prefs.theme === "light"} onClick={() => setChartPrefs({ theme: "light" })} data-testid="chart-sheet-theme-light" className={switchBtn(prefs.theme === "light")}>
                  {t.chart.themeNames.light}
                </button>
              </div>
            </section>
            {interactive && (
              <section className="space-y-2">
                <h4 className="text-xs text-muted-foreground">{t.chart.zoomTitle}</h4>
                <button type="button" onClick={() => { setView(null); closeSheet(); }} disabled={!zoomed} data-testid="chart-sheet-zoom-reset" className={`${switchBtn(false)} disabled:opacity-40`}>
                  {t.chart.zoomReset}
                </button>
                <p className="text-[11px] text-muted-foreground" data-testid="chart-zoom-hint">{t.chart.zoomHint}</p>
              </section>
            )}
          </div>
        )
        : null;

  const fullscreenLayer = (body: ReactNode) => (
    <>
      <div className="glass rounded-xl border border-border p-3 flex items-center justify-between gap-2" data-testid="chart-fullscreen-placeholder">
        <span className="text-xs text-muted-foreground">{t.chart.fullscreenOn}</span>
        <button
          type="button"
          onClick={() => setFull(false)}
          className="px-2 py-0.5 rounded border border-border text-[11px] text-foreground"
        >
          {t.chart.exitFullscreen}
        </button>
      </div>
      {createPortal(
        <div
          ref={overlayRef}
          role="dialog"
          aria-modal="true"
          aria-label={heading ?? t.chart.title}
          data-testid="chart-fullscreen-overlay"
          data-theme={prefs.theme}
          className={`fixed inset-0 z-[100] flex flex-col bg-background text-foreground ${themeClass}`}
          style={{
            paddingTop: "max(0.25rem, env(safe-area-inset-top))",
            paddingBottom: "max(0.25rem, env(safe-area-inset-bottom))",
            paddingLeft: "env(safe-area-inset-left)",
            paddingRight: "env(safe-area-inset-right)",
          }}
        >
          {/* one row where the screen is wide (a phone on its side), wrapping
              where it is not */}
          <div className="flex flex-wrap items-baseline gap-x-3 px-3 pt-1 pb-1" data-testid="chart-fullscreen-header">
            <span className="text-base font-semibold truncate">{heading ?? t.chart.title}</span>
            {zoomed && (
              <span className="text-[11px] text-muted-foreground font-mono" data-testid="chart-zoom-count">{t.chart.zoomShown(count, n)}</span>
            )}
            <div className="font-mono min-h-[1.5rem] basis-full [@media(min-width:640px)]:basis-auto" data-testid="chart-fullscreen-price">
              {hovered ? (
                <span className="text-xs text-muted-foreground">
                  {`O ${hovered.open.toFixed(decimals)} H ${hovered.high.toFixed(decimals)} L ${hovered.low.toFixed(decimals)} C ${hovered.close.toFixed(decimals)}`}
                </span>
              ) : last ? (
                <span className="flex items-baseline gap-2" style={{ color: moveColor }}>
                  <span className="text-lg font-semibold">{last.close.toFixed(decimals)}</span>
                  {move !== null && prev && (
                    <span className="text-xs">
                      {signed(move, decimals)} ({signed((move / prev.close) * 100, 2)}%)
                    </span>
                  )}
                  {move !== null && <span className="text-[10px] text-muted-foreground">{t.chart.vsPrevBar}</span>}
                </span>
              ) : null}
            </div>
            {fullscreenStatus && <div className="text-[11px] space-y-0.5" data-testid="chart-fullscreen-status">{fullscreenStatus}</div>}
          </div>
          {/* scrolls only if something is taller than the screen */}
          <div ref={setBoxEl} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            {body}
          </div>
          <div className="flex items-center gap-1 border-t border-border px-2 pt-1" data-testid="chart-fullscreen-toolbar">
            {fullscreenMenus && (
              <>
                <button
                  type="button"
                  onClick={() => setSheet("symbol")}
                  data-testid="chart-sheet-symbol-open"
                  className="flex items-center gap-0.5 px-2 py-1.5 rounded-lg text-base font-semibold hover:bg-muted/40"
                >
                  {fullscreenMenus.symbol.label}
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
                <button
                  type="button"
                  onClick={() => setSheet("interval")}
                  data-testid="chart-sheet-interval-open"
                  className="flex items-center gap-0.5 px-2 py-1.5 rounded-lg text-base font-semibold hover:bg-muted/40"
                >
                  {fullscreenMenus.interval.label}
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </>
            )}
            <div className="ml-auto flex items-center gap-0.5">
              {zoomButtons}
              <button
                type="button"
                onClick={() => setSheet("settings")}
                aria-label={t.chart.settingsTitle}
                title={t.chart.settingsTitle}
                data-testid="chart-sheet-settings-open"
                className={iconBtn}
              >
                <SlidersHorizontal className="h-4 w-4" />
              </button>
              {themeToggle}
              <button
                type="button"
                onClick={() => setFull(false)}
                aria-label={t.chart.exitFullscreen}
                title={t.chart.exitFullscreen}
                data-testid="chart-fullscreen-close"
                className="ml-1 p-1.5 rounded-lg border border-border text-foreground hover:bg-muted/40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          {sheet && sheetBody && (
            <div className="absolute inset-0 z-10 flex flex-col justify-end" data-testid="chart-sheet">
              <button
                type="button"
                aria-label={t.chart.closeSheet}
                onClick={closeSheet}
                data-testid="chart-sheet-backdrop"
                className="absolute inset-0 bg-black/40"
              />
              <div
                role="dialog"
                aria-label={sheetTitle}
                data-testid={`chart-sheet-${sheet}`}
                className="relative max-h-[80%] overflow-y-auto rounded-t-2xl border-t border-border bg-background px-4 pt-2 shadow-xl"
                style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
              >
                <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/30" />
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-lg font-semibold">{sheetTitle}</h3>
                  <button
                    type="button"
                    onClick={closeSheet}
                    aria-label={t.chart.closeSheet}
                    data-testid="chart-sheet-close"
                    className="p-1.5 rounded-full bg-muted text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {sheetBody}
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );

  if (!geometry || candles.length === 0) {
    if (!full || typeof document === "undefined") return null;
    return fullscreenLayer(
      <p className="px-3 text-sm text-muted-foreground" data-testid="chart-fullscreen-empty">{emptyText ?? ""}</p>,
    );
  }

  const { y, x, slot, bodyW, plotW } = geometry;
  const inDomain = (v: number | null): v is number =>
    v !== null && Number.isFinite(v) && v >= geometry.min && v <= geometry.max;
  // #116: the flags on screen
  const shown = flags.filter((f) => onScreen(f.idx));

  // #104: where each signal's label goes, and which of them get a TP/SL box.
  // Boxes are handed out newest first, up to LEVEL_BOXES, and a box that
  // would sit on one already placed is not drawn — two signals a few bars
  // apart used to print their levels on top of each other. A flag without a
  // box still names its levels on hover.
  // #118: a quarter larger in full screen, with the rest of the print
  const fs = full ? 1.25 : 1;
  const labelH = (narrow ? 12 : 13) * fs;
  const labelW = (narrow ? 32 : 38) * fs;
  const boxW = (narrow ? 66 : 78) * fs;
  const boxH = (narrow ? 20 : 22) * fs;
  const plotTop = PAD_TOP + 1;
  const plotBottom = H - PAD_BOTTOM - 1;
  const gaLabelW = (narrow ? 44 : 54) * fs;
  // #115: each label is kept inside the plot sideways as well (one on the
  // first or last bars was cut in half), and one that would land on a label
  // already placed is moved a row away from the price, or toward it when
  // the plot's edge is in the way — two signals near a high both pushed to
  // the top edge used to print one label over the other
  const flagLayout: Array<{ top: number; left: number; w: number }> = [];
  for (const f of shown) {
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
    for (let n = shown.length - 1; n >= 0 && boxAt.size < LEVEL_BOXES; n--) {
      const f = shown[n];
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
  // at, or the price now. #116: of those reaching onto the screen.
  const lastIdx = candles.length - 1;
  const positionRows = (() => {
    if (!positions) return [];
    const out: Array<{
      key: string; side: "BUY" | "SELL"; outcome: ChartSignalMark["outcome"];
      from: number; to: number; entry: number; stop: number; target: number; exit: number;
    }> = [];
    for (let k = flags.length - 1; k >= 0 && out.length < POSITION_BOXES; k--) {
      const f = flags[k];
      const m = f.marks[0];
      if (m.entry === null || m.stop === null || m.target === null) continue;
      const settled = m.outcome === "win" || m.outcome === "loss" || m.outcome === "ambiguous";
      const end = Math.min(lastIdx, m.outcome === "open"
        ? lastIdx
        : settled && m.bars !== null ? f.idx + m.bars : f.idx + SIGNAL_HORIZON_BARS);
      if (end < from || f.idx >= to) continue;
      const exit = m.outcome === "win" ? m.target : settled ? m.stop : candles[end].close;
      out.push({ key: `${f.side}-${f.idx}-${f.ga ? "ga" : "base"}`, side: f.side, outcome: m.outcome, from: f.idx, to: end, entry: m.entry, stop: m.stop, target: m.target, exit });
    }
    return out.reverse();
  })();
  const exitColor = (o: ChartSignalMark["outcome"]) => (o === "win" ? COLORS.tp : o === "loss" ? COLORS.sl : COLORS.text);

  // #116: a tall chart (full screen) gets a gridline every 70 or so
  const gridLines = Math.min(10, Math.max(4, Math.round((H - PAD_TOP - PAD_BOTTOM) / 70)));
  // #118: as many time labels as fit (at least first, middle and last), each
  // with a faint vertical line; the outer two are anchored to the plot's
  // edges rather than centred on their candle, which would hang half the
  // label off the canvas
  const timeLabelW = 11 * labelSize * 0.6 + 24;
  const timeSlots = Math.min(8, Math.max(3, Math.floor(plotW / timeLabelW)));
  const timeIdx = [...new Set(Array.from({ length: timeSlots }, (_, j) => from + Math.round((j * (count - 1)) / (timeSlots - 1))))];
  const gridPrices = Array.from({ length: gridLines + 1 }, (_, i) =>
    geometry.min + ((geometry.max - geometry.min) * i) / gridLines,
  );

  // A point on the chart, in the drawing's own units, from the screen
  const svgX = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 ? ((clientX - rect.left) / rect.width) * W : 0;
  };
  // how far across the plot a point is, 0 to 1
  const across = (px: number) => Math.min(1, Math.max(0, (px - PAD_LEFT) / plotW));
  const barAt = (px: number) => from + Math.floor((px - PAD_LEFT) / slot);

  const handleMove = (evt: React.MouseEvent<SVGSVGElement>) => {
    const idx = barAt(svgX(evt.clientX, evt.currentTarget));
    setHover(onScreen(idx) ? idx : null);
    setHoverY(null);
  };
  // #118: over the price, the crosshair also has a level: the price there
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const levelAt = (clientY: number, el: Element): number | null => {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const py = ((clientY - rect.top) / rect.height) * H;
    return py >= PAD_TOP && py <= H - PAD_BOTTOM ? py : null;
  };
  const handlePriceMove = (evt: React.MouseEvent<SVGSVGElement>) => {
    handleMove(evt);
    setHoverY(levelAt(evt.clientY, evt.currentTarget));
  };
  const clearHover = () => {
    setHover(null);
    setHoverY(null);
  };

  // #116: one finger (or the mouse) drags the bars sideways, two pinch them.
  // A tap without a drag shows that bar's prices, as hovering does.
  const startGesture = () => {
    const xs = [...pointers.current.values()];
    if (xs.length >= 2) {
      const [a, b] = xs;
      gesture.current = { kind: "pinch", view, x: 0, dist: Math.max(1, Math.abs(a - b)), at: across((a + b) / 2), moved: true };
    } else if (xs.length === 1) {
      gesture.current = { kind: "pan", view, x: xs[0], dist: 0, at: 0, moved: false };
    } else {
      gesture.current = null;
    }
  };
  const onPointerDown = (evt: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive || (evt.pointerType === "mouse" && evt.button !== 0)) return;
    evt.currentTarget.setPointerCapture?.(evt.pointerId);
    pointers.current.set(evt.pointerId, svgX(evt.clientX, evt.currentTarget));
    startGesture();
  };
  const onPointerMove = (evt: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(evt.pointerId)) return;
    pointers.current.set(evt.pointerId, svgX(evt.clientX, evt.currentTarget));
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      const dx = (pointers.current.get(evt.pointerId) ?? g.x) - g.x;
      if (!g.moved && Math.abs(dx) < 4) return;
      g.moved = true;
      if (g.view) setView(panView(n, g.view, dx / slot));
    } else {
      const [a, b] = [...pointers.current.values()];
      if (b === undefined) return;
      setView(zoomView(n, g.view, Math.max(1, Math.abs(a - b)) / g.dist, g.at));
    }
  };
  const onPointerEnd = (evt: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(evt.pointerId)) return;
    const g = gesture.current;
    const px = pointers.current.get(evt.pointerId) ?? 0;
    pointers.current.delete(evt.pointerId);
    if (g?.kind === "pan" && !g.moved && evt.type === "pointerup" && evt.pointerType !== "mouse") {
      const idx = barAt(px);
      setHover(onScreen(idx) ? idx : null);
      setHoverY(levelAt(evt.clientY, evt.currentTarget));
    }
    // the finger left on the glass after a pinch drags from where it is
    startGesture();
  };

  // #116: the wheel zooms about the pointer — in full screen, or with Ctrl
  // (a trackpad's pinch) on the page, where a plain wheel scrolls the page
  wheel.current = (e: WheelEvent) => {
    if (!interactive || !(full || e.ctrlKey) || !svgEl || e.deltaY === 0) return;
    e.preventDefault();
    const at = across(svgX(e.clientX, svgEl));
    setView((v) => zoomView(n, v, e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, at));
  };

  // the card's buttons: zoom, the background, full screen
  const toolbar = (
    <div className="flex items-center gap-0.5 shrink-0" data-testid="chart-toolbar">
      {zoomed && (
        <span className="mr-1 text-[10px] text-muted-foreground font-mono" data-testid="chart-zoom-count">
          {t.chart.zoomShown(count, n)}
        </span>
      )}
      {zoomButtons}
      {themeToggle}
      {interactive && (
        <button
          type="button"
          onClick={() => setFull(true)}
          aria-label={t.chart.fullscreen}
          title={t.chart.fullscreen}
          data-testid="chart-fullscreen"
          className={iconBtn}
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  const header = (
    <div className="flex items-center justify-between gap-2 px-1 pb-2">
      <span className="text-xs font-semibold text-foreground shrink-0">{heading ?? t.chart.title}</span>
      <span className="text-[10px] text-muted-foreground font-mono truncate text-right min-w-0 flex-1">
        {hovered
          ? `O ${hovered.open.toFixed(decimals)} H ${hovered.high.toFixed(decimals)} L ${hovered.low.toFixed(decimals)} C ${hovered.close.toFixed(decimals)}`
          : subtitle ?? t.chart.recentBars(pair, candles.length)}
      </span>
      {toolbar}
    </div>
  );

  const legends = (
    <>
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
    </>
  );

  // An oscillator (0–100) under the price, on the same x scale so a bar
  // here is the bar above it: its lines, its levels, and its reading at the
  // bar hovered or the last one on screen. RSI (#104) and the stochastic (#117).
  const strip = (o: {
    testid: string;
    aria: string;
    label: string;
    lines: Array<{ name: string; values: Array<number | null>; color: string }>;
    levels: Array<{ v: number; color: string; dash: string; opacity: number }>;
    band?: { from: number; to: number; color: string; opacity: number };
  }) => {
    const top = 8;
    const bottom = RH - 6;
    const ry = (v: number) => top + ((100 - Math.min(100, Math.max(0, v))) / 100) * (bottom - top);
    const pathOf = (values: Array<number | null>) => {
      let path = "";
      let pen = false;
      // #116: the bars on screen
      for (let i = from; i < to; i++) {
        const v = values[i];
        if (v === null || v === undefined || !Number.isFinite(v)) {
          pen = false;
          continue;
        }
        path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${ry(v).toFixed(1)} `;
        pen = true;
      }
      return path;
    };
    const readingOf = (values: Array<number | null>) => {
      if (hover !== null && hovered) {
        const v = values[hover];
        return v === null || v === undefined || !Number.isFinite(v) ? null : v;
      }
      return values.slice(from, to).reverse().find((v): v is number => v !== null && Number.isFinite(v)) ?? null;
    };
    return (
      <svg
        viewBox={`0 0 ${W} ${RH}`}
        className="w-full h-auto mt-1"
        role="img"
        aria-label={o.aria}
        data-testid={o.testid}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {o.band && (
          <rect
            x={PAD_LEFT}
            y={ry(o.band.to)}
            width={Math.max(0, W - PAD_RIGHT - PAD_LEFT)}
            height={Math.max(0, ry(o.band.from) - ry(o.band.to))}
            fill={o.band.color}
            opacity={o.band.opacity}
            data-testid={`${o.testid}-band`}
          />
        )}
        {o.levels.map((lv) => (
          <g key={lv.v}>
            <line
              x1={PAD_LEFT} x2={W - PAD_RIGHT}
              y1={ry(lv.v)} y2={ry(lv.v)}
              stroke={lv.color}
              strokeWidth="0.6"
              strokeDasharray={lv.dash}
              opacity={lv.opacity}
            />
            <text x={AXIS_X} y={ry(lv.v) + 3} fontSize={labelSize} fill={COLORS.text} fontFamily="monospace">{lv.v}</text>
          </g>
        ))}
        {hover !== null && hovered && (
          <line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} stroke={COLORS.text} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.7" />
        )}
        {o.lines.map((ln) => (
          <path key={ln.name || "line"} d={pathOf(ln.values)} fill="none" stroke={ln.color} strokeWidth={full ? 1.5 : 1.2} data-line={ln.name || undefined} />
        ))}
        {/* #118: each line's value as a tag on the axis, in its colour, as
            TradingView shows them; two that would overlap are pushed apart */}
        {(() => {
          const tagH = labelSize + 6;
          const tags = o.lines
            .map((ln) => ({ ln, v: readingOf(ln.values) }))
            .filter((g): g is { ln: typeof g.ln; v: number } => g.v !== null)
            .map((g) => ({ ...g, cy: ry(g.v) }))
            .sort((a, b) => a.cy - b.cy);
          for (let i = 1; i < tags.length; i++) {
            if (tags[i].cy - tags[i - 1].cy < tagH) tags[i].cy = tags[i - 1].cy + tagH;
          }
          // kept inside the strip; one pushed past its foot pushes the others up
          const foot = RH - tagH / 2;
          if (tags.length > 0 && tags[tags.length - 1].cy > foot) tags[tags.length - 1].cy = foot;
          for (let i = tags.length - 2; i >= 0; i--) {
            if (tags[i + 1].cy - tags[i].cy < tagH) tags[i].cy = tags[i + 1].cy - tagH;
          }
          for (const g of tags) g.cy = Math.max(g.cy, tagH / 2);
          return tags.map(({ ln, v, cy }) => (
            <g key={`tag-${ln.name || "line"}`} data-testid={`${o.testid}-tag${ln.name ? `-${ln.name.replace("%", "")}` : ""}`}>
              <rect x={W - PAD_RIGHT + 1} y={cy - tagH / 2} width={axisW - 2} height={tagH} rx="2" fill={ln.color} />
              <text x={AXIS_X} y={cy + labelSize * 0.36} fontSize={labelSize} fontWeight="700" fill="#fff" fontFamily="monospace">
                {v.toFixed(2)}
              </text>
            </g>
          ));
        })()}
        <text x={PAD_LEFT + 2} y={top + 2} fontSize={labelSize} fill={COLORS.text} fontFamily="monospace" data-testid={`${o.testid}-reading`}>
          {o.label}
          {o.lines.map((ln) => {
            const v = readingOf(ln.values);
            return (
              <tspan key={ln.name || "line"} fill={ln.name ? ln.color : COLORS.text}>
                {` ${ln.name ? `${ln.name} ` : ""}${v === null ? "—" : v.toFixed(1)}`}
              </tspan>
            );
          })}
        </text>
      </svg>
    );
  };

  const charts = (
    <>
      <svg
        ref={setSvgEl}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto select-none"
        role="img"
        aria-label={t.chart.ariaLabel(pair)}
        onMouseMove={handlePriceMove}
        onMouseLeave={clearHover}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={interactive ? () => setView(null) : undefined}
        // a drag sideways moves the bars, up and down still scrolls the
        // page; in full screen every gesture is the chart's
        style={interactive ? { touchAction: full ? "none" : "pan-y", cursor: zoomed ? "grab" : undefined } : undefined}
        data-testid="chart-price"
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

        {/* recessive grid + price axis (#118: dotted, and a vertical line at
            each time label, as TradingView draws them) */}
        {timeIdx.map((i) => (
          <line
            key={`vgrid-${i}`}
            x1={x(i)} x2={x(i)}
            y1={PAD_TOP} y2={H - PAD_BOTTOM}
            stroke={COLORS.grid} strokeWidth="0.6" strokeDasharray="2 3" opacity="0.8"
          />
        ))}
        {gridPrices.map((p, i) => (
          <g key={i}>
            <line
              x1={PAD_LEFT} x2={W - PAD_RIGHT}
              y1={y(p)} y2={y(p)}
              stroke={COLORS.grid} strokeWidth="0.6" strokeDasharray="2 3" opacity="0.8"
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
        {positions && shown.map((f) => (
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
        {hover !== null && hovered && (
          <line
            x1={x(hover)} x2={x(hover)}
            y1={PAD_TOP} y2={H - PAD_BOTTOM}
            stroke={COLORS.text} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.7"
          />
        )}

        {/* candles — #116: those on screen */}
        <g data-testid="chart-candles">
        {candles.map((c, i) => {
          if (!onScreen(i)) return null;
          const up = c.close >= c.open;
          const color = up ? COLORS.up : COLORS.down;
          const bodyTop = y(Math.max(c.open, c.close));
          const bodyH = Math.max(1, Math.abs(y(c.open) - y(c.close)));
          return (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" />
              <rect
                x={x(i) - bodyW / 2} y={bodyTop}
                width={bodyW} height={bodyH}
                fill={color} rx="1"
              />
            </g>
          );
        })}
        </g>

        {/* #115: from the entry to where each position ended (the price
            now while it is open), and an × there: TP, SL, or neither */}
        {positionRows.map((p) => {
          const x0 = x(p.from);
          const x1 = x(p.to);
          const ex = y(p.exit);
          const color = exitColor(p.outcome);
          const s = (narrow ? 3 : 3.5) * fs;
          // the label on the far side of the × from the entry
          const ty = p.exit >= p.entry ? ex - s - 2 : ex + s + 7 * fs;
          return (
            <g key={`exit-${p.key}`} data-testid={`chart-exit-${p.outcome}`} clipPath={`url(#${clipId})`}>
              <line x1={x0} y1={y(p.entry)} x2={x1} y2={ex} stroke={color} strokeWidth="1" strokeDasharray="3 2" opacity="0.8" />
              {p.outcome !== "open" && (
                <>
                  <path d={`M${x1 - s},${ex - s} L${x1 + s},${ex + s} M${x1 - s},${ex + s} L${x1 + s},${ex - s}`} stroke={color} strokeWidth="1.6" />
                  <text x={x1} y={ty} fontSize={(narrow ? 6.5 : 7.5) * fs} fontWeight="700" fontFamily="monospace" textAnchor="middle" fill={color}>
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
              v !== null && Number.isFinite(v) && onScreen(i)
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
        {shown.map((f, n) => {
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
          const textSize = (narrow ? 7 : 8) * fs;
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
                y={top + labelH - (narrow ? 3 : 3.5) * fs}
                fontSize={(narrow ? 7.5 : 8.5) * fs}
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
          if (!onScreen(m.idx)) return null;
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

        {/* #118: the price now — the newest bar's close — as a dotted line
            across the plot and a tag on the axis, green if that bar is up,
            red if down, as TradingView marks it */}
        {(() => {
          const now = candles[n - 1];
          if (!inDomain(now.close)) return null;
          const color = now.close >= now.open ? COLORS.up : COLORS.down;
          const py = y(now.close);
          const tagH = labelSize + 7;
          return (
            <g data-testid="chart-price-now">
              <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={py} y2={py} stroke={color} strokeWidth="0.8" strokeDasharray="1.5 2.5" opacity="0.9" />
              <rect x={W - PAD_RIGHT + 1} y={py - tagH / 2} width={axisW - 2} height={tagH} rx="2" fill={color} />
              <text x={AXIS_X} y={py + labelSize * 0.36} fontSize={labelSize} fontWeight="700" fill="#fff" fontFamily="monospace">
                {now.close.toFixed(decimals)}
              </text>
            </g>
          );
        })()}

        {/* #118: the crosshair's level: a line and the price there */}
        {hoverY !== null && (() => {
          const price = geometry.max - ((hoverY - PAD_TOP) / plotH) * (geometry.max - geometry.min);
          const tagH = labelSize + 7;
          return (
            <g data-testid="chart-cross-price" pointerEvents="none">
              <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={hoverY} y2={hoverY} stroke={COLORS.text} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.8" />
              <rect x={W - PAD_RIGHT + 1} y={hoverY - tagH / 2} width={axisW - 2} height={tagH} rx="2" fill="hsl(var(--foreground))" />
              <text x={AXIS_X} y={hoverY + labelSize * 0.36} fontSize={labelSize} fill="hsl(var(--background))" fontFamily="monospace">
                {price.toFixed(decimals)}
              </text>
            </g>
          );
        })()}

        {/* time axis (JST) */}
        {timeIdx.map((i, k) => {
          const lastLabel = k === timeIdx.length - 1;
          const anchor = k === 0 ? "start" : lastLabel ? "end" : "middle";
          const tx = k === 0 ? PAD_LEFT : lastLabel ? W - PAD_RIGHT : x(i);
          return (
            <text
              key={i}
              x={tx} y={H - 8}
              fontSize={labelSize} fill={COLORS.text} fontFamily="monospace" textAnchor={anchor}
              data-time-label=""
            >
              {formatCandleLabel(candles[i].datetime, t.intlLocale)}
            </text>
          );
        })}
        {/* #118: the crosshair's bar, on the time axis */}
        {hover !== null && hovered && (() => {
          const label = formatCandleLabel(hovered.datetime, t.intlLocale);
          const w = label.length * labelSize * 0.6 + 10;
          const cx = Math.min(Math.max(x(hover), PAD_LEFT + w / 2), W - PAD_RIGHT - w / 2);
          return (
            <g data-testid="chart-cross-time" pointerEvents="none">
              <rect x={cx - w / 2} y={H - 8 - labelSize - 2} width={w} height={labelSize + 6} rx="2" fill="hsl(var(--foreground))" />
              <text x={cx} y={H - 8} fontSize={labelSize} fill="hsl(var(--background))" fontFamily="monospace" textAnchor="middle">
                {label}
              </text>
            </g>
          );
        })()}
      </svg>
      {/* #117: the strips' switches, and the stochastic's lengths — in the
          card; in full screen they are in the settings sheet (#118) */}
      {!full && (
        <div className="px-1 pt-1 space-y-1" data-testid="chart-indicators">
          <div className="flex flex-wrap items-center gap-1 text-[10px]" role="group" aria-label={t.chart.indicators}>
            <span className="text-muted-foreground mr-0.5">{t.chart.indicators}</span>
            {hasRsi && (
              <button
                type="button"
                aria-pressed={prefs.rsi}
                onClick={() => setChartPrefs({ rsi: !prefs.rsi })}
                data-testid="chart-toggle-rsi"
                className={`px-1.5 py-0.5 rounded border ${prefs.rsi ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
              >
                {t.chart.rsiLabel}
              </button>
            )}
            <button
              type="button"
              aria-pressed={prefs.stoch}
              onClick={() => setChartPrefs({ stoch: !prefs.stoch })}
              title={t.chart.stoch.note}
              data-testid="chart-toggle-stoch"
              className={`px-1.5 py-0.5 rounded border ${prefs.stoch ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
            >
              {t.chart.stoch.name} {prefs.stochParams.kLength} {prefs.stochParams.kSmoothing} {prefs.stochParams.dSmoothing}
            </button>
            <button
              type="button"
              aria-expanded={stochSettings}
              aria-label={t.chart.stoch.settings}
              title={t.chart.stoch.settings}
              onClick={() => setStochSettings((v) => !v)}
              data-testid="chart-stoch-settings"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </div>
          {stochSettings && stochForm}
        </div>
      )}
      {/* #104: RSI(14) under the price, on the same x scale so a bar here is
          the bar above it. The 30 and 70 lines are the rule's levels. */}
      {showRsi && rsi && strip({
        testid: "chart-rsi",
        aria: t.chart.rsiLabel,
        label: t.chart.rsiLabel,
        lines: [{ name: "", values: rsi, color: COLORS.entry }],
        levels: [
          { v: 70, color: COLORS.down, dash: "4 3", opacity: 0.75 },
          { v: 50, color: COLORS.grid, dash: "2 3", opacity: 0.5 },
          { v: 30, color: COLORS.up, dash: "4 3", opacity: 0.75 },
        ],
      })}
      {/* #117: the stochastic, drawn as TradingView draws it — %K blue, %D
          orange, 80/50/20, the band between 20 and 80 shaded */}
      {showStoch && strip({
        testid: "chart-stoch",
        aria: t.chart.stoch.name,
        label: `Stoch ${prefs.stochParams.kLength} ${prefs.stochParams.kSmoothing} ${prefs.stochParams.dSmoothing}`,
        lines: [
          { name: "%K", values: stoch.k, color: COLORS.stochK },
          { name: "%D", values: stoch.d, color: COLORS.stochD },
        ],
        levels: [
          { v: STOCH_LEVELS.upper, color: COLORS.text, dash: "4 3", opacity: 0.8 },
          { v: STOCH_LEVELS.middle, color: COLORS.text, dash: "1.5 3", opacity: 0.45 },
          { v: STOCH_LEVELS.lower, color: COLORS.text, dash: "4 3", opacity: 0.8 },
        ],
        band: { from: STOCH_LEVELS.lower, to: STOCH_LEVELS.upper, color: COLORS.stochBand, opacity: 0.1 },
      })}
    </>
  );

  if (full && typeof document !== "undefined") return fullscreenLayer(charts);

  return (
    <div ref={setBoxEl} className={`glass rounded-xl border border-border p-3 ${themeClass}`} data-theme={prefs.theme}>
      {header}
      {legends}
      {charts}
    </div>
  );
};

export default PriceChart;
