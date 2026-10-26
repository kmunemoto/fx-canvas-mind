// This file is subject to the terms of the Mozilla Public License 2.0 at
// https://mozilla.org/MPL/2.0/ — it is a TypeScript port of the open-source
// Pine Script "AMD Po3 with Live Edge Stats [WillyAlgoTrader]" by Willy |
// WillyAlgoTrader (TradingView script hkKioUnL, version 2.4.0), whose code is
// published without a licence header, so under TradingView's default (MPL 2.0).
//
// #385: the owner asked for this indicator (2026-10-26): 「これと全く同じものを
// 追加して。これでもチャートを分析できる様に。エントリーのタイミングが来たらこれ
// も設定でメールが届く様にもして。」 — asked back once, the owner chose to see it
// drawn on the chart like the original. The chart (src/lib/amdPo3.ts re-exports
// this file) and the email (signal-alerts/indicators.ts, at the DIST event —
// "manipulation confirmed, reference trade opened — the working signal") run
// this same code (docs §8.128).
//
// The port follows the published code line by line, at its DEFAULT settings
// (boundary method "pivot"; HTF bias, killzones, the liquidity filter and the
// depth cap off — so re-arm is inert; outline the last 3 cycles; stats
// All-Time). The other settings are not offered here.
//
//   * ACCUMULATION: after the stats window has warmed up (bar 220), when the
//     width of the 20-bar Donchian channel sits in the bottom 25% of its last
//     200 values and is at least 0.15% of the close (10 bars after the last
//     cycle ended), the window's oldest bars are trimmed while each removal
//     narrows it by more than 15% (down to 13 bars); its boundaries are the
//     highest pivot high / lowest pivot low (3 bars each side) inside it.
//   * MANIPULATION: a breach beyond a boundary by more than 10% of the width,
//     once the range is 12 bars old, with a close back inside within 6 bars.
//     Both sides at once, the other side while waiting, no return in time, or
//     96 bars without a sweep end the range.
//   * DISTRIBUTION: the reference trade opens at the close of the bar where the
//     price returned (D ▲ / D ▼): stop beyond the sweep's extreme by 0.4 × ATR
//     14 (taken on the bar before the range), target at the 1.5 extension of
//     the manipulation leg (0 = the sweep's tip, 1 = the opposite boundary).
//     It ends at the target, the stop (both on one bar counts as the stop) or
//     after 64 bars, and is scored in R.
//
// Pine's runtime is reproduced as measured by PyneCore (github.com/PyneSys/
// pynecore): float comparisons written in a script are tolerant (|a − b| ≤
// 1e-10 counts as equal); ta.pivothigh keeps the newest of equal highs;
// ta.percentrank counts the previous values ≤ the current one; str.tostring
// rounds half up on the shortest decimal digits. These are PyneCore's
// measurements, not this app's.
//
// Deno-free: src/test imports it.

import { pineAtr } from "./pine.ts";

export const AMD_PO3 = {
  version: "v2.4.0",
  minRangeBars: 12,
  maxRangeBars: 96,
  compressionPct: 25,
  statWindow: 200,
  rangeTolerance: 0.10,
  minRangeWidthP: 0.15,
  trimTailPct: 15,
  sweepReturnBars: 6,
  distTimeoutBars: 64,
  stopBufAtr: 0.4,
  fibExt: 1.5,
  showLastCycles: 3,
  minSampleN: 10,
  // constants of the script
  lineUpdateBars: 5,
  labelOffsetBars: 1,
  formLen: 10,
  cooldownBars: 10,
  rangeWin: 20,
  pivotLR: 3,
  pivotCap: 60,
} as const;

export type AmdBar = { t?: number; o: number; h: number; l: number; c: number };
// a Pine color: ["#RRGGBB", transparency 0..100]
export type PineColor = [string, number];
export type AmdLineStyle = "solid" | "dashed" | "dotted";
export type AmdLabelStyle = "label_up" | "label_down" | "label_left";
export type AmdPhase = "idle" | "accum" | "sweepPending" | "manip" | "dist";

export interface AmdBox {
  cycle: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  border: PineColor;
  borderStyle: AmdLineStyle;
  borderWidth: number;
  bg: PineColor | null;
}
export interface AmdLine {
  cycle: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: PineColor;
  style: AmdLineStyle;
  width: number;
}
export interface AmdLabel {
  cycle: number;
  x: number;
  y: number;
  text: string;
  style: AmdLabelStyle;
  color: PineColor;
  textColor: PineColor;
  tooltip: string | null;
}
export type AmdEvent =
  | { bar: number; cycle: number; type: "ACCUM"; start: number; high: number; low: number; tol: number; atrAnchor: number; winLast: number }
  | { bar: number; cycle: number; type: "EXPIRED" | "NEWS" | "EARLY" | "FILTERED" | "TWO_SIDE" | "TOO_DEEP" | "BREAKOUT" | "FAILED" }
  | { bar: number; cycle: number; type: "RANGE_HIGH" | "RANGE_LOW"; value: number }
  | { bar: number; cycle: number; type: "SWEEP"; side: 1 | -1; extreme: number }
  | { bar: number; cycle: number; type: "MANIP"; extremeBar: number; extreme: number }
  | { bar: number; cycle: number; type: "DIST"; dir: 1 | -1; entry: number; stop: number; target: number; riskR: number }
  | { bar: number; cycle: number; type: "OUTCOME"; kind: "target" | "stop" | "ambiguous" | "timeout"; rr: number };
export type AmdDist = Extract<AmdEvent, { type: "DIST" }>;

export interface AmdStats {
  tgtN: number;
  stopN: number;
  timeoutN: number;
  ambigN: number;
  failN: number;
  brkN: number;
  expN: number;
  newsN: number;
  earlyN: number;
  filtN: number;
  sumR: number;
  dsN: number;
  dsSumR: number;
  formStr: string;
}
export interface AmdDashRow {
  l: string;
  r: string | null;
  lc: PineColor;
  rc: PineColor | null;
  bg: PineColor;
}
export interface AmdPo3Result {
  events: AmdEvent[];
  boxes: AmdBox[];
  lines: AmdLine[];
  labels: AmdLabel[];
  stats: AmdStats;
  final: { state: AmdPhase; cycleId: number; lastEndBar: number; rangeHigh: number | null; rangeLow: number | null };
  dash: AmdDashRow[];
  // the reference trade live after the last bar (state DISTRIBUTION)
  live: { dir: 1 | -1; sweepSide: 1 | -1; entry: number; stop: number; target: number; riskR: number; startBar: number } | null;
}

