// #186: the pieces of the gotobi study (docs §8.96) that read no network: the
// calendar (gotobi days, the days compared, the ambiguous days), the trade on
// GMO's 1-minute bid/ask bars, and the statistics. research/gotobi.ts runs
// them on GMO's data, on made-up bars and on made-up daily results.
//
// Every time is UTC milliseconds; a JST date is named "YYYY-MM-DD" and its
// midnight is Date.UTC(date) - 9 hours. Nothing here reads the machine's time
// zone (no getDate / getHours).

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
const JST = 9 * HOUR;

// ---- dates -------------------------------------------------------------------------

/** Date.UTC of a "YYYY-MM-DD" (the date as a UTC day; JST midnight is 9 h earlier) */
export const utcOf = (date: string): number => Date.parse(`${date}T00:00:00Z`);
export const dateOf = (utcMidnight: number): string => new Date(utcMidnight).toISOString().slice(0, 10);
export const addDays = (date: string, n: number): string => dateOf(utcOf(date) + n * DAY);
/** 0 Sunday … 6 Saturday, of the calendar date itself */
export const weekday = (date: string): number => new Date(utcOf(date)).getUTCDay();
export const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

// ---- the Cabinet Office's holiday list ----------------------------------------------

export interface HolidayList {
  days: Map<string, string>;
  rows: number;
}

/** The CSV as text (decoded from Shift_JIS by the caller); throws on any row out of shape */
export const parseHolidayCsv = (text: string): HolidayList => {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("holiday CSV: no rows");
  const days = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const m = line.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}),(.+)$/);
    if (!m) throw new Error(`holiday CSV: a row out of shape: ${JSON.stringify(line)}`);
    const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    days.set(date, m[4].trim());
  }
  return { days, rows: lines.length - 1 };
};

/** Known days that must be in the list (docs §8.96) */
export const KNOWN_HOLIDAYS = ["2019-04-30", "2023-11-03", "2024-02-23", "2024-05-03", "2024-05-06", "2025-11-24", "2026-09-22"];

/** Checks the list against the rules of §8.96 for the years given; returns the problems found */
export const checkHolidays = (list: HolidayList, years: number[]): string[] => {
  const problems: string[] = [];
  for (const d of KNOWN_HOLIDAYS) if (!list.days.has(d)) problems.push(`known holiday missing: ${d}`);
  for (const y of years) {
    const n = [...list.days.keys()].filter((d) => d.startsWith(`${y}-`)).length;
    if (n < 16 || n > 21) problems.push(`${y}: ${n} holidays (expected 16 to 21)`);
  }
  return problems;
};

/** 12/31 to 1/3: banks shut, no fixing */
export const yearEndShut = (date: string): boolean => {
  const md = date.slice(5);
  return md === "12-31" || md === "01-01" || md === "01-02" || md === "01-03";
};

// ---- the calendar ------------------------------------------------------------------

export type DayKind = "gotobi" | "control" | "ambiguous";

export interface CalendarDay {
  date: string;
  weekday: number;
  kind: DayKind;
  /** how it came to be a gotobi day: the calendar date ("5", "10" …) or "前倒し from YYYY-MM-DD" */
  why?: string;
}

export interface Calendar {
  /** business days (Mon–Fri, not a holiday, not 12/31–1/3), each in exactly one kind */
  days: CalendarDay[];
  /** gotobi dates that did not become a gotobi day, and why */
  dropped: Array<{ nominal: string; reason: string; ambiguous: string | null }>;
}

const GOTOBI_DATES = [5, 10, 15, 20, 25, 30];

