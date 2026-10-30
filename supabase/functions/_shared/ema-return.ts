// #387 (docs §8.130): the owner's video's way — 20 EMA and 200 EMA cross, the
// candle back to the 200 EMA, two necklines (a diagonal and a horizontal),
// their break, a return move to the horizontal and the bar that closes past
// the return move's body — as pure functions over a chart's closed bars, so
// the chart (src/lib/emaReturn.ts re-exports this file) and the email
// (signal-alerts/indicators.ts) decide with the same code.
//
// The owner (2026-10-30), with a screen recording of an Instagram video
// ("勝率60% リスクリワード1:1.2のスキャルピング手法を一分で解説", GBPJPY 15分足,
// captions only): 「この機能追加して」; asked, the chart and the email, the
// email on the 15-minute chart of the five pairs and gold.
//
// THE RULE: research/ema-return-spec.md, word for word (the lines the video
// draws by hand fixed as numbers; APP: where it gives none). In short, at the
// closed bars of a window, oldest first, one setup alive at a time:
//   cross    EMA 20 over (under) EMA 200 at window index WARM or later: a BUY
//            (SELL) setup; A the highest high (lowest low) since the cross
//   touch    a bar's low at or under (high at or over) the 200 EMA
//   lines    B the highest swing high (3 bars each side) after the touch and
//            under A; the horizontal at h[B], the diagonal through A and B
//   break    a close above both (a new high over A first: back to the touch;
//            the break's own high at A: no entry)
//   retest   from the 3rd bar after the break, a bar whose low reaches the
//            horizontal (the latest is the return move R); a close back under
//            the horizontal: the break failed (back to the lines); the high
//            reaching A: no entry (the target was reached first)
//   entry    the first bar that closes above R's body (max of its open and
//            close); its close the entry; the stop the lowest low from the
//            diagonal's break to the entry; target 1 A; target 2 wave 1's
//            height above wave 3's start
// SELL is the mirror. Everything here is Deno-free: src/test/ema-return.test.ts
// imports it.

import { ema } from "./pine.ts";

export const EMA_RETURN = {
  fast: 20,
  slow: 200,
  // the closed bars a decision is judged on (the email's: the sweep's history
  // of a 15-minute chart), and the first index of them a cross counts from
  window: 600,
  warm: 400,
  // a swing high (low): higher (lower) than this many bars on each side
  piv: 3,
  // the bars after the break that are not a return move (「1、2本」)
  skip: 2,
} as const;
export type EmaReturnParams = { readonly fast: number; readonly slow: number; readonly window: number; readonly warm: number; readonly piv: number; readonly skip: number };

// the shortest window the chart judges on, where it holds fewer bars before a
// bar than the email's window (crosses before WARM do not count)
export const EMA_RETURN_MIN_WINDOW = EMA_RETURN.warm + 100;

export interface ErBar {
  o: number;
  h: number;
  l: number;
  c: number;
}

export type ErSide = "BUY" | "SELL";
export type ErPhase = "touch" | "lines" | "retest" | "done";

// One entry. Indices into the bars scanned; prices as they are (a SELL's A
// is the lowest low, its stop the highest high)
export interface ErEntry {
  side: ErSide;
  at: number;
  // the cross, the touch, A's bar and price
  x: number;
  t: number;
  aAt: number;
  a: number;
  // the horizontal's swing (B) and level, the break, the diagonal's break, the return move
  b: number;
  neck: number;
  k: number;
  dk: number;
  r: number;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number | null;
  rr: number;
}

// The setup alive at the last bar scanned (for the chart's lines): its phase,
// and what it has so far
export interface ErSetup {
  side: ErSide;
  phase: ErPhase;
  x: number;
  aAt: number;
  a: number;
  t: number | null;
  // the lines: the break's (in RETEST) or the best so far (in LINES), null before a swing
  b: number | null;
  neck: number | null;
  k: number | null;
  r: number | null;
}

export interface ErScan {
  entries: ErEntry[];
  setup: ErSetup | null;
  fast: ReadonlyArray<number | null>;
  slow: ReadonlyArray<number | null>;
}

// +1 golden, -1 dead, 0 none (or a line not yet defined)
const crossAt = (fast: ReadonlyArray<number | null>, slow: ReadonlyArray<number | null>, k: number): 1 | -1 | 0 => {
  if (k < 1) return 0;
  const f0 = fast[k - 1];
  const s0 = slow[k - 1];
  const f1 = fast[k];
  const s1 = slow[k];
  if (f0 === null || s0 === null || f1 === null || s1 === null) return 0;
  if (f0 <= s0 && f1 > s1) return 1;
  if (f0 >= s0 && f1 < s1) return -1;
  return 0;
};