export interface AmdPo3Options {
  // syminfo.mintick: 0.001 (yen pairs), 0.00001 (other pairs), 0.01 (gold)
  mintick: number;
  theme?: "dark" | "light";
  // timeframe.period: "1", "5", "15", "30", "60", "240", "D", "W", "M"
  tf?: string;
  // bars 0 .. confirmed-1 are closed (barstate.isconfirmed); the default is
  // all of them. The forming last bar only extends the live objects.
  confirmed?: number;
}

// ── Pine runtime ───────────────────────────────────────────────────────────
const EPS = 1e-10;
const gt = (a: number, b: number) => a - b > EPS;
const lt = (a: number, b: number) => b - a > EPS;
const ge = (a: number, b: number) => a - b >= -EPS;
const le = (a: number, b: number) => a - b <= EPS;
const neq = (a: number, b: number) => !(Math.abs(a - b) <= EPS);
const na = (x: number) => Number.isNaN(x);

// math.round: half away from zero
const pineRound = (x: number) => (x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5));

// str.tostring(v, "#.##" | "#.#" | "#"): half up on the shortest digits
export const pineFmt = (v: number, decimals: number): string => {
  if (na(v)) return "NaN";
  const a = Math.abs(v);
  let res: string;
  if (a !== 0 && a < 1e-4) res = "0";
  else {
    const s = String(a);
    const dot = s.indexOf(".");
    const ip = dot < 0 ? s : s.slice(0, dot);
    const fp = dot < 0 ? "" : s.slice(dot + 1);
    if (fp.length <= decimals) res = s;
    else {
      let keep = ip + fp.slice(0, decimals);
      if (fp[decimals] >= "5") keep = (BigInt(keep) + 1n).toString().padStart(keep.length, "0");
      res = decimals === 0 ? keep : `${keep.slice(0, keep.length - decimals)}.${keep.slice(keep.length - decimals)}`;
    }
    if (decimals > 0 && res.includes(".")) res = res.replace(/0+$/, "").replace(/\.$/, "");
  }
  return v < 0 && /[1-9]/.test(res) ? `-${res}` : res;
};

// str.tostring(v, format.mintick): whole ticks (half away from zero), all
// the tick's decimals kept
export const pineFmtTick = (v: number, mintick: number): string => {
  if (na(v)) return "—";
  const d = Math.max(0, Math.round(-Math.log10(mintick)));
  const n = Math.abs(v) / mintick;
  let count = Math.floor(n);
  if (n - count >= 0.5) count += 1;
  let s = String(count);
  if (d > 0) {
    s = s.padStart(d + 1, "0");
    s = `${s.slice(0, s.length - d)}.${s.slice(s.length - d)}`;
  }
  return v < 0 && count > 0 ? `-${s}` : s;
};

const hexRgb = (hex: string) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
// f_textOn: dark text on light backgrounds, white on dark ones
const textOn = (c: PineColor): PineColor => {
  const [r, g, b] = hexRgb(c[0]);
  return 0.299 * r + 0.587 * g + 0.114 * b > 145 ? ["#111827", 0] : ["#FFFFFF", 0];
};
const cn = (c: PineColor, t: number): PineColor => [c[0], t];

const GRAY: PineColor = ["#787B86", 0];
const COL_ACC: PineColor = ["#5B7FA6", 80];
const COL_MAN: PineColor = ["#E2963A", 55];
const COL_STOP: PineColor = ["#C94F4F", 0];
const COL_TGT: PineColor = ["#3AA66B", 0];
const COL_DST: PineColor = ["#3AA66B", 82];

export const amdPo3Theme = (dark: boolean) => ({
  TEXT_COLOR: [dark ? "#E0E0E0" : "#1A1A1A", 0] as PineColor,
  TEXT_MUTED: [dark ? "#9E9E9E" : "#757575", 0] as PineColor,
  TABLE_BG: [dark ? "#131722" : "#FFFFFF", 5] as PineColor,
  TABLE_BORDER: [dark ? "#2A2E39" : "#D0D0D0", 0] as PineColor,
  TABLE_ROW_ALT: [dark ? "#1C2030" : "#F0F4F8", 0] as PineColor,
  HEADER_BG: [dark ? "#0D47A1" : "#1565C0", 0] as PineColor,
  HEADER_BG_BULL: ["#0F6E56", 0] as PineColor,
  HEADER_BG_BEAR: ["#A32D2D", 0] as PineColor,
  HEADER_TEXT: ["#FFFFFF", 0] as PineColor,
  ENTRY_COLOR: [dark ? "#5C8AAE" : "#34495E", 0] as PineColor,
  TGT_HIT_COLOR: [dark ? "#4DB6AC" : "#00695C", 0] as PineColor,
  WM_COLOR: [dark ? "#FFFFFF" : "#000000", 80] as PineColor,
  BULL_TEXT: [dark ? "#00E676" : "#00A152", 0] as PineColor,
  BEAR_TEXT: [dark ? "#FF5252" : "#D32F2F", 0] as PineColor,
  NEUTRAL_TEXT: [dark ? "#FFEB3B" : "#F57F17", 0] as PineColor,
});

// buildGauge
const gauge = (value: number, maxVal: number, width: number) => {
  const filled = le(maxVal, 0) ? 0 : pineRound(Math.min(width, Math.max(0.0, (value / maxVal) * width)));
  let s = "";
  for (let i = 0; i < width; i++) s += i < filled ? "▰" : "▱";
  return s;
};

// ── base series (every bar) ────────────────────────────────────────────────
interface Series {
  atr14: number[];
  hi20: number[];
  lo20: number[];
  chW: number[];
  pctRank: number[];
  ph: number[];
  pl: number[];
}

