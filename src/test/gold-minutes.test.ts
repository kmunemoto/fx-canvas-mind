import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  GOLD_EARLY_START_MS,
  GOLD_JUDGE_AFTER_MS,
  GOLD_TICK_EVERY_MS,
  GOLD_TICK_OVERLAP_MS,
  closedMinutes,
  goldSeedRows,
  goldTickPlan,
  judgesWhileShut,
  nextTickAt,
} from "../../supabase/functions/signal-alerts/gold-minutes";
import { freshFor } from "../../supabase/functions/signal-alerts/indicators";
import { isPossiblyClosedFor } from "../../supabase/functions/_shared/market-hours";
import {
  GOLD_QUOTE_STALE_MS,
  isGoldMinute,
  parseTickMinutes,
  tickMinuteCandles,
  twelveRead,
} from "../../supabase/functions/live-chart/logic";
import { barOpenMs } from "../../supabase/functions/analyze/state";

// #291 (docs §8.112): gold's 1-minute bars made from Swissquote's prices all day

const M1 = 60_000;
const T0 = Date.parse("2026-10-12T01:00:00Z");
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

describe("#291 the gold-ticks run's minute", () => {
  it("reads from its start until GOLD_TICK_OVERLAP_MS past its minute (beside the next run), and judges GOLD_JUDGE_AFTER_MS into it", () => {
    const p = goldTickPlan(T0 + 700);
    expect(p.minuteStart).toBe(T0);
    expect(p.stopAt).toBe(T0 + M1 + GOLD_TICK_OVERLAP_MS);
    expect(p.judgeAt).toBe(T0 + GOLD_JUDGE_AFTER_MS);
    // the next minute's run, begun late (a worker booting, the gateway),
    // still begins inside this one's reading: no part of a minute unread
    const next = goldTickPlan(T0 + M1 + 18_000);
    expect(next.minuteStart).toBe(T0 + M1);
    expect(T0 + M1 + 18_000).toBeLessThan(p.stopAt);
    // a run begun late in its minute is still that minute's; one begun in its
    // last GOLD_EARLY_START_MS (the cron's clock a little ahead) is the next one's
    expect(GOLD_EARLY_START_MS).toBe(2_000);
    expect(goldTickPlan(T0 + M1 - GOLD_EARLY_START_MS - 1).minuteStart).toBe(T0);
    expect(goldTickPlan(T0 + M1 - GOLD_EARLY_START_MS).minuteStart).toBe(T0 + M1);
    expect(goldTickPlan(T0 + M1 - 20).minuteStart).toBe(T0 + M1);
    expect(goldTickPlan(T0 + M1).minuteStart).toBe(T0 + M1);
    // a run lasts its minute and the overlap: within a worker's 150 seconds
    // with room for a late start
    expect(p.stopAt - p.minuteStart).toBe(85_000);
  });

  it("reads every GOLD_TICK_EVERY_MS, at once after a late read, and begins none from stopAt on", () => {
    expect(nextTickAt(Number.NEGATIVE_INFINITY, T0 + 700)).toBe(T0 + 700);
    expect(nextTickAt(T0 + 700, T0 + 900)).toBe(T0 + 700 + GOLD_TICK_EVERY_MS);
    // the read took longer than the gap
    expect(nextTickAt(T0 + 700, T0 + 700 + GOLD_TICK_EVERY_MS + 1_200)).toBe(T0 + 700 + GOLD_TICK_EVERY_MS + 1_200);
    // the run's loop, reads taking no time: begun 0.7 s into the minute, 20 reads
    const p = goldTickPlan(T0 + 700);
    const reads: number[] = [];
    let last = Number.NEGATIVE_INFINITY;
    let now = T0 + 700;
    for (;;) {
      const at = nextTickAt(last, now);
      if (at >= p.stopAt) break;
      reads.push(at);
      last = at;
      now = at;
    }
    // 0.7 s to 84.7 s: 29 reads, the last 9 of them inside the next minute
    expect(reads).toHaveLength(29);
    expect(reads[0]).toBe(T0 + 700);
    expect(reads.at(-1)).toBe(T0 + 700 + 28 * GOLD_TICK_EVERY_MS);
    expect(reads.every((t) => t < T0 + M1 + GOLD_TICK_OVERLAP_MS)).toBe(true);
    expect(reads.filter((t) => t >= T0 + M1)).toHaveLength(9);
  });

  it("the minutes closed by a time: a minute's whole length gone by", () => {
    const ms = [T0 - 2 * M1, T0 - M1, T0].map((t) => ({ minute: new Date(t).toISOString() }));
    expect(closedMinutes(ms, T0 + 5_000).map((m) => m.minute)).toEqual([new Date(T0 - 2 * M1).toISOString(), new Date(T0 - M1).toISOString()]);
    expect(closedMinutes(ms, T0)).toHaveLength(2);
    expect(closedMinutes(ms, T0 - 1)).toHaveLength(1);
    expect(closedMinutes(ms, T0 + M1)).toHaveLength(3);
  });

  it("while gold is shut, the runs of its first two minutes judge the last minute it traded, as every minute is judged twice, and no other run does", () => {
    // the week's end in US summer time: Friday 2026-10-09 21:00 UTC; gold's
    // daily hour: 17:00 New York, 21:00 UTC in summer (Tuesday 2026-10-13)
    // and 22:00 UTC in winter (Tuesday 2026-11-10)
    for (const at of ["2026-10-09T21:00:00Z", "2026-10-13T21:00:00Z", "2026-11-10T22:00:00Z"]) {
      const shut = Date.parse(at);
      expect(isPossiblyClosedFor("XAU/USD", shut - M1)).toBe(false);
      expect(isPossiblyClosedFor("XAU/USD", shut)).toBe(true);
      expect(judgesWhileShut(shut)).toBe(true);
      // a run begun a minute late (behind pg_net's other requests) is this one
      expect(judgesWhileShut(shut + M1)).toBe(true);
      expect(judgesWhileShut(shut + 2 * M1)).toBe(false);
      expect(judgesWhileShut(shut + 59 * M1)).toBe(false);
      // the last minute, closed at `shut`, is still fresh for the second run's
      // judging and no longer for a third's
      expect(shut + M1 + GOLD_JUDGE_AFTER_MS - shut).toBeLessThanOrEqual(freshFor("1min"));
      expect(shut + 2 * M1 + GOLD_JUDGE_AFTER_MS - shut).toBeGreaterThan(freshFor("1min"));
    }
    // the whole weekend, minute by minute: two judging runs
    const fri = Date.parse("2026-10-09T21:00:00Z");
    const sun = Date.parse("2026-10-11T22:00:00Z");
    let judging = 0;
    for (let t = fri; t < sun; t += M1) if (isPossiblyClosedFor("XAU/USD", t) && judgesWhileShut(t)) judging++;
    expect(judging).toBe(2);
  });
});

