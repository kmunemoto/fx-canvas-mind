// #276 (docs §8.111 確かめ A 5): hand examples for the 5-minute signals' reading (research/ownerhold-data.ts
// macdxReadOf, mailedFor). Run: deno run research/ownerhold5-hand.ts (no permissions); it throws on the first wrong
// answer.
//
//   1. which closes are mailed: the sweep reads a 5-minute chart 0, 1 and 3 minutes after the close, and the close is
//      mailed if one of those times is outside the time the market may be shut (Friday from 21:00 UTC to Sunday
//      before 22:00 UTC; market-hours.ts isPossiblyClosed). Worked out by hand, one by one.
//   2. a series with fewer than 600 bars has no window to judge: no signal, every bar counted as without a window.
//   3. on a seeded 20-day walk (weekends in it), every bar judged on its own 600-bar window (decideOnWindow, what the
//      sweep runs), the entry and the take profit made from the quote by hand: the signals are exactly those bars that
//      fire and are mailed, with the time, the side, E and TP2 the email would give. The planted error (the decision
//      one bar late) must change that list, and the reading's own look-ahead check must see it.

import { decideOnWindow } from "../supabase/functions/_shared/macd-extreme.ts";
import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { IV15, IV5, macdxReadOf, mailedFor, synthesize } from "./ownerhold-data.ts";
import { DAY, MINUTE } from "./lib.ts";

let n = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`hand example "${what}": got ${a}, want ${b}`);
  n++;
};
const at = (iso: string) => Date.parse(iso);

// 1. which closes are mailed
{
  const m5 = mailedFor(IV5);
  const m15 = mailedFor(IV15);
  // Friday 20:55 closes the 20:50 bar: its reads (20:55, 20:56, 20:58) are before Friday 21:00, so it is mailed
  eq("Fri 20:55 mailed", m5(at("2026-10-09T20:55:00Z")), true);
  // Friday 21:00: its reads (21:00, 21:01, 21:03) are all from Friday 21:00 on, so it is not
  eq("Fri 21:00 not mailed", m5(at("2026-10-09T21:00:00Z")), false);
  // Saturday: shut
  eq("Sat 12:00 not mailed", m5(at("2026-10-10T12:00:00Z")), false);
  // Sunday 21:55: the reads (21:55, 21:56, 21:58) are before Sunday 22:00, so it is not
  eq("Sun 21:55 not mailed", m5(at("2026-10-11T21:55:00Z")), false);
  // Sunday 22:00: its read at 22:00 is from the open on, so it is mailed
  eq("Sun 22:00 mailed", m5(at("2026-10-11T22:00:00Z")), true);
  eq("Sun 22:05 mailed", m5(at("2026-10-11T22:05:00Z")), true);
  // a Wednesday: always
  eq("Wed 12:05 mailed", m5(at("2026-10-07T12:05:00Z")), true);
  // the read at +0 counts for the 5-minute chart and not for the 15-minute one (reads at +1 and +3): a close at
  // Friday 20:59:30 is read at 20:59:30 (before the shut time) by the first, and only from 21:00:30 on by the second
  eq("Fri 20:59:30: 5-minute chart mailed", m5(at("2026-10-09T20:59:30Z")), true);
  eq("Fri 20:59:30: 15-minute chart not mailed", m15(at("2026-10-09T20:59:30Z")), false);
  // the 15-minute chart's Friday 20:00 close is read at 20:01 and 20:03: mailed
  eq("15-minute Fri 20:00 mailed", m15(at("2026-10-09T20:00:00Z")), true);
}

const PAIR = "USD/JPY";
const UNIT = 0.01;
const from = at("2026-03-02T00:00:00Z");

// 2. fewer than 600 bars: nothing to judge
{
  const to = from + 40 * 60 * MINUTE;
  const w = synthesize(PAIR, 0, { seed: 7, trend: 0, startPips: null }, from, to);
  const r = macdxReadOf(PAIR, 0, w.q5, from, to, true, "", IV5);
  // 40 hours of 5-minute bars are 480 bars, the first closing at from + 5 minutes and the last at `to`; a close at END
  // itself is not in the period (T < END), so 479 bars are without a window
  eq("short series: bars", r.bars, 480);
  eq("short series: no window for any bar", [r.judged, r.noWindow, r.signals.length], [0, 479, 0]);
  eq("short series: bar600", r.bar600, null);
}

// 3. a 20-day walk: Monday 2026-03-02 .. Sunday 2026-03-22 (two weekends in it)
{
  const to = from + 20 * DAY;
  const w = synthesize(PAIR, 0, { seed: 11, trend: 0, startPips: null }, from, to);
  const candles = historyRead(PAIR, "5min", w.q5, to).candles;
  const quoteAt = new Map(w.q5.map((q) => [barOpenMs(q.datetime), q]));
  const mailed = mailedFor(IV5);
  // the signals by hand: every bar with a 600-bar window, judged on that window alone
  const want: Array<{ open: number; side: string; E: number; tp: number }> = [];
  let judged = 0;
  for (let i = 599; i < candles.length; i++) {
    judged++;
    const d = decideOnWindow(candles, i);
    if (!d || !d.fire) continue;
    const open = barOpenMs(candles[i].datetime);
    if (!mailed(open + 5 * MINUTE)) continue;
    const q = quoteAt.get(open)!;
    // the chart's mid close: (bid + ask) / 2 to three digits (a yen pair); TP2 is E ± 10 pips
    const E = Number(((q.bid.close + q.ask.close) / 2).toFixed(3));
    want.push({ open, side: d.side, E, tp: Number((E + (d.side === "BUY" ? 1 : -1) * 10 * UNIT).toFixed(3)) });
  }
  eq("walk: some bars fire", want.length > 0, true);
  const r = macdxReadOf(PAIR, 0, w.q5, from, to, true, "", IV5);
  eq("walk: bars judged", [r.judged, r.noWindow], [judged, 599]);
  const got = r.signals.map((s) => ({ open: s.open, side: s.side, E: s.E, tp: Number(s.tp.toFixed(3)) }));
  eq("walk: the signals are the bars that fire and are mailed", got, want);
  eq("walk: T, base, late, dir", r.signals.every((s) => s.T === s.open + 5 * MINUTE && s.base === s.T && s.late === false && s.dir === (s.side === "BUY" ? 1 : -1)), true);
  eq("walk: the reading's own checks find nothing", [r.check.mismatched, r.ahead!.mismatched, r.cut!.mismatched], [0, 0, 0]);
  eq("walk: the checks looked", r.check.compared > 0 && r.ahead!.compared > 0 && r.cut!.compared === judged, true);
  // the planted errors change the list and are seen by the look-ahead check
  const late = macdxReadOf(PAIR, 0, w.q5, from, to, true, "macdWindowAhead", IV5);
  eq("walk: macdWindowAhead changes the list", JSON.stringify(late.signals.map((s) => s.open)) !== JSON.stringify(want.map((x) => x.open)), true);
  eq("walk: macdWindowAhead is seen by the cut check", late.cut!.mismatched > 0, true);
  const next = macdxReadOf(PAIR, 0, w.q5, from, to, true, "signalNextBar", IV5);
  eq("walk: signalNextBar is seen by the cut check", next.cut!.mismatched > 0, true);
}

console.log(`hand examples ok (${n})`);
