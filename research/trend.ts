// #250 (docs §8.106): would a condition on the trend — the live chart's Dow
// line — raise the win rate of the 15-minute ULTRA emails? This program is
// stage 0 (§8.106 6): each of (a)'s emails labelled with the chart's 15M, 1H
// and 4H Dow line at C, and the four candidates' counts. No outcome is read:
// no outcome code is imported, and ultra15-a.csv is read for its T, pair,
// side and P only.
//
//   MODE=stage0  GMO's bars. (a)'s signals (§8.102: signalsOf on GMO's
//                15-minute bars, 2024-01-01..2026-10-03), each labelled; the
//                checks of §8.106 11 that touch the labels; then
//                OUT/trend-labels.csv (its sha256 becomes the constant stages
//                1 and 2 stop on), OUT/print.txt (the counts and the floors)
//                and OUT/checks.json. The emails of 10/7 and 10/9 (JST,
//                research/ledger/trend-examples.csv) labelled as examples.
//   MODE=syn     the same on a walk written as GMO's files (trend-data.ts);
//                with PLANT=<name> one planted error, which a check must
//                catch (the run prints which checks failed).
//
// The label (§8.106 1): trend-labels.ts labelsOf, the chart's Dow line —
// dowTheory, 4 bars a side, on the newest 300 bars closed by C of the files
// the chart's walk reads (301 when the next bar has not begun) — at C, the
// signal bar's close (T; T + 15 minutes for a late signal), as the chart
// shows it a minute later. Up and toUp point up, down and toDown down, none
// nowhere. Unreadable: fewer than 300 closed bars, or a hole the market's
// hours and GMO's own closures (a stamp most of the five pairs miss) do not
// explain. A candidate leaves an email out when its line points against the
// email; it compares only the emails it can read.

import { GMO_SYMBOLS } from "../supabase/functions/track-outcomes/quotes.ts";
import { DAY, HOUR, MINUTE, WEEK, WEEK_OFFSET, iso } from "./lib.ts";
import { LEAD15, PAIRS, type Sig, type Source, gmoDayKey, load15, loadQuotes, newLoadStats, signalsOf, unitOf } from "./ownerhold-data.ts";
import { sha256Hex } from "./spreadhours-lib.ts";
import {
  type Bars,
  DIR_OF,
  FINE,
  LAG,
  type Labels,
  STATE_NAMES,
  type Series,
  type Tf,
  WINDOW,
  chartRead,
  fileFetcher,
  gapsOf,
  labelsOf,
  lowerBound,
  seriesOf,
  sliceBars,
  specialDays,
  weekendOutOf,
} from "./trend-labels.ts";
import { type Agree, STEP_OF, type TfDiag, agreeWith15, coarsen, gmoYearKey, loadTf, walk5, writeWalk } from "./trend-data.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const MODE = env("MODE", "syn");
if (MODE !== "stage0" && MODE !== "syn") throw new Error(`MODE ${MODE}: stage0 or syn`);
const SYN = MODE === "syn";
export const PLANTS = ["formingInWindow", "hourMidPrice", "oneBarAhead", "readAtTminus15", "lateFromT", "buySellSwap", "hintSwap", "keyFromJst", "weekendStamp", "keepEdge"] as const;
const PLANT = env("PLANT", "");
if (PLANT && !(PLANTS as readonly string[]).includes(PLANT)) throw new Error(`PLANT ${PLANT}: not one of ${PLANTS.join(", ")}`);
const OUT = env("OUT", "research/out/trend");
const CACHE = env("CACHE_DIR", "research/.cache");
const SEED = Number(env("SEED", "1"));

// (a)'s period and §8.106 5's split; the walk's (MODE=syn) holds New Year, the clocks changing and the split
const START_MS = Date.parse(SYN ? "2024-10-01T00:00:00Z" : "2024-01-01T00:00:00Z");
const END_MS = Date.parse(SYN ? "2025-07-26T00:00:00Z" : "2026-10-03T00:00:00Z");
const SPLIT_MS = Date.parse("2025-05-19T00:00:00Z");
// the bars are read to here, so that the bar after every C (counted, not read: §8.106 1) is in the files
// (stage0: 10/9 12:00 UTC, when the bars after the last example of 10/9 JST, 08:45 UTC, have closed:
// its 4-hour bar of 08:00 UTC; the run starts an hour after it at least)
const LABEL_END_MS = SYN ? END_MS + 7 * DAY : Date.parse(env("LABEL_END", "2026-10-09T12:00:00Z"));
if (![START_MS, END_MS, SPLIT_MS, LABEL_END_MS].every(Number.isFinite) || !(START_MS < SPLIT_MS && SPLIT_MS < END_MS && END_MS <= LABEL_END_MS)) throw new Error("the times are not in order");
// (a)'s ultra15-a.csv (research/ledger, §8.102), read for T, pair, side and P only
const A_CSV = env("A_CSV", "research/ledger/ultra15-a.csv");
const A_SHA256 = "ce4c6acee90bdef30f616b6a018ae34864d4e48d3c443dcfc7e6d27988be70c2";
const EXAMPLES = env("EXAMPLES", "research/ledger/trend-examples.csv");
// how far a half's edge the 5-minute windows are counted bar by bar (a window is 1,440 bars, about 5 days)
const EDGE = 21 * DAY;
const TRACK_BARS = 1_440;
const DELAY = 2;

const TFS = ["15min", "1h", "4h"] as const;
type LTf = (typeof TFS)[number];
const SIDE_DIR = (s: Sig) => (PLANT === "buySellSwap" ? -s.dir : s.dir);
const dirOf = (state: number): number => {
  if (state < 0) return 0;
  if (PLANT === "hintSwap" && (state === 3 || state === 4)) return -DIR_OF[state];
  return DIR_OF[state];
};