describe("#291 both recorders of gold's price take the same hours", () => {
  it("the minute-by-minute run and the live chart's ticker each leave out a price stamped while gold may be shut", () => {
    const run = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    const chart = readFileSync("supabase/functions/live-chart/index.ts", "utf8");
    expect(run.match(/rpc\/record_gold_tick/g)).toHaveLength(1);
    expect(chart.match(/rpc\/record_gold_tick/g)).toHaveLength(1);
    expect(run).toContain("if (isPossiblyClosedFor(GOLD, Date.parse(tick.time))) {");
    expect(chart).toContain("if (gold && gold.open && gold.time && !isPossiblyClosedFor(GOLD, Date.parse(gold.time))) {");
    // a winter Friday's last hour: gold trades till 22:00 UTC, the FX week
    // at its widest is shut from 21:00 — neither records it
    expect(isPossiblyClosedFor("XAU/USD", Date.parse("2026-11-06T21:30:00Z"))).toBe(true);
  });
});

describe("#291 the fill of the minutes before the recording began", () => {
  const bar = (ms: number, close: number) => ({ datetime: stamp(ms), open: close - 0.1, high: close + 0.4, low: close - 0.5, close });

  it("keeps Twelve Data's ended minutes, as 'twelvedata' rows with no samples", () => {
    const bars = [bar(T0 - 10 * M1, 4000), bar(T0 - 9 * M1, 4001)];
    const rows = goldSeedRows(bars, T0, null);
    expect(rows).toEqual([
      {
        minute: new Date(T0 - 10 * M1).toISOString(),
        open: 3999.9,
        high: 4000.4,
        low: 3999.5,
        close: 4000,
        first_at: new Date(T0 - 10 * M1).toISOString(),
        last_at: new Date(T0 - 10 * M1).toISOString(),
        samples: 0,
        source: "twelvedata",
      },
      expect.objectContaining({ minute: new Date(T0 - 9 * M1).toISOString(), close: 4001, samples: 0, source: "twelvedata" }),
    ]);
  });

  it("leaves out a minute not ended GOLD_QUOTE_STALE_MS before now, and any from the first recorded minute on", () => {
    const now = T0;
    const ended = now - GOLD_QUOTE_STALE_MS - M1;
    // `ended` ends exactly GOLD_QUOTE_STALE_MS before now (kept); ended + 30 s
    // is not on a minute; ended + M1 and now - M1 end later than that
    const bars = [bar(ended - M1, 1), bar(ended, 2), bar(ended + 30_000, 3), bar(ended + M1, 4), bar(now - M1, 5)];
    const rows = goldSeedRows(bars, now, null);
    expect(rows.map((r) => r.close)).toEqual([1, 2]);
    // the first recorded minute and after are Swissquote's
    expect(goldSeedRows(bars, now, ended).map((r) => r.close)).toEqual([1]);
    expect(goldSeedRows(bars, now, ended - M1)).toEqual([]);
  });

  it("leaves out a malformed bar, and a minute given twice after its first", () => {
    const bars = [
      { datetime: stamp(T0 - 10 * M1), open: 1, high: 0.5, low: 1, close: 1 },
      { datetime: stamp(T0 - 9 * M1), open: Number.NaN, high: 2, low: 1, close: 1 },
      { datetime: stamp(T0 - 8 * M1), open: 0, high: 2, low: 1, close: 1 },
      { datetime: "x", open: 1, high: 2, low: 1, close: 1 },
      bar(T0 - 7 * M1, 7),
      bar(T0 - 7 * M1, 8),
    ];
    expect(goldSeedRows(bars, T0, null).map((r) => r.close)).toEqual([7]);
  });
});