const baseSeries = (bars: readonly AmdBar[], mintick: number): Series => {
  const n = bars.length;
  const P = AMD_PO3;
  const atr = pineAtr(bars.map((b) => ({ high: b.h, low: b.l, close: b.c })), 14);
  const atr14 = new Array<number>(n);
  const hi20 = new Array<number>(n).fill(NaN);
  const lo20 = new Array<number>(n).fill(NaN);
  const chW = new Array<number>(n).fill(NaN);
  const pctRank = new Array<number>(n).fill(NaN);
  const ph = new Array<number>(n).fill(NaN);
  const pl = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const tr = i === 0
      ? b.h - b.l
      : Math.max(Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c)), Math.abs(b.l - bars[i - 1].c));
    const a = atr[i];
    atr14[i] = Math.max(a === null ? tr : a, mintick);
    if (i >= P.rangeWin - 1) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = i - P.rangeWin + 1; k <= i; k++) {
        hi = Math.max(hi, bars[k].h);
        lo = Math.min(lo, bars[k].l);
      }
      hi20[i] = hi;
      lo20[i] = lo;
      chW[i] = hi - lo;
    }
    if (i >= P.statWindow && !na(chW[i])) {
      let count = 0;
      for (let j = 1; j <= P.statWindow; j++) {
        const w = chW[i - j];
        if (!na(w) && w - chW[i] <= EPS) count++;
      }
      pctRank[i] = (count * 100) / P.statWindow;
    }
    const L = P.pivotLR;
    if (i >= 2 * L) {
      const hc = bars[i - L].h;
      let isPh = true;
      for (let k = 1; k <= L && isPh; k++) if (!(hc > bars[i - L + k].h) || !(hc >= bars[i - L - k].h)) isPh = false;
      if (isPh) ph[i] = hc;
      const lc = bars[i - L].l;
      let isPl = true;
      for (let k = 1; k <= L && isPl; k++) if (!(lc < bars[i - L + k].l) || !(lc <= bars[i - L - k].l)) isPl = false;
      if (isPl) pl[i] = lc;
    }
  }
  return { atr14, hi20, lo20, chW, pctRank, ph, pl };
};

const PHASE_NAME: Record<AmdPhase, string> = {
  idle: "IDLE",
  accum: "ACCUMULATION",
  sweepPending: "SWEEP?",
  manip: "?",
  dist: "DISTRIBUTION",
};