const weekendOut = weekendOutOf(PLANT === "weekendStamp" ? "stamp" : "inside");
const GAPS = gapsOf(weekendOut);
const src: Source = SYN ? { dir: `${OUT}/gmo`, fetch: false } : { dir: CACHE, fetch: true };
const cachePath = (symbol: string, interval: string, side: string, key: string) => `${src.dir}/${symbol}/${interval}/${side}/${key}.json`;
const fetcher = fileFetcher(cachePath);
const fromOf = (tf: LTf): number =>
  tf === "15min" ? START_MS - 12 * DAY : tf === "1h" ? START_MS - 45 * DAY : SYN ? START_MS - 90 * DAY : Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1);

const lines: string[] = [];
const say = (s = "") => {
  lines.push(s);
  console.log(s);
};
const sayOut = say;
const isoMs = (ms: number) => new Date(ms).toISOString();
const weekOf = (ms: number) => Math.floor((ms - WEEK_OFFSET) / WEEK);

// ---- the checks -----------------------------------------------------------------------------

interface Check {
  ok: boolean;
  n: number;
  detail: string;
  examples: string[];
}
const checks: Record<string, Check> = {};
const check = (name: string, ok: boolean, n: number, detail: string, examples: string[] = []) => {
  checks[name] = { ok, n, detail, examples: examples.slice(0, 8) };
};

// ---- the walk (MODE=syn) ---------------------------------------------------------------------

// a 1-hour day file of USD/JPY written empty (a weekday): GMO losing a file, the hole the labels must call unreadable
const SYN_HOLE = { pair: "USD/JPY", tf: "1h" as Tf, key: "20250212" };

const writeTheWalk = async () => {
  const from = START_MS - 100 * DAY;
  for (const [pi, pair] of PAIRS.entries()) {
    const f = walk5(pair, pi, { seed: SEED }, from, LABEL_END_MS);
    const bars = { "5min": f, "15min": coarsen(f, "15min"), "1h": coarsen(f, "1h"), "4h": coarsen(f, "4h") };
    await writeWalk(src.dir, pair, bars, from, LABEL_END_MS, pair === SYN_HOLE.pair ? [{ tf: SYN_HOLE.tf, key: SYN_HOLE.key }] : []);
  }
};

// ---- one pair's bars, signals and labels ------------------------------------------------------

interface Moment {
  C: number;
  // the signal (null: a moment checked against the chart only)
  sig: Sig | null;
  why: string;
  // a late signal made from an on-time one (the walk has few or none): checked, not counted
  made?: boolean;
}
interface PairRun {
  pair: string;
  bars: Record<LTf, Bars>;
  diags: Record<LTf, TfDiag>;
  sigs: Sig[];
  moments: Moment[];
  series: Record<LTf, Series>;
  labels: Record<LTf, Labels>;
}

// the moments a pair's labels are read at: its signals' C, and (chart check) every 15-minute close of the
// Monday mornings 00:00-03:45 UTC (the newest 4-hour bar the Sunday 20:00 one) and every hour for a day and
// a half after New Year and the clocks changing
const momentsOf = (sigs: Sig[]): Moment[] => {
  const out: Moment[] = [];
  const cOf = (s: Sig) => (PLANT === "readAtTminus15" ? s.base - 15 * MINUTE : PLANT === "lateFromT" && s.late ? s.T : s.base);
  for (const s of sigs) out.push({ C: cOf(s), sig: s, why: s.late ? "late" : "email" });
  // the walk: every 50th on-time signal also as a late one (read at T + 15 minutes), for the checks only
  if (SYN) {
    sigs.filter((s) => !s.late).forEach((s, k) => {
      if (k % 50 !== 0) return;
      const l: Sig = { ...s, late: true, base: s.T + 15 * MINUTE };
      out.push({ C: cOf(l), sig: l, why: "late*", made: true });
    });
  }
  for (let w = Math.floor((START_MS - WEEK_OFFSET) / WEEK); w * WEEK + WEEK_OFFSET < END_MS; w++) {
    const monday = w * WEEK + WEEK_OFFSET + 3 * HOUR;
    for (let q = 0; q < 16; q++) {
      const C = monday + q * 15 * MINUTE;
      if (C > START_MS && C <= END_MS) out.push({ C, sig: null, why: "monday" });
    }
  }
  for (const day of specialDays(START_MS, END_MS)) for (let h = 0; h < 36; h++) out.push({ C: day + 22 * HOUR + h * HOUR, sig: null, why: "special" });
  out.sort((a, b) => a.C - b.C || (a.sig ? 0 : 1) - (b.sig ? 0 : 1));
  return out;
};

// planted errors that change the label itself, applied after labelsOf
const plantLabels = (s: Series, L: Labels, Cs: Float64Array) => {
  if (PLANT !== "formingInWindow" && PLANT !== "hourMidPrice" && PLANT !== "oneBarAhead") return;
  const T = s.bars;
  for (let k = 0; k < Cs.length; k++) {
    const i = L.bar[k];
    if (i < 0 || L.state[k] < 0) continue;
    const C = Cs[k];
    const forming = i + 1 < T.n && T.t[i + 1] <= C;
    if (PLANT === "hourMidPrice" && (s.tf === "15min" || C % s.step === 0)) continue;
    if ((PLANT === "formingInWindow" || PLANT === "hourMidPrice") && !forming) continue;
    if (PLANT === "oneBarAhead" && i + 1 >= T.n) continue;
    // the window moved one bar on: the forming (or next) bar's prices read
    const r = labelsOf(s, Float64Array.of(T.t[i + 1] + s.step - FINE));
    L.state[k] = r.state[0];
    L.bar[k] = r.bar[0];
    L.first[k] = r.first[0];
    L.excl[k] = r.excl[0];
  }
};