// The diagonal through (aAt, a) and (b, hb) at j (spec: exactly this order)
const diagAt = (a: number, aAt: number, hb: number, b: number, j: number): number => a + (hb - a) * (j - aAt) / (b - aAt);

// One scan over `w` from WARM: every entry, and the setup alive at the end.
// Written for a BUY over prices seen through `dir` (a SELL negates them:
// h -> -l, l -> -h, o -> -o, c -> -c, the 200 EMA -> -it; negation is exact,
// so this is the mirror bit for bit)
export const emaReturnScan = (w: ReadonlyArray<ErBar>, o: EmaReturnParams = EMA_RETURN): ErScan => {
  const n = w.length;
  const closes = w.map((b) => b.c);
  const fast = ema(closes, o.fast);
  const slow = ema(closes, o.slow);
  const entries: ErEntry[] = [];

  let dir: 1 | -1 = 1;
  let phase: ErPhase | null = null;
  let x = -1;
  let a = 0;
  let aAt = -1;
  let t = -1;
  // the best swing so far (LINES, and kept through RETEST)
  let best = -1;
  // the break's lines
  let b = -1;
  let neck = 0;
  let k0 = -1;
  let dk = -1;
  let r = -1;

  // prices seen as a BUY's
  const H = (j: number) => (dir === 1 ? w[j].h : -w[j].l);
  const L = (j: number) => (dir === 1 ? w[j].l : -w[j].h);
  const C = (j: number) => (dir === 1 ? w[j].c : -w[j].c);
  const O = (j: number) => (dir === 1 ? w[j].o : -w[j].o);
  const S = (j: number) => (dir === 1 ? (slow[j] as number) : -(slow[j] as number));
  const back = (v: number) => (dir === 1 ? v : -v);
  const isSwing = (p: number): boolean => {
    if (p - o.piv < 0) return false;
    const hp = H(p);
    for (let j = p + 1; j <= p + o.piv; j++) if (!(hp > H(j))) return false;
    for (let j = p - o.piv; j <= p - 1; j++) if (!(hp >= H(j))) return false;
    return true;
  };

  for (let k = Math.max(o.warm, 1); k < n; k++) {
    const cr = crossAt(fast, slow, k);
    if (cr !== 0) {
      dir = cr;
      phase = "touch";
      x = k;
      a = H(k);
      aAt = k;
      t = -1;
      best = -1;
      b = -1;
      k0 = -1;
      dk = -1;
      r = -1;
      continue;
    }
    if (phase === null || phase === "done") continue;
    if (phase === "touch") {
      if (H(k) > a) {
        a = H(k);
        aAt = k;
      }
      if (L(k) <= S(k)) {
        phase = "lines";
        t = k;
        best = -1;
      }
      continue;
    }
    // LINES and RETEST: the swing confirmed at k (its bar k - piv)
    const p = k - o.piv;
    if (p > t && isSwing(p) && H(p) < a && (best < 0 || H(p) >= H(best))) best = p;
    if (phase === "lines") {
      if (best >= 0 && C(k) > H(best) && C(k) > diagAt(a, aAt, H(best), best, k)) {
        // the break's own high at A: the target reached before an entry
        if (H(k) >= a) {
          phase = "done";
          continue;
        }
        phase = "retest";
        b = best;
        neck = H(b);
        k0 = k;
        dk = -1;
        for (let j = b + 1; j <= k; j++) {
          if (C(j) > diagAt(a, aAt, neck, b, j)) {
            dk = j;
            break;
          }
        }
        r = -1;
      } else if (H(k) > a) {
        phase = "touch";
        a = H(k);
        aAt = k;
        t = -1;
        best = -1;
      }
      continue;
    }
    // RETEST
    if (H(k) >= a) {
      phase = "done";
      continue;
    }
    if (C(k) < neck) {
      phase = "lines";
      b = -1;
      k0 = -1;
      dk = -1;
      r = -1;
      continue;
    }
    if (r >= 0 && C(k) > Math.max(O(r), C(r))) {
      const e = C(k);
      let stop = Infinity;
      for (let j = dk; j <= k; j++) stop = Math.min(stop, L(j));
      let l1 = Infinity;
      for (let j = t; j <= b; j++) l1 = Math.min(l1, L(j));
      let l2 = Infinity;
      for (let j = b; j <= k0; j++) l2 = Math.min(l2, L(j));
      const tp2 = l2 + (neck - l1);
      entries.push({
        side: dir === 1 ? "BUY" : "SELL",
        at: k,
        x,
        t,
        aAt,
        a: back(a),
        b,
        neck: back(neck),
        k: k0,
        dk,
        r,
        entry: back(e),
        stop: back(stop),
        tp1: back(a),
        tp2: tp2 > e ? back(tp2) : null,
        rr: (a - e) / (e - stop),
      });
      phase = "done";
      continue;
    }
    if (k >= k0 + o.skip + 1 && L(k) <= neck) r = k;
  }

  const setup: ErSetup | null = phase === null
    ? null
    : {
      side: dir === 1 ? "BUY" : "SELL",
      phase,
      x,
      aAt,
      a: back(a),
      t: t >= 0 ? t : null,
      b: phase === "retest" ? b : phase === "lines" && best >= 0 ? best : null,
      neck: phase === "retest" ? back(neck) : phase === "lines" && best >= 0 ? back(H(best)) : null,
      k: phase === "retest" ? k0 : null,
      r: phase === "retest" && r >= 0 ? r : null,
    };
  return { entries, setup, fast, slow };
};

