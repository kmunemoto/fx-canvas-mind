// #392 (docs §8.135): the similar-past forecast (似た相場の予測) of the
// owner's video (@KFX024, TradingView): the shape of the newest bars, the
// past places most like it, and what came after each, laid on the newest
// close — a grey dotted centre (the median), a green top and a red bottom
// (the highest and lowest of the places) — as one pure function over a
// chart's closed closes, so the chart (src/lib/analogForecast.ts re-exports
// this file) and the measurement (research/analog.ts) compute with the same
// code.
//
// The owner (2026-11-02): 「これと同じインジケーター作れる？ 過去から似た相場を
// 探してきて、先のチャートの動きを予測して表示する。」; asked, the app's chart
// (not TradingView), no email yet.
//
// THE RULE: research/analog-spec.md, word for word (the video gives no
// numbers; APP: chosen here). In short, at the anchor a (the newest closed
// bar), over the pool c[max(0, a-W+1)..a]:
//   shape    p[k] = c[a-L+k] / c[a] - 1, k = 0..L-1
//   places   each j with its own L bars in the pool and its H bars after at
//            or before a; d(j) = Σ (q[k] - p[k])², q[k] = c[j-L+k] / c[j] - 1;
//            the K nearest, ties to the newer, at least G bars apart
//   paths    f_j[h] = c[a] * (c[j+h] / c[j]), h = 0..H
//   lines    mid = the median of the K, up = the highest, lo = the lowest
// Deno-free: src/test/analog-forecast.test.ts imports it.

export const ANALOG = {
  // L: the bars of the shape compared (L + 1 closes)
  pattern: 20,
  // H: the bars forecast (the video's reach past the newest bar, about 20)
  horizon: 20,
  // K: the past places used
  matches: 10,
  // W: the bars searched, the anchor's included
  window: 1500,
  // G: two places taken are at least this many bars apart
  gap: 20,
} as const;

export interface AnalogOptions {
  pattern: number;
  horizon: number;
  matches: number;
  window: number;
  gap: number;
}

export interface AnalogPlace {
  // the place's newest bar (its shape c[j-L..j], its path c[j..j+H])
  j: number;
  // its distance to the shape now (a sum of squares; no root)
  d: number;
}

export interface AnalogForecast {
  // the anchor (the newest closed bar read) and the pool's first bar
  a: number;
  start: number;
  // the places, in the order taken (nearest first)
  places: AnalogPlace[];
  // h = 0..H: index 0 is the anchor's close
  mid: number[];
  up: number[];
  lo: number[];
  // mid[H] above (1), below (-1) or at (0) the anchor's close
  dir: 1 | -1 | 0;
}

// The median of values sorted ascending (the spec's step 6)
const medianOfSorted = (v: number[]): number => {
  const k = v.length;
  return k % 2 === 1 ? v[(k - 1) / 2] : (v[k / 2 - 1] + v[k / 2]) / 2;
};

// The forecast at the anchor a over closes c[0..a] (only those are read);
// null: a close in the pool that is no positive number, or fewer places
// than K (too few bars)
export function analogForecast(c: ArrayLike<number>, a: number = c.length - 1, o: AnalogOptions = ANALOG): AnalogForecast | null {
  const { pattern: L, horizon: H, matches: K, window: W, gap: G } = o;
  if (!(a >= 0) || a >= c.length || !Number.isInteger(a)) return null;
  const s = Math.max(0, a - W + 1);
  for (let i = s; i <= a; i++) {
    const v = c[i];
    if (!Number.isFinite(v) || !(v > 0)) return null;
  }
  // (the shape now needs its L bars in the pool)
  if (a - L < s) return null;
  const ca = c[a];
  // the shape now
  const p = new Array<number>(L);
  for (let k = 0; k < L; k++) p[k] = c[a - L + k] / ca - 1;
  // the candidates
  const cand: AnalogPlace[] = [];
  for (let j = s + L; j <= a - H; j++) {
    const cj = c[j];
    let d = 0;
    for (let k = 0; k < L; k++) {
      const e = (c[j - L + k] / cj - 1) - p[k];
      d += e * e;
    }
    cand.push({ j, d });
  }
  cand.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : y.j - x.j));
  // the places, at least G bars apart
  const places: AnalogPlace[] = [];
  for (const cd of cand) {
    if (places.length >= K) break;
    let near = false;
    for (const t of places) {
      if (Math.abs(cd.j - t.j) < G) {
        near = true;
        break;
      }
    }
    if (!near) places.push(cd);
  }
  if (places.length < K) return null;
  // the lines
  const mid = new Array<number>(H + 1);
  const up = new Array<number>(H + 1);
  const lo = new Array<number>(H + 1);
  mid[0] = up[0] = lo[0] = ca;
  const v = new Array<number>(K);
  for (let h = 1; h <= H; h++) {
    for (let m = 0; m < K; m++) {
      const j = places[m].j;
      v[m] = ca * (c[j + h] / c[j]);
    }
    v.sort((x, y) => x - y);
    mid[h] = medianOfSorted(v);
    up[h] = v[K - 1];
    lo[h] = v[0];
  }
  const dir: 1 | -1 | 0 = mid[H] > ca ? 1 : mid[H] < ca ? -1 : 0;
  return { a, start: s, places, mid, up, lo, dir };
}