/** The gotobi calendar of docs §8.96 between two dates (inclusive) */
export const buildCalendar = (from: string, to: string, holidays: Map<string, string>): Calendar => {
  const isHoliday = (d: string) => holidays.has(d) || yearEndShut(d);
  const business = (d: string) => {
    const w = weekday(d);
    return w >= 1 && w <= 5 && !isHoliday(d);
  };
  const prevBusiness = (d: string): string => {
    let x = addDays(d, -1);
    for (let i = 0; i < 30 && !business(x); i++) x = addDays(x, -1);
    return x;
  };
  const gotobi = new Map<string, string>();
  const ambiguous = new Set<string>();
  const dropped: Calendar["dropped"] = [];
  // every month that touches the range, one before and after for the 前倒し
  const start = utcOf(from.slice(0, 8) + "01") - 40 * DAY;
  const end = utcOf(to) + 40 * DAY;
  for (let t = start; t <= end; t += DAY) {
    const d = dateOf(t);
    const dom = Number(d.slice(8));
    const month = Number(d.slice(5, 7));
    if (!GOTOBI_DATES.includes(dom)) continue;
    if (month === 2 && dom === 30) continue; // never happens; February has no 30th
    const w = weekday(d);
    if (w === 0 || w === 6 || (w === 1 && isHoliday(d))) {
      // 前倒し: the Friday before
      const fri = addDays(d, w === 0 ? -2 : w === 6 ? -1 : -3);
      if (business(fri)) gotobi.set(fri, `前倒し from ${d}`);
      else {
        const amb = prevBusiness(d);
        dropped.push({ nominal: d, reason: `the Friday before (${fri}) is not a business day`, ambiguous: amb });
        ambiguous.add(amb);
      }
    } else if (isHoliday(d)) {
      // a holiday Tuesday to Friday: no gotobi day and no 前倒し
      const amb = prevBusiness(d);
      dropped.push({ nominal: d, reason: "a holiday, Tuesday to Friday", ambiguous: amb });
      ambiguous.add(amb);
    } else {
      gotobi.set(d, String(dom));
    }
  }
  const days: CalendarDay[] = [];
  for (let t = utcOf(from); t <= utcOf(to); t += DAY) {
    const d = dateOf(t);
    if (!business(d)) continue;
    const w = weekday(d);
    if (gotobi.has(d)) days.push({ date: d, weekday: w, kind: "gotobi", why: gotobi.get(d) });
    else if (ambiguous.has(d)) days.push({ date: d, weekday: w, kind: "ambiguous" });
    else days.push({ date: d, weekday: w, kind: "control" });
  }
  // an ambiguous day that is itself a gotobi day stays a gotobi day (2024-12-30)
  return { days, dropped: dropped.filter((x) => utcOf(x.nominal) >= utcOf(from) - 7 * DAY && utcOf(x.nominal) <= utcOf(to) + 7 * DAY) };
};

// ---- times of the trade --------------------------------------------------------------

/** the bar a day's trade buys at: 23:00 JST the evening before = 14:00 UTC of the day before */
export const entryAt = (date: string): number => utcOf(date) - 10 * HOUR;
/** the bar it sells at: 9:55 JST = 00:55 UTC of the day */
export const exitAt = (date: string): number => utcOf(date) + 55 * MIN;
/** an entry at h o'clock JST for the hourly table: 0–9 on the day, 22 and 23 the evening before */
export const hourEntryAt = (date: string, h: number): number =>
  h <= 9 ? utcOf(date) + (h - 9) * HOUR : utcOf(date) + (h - 33) * HOUR;

// ---- bars ------------------------------------------------------------------------------

/** one minute, both sides, prices in 0.001 yen (integers) */
export interface Bar {
  t: number;
  bo: number;
  bh: number;
  bl: number;
  bc: number;
  ao: number;
  ah: number;
  al: number;
  ac: number;
}

export const milli = (price: number): number => Math.round(price * 1000);

/** a side's bars keyed by open time, from GMO day files; a bar in two files is counted once */
export type SideBars = Map<number, { o: number; h: number; l: number; c: number }>;

export const addFile = (into: SideBars, rows: Array<{ t: number; o: number; h: number; l: number; c: number }>) => {
  for (const r of rows) if (!into.has(r.t)) into.set(r.t, { o: r.o, h: r.h, l: r.l, c: r.c });
};

/** the bars both sides have */
export const joinSides = (bid: SideBars, ask: SideBars): Map<number, Bar> => {
  const out = new Map<number, Bar>();
  for (const [t, b] of bid) {
    const a = ask.get(t);
    if (!a) continue;
    out.set(t, { t, bo: b.o, bh: b.h, bl: b.l, bc: b.c, ao: a.o, ah: a.h, al: a.l, ac: a.c });
  }
  return out;
};

