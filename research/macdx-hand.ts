// #272 (docs §8.109 確かめ 4): hand examples for research/macdx-lib.ts, each
// with its answer worked out by hand. Run: deno run research/macdx-hand.ts
// (no permissions); it throws on the first wrong answer.

import { WINDOW, decide, decideOnWindow, msignsOf, runStart, sidesOf, trOf, type Bar } from "./macdx-lib.ts";

let n = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`hand example "${what}": got ${a}, want ${b}`);
  n++;
};

// a 600-bar series: m and h given at the last bars, TR given by bars
const I = WINDOW - 1;
const series = (o: { m?: Record<number, number | null>; h?: Record<number, number | null>; mFill?: number; hFill?: number; trFill?: number; tr?: Record<number, number> }) => {
  const m: Array<number | null> = new Array(WINDOW).fill(o.mFill ?? 1);
  const h: Array<number | null> = new Array(WINDOW).fill(o.hFill ?? 1);
  const tr: number[] = new Array(WINDOW).fill(o.trFill ?? 1);
  for (const [k, v] of Object.entries(o.m ?? {})) m[Number(k)] = v;
  for (const [k, v] of Object.entries(o.h ?? {})) h[Number(k)] = v;
  for (const [k, v] of Object.entries(o.tr ?? {})) tr[Number(k)] = v;
  return { m, h, tr, sides: sidesOf(h), ms: msignsOf(m) };
};
const at = (s: ReturnType<typeof series>, i = I, first = 0) => decide(s.m, s.sides, s.ms, s.tr, i, first);

// 1. sides: h == 0 keeps the previous side; a leading 0 has none; null has none
eq("sides", sidesOf([0, 2, 0, -1, 0, 0, 3, null, 0]), [null, 1, 1, -1, -1, -1, 1, null, null]);

// 2. a DOWN cross at i: h goes + to -; m = 1 everywhere, TR 1: x = 1,
//    S = 288, (4*1)*288 = 1152 >= 288; P = 1, 2 >= 1: SELL fires
{
  const s = series({ h: { [I]: -0.5 } });
  const d = at(s)!;
  eq("down cross: dir/side", [d.dir, d.side], ["DOWN", "SELL"]);
  eq("down cross: x, S, P", [d.x, d.S, d.P], [1, 288, 1]);
  eq("down cross: fires", [d.c0, d.c1, d.c2, d.fire], [true, true, true, true]);
}

// 3. h[i-1] == 0 after a positive h: the side at i-1 is still +1, so a
//    negative h[i] is a DOWN cross at i (not at i-1)
{
  const s = series({ h: { [I - 1]: 0, [I]: -0.2 } });
  eq("h[i-1] == 0: cross at i", at(s)?.dir, "DOWN");
  eq("h[i-1] == 0: no cross at i-1", at(s, I - 1), null);
}

// 4. h[i] == 0: the side stays, no cross at i
{
  const s = series({ h: { [I]: 0 } });
  eq("h[i] == 0: no cross", at(s), null);
}

// 5. m[i] == 0 at a DOWN cross: x = 0, C0 fails
{
  const s = series({ h: { [I]: -1 }, m: { [I]: 0 } });
  const d = at(s)!;
  eq("m[i] == 0: x and C0", [d.x, d.c0, d.fire], [0, false, false]);
}

// 6. a DOWN cross below 0 (m = -1 everywhere): x = -1, C0 fails; an UP cross
//    below 0 fires a BUY
{
  const below = series({ mFill: -1, hFill: 1, h: { [I]: -1 } });
  eq("down cross below 0", [at(below)!.c0, at(below)!.fire], [false, false]);
  const up = series({ mFill: -1, hFill: -1, h: { [I]: 1 } });
  const d = at(up)!;
  eq("up cross below 0: BUY", [d.dir, d.side, d.x, d.fire], ["UP", "BUY", 1, true]);
}

// 7. C1 at equality: TR 4 on every bar, S = 1152, x = 1: (4*1)*288 = 1152 >= 1152 fires;
//    TR 4 and one bar 4.5 (S = 1152.5) fails
{
  const tie = series({ h: { [I]: -1 }, trFill: 4 });
  eq("C1 tie fires", [at(tie)!.S, at(tie)!.c1], [1152, true]);
  const over = series({ h: { [I]: -1 }, trFill: 4, tr: { [I - 10]: 4.5 } });
  eq("C1 over fails", [at(over)!.S, at(over)!.c1, at(over)!.fire], [1152.5, false, false]);
  // TR before i-287 is not read
  const early = series({ h: { [I]: -1 }, trFill: 4, tr: { [I - 288]: 1000 } });
  eq("C1 reads 288 bars only", at(early)!.S, 1152);
}

