// #371 (docs §8.124): hand examples of research/flowz-lib.ts, each with the answer worked out by hand.
// deno run research/flowz-hand.ts — exits 1 on the first example that does not hold.

import { type Bar, flowB, flowsA, guideOf, leanOf, mailedAt, mean, median, mulberry32, ownerOf, randomDrop, type Mail, type Row } from "./flowz-lib.ts";
import type { M1 } from "./ownerhold-data.ts";
import { makeBook } from "./ownerhold-trades.ts";
import { HOUR, MINUTE } from "./lib.ts";

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const T0 = Date.UTC(2024, 2, 4, 10); // Mon 2024-03-04 10:00 UTC

// 1. the trends: A on the bar's own close, B on the newest 4-hour bar closed by T
{
  // 200 closes of 1, then 2: the EMA200's first value is 1 (the mean of 200 ones) at index 199
  const bars: Bar[] = Array.from({ length: 202 }, (_, i) => ({ t: T0 + i * HOUR, close: i < 200 ? 1 : i === 200 ? 2 : 0.5 }));
  const fa = flowsA(bars);
  check("A: no EMA before the 200th bar", fa[198], "none");
  check("A: equal to the EMA is not decided", fa[199], "none");
  check("A: above the EMA is up", fa[200], "up");
  // EMA at 200 = 2*(2/201) + 1*(199/201) = 201/201 + ... = 1.00995…; 0.5 is under it
  check("A: under the EMA is down", fa[201], "down");
  const b4: Bar[] = [{ t: T0, close: 3 }, { t: T0 + 4 * HOUR, close: 1 }];
  const ema4 = [2, 2];
  const t4 = b4.map((b) => b.t);
  check("B: the bar opened at T − 4h has closed by T", flowB(t4, b4, ema4, T0 + 4 * HOUR), "up");
  check("B: a bar still open at T is not read", flowB(t4, b4, ema4, T0 + 8 * HOUR - 1), "up");
  check("B: its close at T + 4h is read", flowB(t4, b4, ema4, T0 + 8 * HOUR), "down");
  check("B: nothing closed yet", flowB(t4, b4, ema4, T0 + 4 * HOUR - 1), "none");
  check("lean: up and BUY", leanOf(1, "up"), "with");
  check("lean: up and SELL", leanOf(-1, "up"), "against");
  check("lean: down and SELL", leanOf(-1, "down"), "with");
  check("lean: none", leanOf(1, "none"), "none");
}

// 2. which closes the sweep can mail (0, 3 and 5 minutes after, a second in): isPossiblyClosed shuts from
// Friday 21:00 UTC (the earliest close) to Sunday 22:00 UTC (the latest open), in either season
{
  check("mailed: Friday 20:00 UTC", mailedAt(Date.UTC(2024, 2, 8, 20)), true);
  check("not mailed: Friday 21:00 UTC (the earliest close)", mailedAt(Date.UTC(2024, 2, 8, 21)), false);
  check("not mailed: Friday 22:00 UTC", mailedAt(Date.UTC(2024, 2, 8, 22)), false);
  check("not mailed: Sunday 21:00 UTC", mailedAt(Date.UTC(2024, 2, 10, 21)), false);
  check("mailed: Sunday 22:00 UTC", mailedAt(Date.UTC(2024, 2, 10, 22)), true);
  check("mailed: Monday 10:00 UTC", mailedAt(T0), true);
}