// The decision at the last bar of `w` (the window ending at the bar judged):
// its entry, or null
export const emaReturnOnWindow = (w: ReadonlyArray<ErBar>, o: EmaReturnParams = EMA_RETURN): ErEntry | null => {
  const s = emaReturnScan(w, o);
  const last = s.entries[s.entries.length - 1];
  return last && last.at === w.length - 1 ? last : null;
};

// The email's decision: the newest of `closed` (oldest first) on the WINDOW
// closed bars ending at it, and on nothing else. Null on a shorter history
export const emaReturnNewest = (closed: ReadonlyArray<ErBar>, o: EmaReturnParams = EMA_RETURN): ErEntry | null => {
  if (closed.length < o.window) return null;
  return emaReturnOnWindow(closed.slice(closed.length - o.window), o);
};

// The chart's: every bar from `from` on, each judged on the WINDOW bars ending
// at it — or, where the chart holds fewer before it, on all it holds (at least
// EMA_RETURN_MIN_WINDOW). A bar judged on a full window is decided as the
// email decides it. Indices are the bars' own in `bars`
export interface ErMark extends ErEntry {
  full: boolean;
}
export const emaReturnMarks = (bars: ReadonlyArray<ErBar>, from = 0, o: EmaReturnParams = EMA_RETURN): ErMark[] => {
  const out: ErMark[] = [];
  const minWindow = Math.min(o.window, o.warm + 100);
  for (let i = Math.max(from, minWindow - 1); i < bars.length; i++) {
    const start = Math.max(0, i - o.window + 1);
    const d = emaReturnOnWindow(bars.slice(start, i + 1), o);
    if (!d) continue;
    out.push({
      ...d,
      at: d.at + start,
      x: d.x + start,
      t: d.t + start,
      aAt: d.aAt + start,
      b: d.b + start,
      k: d.k + start,
      dk: d.dk + start,
      r: d.r + start,
      full: i - start + 1 === o.window,
    });
  }
  return out;
};

// The setup alive at the newest bar and the two EMAs, on the WINDOW bars
// ending at it (the email's: the chart's lines before an entry), indices and
// the lines' places the bars' own (null before the window's line is defined)
export interface ErNow {
  setup: ErSetup | null;
  fast: Array<number | null>;
  slow: Array<number | null>;
}
export const emaReturnNow = (bars: ReadonlyArray<ErBar>, o: EmaReturnParams = EMA_RETURN): ErNow | null => {
  if (bars.length < Math.min(o.window, o.warm + 100)) return null;
  const start = Math.max(0, bars.length - o.window);
  const scan = emaReturnScan(bars.slice(start), o);
  const pad: Array<number | null> = new Array(start).fill(null);
  const s = scan.setup;
  const sh = (v: number | null) => (v === null ? null : v + start);
  return {
    setup: s ? { ...s, x: s.x + start, aAt: s.aAt + start, t: sh(s.t), b: sh(s.b), k: sh(s.k), r: sh(s.r) } : null,
    fast: [...pad, ...scan.fast],
    slow: [...pad, ...scan.slow],
  };
};