const runPair = async (pair: string, pi: number, st: ReturnType<typeof newLoadStats>): Promise<PairRun> => {
  const bars = {} as Record<LTf, Bars>;
  const diags = {} as Record<LTf, TfDiag>;
  for (const tf of TFS) {
    const r = await loadTf(src, pair, tf, fromOf(tf), LABEL_END_MS, st, weekendOut);
    if (PLANT === "keyFromJst") for (let i = 0; i < r.bars.n; i++) r.bars.key[i] = tf === "4h" ? Number(new Date(r.bars.t[i] + 9 * HOUR).getUTCFullYear()) : Number(new Date(r.bars.t[i] + 9 * HOUR).toISOString().slice(0, 10).replace(/-/g, ""));
    bars[tf] = r.bars;
    diags[tf] = r.diag;
  }
  const q15 = await load15(src, pair, START_MS - LEAD15, END_MS, st);
  const read = signalsOf(pair, pi, q15, START_MS, END_MS, false);
  return { pair, bars, diags, sigs: read.signals, moments: momentsOf(read.signals), series: {} as Record<LTf, Series>, labels: {} as Record<LTf, Labels> };
};

const labelPair = (p: PairRun, holes: Record<LTf, Set<number>>) => {
  const Cs = Float64Array.from(p.moments.map((m) => m.C));
  const fineT = Cs.map((C) => C - FINE);
  for (const tf of TFS) {
    const s = seriesOf(tf, p.bars[tf], holes[tf], GAPS);
    const L = labelsOf(s, fineT);
    plantLabels(s, L, Cs);
    p.series[tf] = s;
    p.labels[tf] = L;
  }
};

// ---- the chart check, and the look-ahead checks ---------------------------------------------------

const mineAt = (s: Series, L: Labels, k: number) => ({
  state: L.state[k] >= 0 ? STATE_NAMES[L.state[k]] : null,
  count: L.state[k] >= 0 ? L.bar[k] - L.first[k] + 1 : 0,
  first: L.state[k] >= 0 ? iso(s.bars.t[L.first[k]]) : null,
  last: L.state[k] >= 0 ? iso(s.bars.t[L.bar[k]]) : null,
});

// every moment (each signal at its true C) against fetchDowQuotes -> splitBars -> dowOf on the same files
const chartCheck = async (runs: PairRun[]) => {
  const by: Record<string, { n: number; bad: number }> = {};
  const ex: string[] = [];
  for (const p of runs) {
    for (const tf of TFS) {
      const s = p.series[tf];
      const L = p.labels[tf];
      for (let k = 0; k < p.moments.length; k++) {
        const m = p.moments[k];
        const C = m.sig ? m.sig.base : m.C;
        const c = await chartRead(p.pair, tf, C + LAG, fetcher);
        const mine = mineAt(s, L, k);
        const key = `${m.why}|${tf}`;
        by[key] ??= { n: 0, bad: 0 };
        by[key].n++;
        if (c.state !== mine.state || c.count !== mine.count || c.first !== mine.first || c.last !== mine.last) {
          by[key].bad++;
          if (ex.length < 8) ex.push(`${p.pair} ${tf} C ${isoMs(C)} (${m.why}): chart ${c.state} ${c.count} ${c.first}..${c.last}; here ${mine.state} ${mine.count} ${mine.first}..${mine.last}`);
        }
      }
    }
  }
  const n = Object.values(by).reduce((a, b) => a + b.n, 0);
  const bad = Object.values(by).reduce((a, b) => a + b.bad, 0);
  const emails = Object.entries(by).filter(([k]) => k.startsWith("email|") || k.startsWith("late|")).reduce((a, [, v]) => a + v.n, 0) / TFS.length;
  check("chart", bad === 0 && emails >= Math.min(2_000, runs.reduce((a, p) => a + p.sigs.length, 0)), bad, `${n} readings (${Object.entries(by).map(([k, v]) => `${k} ${v.n}/${v.bad}`).join(", ")}); email times ${emails}`, ex);
};

// Each signal's label rebuilt from the bars around its window only, the bars not closed by C changed:
// "cut" their prices emptied (NaN), "poison" moved ±777.7 pips (times and the 300/301 counting kept);
// the label (state, window, unreadable) must not move. And the walk only: with the past moved instead,
// the label must move somewhere (the check can see).
const lookAhead = (runs: PairRun[], holes: Record<LTf, Set<number>>) => {
  for (const mode of ["cut", "poison"] as const) {
    let n = 0;
    let moved = 0;
    const ex: string[] = [];
    for (const p of runs) {
      const pip = unitOf(p.pair);
      for (const tf of TFS) {
        const s = p.series[tf];
        const L = p.labels[tf];
        for (let k = 0; k < p.moments.length; k++) {
          const m = p.moments[k];
          if (!m.sig || L.bar[k] < 0 || L.state[k] < 0) continue;
          const C = p.moments[k].C;
          const lo = Math.max(0, L.first[k] - 8);
          const hi = Math.min(s.bars.n - 1, L.bar[k] + 8);
          const b = sliceBars(s.bars, lo, hi + 1);
          for (let j = 0; j < b.n; j++) {
            if (b.t[j] + s.step <= C) continue;
            if (mode === "cut") {
              for (const a of [b.bo, b.bh, b.bl, b.bc, b.ao, b.ah, b.al, b.ac]) a[j] = NaN;
            } else {
              const d = (j % 2 === 0 ? 777.7 : -777.7) * pip;
              for (const a of [b.bo, b.bh, b.bl, b.bc, b.ao, b.ah, b.al, b.ac]) a[j] += d;
            }
          }
          const s2 = seriesOf(tf, b, holes[tf], GAPS);
          const L2 = labelsOf(s2, Float64Array.of(C - FINE));
          plantLabels(s2, L2, Float64Array.of(C));
          n++;
          const same = L2.state[0] === L.state[k] && L2.bar[0] + lo === L.bar[k] && L2.first[0] + lo === L.first[k] && L2.excl[0] === L.excl[k];
          if (!same) {
            moved++;
            if (ex.length < 6) ex.push(`${p.pair} ${tf} C ${isoMs(C)}: ${STATE_NAMES[L.state[k]] ?? "-"} -> ${STATE_NAMES[L2.state[0]] ?? "-"}`);
          }
        }
      }
    }
    check(`lookAhead.${mode}`, moved === 0 && n > 0, moved, `${n} labels rebuilt, ${moved} moved`, ex);
  }
};