// 3. one email followed on hand-made 1-minute bars (USD/JPY, a pip 0.01)
{
  // a SELL at E = 150.000, closed at T; the minutes from T on
  const T = T0;
  const rows: Array<[number, number, number, number, number]> = [
    // [minute after T, bid open, bid high, bid low, bid close]; the ask is the bid + 0.002
    [0, 149.990, 149.995, 149.985, 149.990], // T: under E
    [1, 149.990, 149.992, 149.988, 149.990],
    [2, 149.995, 150.001, 149.990, 149.995], // P = T + 2: the bid open 149.995 is under E, so a limit; its high reaches E: filled at E
    [3, 149.990, 149.990, 149.880, 149.900], // the ask low 149.882 reaches the TP 149.900 (E − 10 pips)? 149.882 <= 149.900: TP here
    [4, 149.900, 149.910, 149.890, 149.900],
  ];
  const n = rows.length;
  const f = (k: number) => new Float64Array(rows.map((r) => r[k]));
  const m: M1 = { pair: "USD/JPY", n, t: new Float64Array(rows.map((r) => T + r[0] * MINUTE)), bo: f(1), bh: f(2), bl: f(3), bc: f(4), ao: f(1).map((v) => v + 0.002), ah: f(2).map((v) => v + 0.002), al: f(3).map((v) => v + 0.002), ac: f(4).map((v) => v + 0.002) };
  const bk = makeBook(m, new Float64Array(0), true);
  const mail: Mail = { pair: "USD/JPY", open: T - HOUR, T, side: "SELL", dir: -1, E: 150, m: 0, top: 0, bottom: 0, i: 0 };
  const END = T + 10 * MINUTE;
  const own = ownerOf(bk, mail, END);
  check("owner: filled", own.filled, true);
  check("owner: a limit, not the market", own.path.market, false);
  check("owner: filled in P's own bar at E", [own.path.fillK, own.path.fill], [2, 150]);
  check("owner: TP in the next bar", [own.tp, own.path.tpK, Number(own.path.exit.toFixed(3))], [true, 3, 149.9]);
  check("owner: +10 pips", Number((own.pips as number).toFixed(6)), 10);
  // the worst against a SELL: the ask high from the fill bar to the TP bar: 150.003 (bar 2) → 0.3 pips
  check("owner: MAE", Number((own.mae as number).toFixed(6)), 0.3);
  check("owner: held from the fill bar's start to the TP bar's end", Number((own.hold as number).toFixed(6)), Number((2 / 60).toFixed(6)));
  // the guide: stop 150.130, TP 149.960, from bar 3: its ask low 149.882 reaches the TP; its ask open 149.992 is not past it
  const g = guideOf(bk, mail, own, END);
  check("guide: TP 4 in bar 3", g && [g.result, Number(g.pips.toFixed(6)), g.both], ["tp", 4, false]);
  // the same, ending before the TP: held at END, the ask close of the last bar by END
  const own2 = ownerOf(bk, mail, T + 3 * MINUTE);
  check("owner: held at END", [own2.tp, own2.held, Number((own2.pips as number).toFixed(6))], [false, true, Number(((150 - 149.997) / 0.01).toFixed(6))]);
}

// 4. both the stop and the TP inside one bar: the stop
{
  const T = T0;
  const rows: Array<[number, number, number, number, number]> = [
    [2, 150.000, 150.000, 150.000, 150.000], // a BUY at E 150.000 filled at the market (the ask open 150.000 is not above E)
    [3, 150.000, 150.200, 149.800, 150.000], // the bid reaches both 150.040 (TP 4) and 149.870 (stop 13)
  ];
  const n = rows.length;
  const f = (k: number) => new Float64Array(rows.map((r) => r[k]));
  const m: M1 = { pair: "USD/JPY", n, t: new Float64Array(rows.map((r) => T + r[0] * MINUTE)), bo: f(1), bh: f(2), bl: f(3), bc: f(4), ao: f(1), ah: f(2), al: f(3), ac: f(4) };
  const bk = makeBook(m, new Float64Array(0), true);
  const mail: Mail = { pair: "USD/JPY", open: T - HOUR, T, side: "BUY", dir: 1, E: 150, m: 0, top: 0, bottom: 0, i: 0 };
  const own = ownerOf(bk, mail, T + 10 * MINUTE);
  const g = guideOf(bk, mail, own, T + 10 * MINUTE);
  check("guide: both in one bar is the stop", g && [g.result, Number(g.pips.toFixed(6)), g.both], ["sl", -13, true]);
}

// 5. mulberry32 (the draws the Python draws too), and the helpers
{
  const r = mulberry32(371);
  // computed apart, in Python (32-bit integer arithmetic)
  check("mulberry32(371): first three", [r(), r(), r()].map((x) => Number(x.toFixed(12))), [0.911825324642, 0.587617771933, 0.543832596624]);
  check("median of an even count", median([4, 1, 3, 2]), 2.5);
  check("mean in order", mean([1, 2, 3, 4]), 2.5);
}

// 6. the random drop with nothing against the trend keeps everything: its line is the mean of all
{
  const own = (pips: number) => ({ filled: true, tp: pips === 10, held: pips !== 10, pips, mae: 0, hold: 1, path: {} as never });
  const rows: Row[] = [10, -5, 10, 3].map((p, k) => ({ mail: { T: T0 + k * HOUR } as Mail, half: 2, month: "2025-06", A: "with", B: "with", own: own(p), guide: null }));
  const d = randomDrop(rows, "A", 100, 1);
  check("random drop, k = 0: the line is the mean of all", [d.k, d.n, d.line], [0, 4, 4.5]);
}

console.log(failed === 0 ? "ALL HAND EXAMPLES HOLD" : `${failed} HAND EXAMPLES FAILED`);
if (failed) Deno.exit(1);