// ── the indicator ──────────────────────────────────────────────────────────
export const amdPo3 = (bars: readonly AmdBar[], opts: AmdPo3Options): AmdPo3Result => {
  const P = AMD_PO3;
  const mintick = opts.mintick;
  const n = bars.length;
  const confirmedN = Math.min(n, opts.confirmed ?? n);
  const T = amdPo3Theme(opts.theme !== "light");
  const tf = opts.tf ?? "15";
  const S = baseSeries(bars, mintick);
  const tickRound = (p: number) => pineRound(p / mintick) * mintick;
  const tickOut = (p: number, up: boolean) => (up ? Math.ceil(p / mintick) : Math.floor(p / mintick)) * mintick;
  const fmtPrice = (v: number) => pineFmtTick(v, mintick);
  const pctFromEntry = (level: number, entry: number) => {
    if (na(level) || na(entry) || !neq(entry, 0)) return "";
    const pct = ((level - entry) / entry) * 100.0;
    return ` (${ge(pct, 0) ? "+" : ""}${pineFmt(pct, 2)}%)`;
  };

  const events: AmdEvent[] = [];
  const boxes: AmdBox[] = [];
  const lines: AmdLine[] = [];
  const labels: AmdLabel[] = [];

  // pivot registry
  const pivHiV: number[] = [];
  const pivHiB: number[] = [];
  const pivLoV: number[] = [];
  const pivLoB: number[] = [];

  let state: AmdPhase = "idle";
  let cycleId = 0;
  let lastEndBar = -100;
  let rangeHigh = NaN;
  let rangeLow = NaN;
  let rangeMid = NaN;
  let tolPx = NaN;
  let rangeStartBar = NaN;
  let expiryAnchor = NaN;
  let rangeAge = 0;
  let atrAnchor = NaN;
  let sweepSide: 1 | -1 | 0 = 0;
  let firstSweepSide: 1 | -1 | 0 = 0;
  let sweepExtreme = NaN;
  let sweepBar = NaN;
  let depthCapPx = NaN;
  let sweepExtremeBar = NaN;
  let rearmUsed = false;
  let distDir: 1 | -1 | 0 = 0;
  let entryPrice = NaN;
  let stopPrice = NaN;
  let tgtPrice = NaN;
  let riskR = NaN;
  let distStartBar = NaN;
  let distHi = NaN;
  let distLo = NaN;
  const st: AmdStats = {
    tgtN: 0, stopN: 0, timeoutN: 0, ambigN: 0, failN: 0, brkN: 0,
    expN: 0, newsN: 0, earlyN: 0, filtN: 0, sumR: 0.0, dsN: 0, dsSumR: 0.0, formStr: "",
  };

  let accBox: AmdBox | null = null;
  let swBox: AmdBox | null = null;
  let manLab: AmdLabel | null = null;
  let dstBox: AmdBox | null = null;
  let stopLn: AmdLine | null = null;
  let tgtLn: AmdLine | null = null;
  let entLn: AmdLine | null = null;
  let entLab: AmdLabel | null = null;
  let stopLab: AmdLabel | null = null;
  let tgtLab: AmdLabel | null = null;

  const newBox = (left: number, top: number, right: number, bottom: number, border: PineColor, borderStyle: AmdLineStyle, bg: PineColor | null) => {
    const b: AmdBox = { cycle: cycleId, left, top, right, bottom, border, borderStyle, borderWidth: 1, bg };
    boxes.push(b);
    return b;
  };
  const newLine = (x1: number, y: number, color: PineColor, style: AmdLineStyle, width: number) => {
    const l: AmdLine = { cycle: cycleId, x1, y1: y, x2: x1 + P.lineUpdateBars, y2: y, color, style, width };
    lines.push(l);
    return l;
  };
  const newLabel = (x: number, y: number, text: string, style: AmdLabelStyle, color: PineColor, textColor: PineColor, tooltip: string | null = null) => {
    const l: AmdLabel = { cycle: cycleId, x, y, text, style, color, textColor, tooltip };
    labels.push(l);
    return l;
  };
  // f_trim (history style "outline")
  const trim = () => {
    const cutoff = cycleId - P.showLastCycles;
    const hardCut = cycleId - P.showLastCycles * 3;
    for (let i = 0; i < boxes.length;) {
      const c = boxes[i].cycle;
      if (c <= hardCut) boxes.splice(i, 1);
      else {
        if (c <= cutoff) boxes[i].bg = null;
        i++;
      }
    }
    for (let i = 0; i < lines.length;) {
      const c = lines[i].cycle;
      if (c <= hardCut) lines.splice(i, 1);
      else {
        if (c <= cutoff) lines[i].color = cn(GRAY, 70);
        i++;
      }
    }
    for (let i = 0; i < labels.length;) {
      const c = labels[i].cycle;
      if (c <= hardCut) labels.splice(i, 1);
      else {
        if (c <= cutoff) {
          labels[i].color = cn(GRAY, 85);
          labels[i].textColor = cn(GRAY, 55);
        }
        i++;
      }
    }
  };
  const end = (i: number) => {
    state = "idle";
    lastEndBar = i;
    trim();
  };
  const manLabel = () =>
    newLabel(sweepExtremeBar, sweepExtreme, "M", sweepSide === 1 ? "label_down" : "label_up", cn(COL_MAN, 20), textOn(COL_MAN));

  for (let i = 0; i < n; i++) {
    const { o, h, l, c } = bars[i];
    const ph = S.ph[i];
    const pl = S.pl[i];
    if (!na(ph)) {
      pivHiV.push(ph);
      pivHiB.push(i - P.pivotLR);
      if (pivHiV.length > P.pivotCap) {
        pivHiV.shift();
        pivHiB.shift();
      }
    }
    if (!na(pl)) {
      pivLoV.push(pl);
      pivLoB.push(i - P.pivotLR);
      if (pivLoV.length > P.pivotCap) {
        pivLoV.shift();
        pivLoB.shift();
      }
    }
    const warmedUp = i >= P.statWindow + P.rangeWin;
    const tolBand = na(tolPx) ? 0 : tolPx;
    const insideRng = !na(rangeHigh) && le(c, rangeHigh) && ge(c, rangeLow);
    const breachHigh = !na(rangeHigh) && gt(h, rangeHigh + tolBand);
    const breachLow = !na(rangeLow) && lt(l, rangeLow - tolBand);
    const confirmed = i < confirmedN;

    if (confirmed) {
      if (state === "idle") {
        // T1: IDLE → ACCUMULATION
        if (warmedUp && gt(c, 0) && le(S.pctRank[i], P.compressionPct) && ge(S.chW[i], (P.minRangeWidthP / 100) * c) && i - lastEndBar >= P.cooldownBars) {
          let winLast = P.rangeWin - 1;
          let tHi = S.hi20[i];
          let tLo = S.lo20[i];
          let keepTrim = true;
          while (keepTrim && winLast > P.minRangeBars) {
            let hi2 = h;
            let lo2 = l;
            for (let k = 0; k <= winLast - 1; k++) {
              hi2 = Math.max(hi2, bars[i - k].h);
              lo2 = Math.min(lo2, bars[i - k].l);
            }
            if (gt((tHi - tLo) - (hi2 - lo2), (P.trimTailPct / 100.0) * (tHi - tLo))) {
              winLast -= 1;
              tHi = hi2;
              tLo = lo2;
            } else keepTrim = false;
          }
          const candStart = i - winLast;
          let candHigh = tHi;
          let candLow = tLo;
          let bestHi = NaN;
          let bestLo = NaN;
          for (let j = 0; j < pivHiV.length; j++) if (pivHiB[j] >= candStart) bestHi = na(bestHi) ? pivHiV[j] : Math.max(bestHi, pivHiV[j]);
          for (let j = 0; j < pivLoV.length; j++) if (pivLoB[j] >= candStart) bestLo = na(bestLo) ? pivLoV[j] : Math.min(bestLo, pivLoV[j]);
          candHigh = na(bestHi) ? candHigh : bestHi;
          candLow = na(bestLo) ? candLow : bestLo;
          const candW = candHigh - candLow;
          if (ge(candW, (P.minRangeWidthP / 100) * c) && le(c, candHigh) && ge(c, candLow)) {
            rangeStartBar = candStart;
            expiryAnchor = candStart;
            rangeHigh = candHigh;
            rangeLow = candLow;
            tolPx = candW * P.rangeTolerance;
            rangeMid = (candHigh + candLow) / 2;
            rangeAge = winLast;
            atrAnchor = i - (winLast + 1) >= 0 ? S.atr14[i - (winLast + 1)] : NaN;
            rearmUsed = false;
            firstSweepSide = 0;
            cycleId += 1;
            trim();
            accBox = newBox(rangeStartBar, rangeHigh, i, rangeLow, cn(COL_ACC, 0), "dashed", COL_ACC);
            state = "accum";
            events.push({ bar: i, cycle: cycleId, type: "ACCUM", start: candStart, high: rangeHigh, low: rangeLow, tol: tolPx, atrAnchor, winLast });
          }
        }
      } else if (state === "accum") {
        // T2 / T3
        rangeAge = i - rangeStartBar;
        if (i - expiryAnchor > P.maxRangeBars) {
          st.expN += 1;
          if (accBox) {
            accBox.right = i;
            accBox.border = cn(GRAY, 40);
          }
          newLabel(i, rangeMid, "EXPIRED", "label_left", cn(GRAY, 70), T.TEXT_MUTED);
          events.push({ bar: i, cycle: cycleId, type: "EXPIRED" });
          end(i);
        } else if (breachHigh && breachLow) {
          st.newsN += 1;
          if (accBox) accBox.right = i;
          newLabel(i, c, "NEWS BAR", "label_left", cn(GRAY, 70), T.TEXT_MUTED);
          events.push({ bar: i, cycle: cycleId, type: "NEWS" });
          end(i);
        } else if (breachHigh || breachLow) {
          const side: 1 | -1 = breachHigh ? 1 : -1;
          if (rangeAge < P.minRangeBars) {
            st.earlyN += 1;
            if (accBox) accBox.right = i;
            events.push({ bar: i, cycle: cycleId, type: "EARLY" });
            end(i);
          } else {
            const sameSideBlock = rearmUsed && side === firstSweepSide;
            // killzones, the depth cap and the liquidity filter are off by default
            if (!sameSideBlock) {
              // T3: → SWEEP_PENDING
              if (accBox) accBox.right = i;
              sweepSide = side;
              sweepBar = i;
              sweepExtreme = side === 1 ? h : l;
              sweepExtremeBar = i;
              depthCapPx = NaN;
              if (firstSweepSide === 0) firstSweepSide = side;
              swBox = newBox(sweepBar, side === 1 ? sweepExtreme : rangeLow, i, side === 1 ? rangeHigh : sweepExtreme, cn(COL_MAN, 20), "dashed", cn(COL_MAN, 75));
              state = "sweepPending";
              events.push({ bar: i, cycle: cycleId, type: "SWEEP", side, extreme: sweepExtreme });
              // same-bar return (wick sweep): straight to T4a
              if (insideRng) {
                state = "manip";
                swBox.borderStyle = "solid";
                swBox.bg = cn(COL_MAN, 55);
                manLab = manLabel();
                events.push({ bar: i, cycle: cycleId, type: "MANIP", extremeBar: sweepExtremeBar, extreme: sweepExtreme });
              }
            } else if (!insideRng) {
              st.filtN += 1;
              if (accBox) accBox.right = i;
              events.push({ bar: i, cycle: cycleId, type: "FILTERED" });
              end(i);
            }
          }
        } else {
          // T2-stay, pivot mode: a new confirmed pivot inside the tolerance
          if (!na(ph) && i - P.pivotLR >= rangeStartBar && gt(ph, rangeHigh) && le(ph, rangeHigh + tolBand)) {
            rangeHigh = ph;
            rangeMid = (rangeHigh + rangeLow) / 2;
            if (accBox) accBox.top = rangeHigh;
            events.push({ bar: i, cycle: cycleId, type: "RANGE_HIGH", value: rangeHigh });
          }
          if (!na(pl) && i - P.pivotLR >= rangeStartBar && lt(pl, rangeLow) && ge(pl, rangeLow - tolBand)) {
            rangeLow = pl;
            rangeMid = (rangeHigh + rangeLow) / 2;
            if (accBox) accBox.bottom = rangeLow;
            events.push({ bar: i, cycle: cycleId, type: "RANGE_LOW", value: rangeLow });
          }
        }
      } else if (state === "sweepPending") {
        // T4b: the sweep deepens
        const prevExtreme = sweepExtreme;
        sweepExtreme = sweepSide === 1 ? Math.max(sweepExtreme, h) : Math.min(sweepExtreme, l);
        if (neq(sweepExtreme, prevExtreme)) sweepExtremeBar = i;
        if (swBox) {
          if (sweepSide === 1) swBox.top = sweepExtreme;
          else swBox.bottom = sweepExtreme;
        }
        const oppBreach = sweepSide === 1 ? lt(l, rangeLow - tolBand) : gt(h, rangeHigh + tolBand);
        const curExc = sweepSide === 1 ? sweepExtreme - rangeHigh : rangeLow - sweepExtreme;
        const depthBust = !na(depthCapPx) && gt(curExc, depthCapPx);
        if (oppBreach) {
          st.newsN += 1;
          if (swBox) swBox.right = i;
          newLabel(i, c, "2-SIDE", "label_left", cn(GRAY, 70), T.TEXT_MUTED);
          events.push({ bar: i, cycle: cycleId, type: "TWO_SIDE" });
          end(i);
        } else if (depthBust) {
          st.brkN += 1;
          if (swBox) swBox.right = i;
          newLabel(i, sweepExtreme, "TOO DEEP", sweepSide === 1 ? "label_down" : "label_up", cn(GRAY, 30), textOn(GRAY));
          events.push({ bar: i, cycle: cycleId, type: "TOO_DEEP" });
          end(i);
        } else if (i - sweepBar > P.sweepReturnBars) {
          // T4c: BREAKOUT
          st.brkN += 1;
          if (swBox) swBox.right = i;
          newLabel(i, sweepExtreme, "BREAKOUT", sweepSide === 1 ? "label_down" : "label_up", cn(GRAY, 30), textOn(GRAY));
          events.push({ bar: i, cycle: cycleId, type: "BREAKOUT" });
          end(i);
        } else if (insideRng) {
          // T4a: manipulation confirmed
          state = "manip";
          if (swBox) {
            swBox.right = i;
            swBox.borderStyle = "solid";
            swBox.bg = cn(COL_MAN, 55);
          }
          manLab = manLabel();
          events.push({ bar: i, cycle: cycleId, type: "MANIP", extremeBar: sweepExtremeBar, extreme: sweepExtreme });
        }
      } else if (state === "dist") {
        // T7: outcomes, from the bar after the D bar
        if (i - distStartBar >= 1) {
          const hitT = distDir === 1 ? ge(h, tgtPrice) : le(l, tgtPrice);
          const hitS = distDir === 1 ? le(l, stopPrice) : ge(h, stopPrice);
          const timedOut = i - distStartBar >= P.distTimeoutBars;
          if (hitT || hitS || timedOut) {
            let outcome = "";
            let rr = 0.0;
            let kind: "target" | "stop" | "ambiguous" | "timeout";
            if (hitT && hitS) {
              st.ambigN += 1;
              st.stopN += 1;
              rr = -1.0;
              outcome = "AMB ✗";
              kind = "ambiguous";
            } else if (hitT) {
              st.tgtN += 1;
              const exitT = distDir === 1 ? Math.max(tgtPrice, o) : Math.min(tgtPrice, o);
              rr = Math.abs(exitT - entryPrice) / riskR;
              outcome = `✓ +${pineFmt(rr, 2)}R`;
              kind = "target";
            } else if (hitS) {
              st.stopN += 1;
              const exitS = distDir === 1 ? Math.min(stopPrice, o) : Math.max(stopPrice, o);
              rr = distDir === 1 ? (exitS - entryPrice) / riskR : (entryPrice - exitS) / riskR;
              outcome = `✗ ${pineFmt(rr, 2)}R`;
              kind = "stop";
            } else {
              st.timeoutN += 1;
              rr = distDir === 1 ? (c - entryPrice) / riskR : (entryPrice - c) / riskR;
              outcome = `◌ ${pineFmt(rr, 2)}R`;
              kind = "timeout";
            }
            if (dstBox) {
              distHi = Math.max(distHi, h);
              distLo = Math.min(distLo, l);
              dstBox.top = distHi;
              dstBox.bottom = distLo;
              dstBox.right = i;
            }
            st.sumR += rr;
            if (rearmUsed) {
              st.dsN += 1;
              st.dsSumR += rr;
            }
            const outcCode = hitT && hitS ? 0 : hitT ? 1 : hitS ? 0 : 2;
            st.formStr += outcCode === 1 ? "▰" : outcCode === 0 ? "▱" : "◌";
            if (st.formStr.length > P.formLen) st.formStr = st.formStr.substring(st.formStr.length - P.formLen);
            if (hitT && !hitS) {
              if (tgtLn) {
                tgtLn.color = T.TGT_HIT_COLOR;
                tgtLn.style = "solid";
              }
              if (tgtLab) {
                tgtLab.text = `Target ✓ ${fmtPrice(tgtPrice)}`;
                tgtLab.color = T.TGT_HIT_COLOR;
                tgtLab.textColor = textOn(T.TGT_HIT_COLOR);
              }
            } else if (hitS) {
              if (stopLab) stopLab.text = `Stop ✗ ${fmtPrice(stopPrice)}`;
            } else {
              if (tgtLn) tgtLn.color = cn(GRAY, 60);
              if (tgtLab) tgtLab.color = cn(GRAY, 70);
            }
            const oBase = hitT && !hitS ? COL_TGT : timedOut && !hitS && !hitT ? GRAY : COL_STOP;
            newLabel(i, distDir === 1 ? h : l, outcome, distDir === 1 ? "label_down" : "label_up", cn(oBase, 20), textOn(oBase));
            events.push({ bar: i, cycle: cycleId, type: "OUTCOME", kind, rr });
            end(i);
          }
        }
      }
    }

    if (confirmed && state === "manip") {
      // T5: manipulation confirmed → the reference trade opens on this bar
      const dir: 1 | -1 = sweepSide === -1 ? 1 : -1;
      // the HTF bias filter is off by default: every manipulation opens
      distDir = dir;
      entryPrice = c;
      const fibLeg = dir === 1 ? rangeHigh - sweepExtreme : sweepExtreme - rangeLow;
      tgtPrice = tickRound(dir === 1 ? rangeHigh + (P.fibExt - 1.0) * fibLeg : rangeLow - (P.fibExt - 1.0) * fibLeg);
      const stopRaw = dir === 1 ? sweepExtreme - P.stopBufAtr * atrAnchor : sweepExtreme + P.stopBufAtr * atrAnchor;
      stopPrice = tickOut(stopRaw, dir === -1);
      riskR = Math.max(Math.abs(entryPrice - stopPrice), mintick);
      const rewardOK = dir === 1 ? ge(tgtPrice - entryPrice, mintick) : ge(entryPrice - tgtPrice, mintick);
      if (!rewardOK) {
        st.failN += 1;
        if (manLab) {
          manLab.text = "M ✗";
          manLab.color = cn(GRAY, 40);
        }
        events.push({ bar: i, cycle: cycleId, type: "FAILED" });
        end(i);
      } else {
        distStartBar = i;
        distHi = h;
        distLo = l;
        dstBox = newBox(i, distHi, i, distLo, cn(COL_TGT, 30), "solid", COL_DST);
        const entPxStr = fmtPrice(entryPrice);
        const stpPxStr = fmtPrice(stopPrice);
        const tgtPxStr = fmtPrice(tgtPrice);
        const dRrStr = pineFmt(Math.abs(tgtPrice - entryPrice) / riskR, 2);
        const dTip = `${dir === 1 ? "Distribution UP" : "Distribution DOWN"}\nSweep: ${sweepSide === 1 ? "HIGH" : "LOW"}${rearmUsed ? " (double sweep)" : ""}\nEntry: ${entPxStr} | Stop: ${stpPxStr}\nTarget: ${tgtPxStr} | R:R: ${dRrStr}`;
        newLabel(i, dir === 1 ? l : h, dir === 1 ? "D ▲" : "D ▼", dir === 1 ? "label_up" : "label_down", cn(COL_TGT, 20), textOn(COL_TGT), dTip);
        entLn = newLine(i, entryPrice, T.ENTRY_COLOR, "dotted", 1);
        stopLn = newLine(i, stopPrice, COL_STOP, "solid", 2);
        tgtLn = newLine(i, tgtPrice, COL_TGT, "dashed", 2);
        const lx = i + P.lineUpdateBars + P.labelOffsetBars;
        entLab = newLabel(lx, entryPrice, `Entry ${entPxStr}`, "label_left", T.ENTRY_COLOR, textOn(T.ENTRY_COLOR));
        stopLab = newLabel(lx, stopPrice, `Stop ${stpPxStr}${pctFromEntry(stopPrice, entryPrice)}`, "label_left", COL_STOP, textOn(COL_STOP));
        tgtLab = newLabel(lx, tgtPrice, `Target ${tgtPxStr}${pctFromEntry(tgtPrice, entryPrice)}`, "label_left", COL_TGT, textOn(COL_TGT));
        state = "dist";
        events.push({ bar: i, cycle: cycleId, type: "DIST", dir, entry: entryPrice, stop: stopPrice, target: tgtPrice, riskR });
      }
    }

    // section 11: the live objects follow every bar, the forming one too
    if (state === "accum" && accBox) accBox.right = i;
    if (state === "sweepPending" && swBox) swBox.right = i;
    if (state === "dist") {
      for (const ln of [entLn, stopLn, tgtLn]) if (ln) ln.x2 = i + P.lineUpdateBars;
      for (const lb of [entLab, stopLab, tgtLab]) if (lb) lb.x = i + P.lineUpdateBars + P.labelOffsetBars;
      if (dstBox) {
        distHi = Math.max(distHi, h);
        distLo = Math.min(distLo, l);
        dstBox.top = distHi;
        dstBox.bottom = distLo;
        dstBox.right = i;
      }
    }
  }

  // ── dashboard (the last bar) ─────────────────────────────────────────────
  const dash: AmdDashRow[] = [];
  if (n > 0) {
    const last = n - 1;
    const close = bars[last].c;
    const warmedUp = last >= P.statWindow + P.rangeWin;
    const pctRank = S.pctRank[last];
    const phaseName = PHASE_NAME[state];
    const phaseBars = state === "accum" ? last - rangeStartBar : state === "sweepPending" ? last - sweepBar : state === "dist" ? last - distStartBar : 0;
    let zeb = false;
    const row = (l: string, r: string, rc: PineColor) => {
      dash.push({ l, r, lc: T.TEXT_MUTED, rc, bg: zeb ? T.TABLE_ROW_ALT : T.TABLE_BG });
      zeb = !zeb;
    };
    const merged = (l: string, lc: PineColor, bg: PineColor) => dash.push({ l, r: null, lc, rc: null, bg });

    const headerBg = state === "dist" ? (distDir === 1 ? T.HEADER_BG_BULL : T.HEADER_BG_BEAR) : T.HEADER_BG;
    const headerDir = state === "dist" ? (distDir === 1 ? " ▲" : " ▼") : "";
    merged(`◆ Po3 · ${phaseName}${headerDir}`, T.HEADER_TEXT, headerBg);

    // Market
    merged("— Market —", T.TEXT_MUTED, T.TABLE_ROW_ALT);
    row(
      "Phase",
      !warmedUp ? "Warming up" : phaseName + (state !== "idle" ? ` (${phaseBars}b)` : ""),
      !warmedUp ? T.TEXT_MUTED : state === "dist" ? (distDir === 1 ? T.BULL_TEXT : T.BEAR_TEXT) : state === "idle" ? T.TEXT_MUTED : T.NEUTRAL_TEXT,
    );
    row(
      "Compression",
      !warmedUp ? "—" : `${pineFmt(pctRank, 0)}p  ${gauge(100 - pctRank, 100, 6)}`,
      !warmedUp ? T.TEXT_MUTED : le(pctRank, P.compressionPct) ? T.BULL_TEXT : T.TEXT_COLOR,
    );
    row("Range", state !== "idle" && !na(rangeLow) && !na(rangeHigh) ? `${fmtPrice(rangeLow)} – ${fmtPrice(rangeHigh)}` : "—", T.TEXT_COLOR);
    row("HTF Bias", "Off", T.TEXT_MUTED);
    row("TF", tf + (tf !== "15" ? " ⚠ (opt: 15M)" : ""), tf !== "15" ? T.NEUTRAL_TEXT : T.TEXT_COLOR);

    // Cycle
    merged("— Cycle —", T.TEXT_MUTED, T.TABLE_ROW_ALT);
    if (state === "dist") {
      const curRR = gt(riskR, 0) ? Math.abs(tgtPrice - entryPrice) / riskR : NaN;
      const riskPct = !na(entryPrice) && neq(entryPrice, 0) ? (Math.abs(entryPrice - stopPrice) / Math.abs(entryPrice)) * 100 : NaN;
      row(
        "Entry",
        `${distDir === 1 ? "Long" : "Short"} @ ${fmtPrice(entryPrice)}`,
        distDir === 1 ? T.BULL_TEXT : T.BEAR_TEXT,
      );
      row("Stop", fmtPrice(stopPrice), COL_STOP);
      row("Target", fmtPrice(tgtPrice), COL_TGT);
      row(
        "R:R",
        na(curRR) ? "—" : `${pineFmt(curRR, 2)}R`,
        na(curRR) ? T.TEXT_MUTED : ge(curRR, 1.5) ? T.BULL_TEXT : ge(curRR, 1.0) ? T.NEUTRAL_TEXT : T.BEAR_TEXT,
      );
      row(
        "Risk",
        na(riskPct) ? "—" : `${pineFmt(riskPct, 2)}%`,
        na(riskPct) ? T.TEXT_MUTED : gt(riskPct, 3.0) ? T.BEAR_TEXT : gt(riskPct, 1.0) ? T.NEUTRAL_TEXT : T.BULL_TEXT,
      );
      const rrLeftNum = distDir === 1 ? tgtPrice - close : close - tgtPrice;
      const rrLeftDen = distDir === 1 ? close - stopPrice : stopPrice - close;
      const rrLeft = gt(rrLeftNum, 0) && gt(rrLeftDen, 0) ? rrLeftNum / rrLeftDen : NaN;
      row(
        "RR left",
        na(rrLeft) ? (le(rrLeftNum, 0) ? "past target" : "past stop") : `${pineFmt(rrLeft, 2)}R`,
        na(rrLeft) ? T.TEXT_MUTED : ge(rrLeft, 1.0) ? T.BULL_TEXT : ge(rrLeft, 0.5) ? T.NEUTRAL_TEXT : T.BEAR_TEXT,
      );
      row("Age", `${last - distStartBar} bars`, T.TEXT_COLOR);
    } else {
      const action = state === "idle"
        ? (warmedUp ? "Scanning for compression" : "Warming up")
        : state === "accum"
        ? (rearmUsed ? "Re-arm: awaiting 2nd-side sweep" : last - rangeStartBar < P.minRangeBars ? "Range maturing" : "Awaiting boundary sweep")
        : state === "sweepPending"
        ? "Sweep! Awaiting return inside"
        : "—";
      merged(action, T.TEXT_MUTED, T.TABLE_BG);
    }

    // Stats · All-Time
    const pT = st.tgtN;
    const pS = st.stopN;
    const pTo = st.timeoutN;
    const pSum = st.sumR;
    const pTotal = pT + pS + pTo;
    const pctOK = pTotal >= P.minSampleN;
    const pTgtRate = pTotal > 0 ? (pT / pTotal) * 100.0 : 0.0;
    const pct1 = (k: number) => (pctOK ? ` (${pineFmt((100.0 * k) / pTotal, 1)}%)` : "");
    const collecting = `collecting (${pTotal}/${P.minSampleN})`;
    merged("— Stats · All-Time —", T.TEXT_MUTED, T.TABLE_ROW_ALT);
    row("Cycles", pTotal > 0 ? `${pTotal}${st.dsN > 0 ? ` (ds ${st.dsN})` : ""}` : "—", T.TEXT_COLOR);
    row("Target", pTotal > 0 ? `${pT}${pct1(pT)}` : "—", pTotal > 0 ? T.BULL_TEXT : T.TEXT_MUTED);
    row(`Stop${st.ambigN > 0 ? ` (amb ${st.ambigN})` : ""}`, pTotal > 0 ? `${pS}${pct1(pS)}` : "—", pTotal > 0 ? T.BEAR_TEXT : T.TEXT_MUTED);
    row("Timeout", pTotal > 0 ? `${pTo}${pct1(pTo)}` : "—", T.TEXT_MUTED);
    row(
      "Target rate",
      pTotal === 0 ? "—" : pctOK ? `${pineFmt(pTgtRate, 1)}%  ${gauge(pTgtRate, 100, 8)}` : collecting,
      pTotal === 0 || !pctOK ? T.TEXT_MUTED : ge(pTgtRate, 55.0) ? T.BULL_TEXT : ge(pTgtRate, 45.0) ? T.NEUTRAL_TEXT : T.BEAR_TEXT,
    );
    const pAvg = pTotal > 0 ? pSum / pTotal : NaN;
    row(
      "Avg R",
      pTotal === 0 ? "—" : pctOK ? `${pineFmt(pAvg, 2)}R${st.dsN >= P.minSampleN ? ` (ds ${pineFmt(st.dsSumR / st.dsN, 2)})` : ""}` : collecting,
      pTotal === 0 || !pctOK ? T.TEXT_MUTED : ge(pAvg, 0.2) ? T.BULL_TEXT : ge(pAvg, -0.2) ? T.NEUTRAL_TEXT : T.BEAR_TEXT,
    );
    row("Form", st.formStr === "" ? "—" : st.formStr, T.TEXT_COLOR);
    row("Failed / Breakout · All-Time", `${st.failN} / ${st.brkN}`, T.TEXT_MUTED);
    row("Resets (e/n/y/f) · All-Time", `${st.expN} / ${st.newsN} / ${st.earlyN} / ${st.filtN}`, T.TEXT_MUTED);

    merged(`Po3 · ${P.version}`, T.TEXT_MUTED, T.TABLE_BG);
  }

  return {
    events,
    boxes,
    lines,
    labels,
    stats: st,
    final: { state, cycleId, lastEndBar, rangeHigh: na(rangeHigh) ? null : rangeHigh, rangeLow: na(rangeLow) ? null : rangeLow },
    dash,
    live: state === "dist" && distDir !== 0 && sweepSide !== 0
      ? { dir: distDir, sweepSide, entry: entryPrice, stop: stopPrice, target: tgtPrice, riskR, startBar: distStartBar }
      : null,
  };
};