// ---- the signals against (a)'s file ---------------------------------------------------------------

const joinA = async (sigs: Sig[]) => {
  const text = await Deno.readTextFile(A_CSV);
  const hash = await sha256Hex(text);
  const rows = text.split("\n").filter((l) => l !== "");
  if (rows[0] !== "T,pair,side,P,week,v1d") throw new Error(`${A_CSV}: header ${rows[0]}`);
  const want = new Map<string, number>();
  for (const l of rows.slice(1)) {
    const c = l.split(",");
    const k = `${Date.parse(c[0])}|${c[1]}|${c[2]}`;
    want.set(k, (want.get(k) ?? 0) + 1);
  }
  const have = new Map<string, Sig[]>();
  for (const s of sigs) {
    const k = `${s.T}|${s.pair}|${s.side}`;
    have.set(k, [...(have.get(k) ?? []), s]);
  }
  let rowOnce = 0;
  const rowBad: string[] = [];
  for (const [k, c] of want) {
    const h = have.get(k)?.length ?? 0;
    if (c === 1 && h === 1) rowOnce++;
    else rowBad.push(`${k} rows ${c} signals ${h}`);
  }
  const without = sigs.filter((s) => !want.has(`${s.T}|${s.pair}|${s.side}`));
  const whys = without.map((s) => `${isoMs(s.T)} ${s.pair} ${s.side} P ${isoMs(s.base + DELAY * MINUTE)}${s.base + DELAY * MINUTE + DAY > END_MS ? " (P + 1 day past END)" : " (no P bar?)"}`);
  check("aFile", hash === A_SHA256 && rowBad.length === 0 && rowOnce === rows.length - 1 && without.length === 8, rowBad.length,
    `sha256 ${hash === A_SHA256 ? "as fixed" : `${hash} (not ${A_SHA256})`}; rows ${rows.length - 1}, each one signal ${rowOnce}; signals ${sigs.length}, without a row ${without.length}`, [...rowBad, ...whys]);
  return whys;
};

// ---- which half an email is in (§8.106 5) -----------------------------------------------------------

// the end of each signal's follow (the 1,440th 5-minute bar from T, its close) where a half's edge is near;
// elsewhere the window is days long and inside its half
const halvesOf = async (runs: PairRun[], st: ReturnType<typeof newLoadStats>) => {
  const half = new Map<Sig, "H1" | "H2" | "-">();
  let measured = 0;
  let longest = 0;
  for (const p of runs) {
    const ranges = [[SPLIT_MS - EDGE, SPLIT_MS + 14 * DAY], [END_MS - EDGE, END_MS]];
    const times: number[] = [];
    for (const [a, b] of ranges) for (const q of await loadQuotes(src, p.pair, "5min", 5 * MINUTE, a, b, st)) times.push(Date.parse(q.datetime));
    times.sort((x, y) => x - y);
    const T5 = Float64Array.from(times);
    const endOf = (T: number, limit: number): number => {
      const i = lowerBound(T5, T);
      const j = i + TRACK_BARS - 1;
      if (j >= T5.length || T5[j] + 5 * MINUTE > limit) return Infinity;
      return T5[j] + 5 * MINUTE;
    };
    for (const s of p.sigs) {
      if (PLANT === "keepEdge") {
        // planted: the halves by T alone, a follow crossing the split or END kept
        half.set(s, s.T < SPLIT_MS ? "H1" : "H2");
        continue;
      }
      if (s.T < SPLIT_MS) {
        if (s.T < SPLIT_MS - EDGE) half.set(s, "H1");
        else {
          measured++;
          const e = endOf(s.T, SPLIT_MS);
          if (Number.isFinite(e)) longest = Math.max(longest, e - s.T);
          half.set(s, e <= SPLIT_MS ? "H1" : "-");
        }
      } else if (s.T < END_MS - EDGE) half.set(s, "H2");
      else {
        measured++;
        const e = endOf(s.T, END_MS);
        if (Number.isFinite(e)) longest = Math.max(longest, e - s.T);
        half.set(s, e <= END_MS ? "H2" : "-");
      }
    }
  }
  // 手の例: an email closing within 3 days of the split or of END follows 1,440 bars (5 days of open market)
  // past it, so it is in neither half's comparison
  const edgeBad = runs.flatMap((p) => p.sigs).filter((s) => ((s.T < SPLIT_MS && SPLIT_MS - s.T < 3 * DAY) || END_MS - s.T < 3 * DAY) && half.get(s) !== "-");
  check("halves", (PLANT === "keepEdge" || (longest > 0 && longest < EDGE - DAY)) && edgeBad.length === 0, edgeBad.length,
    `windows counted bar by bar near the edges: ${measured}; the longest ${(longest / DAY).toFixed(2)} days (under ${(EDGE / DAY - 1).toFixed(0)} days, so the others are inside their half); emails within 3 days of an edge kept in a half: ${edgeBad.length}`,
    edgeBad.slice(0, 5).map((s) => `${isoMs(s.T)} ${s.pair} ${s.side} in ${half.get(s)}`));
  return half;
};