/** usable to trade at: both sides there and the ask's open not below the bid's */
export const usable = (bars: Map<number, Bar>, t: number): Bar | null => {
  const b = bars.get(t);
  return b && b.ao >= b.bo ? b : null;
};

export type Unusable = "market shut" | "gap" | "one side or ask below bid" | "no file";

/** why there is no usable bar at t: ① no bar either side within 30 min, ② a gap, ③ one side / crossed, ④ the file missing */
export const whyUnusable = (
  bid: SideBars,
  ask: SideBars,
  t: number,
  fileMissing: boolean,
): Unusable => {
  if (fileMissing) return "no file";
  if (bid.has(t) || ask.has(t)) return "one side or ask below bid";
  for (let dt = -30 * MIN; dt <= 30 * MIN; dt += MIN) if (bid.has(t + dt) || ask.has(t + dt)) return "gap";
  return "market shut";
};

// ---- the trade -----------------------------------------------------------------------------

export interface Trade {
  date: string;
  entryT: number;
  exitT: number;
  /** minutes the exit came after 9:55 (0: on time) */
  exitLate: number;
  /** bought at the ask's open, sold at the bid's open, 0.001 yen */
  buy: number;
  sell: number;
  /** result in 0.001 yen (1 sen = 10) */
  pl: number;
  /** mid to mid, before the spread */
  plMid: number;
  spreadIn: number;
  spreadOut: number;
  /** half of each spread, the cost paid */
  paid: number;
  /** worst bid low from the entry bar to the 9:54 bar, minus the buy */
  mae: number;
  maeMid: number;
  /** the same leaving out 05:00–07:59 JST */
  maeNoRoll: number;
  maeAt: number;
}

export type TradeResult = { ok: true; trade: Trade } | { ok: false; leg: "entry" | "exit"; reason: Unusable };

/**
 * The main trade of §8.96 on day `date`: buy at the first usable bar of
 * 23:00–23:04 JST the evening before, sell at the first usable bar of
 * 9:55–10:54 JST. `missing(t)` says whether the day file holding t was absent.
 */
export const tradeDay = (
  date: string,
  bars: Map<number, Bar>,
  bid: SideBars,
  ask: SideBars,
  missing: (t: number) => boolean,
  entry = entryAt(date),
  exit = exitAt(date),
  exitWindowMin = 59,
): TradeResult => {
  let inBar: Bar | null = null;
  for (let k = 0; k <= 4 && !inBar; k++) inBar = usable(bars, entry + k * MIN);
  if (!inBar) return { ok: false, leg: "entry", reason: whyUnusable(bid, ask, entry, missing(entry)) };
  let outBar: Bar | null = null;
  for (let k = 0; k <= exitWindowMin && !outBar; k++) outBar = usable(bars, exit + k * MIN);
  if (!outBar) return { ok: false, leg: "exit", reason: whyUnusable(bid, ask, exit, missing(exit)) };
  let mae = Infinity;
  let maeMid = Infinity;
  let maeNoRoll = Infinity;
  let maeAt = inBar.t;
  for (let t = inBar.t; t < exit; t += MIN) {
    const b = bars.get(t);
    if (!b) continue;
    const m = (b.bl + b.al) / 2;
    if (b.bl - inBar.ao < mae) {
      mae = b.bl - inBar.ao;
      maeAt = t;
    }
    maeMid = Math.min(maeMid, m - (inBar.bo + inBar.ao) / 2);
    const jstHour = Math.floor(((t + JST) % DAY) / HOUR);
    if (jstHour < 5 || jstHour > 7) maeNoRoll = Math.min(maeNoRoll, b.bl - inBar.ao);
  }
  const spreadIn = inBar.ao - inBar.bo;
  const spreadOut = outBar.ao - outBar.bo;
  return {
    ok: true,
    trade: {
      date,
      entryT: inBar.t,
      exitT: outBar.t,
      exitLate: Math.round((outBar.t - exit) / MIN),
      buy: inBar.ao,
      sell: outBar.bo,
      pl: outBar.bo - inBar.ao,
      plMid: (outBar.bo + outBar.ao) / 2 - (inBar.bo + inBar.ao) / 2,
      spreadIn,
      spreadOut,
      paid: spreadIn / 2 + spreadOut / 2,
      mae: Number.isFinite(mae) ? mae : 0,
      maeMid: Number.isFinite(maeMid) ? maeMid : 0,
      maeNoRoll: Number.isFinite(maeNoRoll) ? maeNoRoll : 0,
      maeAt,
    },
  };
};

