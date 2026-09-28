import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Eye, EyeOff, Info, Lock, Maximize2, Moon, RotateCcw, Settings2, SlidersHorizontal, Sun, X, ZoomIn, ZoomOut } from "lucide-react";
import type { ChartSignalMark, ChartTrendLine, NumericCandle } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { formatCandleLabel, parseUtcCandleTime, priceDecimals } from "@/lib/candleTime";
import { MIN_VISIBLE_BARS, WHEEL_STEP, ZOOM_STEP, panView, visibleRange, zoomView, type ChartView } from "@/lib/chartView";
import { setChartPrefs, useChartPrefs, type ChartOverlays } from "@/lib/chartPrefs";
import { KST_DEFAULTS, kalmanSupertrend } from "@/lib/kalmanSupertrend";
import { ST_DEFAULTS, supertrend } from "@/lib/supertrend";
import { UT_DEFAULTS, utBot } from "@/lib/utBot";
import { fvgCrossfire, starText } from "@/lib/fvgCrossfire";
import { WVP_DEFAULTS, weightedVolumeProfile } from "@/lib/weightedVolumeProfile";
import { ZS_DEFAULTS, zoneShift } from "@/lib/zoneShift";
import { EMA_LINES, emaLine } from "@/lib/emaLines";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "@/lib/qTrend";
import { placeEdgeLabels } from "@/lib/edgeLabels";
import { blsh as blshOf, tripleConfirm } from "@/lib/blsh";
import { GP_DEFAULTS, gainzPro } from "@/lib/gainzPro";
import { STOCH_DEFAULTS, STOCH_LEVELS, STOCH_MAX, stochastic, type StochParams } from "@/lib/stochastic";
import { RSI_SAR_LEVELS } from "@/lib/rsiSar";
import { PCTB_DEFAULTS, PCTB_LEVELS, percentB } from "@/lib/percentB";
import { RCI_DEFAULTS, RCI_LEVELS, rci as rciOf } from "@/lib/rci";
import type { DowTf } from "@/lib/liveChart";

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
  // #104: RSI and the Parabolic SAR, one value per candle. The SAR is
  // drawn as dots on the price chart (green under price, red over it), RSI
  // in its own strip under it with the rule's two levels.
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
  // #119: the newest candle is still forming (the live chart): the
  // SPECTRA-style line marks no turn on it
  formingLast?: boolean;
  // #119: what the signal labels are called in the chart's indicator list
  signalName?: string;
  // #116: when this changes (another pair or timeframe) the view goes back
  // to the newest bars, at the same zoom
  seriesKey?: string;
  // #116: said in full screen while there are no bars (the next pair
  // loading): full screen stays open through it
  emptyText?: string;
  // #124: the closed candles before `candles`, for Zone Shift's 200-bar
  // average (the live chart reads them while it is on). Given, Zone Shift is
  // listed; without it, only on a chart with 200 candles of its own. #131:
  // the Pro-style score and #143: the EMA lines read them too.
  // (#148: with their times, when known, for where Q-Trend starts)
  zoneShiftHistory?: { bars: ReadonlyArray<{ datetime?: string; open: number; high: number; low: number; close: number }> | null; status: "loading" | "ready" | "error" };
  // #129: Dow theory as the live-chart function reads it on 4h, 1h, 15min
  // and 5min — `current` the chart's own timeframe (null when it is not one
  // of them), `higher` those above it. Given, it is listed; drawn: the
  // current one's swings (HH/HL/LH/LL), its 押し安値 or 戻り高値 from its
  // swing to the right edge, ① on a first break and 確定 on the second, and
  // the higher ones' key levels and last high and low as dashed lines.
  dow?: { current: DowTf | null; higher: DowTf[]; status: "loading" | "ready" | "error" };
  // #140: the indicators are a paid feature — locked, they are listed with a
  // lock instead of an eye, never drawn whatever was saved, and a tap on one
  // calls `onLockedIndicator` (the pricing page). The signals and what they
  // are made of (the rule's RSI and SAR, the position boxes) stay free.
  indicatorsLocked?: boolean;
  onLockedIndicator?: () => void;
  // #144: a phone turned on its side opens the chart in full screen (as
  // iSPEED FX's chart turns with the phone), and back upright closes it
  // again if that is how it opened
  landscapeFullscreen?: boolean;
}

// #140: what the lock covers — every indicator added to the chart (#117 on)
const LOCKED_OVERLAYS = ["kalman", "supertrend", "utBot", "fvgProfile", "zoneShift", "dow", "gainzPro", "ema50", "ema200", "qTrend", "qtBlsh"] as const;
const LOCKED_KEYS = new Set<string>([...LOCKED_OVERLAYS, "stoch", "pctB", "rci", "blsh"]);