// ---- the candidates (§8.106 2) ------------------------------------------------------------------

const CANDS = ["①1H", "②4H", "③1H+4H", "④15M"] as const;
// 1: kept, -1: left out, 0: unreadable for this candidate
const verdictOf = (c: number, s: Sig, lab: Record<LTf, { state: number; excl: number }>): number => {
  const ok = (tf: LTf) => lab[tf].state >= 0 && lab[tf].excl === 0;
  const against = (tf: LTf) => dirOf(lab[tf].state) === -SIDE_DIR(s);
  if (c === 0) return ok("1h") ? (against("1h") ? -1 : 1) : 0;
  if (c === 1) return ok("4h") ? (against("4h") ? -1 : 1) : 0;
  if (c === 2) return ok("1h") && ok("4h") ? (against("1h") && against("4h") ? -1 : 1) : 0;
  return ok("15min") ? (against("15min") ? -1 : 1) : 0;
};

interface Row {
  s: Sig;
  half: "H1" | "H2" | "-";
  lab: Record<LTf, { state: number; excl: number }>;
}
const rowsOf = (runs: PairRun[], half: Map<Sig, "H1" | "H2" | "-">): Row[] => {
  const out: Row[] = [];
  for (const p of runs) {
    p.moments.forEach((m, k) => {
      if (!m.sig || m.made) return;
      const lab = {} as Row["lab"];
      for (const tf of TFS) lab[tf] = { state: p.labels[tf].state[k], excl: p.labels[tf].state[k] >= 0 ? p.labels[tf].excl[k] : 9 };
      out.push({ s: m.sig, half: half.get(m.sig) ?? "-", lab });
    });
  }
  out.sort((a, b) => a.s.T - b.s.T || a.s.pi - b.s.pi || b.s.dir - a.s.dir || Number(a.s.late) - Number(b.s.late));
  return out;
};

const csvOf = (rows: Row[]): string => {
  const head = "T,pair,side,late,C,half,s15,x15,s1h,x1h,s4h,x4h";
  const body = rows.map((r) => {
    const c = (tf: LTf) => `${r.lab[tf].state >= 0 ? STATE_NAMES[r.lab[tf].state] : "-"},${r.lab[tf].excl}`;
    return `${isoMs(r.s.T)},${r.s.pair},${r.s.side},${r.s.late ? 1 : 0},${isoMs(r.s.base)},${r.half},${c("15min")},${c("1h")},${c("4h")}`;
  });
  return [head, ...body].join("\n") + "\n";
};

// the counts and the floors (§8.106 6): each half, each candidate
export interface Count {
  half: string;
  cand: string;
  side: string;
  kept: number;
  out: number;
  unread: number;
  weeksKept: number;
  weeksOut: number;
}
const countsOf = (rows: Row[], quiet = false): { floors: Record<string, boolean>; counts: Count[] } => {
  const say = quiet ? (_s = "") => {} : sayOut;
  const counts: Count[] = [];
  const weeksIn = (h: "H1" | "H2") => h === "H1" ? weekOf(SPLIT_MS - 1) - weekOf(START_MS) + 1 : weekOf(END_MS - 1) - weekOf(SPLIT_MS) + 1;
  const all = rows.length;
  const allWeeks = weekOf(END_MS - 1) - weekOf(START_MS) + 1;
  say(`emails ${all} over ${allWeeks} weeks: ${(all / allWeeks).toFixed(1)} a week (both halves and the edges)`);
  const floors: Record<string, boolean> = {};
  for (const h of ["H1", "H2"] as const) {
    const inH = rows.filter((r) => r.half === h);
    const W = weeksIn(h);
    say(`\n-- ${h}: ${inH.length} emails, ${W} weeks, ${(inH.length / W).toFixed(1)} a week (BUY ${inH.filter((r) => r.s.side === "BUY").length}, SELL ${inH.filter((r) => r.s.side === "SELL").length})`);
    CANDS.forEach((name, c) => {
      const v = inH.map((r) => verdictOf(c, r.s, r.lab));
      const cnt = (want: number, side?: string) => inH.filter((r, i) => v[i] === want && (!side || r.s.side === side)).length;
      const weeks = (want: number, side?: string) => new Set(inH.filter((r, i) => v[i] === want && (!side || r.s.side === side)).map((r) => weekOf(r.s.T))).size;
      const kept = cnt(1), out = cnt(-1), unread = cnt(0);
      const kB = cnt(1, "BUY"), kS = cnt(1, "SELL"), oB = cnt(-1, "BUY"), oS = cnt(-1, "SELL"), uB = cnt(0, "BUY"), uS = cnt(0, "SELL");
      const wK = weeks(1), wO = weeks(-1), wKB = weeks(1, "BUY"), wKS = weeks(1, "SELL");
      const unreadShare = inH.length ? unread / inH.length : 0;
      for (const side of ["all", "BUY", "SELL"]) {
        const sd = side === "all" ? undefined : side;
        counts.push({ half: h, cand: name, side, kept: cnt(1, sd), out: cnt(-1, sd), unread: cnt(0, sd), weeksKept: weeks(1, sd), weeksOut: weeks(-1, sd) });
      }
      const pass = kept >= 300 && out >= 300 && wK >= 30 && wO >= 30 && kB >= 50 && kS >= 50 && wKB >= 40 && wKS >= 40 && unreadShare <= 0.02;
      floors[`${h}|${name}`] = pass;
      say(`${name}: kept ${kept} (${(kept / W).toFixed(1)} a week; BUY ${kB}, SELL ${kS}), left out ${out} (BUY ${oB}, SELL ${oS}), unreadable ${unread} (${(100 * unreadShare).toFixed(2)}%; BUY ${uB}, SELL ${uS})`);
      say(`   weeks with a kept email ${wK} (BUY ${wKB}, SELL ${wKS}), with one left out ${wO} -> floors ${pass ? "met" : "NOT met"}${unreadShare > 0.02 ? " (unreadable over 2%: stop and look before any outcome)" : ""}`);
    });
  }
  say(`\nfloors (§8.106 6; a candidate must meet them in both halves): ${CANDS.map((n) => `${n} ${floors[`H1|${n}`] && floors[`H2|${n}`] ? "passes" : "drops"}`).join(", ")}`);
  return { floors, counts };
};