/** a plain trade between two times: buy at the ask's open at `a`, sell at the bid's open at `b` (or the reverse) */
export const legs = (bars: Map<number, Bar>, a: number, b: number, side: "buy" | "sell"): number | null => {
  const x = usable(bars, a);
  const y = usable(bars, b);
  if (!x || !y) return null;
  return side === "buy" ? y.bo - x.ao : x.bo - y.ao;
};

// ---- statistics ------------------------------------------------------------------------------

export const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
export const variance = (xs: number[]): number => {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
};
export const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

// the regularised incomplete beta (Numerical Recipes betacf) for Student's t
const lgamma = (z: number): number => {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};
const betacf = (a: number, b: number, x: number): number => {
  const MAXIT = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
};
const ibeta = (a: number, b: number, x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
};
/** P(T <= t) for Student's t with df degrees of freedom */
export const tCdf = (t: number, df: number): number => {
  const x = df / (df + t * t);
  const tail = 0.5 * ibeta(df / 2, 0.5, x);
  return t >= 0 ? 1 - tail : tail;
};
/** the t quantile, by bisection */
export const tQuantile = (p: number, df: number): number => {
  let lo = -1000;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (tCdf(m, df) < p) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
};

export interface Interval {
  lo: number;
  hi: number;
}

/** a mean's 95% t interval */
export const tMeanCi = (xs: number[]): Interval => {
  const m = mean(xs);
  const se = Math.sqrt(variance(xs) / xs.length);
  const q = tQuantile(0.975, xs.length - 1);
  return { lo: m - q * se, hi: m + q * se };
};

/** Wilson's interval for a share */
export const wilsonCi = (k: number, n: number): Interval => {
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { lo: centre - half, hi: centre + half };
};

/** a weekday-matched difference: Σ_w (n_g,w / N_g) (mean_g,w − mean_c,w) over the weekdays both groups have */
export interface Matched {
  diff: number;
  se: number;
  df: number;
  weights: Map<number, number>;
  /** gotobi days on a weekday no compared day has (left out) */
  unmatched: number;
}

export const matchedDiff = (g: Array<{ w: number; x: number }>, c: Array<{ w: number; x: number }>): Matched | null => {
  const ws = [...new Set(g.map((r) => r.w))].sort();
  const cells: Array<{ w: number; gx: number[]; cx: number[] }> = [];
  let unmatched = 0;
  for (const w of ws) {
    const gx = g.filter((r) => r.w === w).map((r) => r.x);
    const cx = c.filter((r) => r.w === w).map((r) => r.x);
    if (cx.length < 2 || gx.length < 1) {
      unmatched += gx.length;
      continue;
    }
    cells.push({ w, gx, cx });
  }
  const N = cells.reduce((a, k) => a + k.gx.length, 0);
  if (N === 0) return null;
  let diff = 0;
  let v = 0;
  let dfDen = 0;
  const weights = new Map<number, number>();
  for (const k of cells) {
    const wt = k.gx.length / N;
    weights.set(k.w, wt);
    diff += wt * (mean(k.gx) - mean(k.cx));
    const vg = k.gx.length > 1 ? (wt * wt * variance(k.gx)) / k.gx.length : 0;
    const vc = (wt * wt * variance(k.cx)) / k.cx.length;
    v += vg + vc;
    if (k.gx.length > 1) dfDen += (vg * vg) / (k.gx.length - 1);
    dfDen += (vc * vc) / (k.cx.length - 1);
  }
  const df = dfDen > 0 ? (v * v) / dfDen : 1;
  return { diff, se: Math.sqrt(v), df, weights, unmatched };
};

