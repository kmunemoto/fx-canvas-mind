// #395: the owner's 「チャートが1時間足で急激に上がったり、下がったりしたら
// メールください」 (2026-11-05), and, asked, 「3倍以上」 of the usual hourly
// range, 「足の途中ですぐ」, 「5ペア＋金」 and 「チャートにも出す」
// (research/spike-spec.md, docs §8.138).
//
// A 1-hour bar is a sharp rise when its high has gone at least `k` times the
// usual hourly range above its open, a sharp fall when its low has gone as
// far below it; the usual range R is the mean of high − low over the `bars`
// closed bars before it (summed oldest first, then divided). The forming bar
// is read the same way as it forms (its high and low so far), so the email
// goes in the minute the move is seen, not at the close.
//
// Deno-free: the chart (src/lib/spike.ts), the email (signal-alerts/
// indicators.ts) and the tests import it.

export const SPIKE = { k: 3, bars: 120 } as const;
export type SpikeOptions = { k: number; bars: number };

export interface SpikeBar {
  o: number;
  h: number;
  l: number;
}

// The usual hourly range: the mean high − low of `prev` (exactly `n` bars,
// oldest first); null without them or when it is not above zero
export const spikeRange = (prev: ReadonlyArray<{ h: number; l: number }>, n: number = SPIKE.bars): number | null => {
  if (prev.length !== n || n <= 0) return null;
  let sum = 0;
  for (const b of prev) sum += b.h - b.l;
  const r = sum / n;
  return Number.isFinite(r) && r > 0 ? r : null;
};

export interface SpikeRead {
  // the usual range, and how far the bar went above (below) its open
  r: number;
  up: number;
  down: number;
  // those as multiples of r
  upX: number;
  downX: number;
  isUp: boolean;
  isDown: boolean;
}

// One bar against the usual range r
export const spikeOf = (bar: SpikeBar, r: number, k: number = SPIKE.k): SpikeRead => {
  const up = bar.h - bar.o;
  const down = bar.o - bar.l;
  return { r, up, down, upX: up / r, downX: down / r, isUp: up >= k * r, isDown: down >= k * r };
};

// Each bar from the `bars`-th on (oldest first), read against the `bars`
// bars before it; those that are a sharp rise or fall
export const spikeMarks = (bars: ReadonlyArray<SpikeBar>, o: SpikeOptions = SPIKE): Array<SpikeRead & { i: number }> => {
  const out: Array<SpikeRead & { i: number }> = [];
  for (let i = o.bars; i < bars.length; i++) {
    const r = spikeRange(bars.slice(i - o.bars, i), o.bars);
    if (r === null) continue;
    const s = spikeOf(bars[i], r, o.k);
    if (s.isUp || s.isDown) out.push({ ...s, i });
  }
  return out;
};