// ---- the data's own checks ----------------------------------------------------------------------

const dataChecks = (runs: PairRun[], st: ReturnType<typeof newLoadStats>, holes: Record<LTf, Set<number>>) => {
  check("loads", st.failed === 0, st.failed, `requests ${st.requests}, kept files ${st.cached}, read again ${st.partial}, failed ${st.failed}${st.failed ? ` (${Object.entries(st.failedWhy).map(([k, v]) => `${k} ${v}`).join("; ")})` : ""}`, st.failedExamples);
  let keyBad = 0;
  const keyEx: string[] = [];
  for (const p of runs) {
    for (const tf of TFS) {
      const d = p.diags[tf];
      keyBad += d.keyMismatch;
      keyEx.push(...d.keyMismatchEx.map((e) => `${p.pair} ${tf} ${e}`));
      say(`${p.pair} ${tf}: ${d.bars} bars ${d.bars ? `${iso(d.first)} .. ${iso(d.last)}` : ""}; files ${d.files}; in two files ${d.repeated}, one side only ${d.oneSide}, ask under bid ${d.crossed}; 15:00-20:59 UTC bars ${d.lateUtc}; Friday files made before 21:00 UTC ${d.fridayEarly.length}`);
    }
  }
  // a bar's file is the one GMO's rule names (the day from 21:00 UTC, or that day's year): §8.106 11 手の例
  if (PLANT === "keyFromJst") {
    for (const p of runs) for (const tf of TFS) for (let i = 0; i < p.bars[tf].n; i++) {
      const t = p.bars[tf].t[i];
      const rule = tf === "4h" ? Number(gmoYearKey(t)) : Number(gmoDayKey(t));
      if (p.bars[tf].key[i] !== rule) keyBad++;
    }
  }
  check("fileKeys", keyBad === 0, keyBad, `bars in another file than GMO's rule names: ${keyBad}`, keyEx);
  // the 1-hour and 4-hour bars against the 15-minute bars inside them
  const agree: Record<string, Agree> = {};
  let differ = 0;
  for (const p of runs) {
    for (const tf of ["1h", "4h"] as const) {
      const fe = new Set(p.diags["1h"].fridayEarly.map(Number));
      const a = agreeWith15(p.bars[tf], STEP_OF[tf], p.bars["15min"], tf === "1h" ? fe : new Set());
      agree[`${p.pair}|${tf}`] = a;
      differ += a.differ;
      say(`${p.pair} ${tf} against 15min: compared ${a.compared}, differ ${a.differ} (of them in a Friday file made before 21:00 UTC ${a.differFridayEarly}); without 15-minute bars ${a.coarseAlone}, 15-minute bars outside ${a.fineAlone}${a.examples.length ? `; e.g. ${a.examples.join(", ")}` : ""}`);
    }
  }
  check("barsAgree", true, differ, `1h/4h bars differing from their 15-minute bars: ${differ} (counted, printed; not a stop)`);
  // the unexplained holes, and GMO's own closures
  for (const tf of TFS) {
    const days = new Map<string, number>();
    for (const s of holes[tf]) days.set(isoMs(s).slice(0, 10), (days.get(isoMs(s).slice(0, 10)) ?? 0) + 1);
    say(`GMO's own closures ${tf}: ${holes[tf].size} stamps on ${days.size} days${days.size ? `: ${[...days].slice(0, 40).map(([d, n]) => `${d}(${n})`).join(" ")}` : ""}`);
  }
  for (const p of runs) say(`${p.pair} unexplained holes: ${TFS.map((tf) => `${tf} ${p.series[tf].gap[p.series[tf].bars.n]}`).join(", ")}`);
  // the week's last 15-minute bar of each pair, by the US summer (how GMO's week ends)
  for (const p of runs) {
    const ends = new Map<string, number>();
    const b = p.bars["15min"];
    for (let i = 0; i + 1 < b.n; i++) {
      if (b.t[i + 1] - b.t[i] < 24 * HOUR) continue;
      const d = new Date(b.t[i]);
      if (d.getUTCDay() !== 5) continue;
      const k = `${d.toISOString().slice(11, 16)}`;
      ends.set(k, (ends.get(k) ?? 0) + 1);
    }
    say(`${p.pair} the week's last 15-minute bar (UTC start, weeks): ${[...ends].sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
};

// §8.106 11 手の例 on the bars read
const handExamples = (runs: PairRun[]) => {
  const out: string[] = [];
  let bad = 0;
  for (const p of runs) {
    // the 4-hour bars on GMO's grid; the JST year's edge (31 Dec 16:00 and 20:00 UTC) in the year file of its UTC day
    const b4 = p.bars["4h"];
    for (let i = 0; i < b4.n; i++) {
      if (b4.t[i] % (4 * HOUR) !== 0) {
        bad++;
        out.push(`${p.pair} 4h ${isoMs(b4.t[i])} not on 0/4/8.. UTC`);
      }
      const d = new Date(b4.t[i]);
      if (d.getUTCMonth() === 11 && d.getUTCDate() === 31 && d.getUTCHours() >= 16) {
        const ok = b4.key[i] === d.getUTCFullYear();
        if (!ok) bad++;
        if (out.length < 30) out.push(`${p.pair} 4h ${isoMs(b4.t[i])} in year file ${b4.key[i]} (JST already ${d.getUTCFullYear() + 1})${ok ? "" : " WRONG"}`);
      }
    }
    // day files: a bar at 15:00-20:59 UTC under its UTC date; Friday's last hour and a Saturday file
    const b1 = p.bars["1h"];
    let shown = 0;
    for (let i = 0; i < b1.n; i++) {
      const d = new Date(b1.t[i]);
      const h = d.getUTCHours();
      const want = Number(gmoDayKey(b1.t[i]));
      if (b1.key[i] !== want) bad++;
      if (shown < 3 && ((h === 16 && d.getUTCDay() === 2) || (d.getUTCDay() === 5 && h >= 20))) {
        shown++;
        out.push(`${p.pair} 1h ${isoMs(b1.t[i])} in day file ${b1.key[i]} (UTC date ${d.toISOString().slice(0, 10)}, JST ${new Date(b1.t[i] + 9 * HOUR).toISOString().slice(0, 10)})`);
      }
    }
  }
  check("hand", bad === 0, bad, `bars against GMO's file rule and grid: ${bad} wrong`, out);
  return out;
};

// the candidates' verdicts on hand-made labels (§8.106 2: against = BUY with down/toDown, SELL with up/toUp;
// none never leaves an email out; a label not read leaves the candidate out of the comparison)
const verdictHand = () => {
  const sig = (side: "BUY" | "SELL") => ({ side, dir: side === "BUY" ? 1 : -1 }) as Sig;
  const lab = (a: number, b: number, c: number, xb = 0): Row["lab"] => ({ "15min": { state: a, excl: a < 0 ? 9 : 0 }, "1h": { state: b, excl: xb }, "4h": { state: c, excl: 0 } });
  // states: 0 none, 1 up, 2 down, 3 toUp, 4 toDown; expected ① ② ③ ④ (1 kept, -1 left out, 0 unreadable)
  const cases: Array<[string, Sig, Row["lab"], number[]]> = [
    ["BUY 15M up, 1H down, 4H toUp", sig("BUY"), lab(1, 2, 3), [-1, 1, 1, 1]],
    ["SELL 15M toUp, 1H toUp, 4H up", sig("SELL"), lab(3, 3, 1), [-1, -1, -1, -1]],
    ["BUY 15M toDown, 1H none, 4H toDown", sig("BUY"), lab(4, 0, 4), [1, -1, 1, -1]],
    ["SELL 15M down, 1H up (short), 4H down", sig("SELL"), lab(2, 1, 2, 1), [0, 1, 0, 1]],
    ["BUY 15M not read, 1H up, 4H down", sig("BUY"), lab(-1, 1, 2), [1, -1, 1, 0]],
    ["SELL 15M none, 1H down, 4H toDown", sig("SELL"), lab(0, 2, 4), [1, 1, 1, 1]],
  ];
  const bad: string[] = [];
  for (const [name, s, l, want] of cases) {
    const got = CANDS.map((_, c) => verdictOf(c, s, l));
    if (got.join() !== want.join()) bad.push(`${name}: ${got.join(" ")} (want ${want.join(" ")})`);
  }
  check("verdicts", bad.length === 0, bad.length, `${cases.length} hand-made emails through the four candidates`, bad);
};

// ---- the examples of 10/7 and 10/9 (§8.106 12 の5) ------------------------------------------------------

const examples = async (st: ReturnType<typeof newLoadStats>, holes: Record<LTf, Set<number>>) => {
  const text = await Deno.readTextFile(EXAMPLES);
  const rows = text.split("\n").filter((l) => l !== "").slice(1).map((l) => {
    const c = l.split(",");
    return { pair: c[0], side: c[1], open: Date.parse(c[2]), T: Date.parse(c[3]), E: Number(c[4]), sent: Date.parse(c[5]) };
  });
  say(`\n== the examples (§8.106 12 の5; labels only, no outcome): ${rows.length} emails of 10/7 and 10/9 JST`);
  const from = Date.parse("2026-10-06T00:00:00Z");
  for (const [pi, pair] of PAIRS.entries()) {
    const mine = rows.filter((r) => r.pair === pair);
    if (!mine.length) continue;
    const q15 = await load15(src, pair, from - LEAD15, LABEL_END_MS, st);
    const sigs = signalsOf(pair, pi, q15, from, LABEL_END_MS, false).signals;
    const found: Array<{ r: typeof rows[number]; s: Sig | null }> = mine.map((r) => ({ r, s: sigs.find((s) => s.open === r.open && s.side === r.side) ?? null }));
    const moments = found.filter((f) => f.s).map((f) => f.s!.base);
    const bars: Record<LTf, Bars> = {} as Record<LTf, Bars>;
    for (const tf of TFS) bars[tf] = (await loadTf(src, pair, tf, from - (tf === "4h" ? 120 : 60) * DAY, LABEL_END_MS, st, weekendOut)).bars;
    const labs = {} as Record<LTf, Labels>;
    const sers = {} as Record<LTf, Series>;
    for (const tf of TFS) {
      sers[tf] = seriesOf(tf, bars[tf], holes[tf], GAPS);
      labs[tf] = labelsOf(sers[tf], Float64Array.from(moments.map((C) => C - FINE)));
    }
    let k = 0;
    for (const f of found) {
      const jst = new Date(f.r.T + 9 * HOUR).toISOString().slice(5, 16).replace("T", " ");
      if (!f.s) {
        say(`${jst} JST ${pair} ${f.r.side} ${f.r.E}: no signal found at this bar (not labelled)`);
        continue;
      }
      const lab = {} as Row["lab"];
      const parts: string[] = [];
      for (const tf of TFS) {
        lab[tf] = { state: labs[tf].state[k], excl: labs[tf].state[k] >= 0 ? labs[tf].excl[k] : 9 };
        const c = await chartRead(pair, tf, f.s.base + LAG, fetcher);
        const same = c.state === (labs[tf].state[k] >= 0 ? STATE_NAMES[labs[tf].state[k]] : null);
        parts.push(`${tf} ${labs[tf].state[k] >= 0 ? STATE_NAMES[labs[tf].state[k]] : "-"}${lab[tf].excl ? `(x${lab[tf].excl})` : ""}${same ? "" : " [chart differs]"}`);
      }
      const v = CANDS.map((n, c) => `${n} ${["unreadable", "kept", "left out"][verdictOf(c, f.s!, lab) === 1 ? 1 : verdictOf(c, f.s!, lab) === -1 ? 2 : 0]}`);
      say(`${jst} JST ${pair} ${f.r.side} ${f.r.E}${f.s.late ? " (late)" : ""}: ${parts.join(", ")} | ${v.join(", ")}`);
      k++;
    }
  }
};

// ---- the run ------------------------------------------------------------------------------------

const main = async () => {
  if (!SYN && Date.now() < LABEL_END_MS + HOUR) throw new Error(`the bars are read to ${isoMs(LABEL_END_MS)}: run an hour after it`);
  await Deno.mkdir(OUT, { recursive: true });
  say(`MODE ${MODE}${PLANT ? ` PLANT ${PLANT}` : ""}${SYN ? ` SEED ${SEED}` : ""}; ${isoMs(START_MS)} .. ${isoMs(END_MS)}, split ${isoMs(SPLIT_MS)}, bars read to ${isoMs(LABEL_END_MS)}; window ${WINDOW} bars; weekend ${PLANT === "weekendStamp" ? "stamp" : "inside"}`);
  if (SYN) await writeTheWalk();
  const st = newLoadStats();
  const runs: PairRun[] = [];
  for (const [pi, pair] of PAIRS.entries()) {
    if (!GMO_SYMBOLS[pair]) throw new Error(`${pair}: no GMO symbol`);
    runs.push(await runPair(pair, pi, st));
    say(`read ${pair}: ${TFS.map((tf) => `${tf} ${runs[pi].bars[tf].n}`).join(", ")}; signals ${runs[pi].sigs.length} (late ${runs[pi].sigs.filter((s) => s.late).length}); moments ${runs[pi].moments.length}`);
  }
  const holes = {} as Record<LTf, Set<number>>;
  for (const tf of TFS) holes[tf] = GAPS.commonMissing(runs.map((p) => p.bars[tf]), STEP_OF[tf]);
  for (const p of runs) labelPair(p, holes);
  const sigs = runs.flatMap((p) => p.sigs);
  say(`signals ${sigs.length} (late ${sigs.filter((s) => s.late).length})`);

  say("\n== data");
  dataChecks(runs, st, holes);
  if (!SYN) await joinA(sigs);
  handExamples(runs);
  verdictHand();
  await chartCheck(runs);
  lookAhead(runs, holes);
  const half = await halvesOf(runs, st);
  const rows = rowsOf(runs, half);
  const csv = csvOf(rows);
  const hash = await sha256Hex(csv);
  await Deno.writeTextFile(`${OUT}/trend-labels.csv`, csv);
  check("rows", rows.length === sigs.length, Math.abs(rows.length - sigs.length), `label rows ${rows.length}, signals ${sigs.length}`);

  say("\n== checks");
  for (const [k, c] of Object.entries(checks)) {
    say(`${c.ok ? "ok  " : "FAIL"} ${k}: ${c.detail}`);
    for (const e of c.examples) say(`       ${e}`);
  }
  const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);
  await Deno.writeTextFile(`${OUT}/checks.json`, JSON.stringify({ mode: MODE, plant: PLANT, seed: SEED, failed, checks, labels: { rows: rows.length, sha256: hash } }, null, 1));
  say(`\ntrend-labels.csv: ${rows.length} rows, sha256 ${hash}`);
  if (failed.length) {
    say(`\nchecks failed: ${failed.join(", ")} — no counts are printed`);
    await Deno.writeTextFile(`${OUT}/print.txt`, lines.join("\n") + "\n");
    if (!PLANT) Deno.exit(1);
    // a planted error on the walk: the counts written (not printed) for the Python to compare
    const { floors, counts } = countsOf(rows, true);
    await Deno.writeTextFile(`${OUT}/counts.json`, JSON.stringify({ labelsSha256: hash, floors, counts }, null, 1));
    return;
  }
  say("\n== counts (stage 0: no outcome read)");
  const { floors, counts } = countsOf(rows);
  await Deno.writeTextFile(`${OUT}/counts.json`, JSON.stringify({ labelsSha256: hash, floors, counts }, null, 1));
  if (!SYN) await examples(st, holes);
  await Deno.writeTextFile(`${OUT}/print.txt`, lines.join("\n") + "\n");
};

await main();