// #104: up to this many signals carry a TP/SL box beside their label, the
// way the reference indicator shows them — the newest first, skipping any
// box that would land on one already drawn. The rest keep the label and say
// their levels on hover. More boxes than this on a phone is a wall.
const LEVEL_BOXES = 3;
// #131: the bars the Pro-style score needs before its first signal
const GP_MIN_BARS = 2 * GP_DEFAULTS.window + GP_DEFAULTS.emaLength + GP_DEFAULTS.slopeBars;
// #144: how long a finger is held still for the crosshair, and how far the
// price scale stretches or spreads
const LONG_PRESS_MS = 350;
const TOUCH_MOUSE_MS = 800;
const LANDSCAPE_PHONE = "(orientation: landscape) and (pointer: coarse) and (max-height: 540px)";
const PRICE_ZOOM_MIN = 0.25;
const PRICE_ZOOM_MAX = 4;
// #124: no history (one array, so the memo that reads it holds)
const NO_BARS: ReadonlyArray<{ datetime?: string; open: number; high: number; low: number; close: number }> = [];

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
  // #121: FVG Crossfire's own colours
  fvgBull: "#0ecb81",
  fvgBear: "#f6465d",
  // #122: the Weighted Volume Profile's Point Of Control, yellow as in the
  // original (a deeper yellow on the white background, where that one
  // barely shows)
  poc: "#FFEB3B",
  pocLight: "#F2A900",
  // #124: Zone Shift's own colours (Pine's color.lime and color.blue), and
  // its lines in the chart's foreground colour (chart.fg_color)
  zsUp: "#00E676",
  zsDown: "#2962FF",
  zsLine: "hsl(var(--foreground))",
  // #117: TradingView's own colours for the stochastic's two lines and band
  stochK: "#2962FF",
  stochD: "#FF6D00",
  stochBand: "#2196F3",
  // #135: TradingView's colours for Bollinger %b and RCI (its line blue, its
  // average yellow)
  pctB: "#2962FF",
  rci: "#2962FF",
  rciMa: "#FDD835",
  // #145: BLSH as the video colours it — the area green and red, the line
  // yellow and blue
  blshUp: "#16A34A",
  blshDown: "#DC2626",
  blshLineUp: "#FFD600",
  blshLineDown: "#2962FF",
  // the yellow deeper on the white background, as the POC's
  blshLineUpLight: "#F2A900",
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
  formingLast = false, signalName, zoneShiftHistory, dow, indicatorsLocked = false, onLockedIndicator,
  landscapeFullscreen = false,
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
  // #144: besides a drag of the bars and a pinch, the crosshair (a long
  // press, then it follows the finger) and a drag on an axis, as iSPEED FX
  // has them
  const gesture = useRef<{
    kind: "pan" | "pinch" | "cross" | "yzoom" | "xzoom";
    view: ChartView | null;
    x: number;
    y: number;
    dist: number;
    at: number;
    moved: boolean;
    zoom: number;
  } | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // #144: when a finger last touched the chart — the mouse moves a browser
  // sends after a tap are not a mouse, and must not bring the crosshair
  // back that the tap hid
  const touchedAt = useRef(-Infinity);
  // #144: the price scale stretched (over 1) or spread (under 1) by a drag
  // on it, about the middle of the bars on screen; 1 is fitted to them
  const [priceZoom, setPriceZoom] = useState(1);

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
    setPriceZoom(1);
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

  // #144: full screen on its side (a phone: a coarse pointer, and short)
  const fullNow = useRef(full);
  fullNow.current = full;
  const autoFull = useRef(false);
  useEffect(() => {
    if (!landscapeFullscreen || !interactive || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(LANDSCAPE_PHONE);
    const apply = () => {
      if (mq.matches) {
        if (!fullNow.current) {
          autoFull.current = true;
          setFull(true);
        }
      } else if (autoFull.current) {
        autoFull.current = false;
        setFull(false);
      }
    };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, [landscapeFullscreen, interactive]);

  // #144: while the crosshair follows a finger or the price scale is
  // dragged, the page does not scroll under it (on the card a drag up and
  // down otherwise scrolls the page); and no long press outlives the chart
  useEffect(() => {
    if (!svgEl) return;
    const onTouchMove = (e: TouchEvent) => {
      const k = gesture.current?.kind;
      if ((k === "cross" || k === "yzoom") && e.cancelable) e.preventDefault();
    };
    svgEl.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => svgEl.removeEventListener("touchmove", onTouchMove);
  }, [svgEl]);
  useEffect(
    () => () => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
    },
    [],
  );

  const W = measured && measured.w > 0 ? measured.w : FALLBACK_W;
  const narrow = W < NARROW;
  const hasRsi = !!rsi && rsi.length === candles.length && rsi.some((v) => v !== null && Number.isFinite(v));
  // #117: the strips under the price — RSI when the chart has it, and the
  // stochastic, each as chosen (for every chart, kept in this browser)
  const saved = useChartPrefs();
  // #140: while the indicators are locked, every one of them is off here,
  // whatever this browser saved (the saved choice comes back with a plan)
  const prefs = useMemo(() => {
    if (!indicatorsLocked) return saved;
    const overlays = { ...saved.overlays };
    for (const k of LOCKED_OVERLAYS) overlays[k] = false;
    return { ...saved, stoch: false, pctB: false, rci: false, blsh: false, overlays };
  }, [saved, indicatorsLocked]);
  const stoch = useMemo(() => stochastic(candles, prefs.stochParams), [candles, prefs.stochParams]);
  // #135: Bollinger %b and RCI, computed only while switched on
  const pctB = useMemo(() => (prefs.pctB ? percentB(candles) : null), [prefs.pctB, candles]);
  const rciRead = useMemo(() => (prefs.rci ? rciOf(candles) : null), [prefs.rci, candles]);
  // #119: what is drawn over the price, as switched in the chart's list
  const ov = prefs.overlays;
  const hasSar = !!sar && sar.length === candles.length;
  const showSarDots = hasSar && sarStyle !== "cloud" && ov.sarDots;
  const showSarCloud = hasSar && sarStyle !== "dots" && ov.sarCloud;
  const kst = useMemo(
    () => (ov.kalman ? kalmanSupertrend(candles, KST_DEFAULTS, formingLast ? candles.length - 2 : candles.length - 1) : null),
    [ov.kalman, candles, formingLast],
  );
  // #136: SuperTrend, on the closed candles
  const st = useMemo(
    () => (ov.supertrend ? supertrend(candles, ST_DEFAULTS, formingLast ? candles.length - 2 : candles.length - 1) : null),
    [ov.supertrend, candles, formingLast],
  );
  // #137: UT Bot Alerts, on the closed candles
  const ut = useMemo(
    () => (ov.utBot ? utBot(candles, UT_DEFAULTS, formingLast ? candles.length - 2 : candles.length - 1) : null),
    [ov.utBot, candles, formingLast],
  );
  // #121: FVG Crossfire, on the closed candles, and #122: the Weighted
  // Volume Profile of the newest candles — the forming one too, as the
  // original recomputes on the chart's last bar. #123: one indicator, on
  // one switch.
  const fvgcf = useMemo(
    () => (ov.fvgProfile ? fvgCrossfire(candles, formingLast ? candles.length - 2 : candles.length - 1) : null),
    [ov.fvgProfile, candles, formingLast],
  );
  const vp = useMemo(() => (ov.fvgProfile ? weightedVolumeProfile(candles) : null), [ov.fvgProfile, candles]);
  // #124: Zone Shift, over the history before the chart's candles and the
  // candles themselves; `zsOff` is where the chart's first candle is in it.
  // While the history is not there, nothing is drawn (the candles alone
  // are too few for its 200-bar average, and every candle would be blue).
  const zsListed = zoneShiftHistory !== undefined || candles.length >= ZS_DEFAULTS.rangeLength;
  const zsPast = zoneShiftHistory ? zoneShiftHistory.bars : NO_BARS;
  const zs = useMemo(() => {
    if (!ov.zoneShift || !zsListed || candles.length === 0 || zsPast === null) return null;
    const all = zsPast.length > 0 ? [...zsPast, ...candles] : candles;
    return { ...zoneShift(all, formingLast ? all.length - 2 : all.length - 1), off: zsPast.length, total: all.length };
  }, [ov.zoneShift, zsListed, zsPast, candles, formingLast]);
  // #131: the Pro-style score's signals, over the same history as Zone Shift
  // (each part and the score are ranked against `window` bars each, so its first
  // signal needs about 2 windows and the EMA); listed where Zone Shift is
  const gpListed = zoneShiftHistory !== undefined || candles.length >= GP_MIN_BARS;
  const gp = useMemo(() => {
    if (!ov.gainzPro || !gpListed || candles.length === 0 || zsPast === null) return null;
    const all = zsPast.length > 0 ? [...zsPast, ...candles] : candles;
    const read = gainzPro(all, GP_DEFAULTS, formingLast ? all.length - 2 : all.length - 1);
    return { signals: read.signals.map((sg) => ({ ...sg, i: sg.i - zsPast.length })).filter((sg) => sg.i >= 0), total: all.length };
  }, [ov.gainzPro, gpListed, zsPast, candles, formingLast]);
  // #143: EMA 50 and EMA 200 over the same history and the candles, the
  // forming one too (as TradingView draws them). Given a history that is
  // still loading, nothing yet: the line would move when it came.
  const emaOn = EMA_LINES.filter((l) => ov[l.key]).map((l) => l.key).join(" ");
  const emas = useMemo(() => {
    const on = EMA_LINES.filter((l) => emaOn.split(" ").includes(l.key));
    if (on.length === 0 || candles.length === 0 || zsPast === null) return null;
    const closes = [...zsPast.map((b) => b.close), ...candles.map((c) => c.close)];
    return { off: zsPast.length, total: closes.length, lines: on.map((l) => ({ ...l, values: emaLine(closes, l.length) })) };
  }, [emaOn, zsPast, candles]);
  // #145: Q-Trend and BLSH over the same history and the candles (Q-Trend's
  // line needs 200 closes before its first); the triple confirmation needs
  // both, whichever of them is drawn
  const qtNeeded = ov.qTrend || ov.qtBlsh;
  const blshNeeded = prefs.blsh || ov.qtBlsh;
  // #148: both computed from a fixed time (anchoredStart), not from the
  // first bar read, so the chart opened again draws the same labels
  const qtFrom = useMemo(() => {
    if (!(qtNeeded || blshNeeded) || candles.length === 0 || zsPast === null) return 0;
    const times = (bars: ReadonlyArray<{ datetime?: string }>) => bars.map((c) => parseUtcCandleTime(c.datetime ?? ""));
    return anchoredStart([...times(zsPast), ...times(candles)], barStepMs(times(candles)), zsPast.length);
  }, [qtNeeded, blshNeeded, zsPast, candles]);
  const qt = useMemo(() => {
    if (!qtNeeded || candles.length === 0 || zsPast === null) return null;
    const all = (zsPast.length > 0 ? [...zsPast, ...candles] : candles).slice(qtFrom);
    const r = qTrend(all, QT_DEFAULTS, formingLast ? all.length - 2 : all.length - 1);
    const off = zsPast.length - qtFrom;
    return {
      whole: r,
      off,
      line: r.line.slice(off),
      trend: r.trend.slice(off),
      signals: r.signals.map((sg) => ({ ...sg, i: sg.i - off })).filter((sg) => sg.i >= 0),
    };
  }, [qtNeeded, zsPast, candles, formingLast, qtFrom]);
  const blshRead = useMemo(() => {
    if (!blshNeeded || candles.length === 0 || zsPast === null) return null;
    const all = (zsPast.length > 0 ? [...zsPast, ...candles] : candles).slice(qtFrom);
    const r = blshOf(all);
    const off = zsPast.length - qtFrom;
    return { whole: r, off, composite: r.composite.slice(off), line: r.line.slice(off), lineUp: r.lineUp.slice(off) };
  }, [blshNeeded, zsPast, candles, qtFrom]);
  const triple = useMemo(() => {
    if (!ov.qtBlsh || !qt || !blshRead) return null;
    const last = qt.whole.line.length - 1 - (formingLast ? 1 : 0);
    return tripleConfirm(qt.whole.trend, blshRead.whole, last)
      .map((sg) => ({ ...sg, i: sg.i - qt.off }))
      .filter((sg) => sg.i >= 0);
  }, [ov.qtBlsh, qt, blshRead, formingLast]);
  // #129: the Dow reading placed on the chart's candles (by their open
  // times; a swing or mark before the first candle is not drawn, the key
  // level from an older swing starts at the first candle)
  const dowDraw = useMemo(() => {
    if (!dow || !ov.dow || candles.length === 0) return null;
    const at = new Map<number, number>();
    candles.forEach((c, i) => {
      const ms = parseUtcCandleTime(c.datetime);
      if (Number.isFinite(ms)) at.set(ms, i);
    });
    const idx = (s: string | null) => (s === null ? undefined : at.get(parseUtcCandleTime(s)));
    const cur = dow.current;
    const swings = (cur?.swings ?? []).flatMap((s) => {
      const i = idx(s.at);
      return i === undefined ? [] : [{ ...s, i }];
    });
    const events = (cur?.events ?? []).filter((e) => e.kind !== "update").flatMap((e) => {
      const i = idx(e.at);
      return i === undefined ? [] : [{ ...e, i }];
    });
    const key = cur?.key ? { ...cur.key, i: idx(cur.key.at) ?? 0, broken: cur.state === "toDown" || cur.state === "toUp" } : null;
    // each higher timeframe's key level, and its last high and low where
    // they are not the same price
    const higher = dow.higher.flatMap((h) => {
      const rows: Array<{ tf: string; kind: "pushLow" | "pullHigh" | "high" | "low"; price: number }> = [];
      if (h.key) rows.push({ tf: h.tf, kind: h.key.kind, price: h.key.price });
      if (h.high && h.high.price !== h.key?.price) rows.push({ tf: h.tf, kind: "high", price: h.high.price });
      if (h.low && h.low.price !== h.key?.price) rows.push({ tf: h.tf, kind: "low", price: h.low.price });
      return rows;
    });
    return { swings, events, key, higher };
  }, [dow, ov.dow, candles]);
  const [stochSettings, setStochSettings] = useState(false);
  // #144: the indicator whose ⓘ is open in the settings list
  const [infoOpen, setInfoOpen] = useState<string | null>(null);
  const showRsi = hasRsi && prefs.rsi;
  const showStoch = prefs.stoch && stoch.k.some((v) => v !== null);
  const showPctB = pctB !== null && pctB.some((v) => v !== null);
  const showRci = rciRead !== null && rciRead.rci.some((v) => v !== null);
  const showBlsh = prefs.blsh && blshRead !== null && blshRead.composite.some((v) => v !== null);
  const strips = (showRsi ? 1 : 0) + (showStoch ? 1 : 0) + (showPctB ? 1 : 0) + (showRci ? 1 : 0) + (showBlsh ? 1 : 0);
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
  const decimals = priceDecimals(pair);
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
    // (#119: while the dots or the band are shown)
    if (sar && sar.length === candles.length && (showSarDots || showSarCloud)) {
      for (let i = from; i < to; i++) {
        const v = sar[i];
        if (v === null || !Number.isFinite(v)) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    // #143: the EMA lines too — the price is read against them (as
    // TradingView fits its scale to the lines it draws)
    if (emas) {
      for (const l of emas.lines) {
        for (let i = from; i < to; i++) {
          const v = l.values[i + emas.off];
          if (v === null || !Number.isFinite(v)) continue;
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }
    }
    // #104: signal labels and their TP/SL boxes stand above the highs and
    // hang below the lows, so a chart that has any gets more room at both
    // ends — otherwise a signal at the window's extreme is pushed onto the
    // candles it points at.
    const pad = (max - min) * (marks.length > 0 ? 0.16 : 0.06) || Math.abs(max) * 0.001 || 1;
    min -= pad;
    max += pad;
    // #144: as dragged on the price scale
    if (priceZoom !== 1) {
      const mid = (min + max) / 2;
      const half = ((max - min) / 2) * priceZoom;
      min = mid - half;
      max = mid + half;
    }

    const plotW = W - PAD_LEFT - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const slot = plotW / (to - from);
    // wider candles when zoomed in, up to a point
    const bodyW = Math.max(2, Math.min(interactive && view ? 18 : 9, slot * 0.62));
    const y = (price: number) => PAD_TOP + ((max - price) / (max - min)) * plotH;
    const x = (i: number) => PAD_LEFT + slot * (i - from) + slot / 2;

    return { min, max, y, x, slot, bodyW, plotW };
  }, [candles, levels, W, H, PAD_RIGHT, sar, marks.length, from, to, interactive, view, showSarDots, showSarCloud, emas, priceZoom]);

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
    if (!showSarCloud || !sar || !sarBelow || sar.length !== candles.length || sarBelow.length !== candles.length) {
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
  }, [showSarCloud, sar, sarBelow, candles]);

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

  // #119: everything the chart can draw besides the candles, each with its
  // switch. #144: grouped as iSPEED FX groups its indicators — the signals,
  // the trend ones drawn over the price, the oscillators under it — in the
  // settings list (the card's, and full screen's sheet), each with its note
  // behind an ⓘ. Only what this chart has is listed.
  const flip = (k: keyof ChartOverlays) => () => setChartPrefs({ overlays: { ...ov, [k]: !ov[k] } });
  const openStochSettings = () => (full ? setSheet("settings") : setStochSettings((v) => !v));
  const emaNoteText = t.chart.emaNote(emas ? emas.total : null, zoneShiftHistory ? (emas ? "ready" : zoneShiftHistory.status) : "ready");
  const noteOf: Partial<Record<string, ReactNode>> = {
    signals: signalLegend ?? t.chart.signalLegend,
    ema50: emaNoteText,
    ema200: emaNoteText,
    kalman: t.chart.kalmanNote,
    supertrend: t.chart.supertrendNote,
    utBot: t.chart.utBotNote,
    fvgProfile: t.chart.fvgProfileNote(vp ? vp.to - vp.from + 1 : Math.min(WVP_DEFAULTS.analyzeBars, candles.length)),
    zoneShift: t.chart.zoneShiftNote(zs ? zs.total : null, zoneShiftHistory ? (zs ? "ready" : zoneShiftHistory.status) : "ready"),
    dow: dow ? t.chart.dowNote(dow.status, dow.current !== null, dow.higher.map((h) => t.chart.dowTfShort[h.tf] ?? h.tf)) : undefined,
    gainzPro: t.chart.gainzProNote(gp ? gp.total : null, zoneShiftHistory ? (gp ? "ready" : zoneShiftHistory.status) : "ready"),
    stoch: t.chart.stoch.note,
    pctB: t.chart.pctB.note,
    rci: t.chart.rci.note,
    qTrend: t.chart.qTrendNote,
    blsh: t.chart.blsh.note,
    qtBlsh: t.chart.qtBlshNote,
  };
  type Group = "signals" | "trend" | "oscillator";
  const overlayItems: Array<{ key: string; group: Group; name: string; on: boolean; toggle: () => void; settings?: () => void; locked?: true; swatch?: string }> = [
    ...(flags.length > 0 ? [{ key: "signals", group: "signals" as const, name: signalName ?? t.chart.overlayNames.signals, on: ov.signals, toggle: flip("signals") }] : []),
    ...(positions && flags.length > 0 ? [{ key: "positions", group: "signals" as const, name: t.chart.overlayNames.positions, on: ov.positions, toggle: flip("positions") }] : []),
    ...(trendLines.length > 0 ? [{ key: "trendLines", group: "signals" as const, name: t.chart.overlayNames.trendLines, on: ov.trendLines, toggle: flip("trendLines") }] : []),
    // #145: the video's combination
    { key: "qtBlsh", group: "signals" as const, name: t.chart.overlayNames.qtBlsh, on: ov.qtBlsh, toggle: flip("qtBlsh") },
    ...(hasSar && sarStyle !== "dots" ? [{ key: "sarCloud", group: "trend" as const, name: t.chart.overlayNames.sarCloud, on: ov.sarCloud, toggle: flip("sarCloud") }] : []),
    ...(hasSar && sarStyle !== "cloud" ? [{ key: "sarDots", group: "trend" as const, name: t.chart.overlayNames.sarDots, on: ov.sarDots, toggle: flip("sarDots") }] : []),
    // #143: each with its line's colour
    ...EMA_LINES.map((l) => ({ key: l.key, group: "trend" as const, name: t.chart.overlayNames.ema(l.length), on: ov[l.key], toggle: flip(l.key), swatch: l.color })),
    { key: "qTrend", group: "trend" as const, name: t.chart.overlayNames.qTrend(QT_DEFAULTS.period, QT_DEFAULTS.atrPeriod, QT_DEFAULTS.mult), on: ov.qTrend, toggle: flip("qTrend") },
    { key: "kalman", group: "trend" as const, name: t.chart.overlayNames.kalman(KST_DEFAULTS.atrLength, KST_DEFAULTS.factor), on: ov.kalman, toggle: flip("kalman") },
    { key: "supertrend", group: "trend" as const, name: t.chart.overlayNames.supertrend(ST_DEFAULTS.period, ST_DEFAULTS.multiplier), on: ov.supertrend, toggle: flip("supertrend") },
    { key: "utBot", group: "trend" as const, name: t.chart.overlayNames.utBot(UT_DEFAULTS.keyValue, UT_DEFAULTS.atrPeriod), on: ov.utBot, toggle: flip("utBot") },
    { key: "fvgProfile", group: "trend" as const, name: t.chart.overlayNames.fvgProfile, on: ov.fvgProfile, toggle: flip("fvgProfile") },
    ...(zsListed ? [{ key: "zoneShift", group: "trend" as const, name: t.chart.overlayNames.zoneShift(ZS_DEFAULTS.length), on: ov.zoneShift, toggle: flip("zoneShift") }] : []),
    ...(dow ? [{ key: "dow", group: "trend" as const, name: t.chart.overlayNames.dow, on: ov.dow, toggle: flip("dow") }] : []),
    ...(gpListed ? [{ key: "gainzPro", group: "trend" as const, name: t.chart.overlayNames.gainzPro, on: ov.gainzPro, toggle: flip("gainzPro") }] : []),
    ...(hasRsi ? [{ key: "rsi", group: "oscillator" as const, name: t.chart.rsiLabel, on: prefs.rsi, toggle: () => setChartPrefs({ rsi: !prefs.rsi }) }] : []),
    {
      key: "stoch",
      group: "oscillator" as const,
      name: `${t.chart.stoch.name} ${prefs.stochParams.kLength} ${prefs.stochParams.kSmoothing} ${prefs.stochParams.dSmoothing}`,
      on: prefs.stoch,
      toggle: () => setChartPrefs({ stoch: !prefs.stoch }),
      settings: openStochSettings,
    },
    // #135: off until switched on
    { key: "pctB", group: "oscillator" as const, name: t.chart.pctB.name(PCTB_DEFAULTS.length, PCTB_DEFAULTS.mult), on: prefs.pctB, toggle: () => setChartPrefs({ pctB: !prefs.pctB }) },
    { key: "rci", group: "oscillator" as const, name: t.chart.rci.name(RCI_DEFAULTS.length), on: prefs.rci, toggle: () => setChartPrefs({ rci: !prefs.rci }) },
    { key: "blsh", group: "oscillator" as const, name: t.chart.blsh.name, on: prefs.blsh, toggle: () => setChartPrefs({ blsh: !prefs.blsh }) },
  ].map((item) => (indicatorsLocked && LOCKED_KEYS.has(item.key)
    // #140: listed, so what a plan adds is in sight, but off and locked
    ? { ...item, on: false, locked: true as const, settings: undefined, toggle: () => onLockedIndicator?.() }
    : item));
  const onCount = overlayItems.filter((i) => i.on).length;
  // #144: the settings list, grouped — in the card (folded under its
  // button) and in full screen's settings sheet; `ids` names its switches
  const indicatorList = (ids: { toggle: string; lock: string }) => (
    <div className="space-y-3" data-testid="chart-overlay-list">
      {(["signals", "trend", "oscillator"] as const).map((g) => {
        const items = overlayItems.filter((i) => i.group === g);
        if (items.length === 0) return null;
        return (
          <section key={g} className="space-y-1" data-testid={`chart-group-${g}`}>
            <h4 className="text-[11px] font-semibold text-muted-foreground">{t.chart.groups[g]}</h4>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {items.map((item) => {
                const note = noteOf[item.key];
                const open = infoOpen === item.key;
                return (
                  <li key={item.key} className="px-2 py-1" data-testid={`chart-overlay-${item.key}`}>
                    <div className="flex items-center gap-1.5 text-xs">
                      {item.locked ? (
                        // #140: a paid indicator — the lock says so and leads to the plan
                        <button
                          type="button"
                          aria-label={`${item.name}: ${t.chart.lockedHint}`}
                          title={t.chart.lockedHint}
                          onClick={item.toggle}
                          data-testid={`${ids.lock}-${item.key}`}
                          className="p-1 rounded text-muted-foreground hover:text-foreground"
                        >
                          <Lock className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-pressed={item.on}
                          aria-label={`${item.name}: ${item.on ? t.chart.hide : t.chart.show}`}
                          title={item.on ? t.chart.hide : t.chart.show}
                          onClick={item.toggle}
                          data-testid={`${ids.toggle}-${item.key}`}
                          className={`p-1 rounded hover:text-foreground ${item.on ? "text-primary" : "text-muted-foreground"}`}
                        >
                          {item.on ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        </button>
                      )}
                      {item.swatch && <span aria-hidden="true" className="inline-block h-0.5 w-3 shrink-0 rounded" style={{ background: item.swatch }} data-testid={`chart-swatch-${item.key}`} />}
                      <span
                        className={`min-w-0 flex-1 truncate ${item.on ? "text-foreground" : item.locked ? "text-muted-foreground opacity-60" : "text-muted-foreground line-through opacity-60"}`}
                        data-testid={`chart-overlay-name-${item.key}`}
                      >
                        {item.name}
                      </span>
                      {item.settings && (
                        <button
                          type="button"
                          aria-expanded={stochSettings}
                          aria-label={t.chart.stoch.settings}
                          title={t.chart.stoch.settings}
                          onClick={item.settings}
                          data-testid="chart-stoch-settings"
                          className="p-1 rounded text-muted-foreground hover:text-foreground"
                        >
                          <Settings2 className="h-4 w-4" />
                        </button>
                      )}
                      {note && (
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-label={`${item.name}: ${t.chart.info}`}
                          title={t.chart.info}
                          onClick={() => setInfoOpen(open ? null : item.key)}
                          data-testid={`chart-info-${item.key}`}
                          className={`p-1 rounded hover:text-foreground ${open ? "text-primary" : "text-muted-foreground"}`}
                        >
                          <Info className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    {open && note && (
                      <p className="pb-1 pl-7 text-[11px] leading-relaxed text-muted-foreground" data-testid={`chart-info-text-${item.key}`}>{note}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {indicatorsLocked && <p className="text-[11px] text-muted-foreground" data-testid="chart-sheet-locked-note">{t.chart.lockedNote}</p>}
    </div>
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
              {indicatorList({ toggle: "chart-sheet", lock: "chart-sheet-lock" })}
              {!indicatorsLocked && stochForm}
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
                <p className="text-[11px] text-muted-foreground" data-testid="chart-gesture-hint">{t.chart.gestureHint}</p>
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
                  {t.chart.ohlc(hovered.open.toFixed(decimals), hovered.high.toFixed(decimals), hovered.low.toFixed(decimals), hovered.close.toFixed(decimals))}
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
  // #145: Q-Trend's labels and the 3✓ badges (the badge a row beyond the
  // label), placed in bar order clear of one another and of the plot's edges
  const qtFsz = (narrow ? 7.5 : 8.5) * fs;
  const qtLabels = [
    ...(qt && ov.qTrend
      ? qt.signals.filter((sg) => onScreen(sg.i)).map((sg) => ({ key: `qt-${sg.i}`, i: sg.i, buy: sg.side === "BUY", text: sg.strong ? "STRONG" : sg.side, badge: false }))
      : []),
    ...(triple ? triple.filter((sg) => onScreen(sg.i)).map((sg) => ({ key: `tc-${sg.i}`, i: sg.i, buy: sg.side === "BUY", text: `3✓ ${sg.side}`, badge: true })) : []),
  ]
    .sort((a, b) => a.i - b.i || Number(a.badge) - Number(b.badge))
    .map((it) => ({
      key: it.key,
      x: x(it.i),
      highY: y(candles[it.i].high),
      lowY: y(candles[it.i].low),
      w: it.text.length * qtFsz * 0.62 + (it.badge ? 8 : 6),
      h: qtFsz + (it.badge ? 6 : 5),
      off: it.badge ? 6 + qtFsz + 12 : 6,
      buy: it.buy,
    }));
  const qtSpots = placeEdgeLabels(qtLabels, plotTop, plotBottom);
  const qtPlaced = new Map(qtLabels.map((l) => [l.key, { ...qtSpots.get(l.key)!, w: l.w, h: l.h }]));
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
    if (!positions || !ov.positions) return [];
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
  // #119: the SPECTRA-style line in runs of one trend
  const kstRuns = (() => {
    if (!kst) return [];
    const runs: Array<{ up: boolean; from: number; to: number }> = [];
    kst.trend.forEach((tr, i) => {
      if (tr === null || kst.line[i] === null) return;
      const last = runs[runs.length - 1];
      if (last && last.up === (tr === 1) && last.to === i - 1) last.to = i;
      else runs.push({ up: tr === 1, from: i, to: i });
    });
    return runs;
  })();
  // #136: SuperTrend's line in runs of one trend (broken where it turns, as
  // the original's plot.style_linebr)
  const stRuns = (() => {
    if (!st) return [];
    const runs: Array<{ up: boolean; from: number; to: number }> = [];
    st.trend.forEach((tr, i) => {
      if (tr === null || st.line[i] === null) return;
      const last = runs[runs.length - 1];
      if (last && last.up === (tr === 1) && last.to === i - 1) last.to = i;
      else runs.push({ up: tr === 1, from: i, to: i });
    });
    return runs;
  })();
  const exitColor = (o: ChartSignalMark["outcome"]) => (o === "win" ? COLORS.tp : o === "loss" ? COLORS.sl : COLORS.text);
  // #129: Dow theory's levels — lows (押し安値) green, highs (戻り高値) red;
  // the higher timeframes' inside the price range only (they do not stretch
  // it, as the overlays do not), their labels pushed apart
  const dowColor = (k: "pushLow" | "pullHigh" | "high" | "low") => (k === "pushLow" || k === "low" ? COLORS.up : COLORS.down);
  const dowHigher = dowDraw
    ? dowDraw.higher
      .filter((r) => r.price >= geometry.min && r.price <= geometry.max)
      .map((r) => ({ ...r, key: r.kind === "pushLow" || r.kind === "pullHigh" }))
    : [];
  // every level's label at the right end of its line (the indicator list
  // covers the top left), the chart's own key level's among them, moved
  // apart where two would overlap
  const dowLabels = (() => {
    if (!dowDraw) return [];
    const rows: Array<{ id: string; text: string; color: string; bold: boolean; ly: number }> = dowHigher.map((r) => ({
      id: `chart-dow-higher-label-${r.tf}-${r.kind}`,
      text: `${t.chart.dowTfShort[r.tf] ?? r.tf} ${t.chart.dowLevel[r.kind]} ${r.price.toFixed(decimals)}`,
      color: dowColor(r.kind),
      bold: false,
      ly: y(r.price) - 2,
    }));
    const k = dowDraw.key;
    if (k && k.price >= geometry.min && k.price <= geometry.max) {
      rows.push({
        id: `chart-dow-key-label-${k.kind}`,
        text: `${t.chart.dowLevel[k.kind]}${k.broken ? t.chart.dowBroken[k.kind] : ""} ${k.price.toFixed(decimals)}`,
        color: dowColor(k.kind),
        bold: true,
        ly: y(k.price) - 3,
      });
    }
    rows.sort((a, b) => a.ly - b.ly);
    for (let n = 1; n < rows.length; n++) rows[n].ly = Math.max(rows[n].ly, rows[n - 1].ly + labelSize + 1);
    return rows;
  })();
  const dowZigzag = dowDraw && dowDraw.swings.length > 1
    ? dowDraw.swings.map((sw, k) => `${k === 0 ? "M" : "L"}${x(sw.i).toFixed(1)},${y(sw.price).toFixed(1)}`).join(" ")
    : "";

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

  const afterTouch = () => Date.now() - touchedAt.current < TOUCH_MOUSE_MS;
  const handleMove = (evt: React.MouseEvent<SVGSVGElement>) => {
    if (afterTouch()) return;
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
    if (afterTouch()) return;
    handleMove(evt);
    setHoverY(levelAt(evt.clientY, evt.currentTarget));
  };
  const clearHover = () => {
    setHover(null);
    setHoverY(null);
  };

  // #116: one finger (or the mouse) drags the bars sideways, two pinch them.
  // #144: as iSPEED FX: a finger held still brings up the crosshair, which
  // then follows it (and stays where it is let go); a tap hides it, or shows
  // it where there was none; one finger up and down the price scale
  // stretches it, sideways along the time scale zooms.
  const svgY = (clientY: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    return rect.height > 0 ? ((clientY - rect.top) / rect.height) * H : 0;
  };
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const startGesture = (clientY = 0) => {
    const xs = [...pointers.current.values()];
    if (xs.length >= 2) {
      const [a, b] = xs;
      gesture.current = { kind: "pinch", view, x: 0, y: clientY, dist: Math.max(1, Math.abs(a - b)), at: across((a + b) / 2), moved: true, zoom: priceZoom };
    } else if (xs.length === 1) {
      gesture.current = { kind: "pan", view, x: xs[0], y: clientY, dist: 0, at: 0, moved: false, zoom: priceZoom };
    } else {
      gesture.current = null;
    }
  };
  const onPointerDown = (evt: React.PointerEvent<SVGSVGElement>) => {
    if (evt.pointerType !== "mouse") touchedAt.current = Date.now();
    if (!interactive || (evt.pointerType === "mouse" && evt.button !== 0)) return;
    evt.currentTarget.setPointerCapture?.(evt.pointerId);
    const px = svgX(evt.clientX, evt.currentTarget);
    const py = svgY(evt.clientY, evt.currentTarget);
    pointers.current.set(evt.pointerId, px);
    cancelPress();
    if (pointers.current.size === 1) {
      if (px >= W - PAD_RIGHT && py <= H - PAD_BOTTOM) {
        gesture.current = { kind: "yzoom", view, x: px, y: evt.clientY, dist: 0, at: 0, moved: false, zoom: priceZoom };
        return;
      }
      if (py > H - PAD_BOTTOM && px < W - PAD_RIGHT) {
        gesture.current = { kind: "xzoom", view, x: px, y: evt.clientY, dist: 0, at: 1, moved: false, zoom: priceZoom };
        return;
      }
    }
    startGesture(evt.clientY);
    if (evt.pointerType !== "mouse" && pointers.current.size === 1) {
      const el = evt.currentTarget;
      const clientY = evt.clientY;
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null;
        const g = gesture.current;
        if (!g || g.kind !== "pan" || g.moved) return;
        g.kind = "cross";
        const idx = barAt(px);
        setHover(onScreen(idx) ? idx : null);
        setHoverY(levelAt(clientY, el));
      }, LONG_PRESS_MS);
    }
  };
  const onPointerMove = (evt: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(evt.pointerId)) return;
    const px = svgX(evt.clientX, evt.currentTarget);
    pointers.current.set(evt.pointerId, px);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "cross") {
      const idx = barAt(px);
      setHover(onScreen(idx) ? idx : null);
      setHoverY(levelAt(evt.clientY, evt.currentTarget));
      return;
    }
    if (g.kind === "yzoom") {
      const dy = evt.clientY - g.y;
      if (!g.moved && Math.abs(dy) < 3) return;
      g.moved = true;
      // down squeezes the prices together, up spreads them apart
      setPriceZoom(Math.min(PRICE_ZOOM_MAX, Math.max(PRICE_ZOOM_MIN, g.zoom * Math.exp(dy / 150))));
      return;
    }
    if (g.kind === "xzoom") {
      const dx = px - g.x;
      if (!g.moved && Math.abs(dx) < 3) return;
      g.moved = true;
      // right: fewer, wider bars; left: more — the newest kept at the right
      setView(zoomView(n, g.view, Math.exp(dx / 120), 1));
      return;
    }
    if (g.kind === "pan") {
      const dx = px - g.x;
      // a finger that moves is not held still (up and down it scrolls the page)
      if (Math.abs(evt.clientY - g.y) > 8) cancelPress();
      if (!g.moved && Math.abs(dx) < 4) return;
      g.moved = true;
      cancelPress();
      if (g.view) setView(panView(n, g.view, dx / slot));
    } else {
      const [a, b] = [...pointers.current.values()];
      if (b === undefined) return;
      setView(zoomView(n, g.view, Math.max(1, Math.abs(a - b)) / g.dist, g.at));
    }
  };
  const onPointerEnd = (evt: React.PointerEvent<SVGSVGElement>) => {
    if (evt.pointerType !== "mouse") touchedAt.current = Date.now();
    if (!pointers.current.has(evt.pointerId)) return;
    cancelPress();
    const g = gesture.current;
    const px = pointers.current.get(evt.pointerId) ?? 0;
    pointers.current.delete(evt.pointerId);
    if (g && (g.kind === "cross" || g.kind === "yzoom" || g.kind === "xzoom")) {
      // the crosshair stays where it was let go, an axis as it was dragged
      gesture.current = null;
      if (pointers.current.size > 0) startGesture();
      return;
    }
    if (g?.kind === "pan" && !g.moved && evt.type === "pointerup" && evt.pointerType !== "mouse") {
      if (hover !== null) {
        clearHover();
      } else {
        const idx = barAt(px);
        setHover(onScreen(idx) ? idx : null);
        setHoverY(levelAt(evt.clientY, evt.currentTarget));
      }
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
        {subtitle ?? t.chart.recentBars(pair, candles.length)}
      </span>
      {toolbar}
    </div>
  );

  const legends = (
    <>
      {/* #144: how the chart is worked, first */}
      {interactive && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-gesture-note">
          {t.chart.gestureHint}
        </p>
      )}
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
      {ov.kalman && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-kalman-legend">
          {t.chart.kalmanNote}
        </p>
      )}
      {ov.supertrend && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-supertrend-legend">
          {t.chart.supertrendNote}
        </p>
      )}
      {ov.utBot && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-utbot-legend">
          {t.chart.utBotNote}
        </p>
      )}
      {emaOn !== "" && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-ema-legend">
          {noteOf.ema50}
        </p>
      )}
      {ov.qtBlsh && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-qtblsh-legend">
          {noteOf.qtBlsh}
        </p>
      )}
      {ov.qTrend && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-qtrend-legend">
          {noteOf.qTrend}
        </p>
      )}
      {prefs.blsh && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-blsh-legend">
          {noteOf.blsh}
        </p>
      )}
      {ov.zoneShift && zsListed && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-zoneshift-legend">
          {noteOf.zoneShift}
        </p>
      )}
      {ov.gainzPro && gpListed && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-gainzpro-legend">
          {noteOf.gainzPro}
        </p>
      )}
      {showPctB && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-pctb-legend">
          {t.chart.pctB.note}
        </p>
      )}
      {showRci && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-rci-legend">
          {t.chart.rci.note}
        </p>
      )}
      {dow && ov.dow && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-dow-legend">
          {noteOf.dow}
        </p>
      )}
      {ov.fvgProfile && (
        <p className="px-1 pb-1 text-[9px] text-muted-foreground" data-testid="chart-fvgprofile-legend">
          {noteOf.fvgProfile}
        </p>
      )}
    </>
  );

  // An oscillator under the price, on the same x scale so a bar here is the
  // bar above it: its lines, its levels, and its reading at the bar hovered
  // or the last one on screen. RSI (#104) and the stochastic (#117), 0–100;
  // #135: Bollinger %b (its own range) and RCI (−100 to 100).
  const strip = (o: {
    testid: string;
    aria: string;
    label: string;
    // `tagText`: the value's colour on its axis tag (white unless given, dark
    // on a light line; #145: or chosen by the tag's colour)
    // #145: `colors` a colour for each bar's stretch (the line changes
    // colour), `colorAt` its tag's and reading's colour at the bar read,
    // `hidden` read and tagged but not drawn (an area draws it)
    lines: Array<{
      name: string;
      values: Array<number | null>;
      color: string;
      tagText?: string | ((fill: string) => string);
      colors?: Array<string | null>;
      colorAt?: (i: number) => string;
      hidden?: boolean;
    }>;
    levels: Array<{ v: number; color: string; dash: string; opacity: number }>;
    // #145: an area from `base` to the values, `up` above it and `down` below
    area?: { values: Array<number | null>; base: number; up: string; down: string; opacity: number };
    band?: { from: number; to: number; color: string; opacity: number };
    bands?: Array<{ from: number; to: number; color: string; opacity: number; key: string }>;
    // the values at the strip's top and foot (0–100 unless given)
    range?: { min: number; max: number };
    // decimals of the reading, and how a level is written
    digits?: number;
    levelText?: (v: number) => string;
  }) => {
    const top = 8;
    const bottom = RH - 6;
    const lo = o.range?.min ?? 0;
    const hi = o.range?.max ?? 100;
    const ry = (v: number) => top + ((hi - Math.min(hi, Math.max(lo, v))) / (hi - lo)) * (bottom - top);
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
    // the bar read: the crosshair's, or the last on screen with a value
    const readAt = (values: Array<number | null>): number | null => {
      if (hover !== null && hovered) {
        const v = values[hover];
        return v === null || v === undefined || !Number.isFinite(v) ? null : hover;
      }
      for (let i = to - 1; i >= from; i--) {
        const v = values[i];
        if (v !== null && v !== undefined && Number.isFinite(v)) return i;
      }
      return null;
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
        {o.bands?.map((b) => (
          <rect
            key={b.key}
            x={PAD_LEFT}
            y={ry(b.to)}
            width={Math.max(0, W - PAD_RIGHT - PAD_LEFT)}
            height={Math.max(0, ry(b.from) - ry(b.to))}
            fill={b.color}
            opacity={b.opacity}
            data-testid={`${o.testid}-band-${b.key}`}
          />
        ))}
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
            <text x={AXIS_X} y={ry(lv.v) + 3} fontSize={labelSize} fill={COLORS.text} fontFamily="monospace">{o.levelText ? o.levelText(lv.v) : lv.v}</text>
          </g>
        ))}
        {hover !== null && hovered && (
          <line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} stroke={COLORS.text} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.7" />
        )}
        {/* #145: the area, split at its base: one colour over, one under */}
        {o.area && (() => {
          const a = o.area;
          let d = "";
          let run: number[] = [];
          const close = () => {
            if (run.length > 0) {
              d += `M${x(run[0]).toFixed(1)},${ry(a.base).toFixed(1)} `;
              for (const i of run) d += `L${x(i).toFixed(1)},${ry(a.values[i] as number).toFixed(1)} `;
              d += `L${x(run[run.length - 1]).toFixed(1)},${ry(a.base).toFixed(1)} Z `;
            }
            run = [];
          };
          for (let i = from; i < to; i++) {
            const v = a.values[i];
            if (v === null || v === undefined || !Number.isFinite(v)) close();
            else run.push(i);
          }
          close();
          if (!d) return null;
          const baseY = ry(a.base);
          const idAbove = `${clipId}-${o.testid}-over`;
          const idBelow = `${clipId}-${o.testid}-under`;
          return (
            <g data-testid={`${o.testid}-area`}>
              <defs>
                <clipPath id={idAbove}><rect x={0} y={0} width={W} height={Math.max(0, baseY)} /></clipPath>
                <clipPath id={idBelow}><rect x={0} y={baseY} width={W} height={Math.max(0, RH - baseY)} /></clipPath>
              </defs>
              <path d={d} fill={a.up} stroke={a.up} strokeWidth={1} opacity={a.opacity} clipPath={`url(#${idAbove})`} data-testid={`${o.testid}-area-up`} />
              <path d={d} fill={a.down} stroke={a.down} strokeWidth={1} opacity={a.opacity} clipPath={`url(#${idBelow})`} data-testid={`${o.testid}-area-down`} />
            </g>
          );
        })()}
        {o.lines.map((ln) => {
          if (ln.hidden) return null;
          if (!ln.colors) {
            return <path key={ln.name || "line"} d={pathOf(ln.values)} fill="none" stroke={ln.color} strokeWidth={full ? 1.5 : 1.2} data-line={ln.name || undefined} />;
          }
          // #145: each stretch in the colour of the bar it ends on
          const runs: Array<{ color: string; d: string }> = [];
          for (let i = Math.max(from, 1); i < to; i++) {
            const a = ln.values[i - 1];
            const b = ln.values[i];
            if (a === null || b === null || a === undefined || b === undefined) continue;
            const color = ln.colors[i] ?? ln.color;
            const seg = `M${x(i - 1).toFixed(1)},${ry(a).toFixed(1)} L${x(i).toFixed(1)},${ry(b).toFixed(1)} `;
            const lastRun = runs[runs.length - 1];
            if (lastRun && lastRun.color === color) lastRun.d += seg;
            else runs.push({ color, d: seg });
          }
          return (
            <g key={ln.name || "line"} data-line={ln.name || undefined}>
              {runs.map((r, k) => <path key={k} d={r.d} fill="none" stroke={r.color} strokeWidth={full ? 1.5 : 1.2} />)}
            </g>
          );
        })}
        {/* #118: each line's value as a tag on the axis, in its colour, as
            TradingView shows them; two that would overlap are pushed apart */}
        {(() => {
          const tagH = labelSize + 6;
          const tags = o.lines
            .map((ln) => {
              const i = readAt(ln.values);
              return { ln, v: i === null ? null : (ln.values[i] as number), fill: i !== null && ln.colorAt ? ln.colorAt(i) : ln.color };
            })
            .filter((g): g is { ln: typeof g.ln; v: number; fill: string } => g.v !== null)
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
          return tags.map(({ ln, v, cy, fill }) => (
            <g key={`tag-${ln.name || "line"}`} data-testid={`${o.testid}-tag${ln.name ? `-${ln.name.replace("%", "")}` : ""}`}>
              <rect x={W - PAD_RIGHT + 1} y={cy - tagH / 2} width={axisW - 2} height={tagH} rx="2" fill={fill} />
              <text x={AXIS_X} y={cy + labelSize * 0.36} fontSize={labelSize} fontWeight="700" fill={typeof ln.tagText === "function" ? ln.tagText(fill) : ln.tagText ?? "#fff"} fontFamily="monospace">
                {v.toFixed(2)}
              </text>
            </g>
          ));
        })()}
        <text x={PAD_LEFT + 2} y={top + 2} fontSize={labelSize} fill={COLORS.text} fontFamily="monospace" data-testid={`${o.testid}-reading`}>
          {o.label}
          {o.lines.map((ln) => {
            const i = readAt(ln.values);
            const v = i === null ? null : (ln.values[i] as number);
            return (
              <tspan key={ln.name || "line"} fill={ln.name ? (i !== null && ln.colorAt ? ln.colorAt(i) : ln.color) : COLORS.text}>
                {` ${ln.name ? `${ln.name} ` : ""}${v === null ? "—" : v.toFixed(o.digits ?? 1)}`}
              </tspan>
            );
          })}
        </text>
      </svg>
    );
  };

  // #144: the chart's top left says what is drawn over the price and, for
  // the EMA lines, their values — at the crosshair's bar, or the last one on
  // screen — as iSPEED FX heads its chart. It takes no touches: the switches
  // are in the settings list.
  const legendAt = hover !== null && hovered ? hover : Math.min(to, candles.length) - 1;
  const legendNames = overlayItems.filter((i) => i.group === "trend" && i.on && !i.swatch).map((i) => i.name);
  // the crosshair's bar's prices first (始 高 安 終, as iSPEED FX heads its
  // chart; full screen has them in its header)
  const ohlcLine = hovered && !full
    ? t.chart.ohlc(hovered.open.toFixed(decimals), hovered.high.toFixed(decimals), hovered.low.toFixed(decimals), hovered.close.toFixed(decimals))
    : null;
  const overlayLegend = emas || legendNames.length > 0 || ohlcLine ? (
    <div
      className={`pointer-events-none absolute left-1 top-1 z-10 ${ohlcLine ? "max-w-[94%]" : "max-w-[78%]"} rounded bg-background/70 px-1.5 py-0.5 text-[10px] leading-snug`}
      data-testid="chart-overlay-legend"
    >
      {ohlcLine && <div className="whitespace-nowrap font-mono text-foreground" data-testid="chart-legend-ohlc">{ohlcLine}</div>}
      {emas && (
        <div className="flex flex-wrap gap-x-2 font-mono">
          {emas.lines.map((l) => {
            const v = l.values[legendAt + emas.off];
            return (
              <span key={l.key} style={{ color: l.color }} data-testid={`chart-legend-${l.key}`}>
                {`EMA ${l.length} ${v === null || v === undefined ? "—" : v.toFixed(decimals)}`}
              </span>
            );
          })}
        </div>
      )}
      {legendNames.length > 0 && <div className="truncate text-muted-foreground" data-testid="chart-legend-names">{legendNames.join(" · ")}</div>}
    </div>
  ) : null;

  // #144: the card's settings list, folded under a button above the chart
  // (how many of the listed are on); full screen has it in its sheet
  const indicatorPanel = (
    <details className="px-1 pb-2" data-testid="chart-indicator-panel">
      <summary
        className="flex w-fit cursor-pointer list-none items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
        data-testid="chart-overlay-fold"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {t.chart.indicators} {onCount}/{overlayItems.length}
        <ChevronDown className="h-3.5 w-3.5" />
      </summary>
      <div className="pt-2">{indicatorList({ toggle: "chart-toggle", lock: "chart-lock" })}</div>
    </details>
  );

  const charts = (
    <>
      <div className="relative">
      {overlayLegend}
      {priceZoom !== 1 && (
        <button
          type="button"
          onClick={() => setPriceZoom(1)}
          aria-label={t.chart.priceAutoHint}
          title={t.chart.priceAutoHint}
          data-testid="chart-price-auto"
          className="absolute right-1 top-1 z-10 rounded border border-border bg-background/80 px-1.5 py-0.5 text-[10px] text-foreground"
        >
          {t.chart.priceAuto}
        </button>
      )}
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
        onDoubleClick={interactive ? () => { setView(null); setPriceZoom(1); } : undefined}
        // a drag sideways moves the bars, up and down still scrolls the
        // page; in full screen every gesture is the chart's
        style={interactive ? { touchAction: full ? "none" : "pan-y", cursor: zoomed ? "grab" : undefined, WebkitTouchCallout: "none" } : undefined}
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

        {/* #122: the Weighted Volume Profile — a bar per price row from the
            first candle it reads, bullish then bearish, as long as the row
            is full (1 to 50 candles), and the Point Of Control's line from
            the end of the fullest row to the right edge. Under the candles
            and see-through, where the original's opaque boxes sit on top;
            #123: in FVG Crossfire's colours, the two being one indicator. */}
        {vp && (
          <g data-testid="chart-vp" clipPath={`url(#${clipId})`}>
            {vp.rows.map((r, k) => {
              if (r.total <= 0) return null;
              const yTop = y(r.top - vp.gap / 2);
              const h = Math.max(1, y(r.bottom + vp.gap / 2) - yTop);
              const xMid = x(r.start + r.bullSize);
              return (
                <g key={`vp-${k}`}>
                  {r.bullSize > 0 && (
                    <rect
                      x={x(r.start)} y={yTop} width={Math.max(0.5, xMid - x(r.start))} height={h}
                      fill={COLORS.fvgBull} opacity="0.3"
                      data-testid="chart-vp-row" data-side="bull"
                    />
                  )}
                  {r.bearSize > 0 && (
                    <rect
                      x={xMid} y={yTop} width={Math.max(0.5, x(r.end) - xMid)} height={h}
                      fill={COLORS.fvgBear} opacity="0.3"
                      data-testid="chart-vp-row" data-side="bear"
                    />
                  )}
                </g>
              );
            })}
            {vp.poc && (
              <line
                x1={x(vp.rows[vp.poc.row].end)} x2={W - PAD_RIGHT}
                y1={y(vp.poc.price)} y2={y(vp.poc.price)}
                stroke={prefs.theme === "light" ? COLORS.pocLight : COLORS.poc} strokeWidth={2 * fs}
                data-testid="chart-vp-poc" data-price={vp.poc.price}
              />
            )}
          </g>
        )}

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

        {/* #121: FVG Crossfire's zones — each state of a chain as a box from
            where it began to where it flipped (or to the newest candle while
            live), faded once a close went through it — and the funnel from
            the older gap each chain grew out of */}
        {fvgcf && fvgcf.segments.length > 0 && (
          <g data-testid="chart-fvgcf" clipPath={`url(#${clipId})`}>
            {fvgcf.segments.map((sg, k) => {
              const color = sg.dir === 1 ? COLORS.fvgBull : COLORS.fvgBear;
              const x0 = x(sg.from);
              const x1 = x(sg.to ?? lastIdx);
              const funnel = sg.funnel;
              return (
                <g key={`fz-${k}`}>
                  {funnel && (
                    <polygon
                      points={`${x(funnel.topBar).toFixed(1)},${y(funnel.top).toFixed(1)} ${x0.toFixed(1)},${y(sg.top).toFixed(1)} ${x0.toFixed(1)},${y(sg.bottom).toFixed(1)} ${x(funnel.bottomBar).toFixed(1)},${y(funnel.bottom).toFixed(1)}`}
                      fill={funnel.dir === 1 ? COLORS.fvgBull : COLORS.fvgBear}
                      opacity={sg.done ? 0.04 : 0.14}
                      data-testid="chart-fvgcf-funnel"
                    />
                  )}
                  {/* the prices are the original's; on a chart this small a
                      band a few pips wide is a line, so it is drawn at least
                      2 high, and a live one gets an edge to be seen by */}
                  <rect
                    x={x0}
                    y={Math.min(y(sg.top), (y(sg.top) + y(sg.bottom)) / 2 - 1)}
                    width={Math.max(1, x1 - x0)}
                    height={Math.max(2, y(sg.bottom) - y(sg.top))}
                    fill={color}
                    opacity={sg.done ? 0.1 : sg.active ? 0.28 : 0.2}
                    stroke={sg.active && !sg.done ? color : "none"}
                    strokeOpacity={0.7}
                    strokeWidth={0.8}
                    data-testid="chart-fvgcf-zone"
                    data-dir={sg.dir === 1 ? "bull" : "bear"}
                    data-live={sg.active && !sg.done ? "1" : "0"}
                  />
                </g>
              );
            })}
          </g>
        )}

        {/* #119: the SPECTRA-style trend cloud — between the smoothed price
            and its Supertrend line, green while up, red while down */}
        {kst && kstRuns.length > 0 && (
          <g data-testid="chart-kalman-cloud" clipPath={`url(#${clipId})`}>
            {kstRuns.map((r) => {
              const cols: number[] = [];
              for (let i = r.from; i <= r.to; i++) if (kst.mid[i] !== null && kst.line[i] !== null) cols.push(i);
              if (cols.length < 2) return null;
              const top = cols.map((i) => `${x(i).toFixed(1)},${y(kst.mid[i] as number).toFixed(1)}`);
              const bottom = cols.map((i) => `${x(i).toFixed(1)},${y(kst.line[i] as number).toFixed(1)}`).reverse();
              return (
                <polygon key={`kc-${r.from}`} points={[...top, ...bottom].join(" ")} fill={r.up ? COLORS.up : COLORS.down} opacity="0.1" />
              );
            })}
          </g>
        )}

        {/* #136: SuperTrend's highlight — between its line and ohlc4, green
            while up, red while down (the original's fills, 90% transparent) */}
        {st && stRuns.length > 0 && (
          <g data-testid="chart-supertrend-fill" clipPath={`url(#${clipId})`}>
            {stRuns.map((r) => {
              const cols: number[] = [];
              for (let i = Math.max(r.from, from); i <= Math.min(r.to, to - 1); i++) cols.push(i);
              if (cols.length < 2) return null;
              const mid = (i: number) => (candles[i].open + candles[i].high + candles[i].low + candles[i].close) / 4;
              const top = cols.map((i) => `${x(i).toFixed(1)},${y(mid(i)).toFixed(1)}`);
              const bottom = cols.map((i) => `${x(i).toFixed(1)},${y(st.line[i] as number).toFixed(1)}`).reverse();
              return <polygon key={`sf-${r.from}`} points={[...top, ...bottom].join(" ")} fill={r.up ? COLORS.up : COLORS.down} opacity="0.1" />;
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
        {positions && ov.positions && shown.map((f) => (
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

        {/* #124: Zone Shift's band — the top and bottom solid, the midline
            and the trend initiation level dashed (the original draws them
            on every other candle), in the chart's foreground colour */}
        {zs && (
          <g data-testid="chart-zoneshift" clipPath={`url(#${clipId})`}>
            {(["top", "bot"] as const).map((k) => {
              const vals = zs[k];
              let d = "";
              let pen = false;
              for (let i = Math.max(0, from - 1); i < Math.min(candles.length, to + 1); i++) {
                const v = vals[i + zs.off];
                if (v === null) {
                  pen = false;
                  continue;
                }
                d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
                pen = true;
              }
              return d ? <path key={k} d={d} fill="none" stroke={COLORS.zsLine} strokeWidth={fs} opacity="0.75" data-testid={`chart-zoneshift-${k}`} /> : null;
            })}
            {(["mid", "level"] as const).map((k) => {
              const vals = zs[k];
              let d = "";
              for (let i = Math.max(1, from - 1); i < Math.min(candles.length, to + 1); i++) {
                const g = i + zs.off;
                const a = vals[g - 1];
                const b = vals[g];
                // a segment is drawn in the colour of the candle it ends on:
                // every other one (Pine's `bar_index % 2 == 0`)
                if (a === null || b === null || g % 2 !== 0) continue;
                d += `M${x(i - 1).toFixed(1)},${y(a).toFixed(1)} L${x(i).toFixed(1)},${y(b).toFixed(1)} `;
              }
              return d ? <path key={k} d={d} fill="none" stroke={COLORS.zsLine} strokeWidth={fs} opacity="0.75" data-testid={`chart-zoneshift-${k}`} /> : null;
            })}
          </g>
        )}

        {/* #129: Dow theory — the higher timeframes' levels dashed (their
            key level bolder), the chart's own swings joined, and its key
            level from its swing to the right edge (dashed once broken) */}
        {dowDraw && (
          <g data-testid="chart-dow" clipPath={`url(#${clipId})`}>
            {dowHigher.map((r) => (
              <line
                key={`dh-${r.tf}-${r.kind}`}
                data-testid={`chart-dow-higher-${r.tf}-${r.kind}`}
                x1={PAD_LEFT} x2={W - PAD_RIGHT}
                y1={y(r.price)} y2={y(r.price)}
                stroke={dowColor(r.kind)}
                strokeWidth={(r.key ? 1.2 : 0.8) * fs}
                strokeDasharray={r.key ? "6 3" : "2 3"}
                opacity={r.key ? 0.85 : 0.55}
              />
            ))}
            {dowZigzag && (
              <path d={dowZigzag} fill="none" stroke={COLORS.zsLine} strokeWidth={fs} opacity="0.45" data-testid="chart-dow-zigzag" />
            )}
            {dowDraw.key && (
              <line
                data-testid={`chart-dow-key-${dowDraw.key.kind}`}
                x1={x(dowDraw.key.i)} x2={W - PAD_RIGHT}
                y1={y(dowDraw.key.price)} y2={y(dowDraw.key.price)}
                stroke={dowColor(dowDraw.key.kind)} strokeWidth={1.4 * fs}
                strokeDasharray={dowDraw.key.broken ? "4 2" : undefined}
                opacity="0.9"
              />
            )}
          </g>
        )}

        {/* candles — #116: those on screen (#124: in Zone Shift's trend
            colour while it is on, as the original paints them; #137: UT
            Bot's green or red first while it is on, as its barcolor) */}
        <g data-testid="chart-candles">
        {candles.map((c, i) => {
          if (!onScreen(i)) return null;
          const up = c.close >= c.open;
          const utSide = ut ? ut.side[i] : null;
          // #145: Q-Trend's colour (green after its buy, red otherwise, as
          // the original's barcolor), under UT Bot's and over Zone Shift's
          const qtSide = qt && ov.qTrend ? qt.trend[i] ?? null : null;
          const color = utSide !== null
            ? (utSide === 1 ? COLORS.up : COLORS.down)
            : qtSide !== null
              ? (qtSide === 1 ? COLORS.up : COLORS.down)
              : zs ? (zs.up[i + zs.off] ? COLORS.zsUp : COLORS.zsDown) : up ? COLORS.up : COLORS.down;
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

        {/* #121: FVG Crossfire's marks — the stars on each live zone's edge at
            the newest candle (under a bullish zone, over a bearish one) and
            an arrow on each retest (▲ under the candle for a bullish zone,
            ▼ over it for a bearish one) */}
        {fvgcf && (
          <g clipPath={`url(#${clipId})`}>
            {/* arrows stay with a frozen state of a chain until the chain is
                finished, as the original's labels do; stars only on the live one */}
            {fvgcf.segments.filter((sg) => !sg.done).map((sg, k) => {
              const color = sg.dir === 1 ? COLORS.fvgBull : COLORS.fvgBear;
              const size = labelSize + 1;
              return (
                <g key={`fs-${k}`}>
                  {sg.active && (
                    <text
                      x={x(lastIdx)}
                      y={sg.dir === 1 ? y(sg.bottom) + size + 1 : y(sg.top) - 3}
                      fontSize={size}
                      textAnchor="end"
                      fill={color}
                      data-testid="chart-fvgcf-stars"
                    >
                      {starText(sg.flips)}
                    </text>
                  )}
                  {sg.retests.filter(onScreen).map((i) => {
                    const c = candles[i];
                    const bull = sg.dir === 1;
                    return (
                      <text
                        key={`fr-${i}`}
                        x={x(i)}
                        y={bull ? y(c.low) + labelSize + 3 : y(c.high) - 3}
                        fontSize={labelSize - 1}
                        textAnchor="middle"
                        fill={color}
                        data-testid={`chart-fvgcf-retest-${bull ? "bull" : "bear"}`}
                      >
                        {bull ? "▲" : "▼"}
                      </text>
                    );
                  })}
                </g>
              );
            })}
          </g>
        )}

        {/* #124: Zone Shift's retests — a diamond under the candle in an
            uptrend, over it in a downtrend, in the trend's colour */}
        {zs && (
          <g clipPath={`url(#${clipId})`}>
            {zs.retests.map((r) => {
              const i = r.i - zs.off;
              if (!onScreen(i)) return null;
              const c = candles[i];
              const sz = (narrow ? 3.5 : 4) * fs;
              const cx = x(i);
              const cy = r.up ? y(c.low) + sz + 3 : y(c.high) - sz - 3;
              return (
                <path
                  key={`zr-${r.i}`}
                  d={`M${cx},${cy - sz} L${cx + sz},${cy} L${cx},${cy + sz} L${cx - sz},${cy} Z`}
                  fill={r.up ? COLORS.zsUp : COLORS.zsDown}
                  data-testid={`chart-zoneshift-retest-${r.up ? "up" : "down"}`}
                />
              );
            })}
          </g>
        )}

        {/* #129: Dow theory's level labels (each at the right end of its
            line), its swing labels (HH/HL up-coloured, LH/LL
            down-coloured), and ① on a first break, 確定 on the second, 取消
            when the old trend resumed first — under the candle for a break
            down, over it for a break up */}
        {dowDraw && (
          <g clipPath={`url(#${clipId})`} stroke="hsl(var(--background))" strokeWidth={2.5} strokeLinejoin="round" paintOrder="stroke">
            {dowLabels.map((r) => (
              <text
                key={r.id}
                data-testid={r.id}
                x={W - PAD_RIGHT - 2} y={r.ly}
                textAnchor="end" fontSize={r.bold ? labelSize : labelSize - 0.5} fontWeight={r.bold ? 700 : 400} fontFamily="monospace"
                fill={r.color}
              >
                {r.text}
              </text>
            ))}
            {dowDraw.swings.filter((sw) => sw.label !== null && onScreen(sw.i)).map((sw) => (
              <text
                key={`ds-${sw.i}-${sw.kind}`}
                x={x(sw.i)}
                y={sw.kind === "H" ? y(sw.price) - 3 : y(sw.price) + labelSize + 1}
                textAnchor="middle" fontSize={labelSize - 1} fontWeight="700" fontFamily="monospace"
                fill={sw.label === "HH" || sw.label === "HL" ? COLORS.up : COLORS.down}
                data-testid={`chart-dow-swing-${sw.label}`}
              >
                {sw.label}
              </text>
            ))}
            {dowDraw.events.filter((e) => onScreen(e.i)).map((e) => {
              const c = candles[e.i];
              const below = e.dir === "down";
              const color = e.kind === "cancel" ? COLORS.text : e.dir === "up" ? COLORS.up : COLORS.down;
              const size = e.kind === "break1" ? labelSize + 2 : labelSize;
              return (
                <text
                  key={`de-${e.i}-${e.kind}`}
                  x={x(e.i)}
                  y={below ? y(c.low) + size + 3 + (labelSize + 1) : y(c.high) - 4 - (labelSize + 1)}
                  textAnchor="middle" fontSize={size} fontWeight="700" fill={color}
                  data-testid={`chart-dow-${e.kind}-${e.dir}`}
                >
                  <title>{t.chart.dowEventTitle(e.kind, e.dir, e.level.toFixed(decimals))}</title>
                  {e.kind === "break1" ? t.chart.dowBreak1 : e.kind === "confirm" ? t.chart.dowConfirm : t.chart.dowCancel}
                </text>
              );
            })}
          </g>
        )}

        {/* #131: the Pro-style score's signals — a ringed P under the candle
            for a buy, over it for a sell (a row further out where a GA label
            sits on the same bar) */}
        {gp && (
          <g clipPath={`url(#${clipId})`}>
            {gp.signals.filter((sg) => onScreen(sg.i)).map((sg) => {
              const c = candles[sg.i];
              const buy = sg.side === "BUY";
              const r = (narrow ? 5 : 5.5) * fs;
              const gaHere = ov.signals && flags.some((f) => f.idx === sg.i && f.side === sg.side);
              const away = r + 3 + (gaHere ? labelH + 4 : 0);
              const cx = x(sg.i);
              const cy = buy ? y(c.low) + away : y(c.high) - away;
              const color = buy ? COLORS.up : COLORS.down;
              return (
                <g key={`gp-${sg.i}`} data-testid={`chart-gainzpro-signal-${sg.side}`}>
                  <title>{t.chart.gainzProTitle(sg.side, Math.round(sg.score * 100), Math.round(sg.rank * 100))}</title>
                  <circle cx={cx} cy={cy} r={r} fill="hsl(var(--background))" stroke={color} strokeWidth={1.3} />
                  <text x={cx} y={cy + r * 0.45} textAnchor="middle" fontSize={r * 1.3} fontWeight="700" fill={color}>P</text>
                </g>
              );
            })}
          </g>
        )}

        {/* #119: the SPECTRA-style Supertrend line, and a triangle on each
            closed bar where it turned and RSI agreed (▲ up under the low,
            ▼ down over the high) */}
        {kst && kstRuns.length > 0 && (
          <g data-testid="chart-kalman" clipPath={`url(#${clipId})`}>
            {kstRuns.map((r) => {
              // broken where the trend turns, as TradingView draws it
              let d = "";
              for (let i = r.from; i <= r.to; i++) {
                d += `${i === r.from ? "M" : "L"}${x(i).toFixed(1)},${y(kst.line[i] as number).toFixed(1)} `;
              }
              return (
                <path key={`kl-${r.from}`} d={d} fill="none" stroke={r.up ? COLORS.up : COLORS.down} strokeWidth={full ? 2 : 1.6} data-testid="chart-kalman-line" />
              );
            })}
            {kst.flips.filter((f) => f.passed && onScreen(f.i)).map((f) => {
              const c = candles[f.i];
              const buy = f.side === "BUY";
              const cx = x(f.i);
              const sz = (narrow ? 4 : 4.5) * fs;
              const cy = buy ? y(c.low) + sz + 3 : y(c.high) - sz - 3;
              const color = buy ? COLORS.up : COLORS.down;
              return (
                <g key={`kf-${f.i}`} data-testid={`chart-kalman-signal-${f.side}`}>
                  <title>{`SPECTRA ${f.side}${f.rsi !== null ? ` · RSI ${f.rsi.toFixed(1)}` : ""}`}</title>
                  <polygon
                    points={buy
                      ? `${cx},${cy - sz} ${cx - sz},${cy + sz * 0.8} ${cx + sz},${cy + sz * 0.8}`
                      : `${cx},${cy + sz} ${cx - sz},${cy - sz * 0.8} ${cx + sz},${cy - sz * 0.8}`}
                    fill={color}
                  />
                </g>
              );
            })}
          </g>
        )}

        {/* #136: SuperTrend's line (green under the price while up, red over
            it while down), and where it turned a dot on the line with a
            "Buy" label under it or a "Sell" label over it, as the original */}
        {st && stRuns.length > 0 && (
          <g data-testid="chart-supertrend" clipPath={`url(#${clipId})`}>
            {stRuns.map((r) => {
              let d = "";
              for (let i = Math.max(r.from, from); i <= Math.min(r.to, to - 1); i++) {
                d += `${d === "" ? "M" : "L"}${x(i).toFixed(1)},${y(st.line[i] as number).toFixed(1)} `;
              }
              return d === "" ? null : (
                <path key={`sl-${r.from}`} d={d} fill="none" stroke={r.up ? COLORS.up : COLORS.down} strokeWidth={full ? 2.2 : 1.8} data-testid="chart-supertrend-line" />
              );
            })}
            {st.signals.filter((s) => onScreen(s.i)).map((s) => {
              const buy = s.side === "BUY";
              const cx = x(s.i);
              const cy = y(s.price);
              const color = buy ? COLORS.up : COLORS.down;
              const text = buy ? "Buy" : "Sell";
              const fsz = (narrow ? 7.5 : 8.5) * fs;
              const w = text.length * fsz * 0.62 + 6;
              const h = fsz + 5;
              const ty = buy ? cy + 5 : cy - 5 - h;
              return (
                <g key={`ss-${s.i}`} data-testid={`chart-supertrend-signal-${s.side}`}>
                  <title>{`SuperTrend ${text}`}</title>
                  <circle cx={cx} cy={cy} r={2.4 * fs} fill={color} />
                  <polygon points={buy ? `${cx},${cy + 2} ${cx - 3},${ty} ${cx + 3},${ty}` : `${cx},${cy - 2} ${cx - 3},${ty + h} ${cx + 3},${ty + h}`} fill={color} />
                  <rect x={cx - w / 2} y={ty} width={w} height={h} rx="2" fill={color} />
                  <text x={cx} y={ty + h / 2 + fsz * 0.36} fontSize={fsz} textAnchor="middle" fill="#fff" fontWeight="600">{text}</text>
                </g>
              );
            })}
          </g>
        )}

        {/* #145: Q-Trend's line (3 wide in the original), each stretch in the
            colour of the bar it ends on, and its BUY / SELL / STRONG labels
            (under the candle for a buy, over it for a sell) */}
        {qt && ov.qTrend && (
          <g data-testid="chart-qtrend" clipPath={`url(#${clipId})`}>
            {(() => {
              const runs: Array<{ up: boolean; d: string }> = [];
              for (let i = Math.max(1, from - 1); i < Math.min(candles.length, to + 1); i++) {
                const a = qt.line[i - 1];
                const b = qt.line[i];
                if (a === null || b === null || a === undefined || b === undefined) continue;
                const upSeg = qt.trend[i] === 1;
                const seg = `M${x(i - 1).toFixed(1)},${y(a).toFixed(1)} L${x(i).toFixed(1)},${y(b).toFixed(1)} `;
                const lastRun = runs[runs.length - 1];
                if (lastRun && lastRun.up === upSeg) lastRun.d += seg;
                else runs.push({ up: upSeg, d: seg });
              }
              return runs.map((r, k) => (
                <path key={`qt-${k}`} d={r.d} fill="none" stroke={r.up ? COLORS.up : COLORS.down} strokeWidth={2.2 * fs} strokeLinecap="round" data-testid="chart-qtrend-line" />
              ));
            })()}
          </g>
        )}
        {qt && ov.qTrend && (
          <g data-testid="chart-qtrend-signals">
            {qt.signals.filter((sg) => onScreen(sg.i)).map((sg) => {
              const c = candles[sg.i];
              const cx = x(sg.i);
              const color = sg.side === "BUY" ? COLORS.up : COLORS.down;
              const text = sg.strong ? "STRONG" : sg.side;
              const fsz = qtFsz;
              const { top: ty, under, w, h } = qtPlaced.get(`qt-${sg.i}`)!;
              const tip = under ? y(c.low) + 2 : y(c.high) - 2;
              return (
                <g key={`qt-${sg.i}`} data-testid={`chart-qtrend-signal-${sg.side}${sg.strong ? "-strong" : ""}`}>
                  <title>{`Q-Trend ${sg.strong ? `STRONG ${sg.side}` : sg.side}`}</title>
                  <polygon points={under ? `${cx},${tip} ${cx - 3},${ty} ${cx + 3},${ty}` : `${cx},${tip} ${cx - 3},${ty + h} ${cx + 3},${ty + h}`} fill={color} />
                  <rect x={cx - w / 2} y={ty} width={w} height={h} rx="2" fill={color} />
                  <text x={cx} y={ty + h / 2 + fsz * 0.36} fontSize={fsz} textAnchor="middle" fill="#fff" fontWeight="600">{text}</text>
                </g>
              );
            })}
          </g>
        )}
        {/* #145: the video's triple confirmation — Q-Trend, the BLSH line
            and the BLSH area agreeing — an outlined badge beyond Q-Trend's
            label (under for a buy, over for a sell) */}
        {triple && (
          <g data-testid="chart-qtblsh">
            {triple.filter((sg) => onScreen(sg.i)).map((sg) => {
              const cx = x(sg.i);
              const color = sg.side === "BUY" ? COLORS.up : COLORS.down;
              const text = `3✓ ${sg.side}`;
              const fsz = qtFsz;
              const { top: ty, w, h } = qtPlaced.get(`tc-${sg.i}`)!;
              return (
                <g key={`tc-${sg.i}`} data-testid={`chart-qtblsh-signal-${sg.side}`}>
                  <title>{t.chart.qtBlshTitle(sg.side)}</title>
                  <rect x={cx - w / 2} y={ty} width={w} height={h} rx={h / 2} fill="hsl(var(--background))" stroke={color} strokeWidth={1.4} />
                  <text x={cx} y={ty + h / 2 + fsz * 0.36} fontSize={fsz} textAnchor="middle" fill={color} fontWeight="700">{text}</text>
                </g>
              );
            })}
          </g>
        )}

        {/* #143: EMA 50 (orange) and EMA 200 (purple) over the candles */}
        {emas && (
          <g data-testid="chart-ema" clipPath={`url(#${clipId})`}>
            {emas.lines.map((l) => {
              let d = "";
              let pen = false;
              for (let i = Math.max(0, from - 1); i < Math.min(candles.length, to + 1); i++) {
                const v = l.values[i + emas.off];
                if (v === null || !Number.isFinite(v)) {
                  pen = false;
                  continue;
                }
                d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
                pen = true;
              }
              return d ? <path key={l.key} d={d} fill="none" stroke={l.color} strokeWidth={1.5 * fs} opacity="0.9" data-testid={`chart-${l.key}-line`} /> : null;
            })}
          </g>
        )}

        {/* #137: UT Bot's "Buy" under the candle and "Sell" over it, as the
            original's labels (belowbar / abovebar) */}
        {ut && (
          <g data-testid="chart-utbot">
            {ut.signals.filter((s) => onScreen(s.i)).map((s) => {
              const c = candles[s.i];
              const buy = s.side === "BUY";
              const cx = x(s.i);
              const color = buy ? COLORS.up : COLORS.down;
              const text = buy ? "Buy" : "Sell";
              const fsz = (narrow ? 7.5 : 8.5) * fs;
              const w = text.length * fsz * 0.62 + 6;
              const h = fsz + 5;
              const tip = buy ? y(c.low) + 2 : y(c.high) - 2;
              const ty = buy ? tip + 4 : tip - 4 - h;
              return (
                <g key={`ut-${s.i}`} data-testid={`chart-utbot-signal-${s.side}`}>
                  <title>{`UT Bot ${text}`}</title>
                  <polygon points={buy ? `${cx},${tip} ${cx - 3},${ty} ${cx + 3},${ty}` : `${cx},${tip} ${cx - 3},${ty + h} ${cx + 3},${ty + h}`} fill={color} />
                  <rect x={cx - w / 2} y={ty} width={w} height={h} rx="2" fill={color} />
                  <text x={cx} y={ty + h / 2 + fsz * 0.36} fontSize={fsz} textAnchor="middle" fill="#fff" fontWeight="600">{text}</text>
                </g>
              );
            })}
          </g>
        )}

        {/* #99: the lines through the last two swings, extended to the right
            edge and clipped to the plot. Labelled at the swing they start
            from, in the same register as the measured levels. */}
        {ov.trendLines && trendLines.map((l) => {
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
        {showSarDots && sar && (
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
        {ov.signals && shown.map((f, n) => {
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
      </div>
      {/* #117: the stochastic's lengths, opened from its gear in the list
          (#119; in full screen the gear opens the settings sheet) */}
      {!full && stochSettings && <div className="px-1 pt-1">{stochForm}</div>}
      {/* #104: RSI under the price, on the same x scale so a bar here is the
          bar above it. The two outer lines are the rule's levels (#132: 25/75) */}
      {showRsi && rsi && strip({
        testid: "chart-rsi",
        aria: t.chart.rsiLabel,
        label: t.chart.rsiLabel,
        lines: [{ name: "", values: rsi, color: COLORS.entry }],
        levels: [
          { v: RSI_SAR_LEVELS.sell, color: COLORS.down, dash: "4 3", opacity: 0.75 },
          { v: 50, color: COLORS.grid, dash: "2 3", opacity: 0.5 },
          { v: RSI_SAR_LEVELS.buy, color: COLORS.up, dash: "4 3", opacity: 0.75 },
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
      {/* #135: Bollinger %b as TradingView draws it — a blue line, dashed
          lines at 1, 0.5 and 0, the space between the bands blue, above
          the upper one red and below the lower one green; its scale follows
          what is on screen, always showing 0 to 1 */}
      {showPctB && pctB && (() => {
        const seen = pctB.slice(from, to).filter((v): v is number => v !== null && Number.isFinite(v));
        const min = Math.min(PCTB_LEVELS.lower, ...seen) - 0.1;
        const max = Math.max(PCTB_LEVELS.upper, ...seen) + 0.1;
        return strip({
          testid: "chart-pctb",
          aria: t.chart.pctB.name(PCTB_DEFAULTS.length, PCTB_DEFAULTS.mult),
          label: t.chart.pctB.name(PCTB_DEFAULTS.length, PCTB_DEFAULTS.mult),
          lines: [{ name: "", values: pctB, color: COLORS.pctB }],
          levels: [
            { v: PCTB_LEVELS.upper, color: COLORS.down, dash: "4 3", opacity: 0.75 },
            { v: PCTB_LEVELS.middle, color: COLORS.pctB, dash: "4 3", opacity: 0.6 },
            { v: PCTB_LEVELS.lower, color: COLORS.up, dash: "4 3", opacity: 0.75 },
          ],
          bands: [
            { key: "over", from: PCTB_LEVELS.upper, to: max, color: COLORS.down, opacity: 0.08 },
            { key: "in", from: PCTB_LEVELS.lower, to: PCTB_LEVELS.upper, color: COLORS.stochBand, opacity: 0.1 },
            { key: "under", from: min, to: PCTB_LEVELS.lower, color: COLORS.up, opacity: 0.08 },
          ],
          range: { min, max },
          digits: 2,
          levelText: (v) => v.toFixed(2),
        });
      })()}
      {/* #135: RCI as TradingView draws it — a blue line, its 14-bar average
          yellow, dashed lines at +80, 0 and −80 and the band between them */}
      {showRci && rciRead && strip({
        testid: "chart-rci",
        aria: t.chart.rci.name(RCI_DEFAULTS.length),
        label: t.chart.rci.name(RCI_DEFAULTS.length),
        lines: [
          { name: "", values: rciRead.rci, color: COLORS.rci },
          { name: "MA", values: rciRead.ma, color: COLORS.rciMa, tagText: "#131722" },
        ],
        levels: [
          { v: RCI_LEVELS.upper, color: COLORS.text, dash: "4 3", opacity: 0.8 },
          { v: RCI_LEVELS.middle, color: COLORS.text, dash: "1.5 3", opacity: 0.45 },
          { v: RCI_LEVELS.lower, color: COLORS.text, dash: "4 3", opacity: 0.8 },
        ],
        band: { from: RCI_LEVELS.lower, to: RCI_LEVELS.upper, color: COLORS.stochBand, opacity: 0.1 },
        range: { min: -100, max: 100 },
      })}
      {/* #145: BLSH as the video shows it — the composite as an area (green
          over 0, red at or under), the MACD signal line yellow while MACD is
          at or over it and blue while under, a dotted line at 0; its scale
          follows what is on screen, always showing −1 to +1 */}
      {showBlsh && blshRead && (() => {
        const seen = [...blshRead.composite.slice(from, to), ...blshRead.line.slice(from, to)].filter((v): v is number => v !== null && Number.isFinite(v));
        const min = Math.min(-1, ...seen) - 0.05;
        const max = Math.max(1, ...seen) + 0.05;
        const yellow = prefs.theme === "light" ? COLORS.blshLineUpLight : COLORS.blshLineUp;
        const lineColor = (u: boolean | null | undefined) => (u === null || u === undefined ? null : u ? yellow : COLORS.blshLineDown);
        return strip({
          testid: "chart-blsh",
          aria: t.chart.blsh.name,
          label: t.chart.blsh.name,
          lines: [
            {
              name: "",
              values: blshRead.composite,
              color: COLORS.blshUp,
              hidden: true,
              colorAt: (i) => ((blshRead.composite[i] ?? 0) > 0 ? COLORS.blshUp : COLORS.blshDown),
            },
            {
              name: "MACD",
              values: blshRead.line,
              color: yellow,
              colors: blshRead.lineUp.map(lineColor),
              colorAt: (i) => lineColor(blshRead.lineUp[i]) ?? yellow,
              // dark on the yellow, white on the blue
              tagText: (fill) => (fill === COLORS.blshLineDown ? "#fff" : "#131722"),
            },
          ],
          levels: [{ v: 0, color: COLORS.text, dash: "1.5 3", opacity: 0.6 }],
          area: { values: blshRead.composite, base: 0, up: COLORS.blshUp, down: COLORS.blshDown, opacity: 0.5 },
          range: { min, max },
          digits: 2,
        });
      })()}
    </>
  );

  if (full && typeof document !== "undefined") return fullscreenLayer(charts);

  // #144: the chart first, and what it all means folded under it
  return (
    <div ref={setBoxEl} className={`glass rounded-xl border border-border p-3 ${themeClass}`} data-theme={prefs.theme}>
      {header}
      {indicatorPanel}
      {charts}
      <details className="mt-2 px-1" data-testid="chart-notes">
        <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">{t.chart.notesTitle}</summary>
        <div className="pt-1">{legends}</div>
      </details>
    </div>
  );
};

export default PriceChart;