describe("#291 gold's 1-minute chart is the minutes recorded", () => {
  it("is gold's 1-minute chart only", () => {
    expect(isGoldMinute("XAU/USD", "1min")).toBe(true);
    expect(isGoldMinute("xau/usd", "1min")).toBe(true);
    expect(isGoldMinute("XAU/USD", "2min")).toBe(false);
    expect(isGoldMinute("XAU/USD", "5min")).toBe(false);
    expect(isGoldMinute("USD/JPY", "1min")).toBe(false);
    expect(isGoldMinute("USD/CAD", "1min")).toBe(false);
  });

  it("draws each minute as a candle stamped as Twelve Data's are", () => {
    const rows = [
      { minute: "2026-10-12T01:01:00+00:00", open: 4001, high: 4002.5, low: 4000.75, close: 4002, last_at: "2026-10-12T01:01:58+00:00" },
      { minute: "2026-10-12T01:00:00+00:00", open: "4000", high: "4001.2", low: "3999.8", close: "4001", last_at: "2026-10-12T01:00:59+00:00" },
    ];
    const candles = tickMinuteCandles(parseTickMinutes(rows));
    expect(candles).toEqual([
      { datetime: "2026-10-12 01:00:00", open: 4000, high: 4001.2, low: 3999.8, close: 4001 },
      { datetime: "2026-10-12 01:01:00", open: 4001, high: 4002.5, low: 4000.75, close: 4002 },
    ]);
    expect(barOpenMs(candles[0].datetime)).toBe(T0);
  });

  it("as of now: the minute now forming is the forming bar, the one before it closed, and the read says it is the minutes recorded", () => {
    const rows = Array.from({ length: 130 }, (_, i) => ({
      minute: new Date(T0 + i * M1).toISOString(),
      open: 4000 + i,
      high: 4000.5 + i,
      low: 3999.5 + i,
      close: 4000.2 + i,
      last_at: new Date(T0 + i * M1 + 57_000).toISOString(),
    }));
    const bars = tickMinuteCandles(parseTickMinutes(rows));
    // 2 seconds into the newest minute, before its next price is recorded
    const now = T0 + 129 * M1 + 2_000;
    const r = twelveRead("XAU/USD", bars, "1min", now, new Date(now).toISOString(), false, null, true);
    expect(r.recorded).toBe(true);
    expect(r.feed).toBe("gold");
    expect(r.limited).toBe(false);
    expect(r.ticks_from).toBeNull();
    expect(r.candles.at(-1)!.datetime).toBe(stamp(T0 + 129 * M1));
    expect(r.now.datetime).toBe(stamp(T0 + 128 * M1));
    expect(r.next_close).toBe(new Date(T0 + 130 * M1).toISOString());
    // a read of Twelve Data's bars says it is not
    expect(twelveRead("XAU/USD", bars, "1min", now, new Date(now).toISOString()).recorded).toBe(false);
  });
});