// 8. S == 0 (no range at all): C1 fails
{
  const s = series({ h: { [I]: -1 }, trFill: 0 });
  eq("S == 0", [at(s)!.S, at(s)!.c1, at(s)!.fire], [0, false, false]);
}

// 9. C2 at equality: the wave's peak 2 and x = 1: 2*1 >= 2 fires; peak 2.5 fails
{
  const tie = series({ h: { [I]: -1 }, m: { [I - 50]: 2 } });
  eq("C2 tie fires", [at(tie)!.P, at(tie)!.c2, at(tie)!.fire], [2, true, true]);
  const over = series({ h: { [I]: -1 }, m: { [I - 50]: 2.5 } });
  eq("C2 over fails", [at(over)!.P, at(over)!.c2, at(over)!.fire], [2.5, false, false]);
}

// 10. the wave starts where the sign of m last changed: a bigger peak before
//     the change is not read
{
  const s = series({ h: { [I]: -1 }, m: { [I - 100]: 9, [I - 60]: -1 } });
  const d = at(s)!;
  eq("wave starts after the sign change", [d.run, d.from, d.P, d.fire], [I - 59, I - 59, 1, true]);
}

// 11. m == 0 inside a run keeps the run: the peak before the zero is read
{
  const s = series({ h: { [I]: -1 }, m: { [I - 40]: 3, [I - 20]: 0 } });
  const d = at(s)!;
  eq("m == 0 keeps the run", [d.run, d.P, d.c2], [0, 3, false]);
}

// 12. a run longer than 288 bars: only bars i-287 .. i are read
{
  const s = series({ h: { [I]: -1 }, m: { [I - 288]: 50, [I - 287]: 1.5 } });
  const d = at(s)!;
  eq("run capped at 288 bars", [d.run, d.from, d.P, d.c2], [0, I - 287, 1.5, true]);
}

// 13. a run that starts at i: m changes sign at i itself; P = |m[i]| = x
{
  const s = series({ mFill: -2, h: { [I]: -1 }, m: { [I]: 0.5 } });
  const d = at(s)!;
  eq("run starts at i", [d.run, d.from, d.P, d.x, d.c2], [I, I, 0.5, 0.5, true]);
}

// 14. a null m ends a run
{
  const s = series({ h: { [I]: -1 }, m: { [I - 30]: null, [I - 50]: 9 } });
  eq("null m ends a run", [runStart(msignsOf(s.m), I), at(s)!.P], [I - 29, 1]);
}

// 15. fewer than 600 bars in the window: no decision
{
  const s = series({ h: { [I]: -1 } });
  eq("short window", at(s, I, 1), null);
}

// 16. TR across a gap: close[k-1] is the previous bar by index
{
  const bars: Bar[] = [
    { high: 101, low: 100, close: 100.5 },
    // after a weekend the price opened 10 higher: TR = 111 - 100.5
    { high: 111, low: 110, close: 110.5 },
    { high: 110.6, low: 110.4, close: 110.5 },
  ];
  eq("TR across a gap", trOf(bars).slice(1).map((v) => Math.round(v * 1e10) / 1e10), [10.5, 0.2]);
}

// 17. the windowed decision equals the whole-series one on a long series
//     (a smooth wave, 900 bars): every bar from 599 on
{
  const bars: Bar[] = [];
  for (let k = 0; k < 900; k++) {
    const c = 150 + Math.sin(k / 23) * 0.4 + Math.sin(k / 7) * 0.05;
    bars.push({ high: c + 0.02, low: c - 0.02, close: Math.round(c * 1000) / 1000 });
  }
  const { prepare } = await import("./macdx-lib.ts");
  const p = prepare(bars);
  let crosses = 0;
  let same = 0;
  for (let i = WINDOW - 1; i < bars.length; i++) {
    const a = decide(p.m, p.sides, p.ms, p.tr, i, 0);
    const b = decideOnWindow(bars, i);
    if (a) crosses++;
    if (JSON.stringify(a && [a.dir, a.fire]) === JSON.stringify(b && [b.dir, b.fire])) same++;
  }
  eq("window = whole series (crosses > 0)", crosses > 0, true);
  eq("window = whole series", same, bars.length - (WINDOW - 1));
}

console.log(`hand examples ok (${n})`);