export const matchedCi = (m: Matched): Interval => {
  const q = tQuantile(0.975, m.df);
  return { lo: m.diff - q * m.se, hi: m.diff + q * m.se };
};

/** Welch's interval for a plain difference of means */
export const welchCi = (a: number[], b: number[]): Interval & { diff: number } => {
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const diff = mean(a) - mean(b);
  const df = (va + vb) ** 2 / (va * va / (a.length - 1) + vb * vb / (b.length - 1));
  const q = tQuantile(0.975, df);
  const se = Math.sqrt(va + vb);
  return { diff, lo: diff - q * se, hi: diff + q * se };
};

/** mulberry32, as research/gmo.ts */
export const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface Row {
  date: string;
  /** month key "YYYY-MM" */
  month: string;
  w: number;
  kind: "gotobi" | "control";
  x: number;
}

export interface Boot {
  gotobi: Interval;
  matched: Interval;
  /** monthly resamples that had to leave a weekday out of the weights */
  dropped: number;
}

const pct = (xs: number[]): Interval => ({ lo: quantile(xs, 0.025), hi: quantile(xs, 0.975) });

/** the matched difference and the gotobi mean from per-(kind, weekday) sums and counts */
const fromCells = (gs: number[], gn: number[], cs: number[], cn: number[]): { gotobi: number; matched: number | null; unmatched: number } => {
  let N = 0;
  let total = 0;
  let unmatched = 0;
  for (let w = 0; w < 7; w++) {
    total += gs[w];
    if (gn[w] > 0 && cn[w] >= 2) N += gn[w];
    else unmatched += gn[w];
  }
  const all = gn.reduce((a, b) => a + b, 0);
  let diff = 0;
  for (let w = 0; w < 7; w++) if (gn[w] > 0 && cn[w] >= 2) diff += (gn[w] / N) * (gs[w] / gn[w] - cs[w] / cn[w]);
  return { gotobi: total / all, matched: N > 0 ? diff : null, unmatched };
};

/** day-wise bootstrap: each (group, weekday) cell resampled at its own size */
export const bootDays = (rows: Row[], reps: number, seed: number): Boot => {
  const r = rng(seed);
  const g: number[][] = Array.from({ length: 7 }, () => []);
  const c: number[][] = Array.from({ length: 7 }, () => []);
  for (const x of rows) (x.kind === "gotobi" ? g : c)[x.w].push(x.x);
  const gm: number[] = [];
  const dm: number[] = [];
  const gs = new Array(7).fill(0);
  const cs = new Array(7).fill(0);
  const gn = g.map((xs) => xs.length);
  const cn = c.map((xs) => xs.length);
  for (let i = 0; i < reps; i++) {
    for (let w = 0; w < 7; w++) {
      let s = 0;
      for (let j = 0; j < gn[w]; j++) s += g[w][Math.floor(r() * gn[w])];
      gs[w] = s;
      s = 0;
      for (let j = 0; j < cn[w]; j++) s += c[w][Math.floor(r() * cn[w])];
      cs[w] = s;
    }
    const f = fromCells(gs, gn, cs, cn);
    gm.push(f.gotobi);
    if (f.matched !== null) dm.push(f.matched);
  }
  return { gotobi: pct(gm), matched: pct(dm), dropped: 0 };
};