// Each reference trade the run opened (a DIST), with what made it: the range
// as it stood (its last boundary move before the D bar), the sweep's side and
// tip, the R:R written on D's tooltip and the outcome when there is one —
// for the email (signal-alerts/indicators.ts amdpo3Signals). From the run's
// events, so the events stay the original's (and the independent port's)
// one for one.
export interface AmdTrade {
  bar: number;
  dir: 1 | -1;
  entry: number;
  stop: number;
  target: number;
  riskR: number;
  // |target − entry| / riskR, as D's tooltip and the DIST alert write it
  rr: number;
  sweepSide: 1 | -1;
  sweepExtreme: number;
  sweepExtremeBar: number;
  rangeStart: number;
  rangeHigh: number;
  rangeLow: number;
  outcome: { bar: number; kind: "target" | "stop" | "ambiguous" | "timeout"; rr: number } | null;
}

export const amdPo3Trades = (events: readonly AmdEvent[]): AmdTrade[] => {
  const out: AmdTrade[] = [];
  // (the range of the newest ACCUM, its boundaries as they moved)
  const range = { start: -1, high: NaN, low: NaN };
  let side: 1 | -1 | 0 = 0;
  let tip: { bar: number; value: number } | null = null;
  let open: AmdTrade | null = null;
  for (const e of events) {
    if (e.type === "ACCUM") {
      range.start = e.start;
      range.high = e.high;
      range.low = e.low;
    } else if (e.type === "RANGE_HIGH") range.high = e.value;
    else if (e.type === "RANGE_LOW") range.low = e.value;
    else if (e.type === "SWEEP") side = e.side;
    else if (e.type === "MANIP") tip = { bar: e.extremeBar, value: e.extreme };
    else if (e.type === "DIST" && range.start >= 0 && tip && side !== 0) {
      open = {
        bar: e.bar,
        dir: e.dir,
        entry: e.entry,
        stop: e.stop,
        target: e.target,
        riskR: e.riskR,
        rr: Math.abs(e.target - e.entry) / e.riskR,
        sweepSide: side,
        sweepExtreme: tip.value,
        sweepExtremeBar: tip.bar,
        rangeStart: range.start,
        rangeHigh: range.high,
        rangeLow: range.low,
        outcome: null,
      };
      out.push(open);
    } else if (e.type === "OUTCOME" && open) {
      open.outcome = { bar: e.bar, kind: e.kind, rr: e.rr };
      open = null;
    }
  }
  return out;
};
