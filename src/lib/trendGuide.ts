// #394: the owner's ① ② ④ drawn by themselves. The owner (2026-11-04), after a
// trend-line lesson on an AUD/USD 1-hour chart (① the falling line through the
// highest high and the high that touched it next, ② the steeper line of the
// last leg, ③ the band where the price stopped again and again — srZones.ts,
// ④ the low the rising line will start from): 「今後は自動で画像の①から④を
// チャートに表示させるようにして」.
//
// Read mechanically from the closed bars on screen (the window the owner looks
// at, as a person draws on it):
//   * the move: down when the window's highest high comes before its lowest low,
//     up otherwise (everything below is mirrored for an up move);
//   * ① from the highest high (the later of equal ones), the line with the
//     shallowest fall that every swing high from there to the lowest low stays
//     under — it touches the swing that sticks up most (a swing high: no higher
//     high `pivot` bars either side, as the trend lines read them; a bar that is
//     not a swing may poke through by up to about `pivot` × the slope);
//   * ② the same from the highest swing high after ①'s touch (the last leg),
//     when it falls more steeply than ①;
//   * a break: the first close above the line after the lowest low (a close above
//     it before the low was not a break: the price went on to the low);
//   * ④ the lowest low (the end of the move, the later of equal ones), and the
//     rising line from it through the first confirmed higher swing low after it
//     (「上昇の線は、次の押し安値ができてから引く」), with its break: the first
//     close below it after that swing.
// Shown on the chart only: no signal, alert or record is judged on it, and none
// of it has been measured on past data.

type Bar = { high: number; low: number; close: number };

export const TREND_GUIDE = { pivot: 4, minBars: 30 } as const;
export type TrendGuideOptions = { pivot: number; minBars: number };

export interface GuideLine {
  // through bar a at pa and bar b at pb (b > a)
  a: number;
  pa: number;
  b: number;
  pb: number;
  // the first close through it after b (above a falling line, below a rising one)
  brokenAt: number | null;
}

export interface TrendGuide {
  dir: "down" | "up";
  main: GuideLine | null;
  steep: GuideLine | null;
  // the end of the move: the lowest low of a down move, the highest high of an up move
  extreme: { i: number; price: number };
  // the line from the extreme the other way, once a confirmed swing after it holds one
  counter: GuideLine | null;
}

export const guideAt = (l: GuideLine, i: number): number => l.pa + ((l.pb - l.pa) * (i - l.a)) / (l.b - l.a);

// a swing high of `h` (no higher value `pivot` bars before, none higher after; ties to the earlier)
const isSwing = (h: ReadonlyArray<number>, p: number, pivot: number, last: number): boolean => {
  if (p - pivot < 0 || p + pivot > last) return false;
  for (let k = p - pivot; k <= p + pivot; k++) {
    if (k === p) continue;
    if (k < p ? h[k] >= h[p] : h[k] > h[p]) return false;
  }
  return true;
};

// The falling line from the top at k0 over the bars to `end`: the swing high after
// k0 + pivot with the shallowest fall to it (ties: the later), null without one
const fallingFrom = (hi: ReadonlyArray<number>, k0: number, end: number, last: number, pivot: number): { b: number; s: number } | null => {
  let best: { b: number; s: number } | null = null;
  for (let k = k0 + pivot; k <= end; k++) {
    if (!isSwing(hi, k, pivot, last) || hi[k] >= hi[k0]) continue;
    const s = (hi[k] - hi[k0]) / (k - k0);
    if (!best || s >= best.s) best = { b: k, s };
  }
  return best;
};

// The whole read on one side (`hi` the highs, `lo` the lows, `cl` the closes, all
// already mirrored for an up move so the move is down)
const readDown = (hi: number[], lo: number[], cl: number[], from: number, last: number, pivot: number) => {
  let k0 = from;
  let kL = from;
  for (let k = from; k <= last; k++) {
    if (hi[k] >= hi[k0]) k0 = k;
    if (lo[k] <= lo[kL]) kL = k;
  }
  const lineOf = (top: number): GuideLine | null => {
    const f = fallingFrom(hi, top, kL, last, pivot);
    if (!f) return null;
    const l: GuideLine = { a: top, pa: hi[top], b: f.b, pb: hi[f.b], brokenAt: null };
    for (let t = Math.max(f.b, kL) + 1; t <= last; t++) {
      if (cl[t] > guideAt(l, t)) {
        l.brokenAt = t;
        break;
      }
    }
    return l;
  };
  const main = k0 < kL ? lineOf(k0) : null;
  let steep: GuideLine | null = null;
  if (main) {
    // the highest swing high of the last leg: after ①'s touch, with room for a touch before the low
    let k1 = -1;
    for (let k = main.b + 1; k <= kL - pivot; k++) if (isSwing(hi, k, pivot, last) && (k1 < 0 || hi[k] >= hi[k1])) k1 = k;
    if (k1 >= 0) {
      const l = lineOf(k1);
      if (l && (l.pb - l.pa) / (l.b - l.a) < (main.pb - main.pa) / (main.b - main.a)) steep = l;
    }
  }
  // the counter line: from the low through the first confirmed higher swing low after
  // it (a later one does not move it, so its break stays where it was)
  let counter: GuideLine | null = null;
  const neg = lo.map((v) => -v);
  let c = -1;
  for (let k = kL + 1; k <= last && c < 0; k++) if (isSwing(neg, k, pivot, last) && lo[k] > lo[kL]) c = k;
  if (c >= 0) {
    counter = { a: kL, pa: lo[kL], b: c, pb: lo[c], brokenAt: null };
    for (let t = c + 1; t <= last; t++) {
      if (cl[t] < guideAt(counter, t)) {
        counter.brokenAt = t;
        break;
      }
    }
  }
  return { main, steep, extreme: { i: kL, price: lo[kL] }, counter };
};

// The guide of bars[from..lastClosed]; null when the window has fewer than minBars bars
export const trendGuide = (bars: ReadonlyArray<Bar>, from: number, lastClosed: number, o: TrendGuideOptions = TREND_GUIDE): TrendGuide | null => {
  const last = Math.min(lastClosed, bars.length - 1);
  const start = Math.max(0, from);
  if (last - start + 1 < o.minBars) return null;
  const hi = bars.map((b) => b.high);
  const lo = bars.map((b) => b.low);
  const cl = bars.map((b) => b.close);
  let kH = start;
  let kL = start;
  for (let k = start; k <= last; k++) {
    if (hi[k] >= hi[kH]) kH = k;
    if (lo[k] <= lo[kL]) kL = k;
  }
  if (kH <= kL) {
    const r = readDown(hi, lo, cl, start, last, o.pivot);
    return { dir: "down", ...r };
  }
  // an up move: mirror the prices (highs become lows), read it as a down move, mirror back
  const m = (l: GuideLine | null): GuideLine | null => (l ? { ...l, pa: -l.pa, pb: -l.pb } : null);
  const r = readDown(lo.map((v) => -v), hi.map((v) => -v), cl.map((v) => -v), start, last, o.pivot);
  return { dir: "up", main: m(r.main), steep: m(r.steep), extreme: { i: r.extreme.i, price: -r.extreme.price }, counter: m(r.counter) };
};