/** month-wise bootstrap: whole calendar months resampled, weights recomputed each time */
export const bootMonths = (rows: Row[], reps: number, seed: number): Boot => {
  const r = rng(seed);
  const months = new Map<string, { gs: number[]; gn: number[]; cs: number[]; cn: number[] }>();
  for (const x of rows) {
    if (!months.has(x.month)) months.set(x.month, { gs: new Array(7).fill(0), gn: new Array(7).fill(0), cs: new Array(7).fill(0), cn: new Array(7).fill(0) });
    const m = months.get(x.month)!;
    if (x.kind === "gotobi") {
      m.gs[x.w] += x.x;
      m.gn[x.w]++;
    } else {
      m.cs[x.w] += x.x;
      m.cn[x.w]++;
    }
  }
  const list = [...months.values()];
  const gm: number[] = [];
  const dm: number[] = [];
  let dropped = 0;
  const gs = new Array(7);
  const gn = new Array(7);
  const cs = new Array(7);
  const cn = new Array(7);
  for (let i = 0; i < reps; i++) {
    gs.fill(0);
    gn.fill(0);
    cs.fill(0);
    cn.fill(0);
    for (let j = 0; j < list.length; j++) {
      const m = list[Math.floor(r() * list.length)];
      for (let w = 0; w < 7; w++) {
        gs[w] += m.gs[w];
        gn[w] += m.gn[w];
        cs[w] += m.cs[w];
        cn[w] += m.cn[w];
      }
    }
    if (gn.reduce((a: number, b: number) => a + b, 0) === 0) continue;
    const f = fromCells(gs, gn, cs, cn);
    gm.push(f.gotobi);
    if (f.matched !== null) {
      dm.push(f.matched);
      if (f.unmatched > 0) dropped++;
    }
  }
  return { gotobi: pct(gm), matched: pct(dm), dropped };
};

export interface Verdict {
  gotobiMean: number;
  matched: number;
  plain: number;
  /** the three intervals of each */
  gotobiCis: { t: Interval; days: Interval; months: Interval };
  matchedCis: { t: Interval; days: Interval; months: Interval };
  gotobiLow: number;
  matchedLow: number;
  matchedHigh: number;
  candidate: boolean;
  /** reading (a) candidate, (b) Kobe's size not seen, (c) undecided */
  reading: "a" | "b" | "c";
  minDetectable: number;
}

/** the decision rule of §8.96 on daily results (any unit; `kobe` in the same unit) */
export const decide = (rows: Row[], reps: number, seed: number, kobe: number): Verdict | null => {
  const g = rows.filter((x) => x.kind === "gotobi");
  const c = rows.filter((x) => x.kind === "control");
  if (g.length < 3 || c.length < 3) return null;
  const m = matchedDiff(g.map((x) => ({ w: x.w, x: x.x })), c.map((x) => ({ w: x.w, x: x.x })));
  if (!m) return null;
  const gt = tMeanCi(g.map((x) => x.x));
  const mt = matchedCi(m);
  const bd = bootDays(rows, reps, seed);
  const bm = bootMonths(rows, reps, seed + 1);
  const gotobiLow = Math.min(gt.lo, bd.gotobi.lo, bm.gotobi.lo);
  const matchedLow = Math.min(mt.lo, bd.matched.lo, bm.matched.lo);
  const matchedHigh = Math.max(mt.hi, bd.matched.hi, bm.matched.hi);
  const candidate = gotobiLow > 0 && matchedLow > 0;
  const widest = Math.max(mt.hi - mt.lo, bd.matched.hi - bd.matched.lo, bm.matched.hi - bm.matched.lo);
  return {
    gotobiMean: mean(g.map((x) => x.x)),
    matched: m.diff,
    plain: mean(g.map((x) => x.x)) - mean(c.map((x) => x.x)),
    gotobiCis: { t: gt, days: bd.gotobi, months: bm.gotobi },
    matchedCis: { t: mt, days: bd.matched, months: bm.matched },
    gotobiLow,
    matchedLow,
    matchedHigh,
    candidate,
    reading: candidate ? "a" : matchedHigh < kobe ? "b" : "c",
    minDetectable: (widest / 2 / 1.96) * 2.8,
  };
};

/** cumulative path: the largest fall from a peak, and the longest run of losses (pl <= 0) */
export const pathStats = (xs: number[]): { maxDrawdown: number; longestLosing: number } => {
  let peak = 0;
  let cum = 0;
  let dd = 0;
  let run = 0;
  let longest = 0;
  for (const x of xs) {
    cum += x;
    peak = Math.max(peak, cum);
    dd = Math.min(dd, cum - peak);
    run = x > 0 ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return { maxDrawdown: dd, longestLosing: longest };
};

/** lag-1 autocorrelation */
export const autocorr1 = (xs: number[]): number => {
  if (xs.length < 3) return NaN;
  const m = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    den += (xs[i] - m) ** 2;
    if (i > 0) num += (xs[i] - m) * (xs[i - 1] - m);
  }
  return num / den;
};
