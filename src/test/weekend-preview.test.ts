import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CLOSED_WINDOW_MS,
  barFullyClosed,
  isMarketClosed,
  isPossiblyClosed,
  lastClose,
  nextOpen,
} from "../../supabase/functions/_shared/market-hours.ts";
import { parseCandles, seriesHealth } from "../../supabase/functions/analyze/indicators.ts";
import { byTimeframe, causeCounts, isPreview, tally } from "../lib/outcomeStats";
import type { AnalysisRecord } from "../lib/types";

const analyze = readFileSync("supabase/functions/analyze/index.ts", "utf8");
const indexPage = readFileSync("src/pages/Index.tsx", "utf8");
const structure = readFileSync("supabase/functions/analyze/structure.ts", "utf8");
const marketHours = readFileSync("supabase/functions/_shared/market-hours.ts", "utf8");

const rec = (over: Partial<AnalysisRecord>): AnalysisRecord => ({
  id: Math.random().toString(36).slice(2),
  pair: "USD/JPY",
  interval: "1h",
  mode: "full",
  signal: "BUY",
  confidence: 70,
  thesis: null,
  entry_point: 150,
  stop_loss: 149,
  take_profit_1: 152,
  take_profit_2: null,
  take_profit_3: null,
  price_at_signal: 150.2,
  outcome: "pending",
  outcome_price: null,
  created_at: "2026-08-20T00:00:00Z",
  closed_at: null,
  evaluation: null,
  ...over,
});

describe("when the market reopens", () => {
  it("answers the coming Sunday 22:00 UTC — Monday 07:00 in Tokyo", () => {
    // Every hour the analyst refuses a plan, from the Friday close to the
    // Sunday open, resolves to the same moment.
    const shut = [
      "2026-09-04T21:00:00Z", // Friday, earliest possible close
      "2026-09-04T23:30:00Z",
      "2026-09-05T00:00:00Z", // Saturday
      "2026-09-05T12:00:00Z",
      "2026-09-06T00:00:00Z", // Sunday
      "2026-09-06T05:03:11Z", // the run this was built for
      "2026-09-06T21:59:00Z", // one minute before the latest open
    ];
    for (const iso of shut) {
      const ms = Date.parse(iso);
      expect(isPossiblyClosed(ms), iso).toBe(true);
      expect(new Date(nextOpen(ms)).toISOString(), iso).toBe("2026-09-06T22:00:00.000Z");
    }
  });

  it("covers about 49 hours a week, which is the whole weekend in Tokyo", () => {
    // The size of the hole is the reason preview mode exists, so it is worth
    // a test rather than a comment: an hour-by-hour sweep of one week.
    let shutHours = 0;
    const start = Date.parse("2026-08-31T00:00:00Z"); // a Monday
    for (let h = 0; h < 24 * 7; h++) {
      if (isPossiblyClosed(start + h * 3600_000)) shutHours += 1;
    }
    expect(shutHours).toBe(49);
  });
});

describe("analyze no longer refuses to look", () => {
  it("has dropped the 409 that ran before any analysis", () => {
    // It returned ok:false with "I made it a WAIT" — and no WAIT was made:
    // no model call, no quota, no row. The message described a decision that
    // did not exist.
    expect(analyze).not.toContain('error_stage: "market_closed", stage');
    expect(analyze).not.toContain("market_closed: true");
    expect(analyze).toContain("const previewMode = isPossiblyClosed(Date.now());");
  });

  it("decides preview from the arrival time, not from the gate's own clock", () => {
    // A run that began while the market was open and finished after the close
    // was still decided at a price that existed; that WAIT is real and the
    // scorer should grade it. So the late gate keeps its own reading.
    expect(analyze).toContain("const marketShut = isPossiblyClosed(Date.now());");
    expect(analyze).toContain("marketShut || lowConfidence");
  });

  it("writes no wait_plan on a preview, which is what keeps it unscored", () => {
    // Both sweeps select on `outcome=eq.skipped` AND a non-null wait_plan.
    expect(analyze).toContain(
      'wait_plan: normalizedAnalysis.signal === "WAIT" && !previewMode ? waitPlan : null,',
    );
    expect(analyze).toContain("preview: previewMode,");
  });

  it("never opens a tracked shadow trade over the weekend gap", () => {
    // The shadow row carries `outcome: pending`, and the shape gate's own
    // rejection can still be "too_far" while the reason acted on was the
    // closed market — so without this a preview would settle against Monday.
    expect(analyze).toContain("entryRejected && !previewMode &&");
  });

  it("tells the client when plans resume", () => {
    expect(analyze).toContain("preview: previewMode,");
    expect(analyze).toContain("market_opens_at: marketOpensAt,");
  });
});

describe("a preview counts towards nothing", () => {
  it("is recognised from the row", () => {
    expect(isPreview(rec({ preview: true }))).toBe(true);
    expect(isPreview(rec({}))).toBe(false);
    expect(isPreview(rec({ preview: false }))).toBe(false);
  });

  it("is not a call, a WAIT, or a trade in the tally", () => {
    const real = tally("all", [
      rec({ signal: "BUY", outcome: "win" }),
      rec({ signal: "WAIT", outcome: "skipped" }),
    ]);
    const withPreviews = tally("all", [
      rec({ signal: "BUY", outcome: "win" }),
      rec({ signal: "WAIT", outcome: "skipped" }),
      rec({ signal: "WAIT", outcome: "skipped", preview: true }),
      rec({ signal: "WAIT", outcome: "skipped", preview: true }),
    ]);
    // Every number, not just the win rate: a preview in the denominator would
    // move the WAIT rate and trades-per-call without a trade being declined.
    expect(withPreviews).toEqual(real);
  });

  it("stays out of the cause counts and the timeframe split", () => {
    const rows = [
      rec({ signal: "BUY", outcome: "loss", postmortem: { status: "done", cause: "direction_wrong" } as never }),
      rec({
        signal: "WAIT", outcome: "skipped", preview: true, interval: "1day",
        postmortem: { status: "done", cause: "direction_wrong" } as never,
      }),
    ];
    expect(causeCounts(rows)).toEqual([{ cause: "direction_wrong", count: 1 }]);
    expect(byTimeframe(rows).map((g) => g.key)).toEqual(["1h"]);
  });
});

describe("the client and the function agree on which build is live", () => {
  it("pins EXPECTED_ANALYZE_VERSION to the function's own FUNCTION_VERSION", () => {
    // It had drifted twelve deploys behind, so the mismatch warning fired on
    // every call. A constant nobody maintains is worse than no constant: it
    // trains the reader to ignore the day it means something.
    const deployed = analyze.match(/const FUNCTION_VERSION = "([^"]+)"/)?.[1];
    const expected = indexPage.match(/const EXPECTED_ANALYZE_VERSION = "([^"]+)"/)?.[1];
    expect(deployed).toBeTruthy();
    expect(expected).toBe(deployed);
  });
});

describe("a weekend series is not a broken feed", () => {
  // The newest bar on a Sunday is Friday's close, by definition. Measured
  // against the wall clock that is ~56 hours of staleness and `seriesHealth`
  // rejects the entry series — so the preview 502s on the freshness gate
  // before computing a single indicator.
  //
  // The first fix substituted the last close for `nowMs` wholesale and SHIPPED,
  // which broke the other check in the same function: every bar newer than the
  // Friday close became a `future_bar`, and the gate rejected the series for
  // being too NEW instead of too old. Production said so in one word:
  // `Entry series unfit { pair: "USD/JPY", tf: "1h", issues: [ "future_bar" ] }`.
  // The two clocks answer different questions and are now separate.
  const SUNDAY_0503 = Date.parse("2026-09-06T05:03:11Z");
  const HOUR = 3_600_000;

  const seriesEndingAt = (newestMs: number) =>
    Array.from({ length: 250 }, (_, i) => {
      const at = new Date(newestMs - (249 - i) * HOUR);
      return {
        datetime: at.toISOString().slice(0, 19).replace("T", " "),
        open: 155, high: 155.4, low: 154.8, close: 155.1,
      };
    });

  const health = (newestMs: number, nowMs: number, staleFromMs: number) =>
    seriesHealth(seriesEndingAt(newestMs), 250, 60, HOUR, nowMs, 3, staleFromMs);

  it("is stale against the wall clock — the failure this all started from", () => {
    const h = health(Date.parse("2026-09-04T20:00:00Z"), SUNDAY_0503, SUNDAY_0503);
    expect(h.ok).toBe(false);
    expect(h.issues.some((i) => i.startsWith("stale:"))).toBe(true);
  });

  it("accepts every bar the feed could plausibly end on, over the whole shut window", () => {
    // Whatever Twelve Data's last bar turns out to be — Friday 20:00, the
    // 21:00 bar, or a thin Sunday-open one — none of them may be rejected.
    // A single fixed timestamp would have missed the `future_bar` regression;
    // the sweep is the point.
    for (let ms = Date.parse("2026-09-04T18:00:00Z"); ms <= SUNDAY_0503; ms += HOUR) {
      const h = health(ms, SUNDAY_0503, lastClose(SUNDAY_0503));
      expect(h.issues, new Date(ms).toISOString()).toEqual([]);
      expect(h.ok, new Date(ms).toISOString()).toBe(true);
    }
  });

  it("still calls a genuinely future bar broken, on a Sunday like any other day", () => {
    const h = health(SUNDAY_0503 + 2 * HOUR, SUNDAY_0503, lastClose(SUNDAY_0503));
    expect(h.issues).toContain("future_bar");
  });

  it("still calls a genuinely abandoned feed stale", () => {
    // A series that stopped on Wednesday is not explained by the weekend.
    const h = health(Date.parse("2026-09-02T12:00:00Z"), SUNDAY_0503, lastClose(SUNDAY_0503));
    expect(h.issues.some((i) => i.startsWith("stale:"))).toBe(true);
  });

  it("reports the real age whichever clock staleness was measured from", () => {
    const newest = Date.parse("2026-09-04T20:00:00Z");
    const h = health(newest, SUNDAY_0503, lastClose(SUNDAY_0503));
    expect(h.age_ms).toBe(SUNDAY_0503 - newest);
  });

  it("puts the last close at Friday 21:00 UTC from anywhere in the shut window", () => {
    for (const iso of ["2026-09-04T21:00:00Z", "2026-09-05T12:00:00Z", "2026-09-06T05:03:11Z"]) {
      expect(new Date(lastClose(Date.parse(iso))).toISOString(), iso).toBe("2026-09-04T21:00:00.000Z");
    }
    // It must never sit in the future of the moment being judged, or a shut
    // hour would be measured against a close that has not happened.
    for (let h = 0; h < 24 * 7; h++) {
      const ms = Date.parse("2026-08-31T00:00:00Z") + h * HOUR;
      if (isPossiblyClosed(ms)) expect(lastClose(ms)).toBeLessThanOrEqual(ms);
    }
  });

  it("is wired as a separate clock in analyze, not a substituted one", () => {
    expect(analyze).toContain("const staleFrom = previewMode ? lastClose(Date.now()) : Date.now();");
    // The real clock still goes in as nowMs; only staleness gets the close.
    expect(analyze).toMatch(/Date\.now\(\),\s*\n\s*3,\s*\n\s*staleFrom,/);
  });
});


// Twelve Data emits one bar per interval for every hour the market is shut,
// and analyze read them as market data. Only the preview path trimmed them,
// and only the trailing run, so on a weekday nothing was removed at all.
// Production, Sunday 2026-09-06 15:01:21Z, trimming the tail alone:
//   1h dropped 42 kept 208 / 4h dropped 10 kept 240 / 1day dropped 2 kept 248
// — 42 hours from the Friday 21:00 close, one bar per interval, on every
// timeframe including 1day. A whole-series filter on the same run drops
// 89/70/72; the difference is the earlier weekends nothing has ever touched.
describe("the market-week filter: every bar, not just the tail", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const at = (iso: string) => Date.parse(iso);

  it("drops Saturday's daily bar and keeps Sunday's", () => {
    // The test that separates the rule from the one it replaced. Asked of the
    // OPEN stamp, `isMarketClosed(Sunday 00:00Z)` is true and the daily bar
    // carrying the week's open — and the whole weekend gap — is deleted every
    // single week.
    //
    // On a daily bar the stamp is the trading day's NAME, not a UTC start: the
    // 2026-09-05 bar is Friday 21:00Z to Saturday 21:00Z (see the grid test
    // below), so this is asking whether the day NAMED Saturday is a trading
    // day. It is not, and the bar named Sunday holds the weekend gap.
    expect(barFullyClosed(at("2026-09-05T00:00:00Z"), DAY)).toBe(true);
    expect(barFullyClosed(at("2026-09-06T00:00:00Z"), DAY)).toBe(false);
    expect(isMarketClosed(at("2026-09-06T00:00:00Z"))).toBe(true); // ...which is the trap
  });

  it("keeps the bar the weekly open is priced in, on every intraday rung", () => {
    // Production, analysis 1b003cf3, sent 2026-09-07T01:06:34Z. The 4h bar
    // stamped 2026-09-06 17:00 came back
    //   O 156.23401 H 156.38212 L 155.86375 C 155.99882   range 0.518
    // between neighbours of 0.092 (13:00) and 0.476 (21:00), with that low the
    // week's opening low and that close the 21:00 bar's open to five decimals.
    // The 4h stamp is the bar's true start — the 1h bars 21:00+22:00+23:00+
    // 00:00 reproduce the 4h bar stamped 2026-09-04 21:00 exactly — so this
    // bar really does span Sunday 17:00-21:00Z, and a span test on
    // `isMarketClosed` alone deletes it from every Monday run.
    expect(barFullyClosed(at("2026-09-06T17:00:00Z"), 4 * HOUR)).toBe(false);
    // ...and the same band on the rungs that share the grid.
    expect(barFullyClosed(at("2026-09-06T17:00:00Z"), HOUR)).toBe(false);
    expect(barFullyClosed(at("2026-09-06T20:00:00Z"), HOUR)).toBe(false);
    expect(barFullyClosed(at("2026-09-06T20:45:00Z"), 15 * MIN)).toBe(false);
    // The band starts at 17:00Z and not a slot earlier: everything that ends
    // before it is still filler and still goes, or the fix would be a licence
    // to keep the whole Sunday.
    expect(barFullyClosed(at("2026-09-06T13:00:00Z"), 4 * HOUR)).toBe(true);
    expect(barFullyClosed(at("2026-09-06T16:00:00Z"), HOUR)).toBe(true);
    expect(barFullyClosed(at("2026-09-06T16:45:00Z"), 15 * MIN)).toBe(true);
    // Saturday is untouched by it — the band is Sunday's alone.
    expect(barFullyClosed(at("2026-09-05T17:00:00Z"), 4 * HOUR)).toBe(true);
    expect(barFullyClosed(at("2026-09-05T20:00:00Z"), HOUR)).toBe(true);
  });

  it("reads the provider's coarse stamps as trading-day names, not UTC starts", () => {
    // Measured, not assumed: the daily bars in the same production prompt are
    // exact aggregations of its own 21:00-anchored 4h bars.
    //   1day 2026-09-05  O 156.24812 H 156.34519 L 156.14789 C 156.23697
    //     = 4h 09-04 21:00 .. 09-05 17:00  ->  Fri 21:00Z .. Sat 21:00Z
    //   1day 2026-09-06  O 156.23459 H 156.38212 L 155.86375 C 155.99882
    //     = 4h 09-05 21:00 .. 09-06 17:00  ->  Sat 21:00Z .. Sun 21:00Z
    // So the daily stamp trails the bar by three hours and the 4h grid is
    // {01,05,09,13,17,21}Z, not {00,04,08,12,16,20}Z. The rule is written on
    // the labelled day on purpose. Modelling the true span would be WORSE:
    // Friday 21:00-22:00Z is open under the narrow predicate, so a span test
    // would keep the Saturday-named bar — the one that is 23/24 filler.
    const dayNamed = (iso: string) => barFullyClosed(at(iso), DAY);
    expect(dayNamed("2026-09-05T00:00:00Z")).toBe(true);  // Sat: no session
    expect(dayNamed("2026-09-06T00:00:00Z")).toBe(false); // Sun: holds the gap
    expect(dayNamed("2026-09-07T00:00:00Z")).toBe(false); // Mon
    expect(dayNamed("2026-09-04T00:00:00Z")).toBe(false); // Fri
    // The true span of the Saturday-named bar begins in an hour the narrow
    // predicate calls OPEN, which is why the span reading cannot be used here.
    expect(isMarketClosed(at("2026-09-04T21:00:00Z"))).toBe(false);
    // Every 4h slot of the real grid, across one whole week, answers.
    const grid: string[] = [];
    for (let t = at("2026-08-31T01:00:00Z"); t < at("2026-09-07T01:00:00Z"); t += 4 * HOUR) {
      if (barFullyClosed(t, 4 * HOUR)) grid.push(new Date(t).toISOString().slice(0, 16));
    }
    expect(grid).toEqual([
      "2026-09-05T01:00", "2026-09-05T05:00", "2026-09-05T09:00",
      "2026-09-05T13:00", "2026-09-05T17:00", "2026-09-05T21:00",
      "2026-09-06T01:00", "2026-09-06T05:00", "2026-09-06T09:00",
      "2026-09-06T13:00",
    ]);
  });

  it("never drops a bar longer than the closed window", () => {
    // 1week is the interval the length guard exists for: 7 days is 0 mod 7, so
    // a Saturday- or Sunday-stamped weekly bar ends inside the SAME closure it
    // began in and both endpoints read shut. Higher-timeframe health is only a
    // console.warn, so deleting these would be silent.
    expect(barFullyClosed(at("2026-09-05T00:00:00Z"), 7 * DAY)).toBe(false);
    expect(barFullyClosed(at("2026-09-06T00:00:00Z"), 7 * DAY)).toBe(false);
    // A 30-day span is 2 mod 7 and can never land both endpoints in one
    // closure, so the monthly bars stamped on a weekend 1st — production
    // monthly bars carry the 1st, and 2026-08-01 was a Saturday — are already
    // safe from the endpoint test alone. Pinned as behaviour, not as proof of
    // the guard.
    expect(barFullyClosed(at("2026-08-01T00:00:00Z"), 30 * DAY)).toBe(false);
  });

  it("takes its window from the predicate rather than asserting one", () => {
    // 47h is Friday 22:00Z to Sunday 21:00Z under `isMarketClosed`. Measured
    // at one-minute steps, because the "longer than the window ⇒ keep"
    // shortcut starts deleting real bars the moment someone widens the
    // predicate — say to swallow the 21:00-22:00Z daylight-saving band —
    // without moving the constant with it.
    let longest = 0;
    let run = 0;
    const start = at("2026-08-24T00:00:00Z"); // a Monday
    for (let m = 0; m < 14 * 24 * 60; m++) {
      if (isMarketClosed(start + m * MIN)) { run += 1; longest = Math.max(longest, run); } else run = 0;
    }
    expect(longest * MIN).toBe(CLOSED_WINDOW_MS);
  });

  it("keeps a bar it cannot read, and a bar of unknown length", () => {
    // An interval of 0 means the timeframe is not in INTERVAL_MS: without the
    // guard the test degenerates to `openMs` against `openMs - 1`, which on a
    // Saturday midnight is Friday 23:59:59.999 — shut — and bars whose span is
    // unknown start being deleted. A negative interval is the same accident
    // pointing further back.
    expect(barFullyClosed(at("2026-09-05T00:00:00Z"), 0)).toBe(false);
    expect(barFullyClosed(at("2026-09-05T00:00:00Z"), -HOUR)).toBe(false);
    // An unreadable timestamp is not evidence of a closed market, and
    // parseCandles sorts undated bars to the FRONT, so they are interior by
    // construction. This one cannot be shown by behaviour — `isMarketClosed`
    // already answers false to every comparison against NaN, so the guard
    // states an intent rather than changing an answer. It is pinned at the
    // source instead, and labelled as that rather than dressed up as a result.
    expect(barFullyClosed(Number.NaN, HOUR)).toBe(false);
    expect(marketHours).toContain("if (!Number.isFinite(openMs)) return false;");
  });

  it("pins the pre-open band and the guards at the source, not only by answer", () => {
    // Each of these lines can be weakened in some direction with the answers
    // above still green, so the constants and the guards are named here too.
    expect(marketHours).toContain("export const SUNDAY_PREOPEN_UTC_HOUR = 17;");
    expect(marketHours).toContain(
      "if (end.getUTCDay() === 0 && end.getUTCHours() >= SUNDAY_PREOPEN_UTC_HOUR) return false;",
    );
    expect(marketHours).toContain("if (!(intervalMs > 0) || intervalMs > CLOSED_WINDOW_MS) return false;");
    expect(marketHours).toContain("return isMarketClosed(openMs) && isMarketClosed(endMs);");
  });

  it("removes the interior on a weekday, which is the bug itself", () => {
    // A 1h series ending Wednesday and spanning two weekends. Trimming the
    // tail returns 0 here — mid-week the newest bar is a real one — so before
    // this change not one of these bars was removed on any weekday run.
    const times: number[] = [];
    for (let t = at("2026-08-27T00:00:00Z"); t <= at("2026-09-09T12:00:00Z"); t += HOUR) times.push(t);
    const kept = times.filter((t) => !barFullyClosed(t, HOUR));
    // 43, not 47: the four Sunday pre-open hours are kept on purpose.
    expect(times.length - kept.length).toBe(2 * 43);
    // A trailing trim — all analyze ever did, and only on the preview path —
    // removes nothing at all from this array, because mid-week the newest bar
    // is a real one. Every one of those 86 bars was analysed as market data.
    let tail = 0;
    for (let i = times.length - 1; i >= 0 && isMarketClosed(times[i]); i -= 1) tail += 1;
    expect(tail).toBe(0);
    // What survives inside the closure is the Sunday pre-open band, nothing else.
    expect(kept.filter((t) => isMarketClosed(t)).every((t) => {
      const d = new Date(t);
      return d.getUTCDay() === 0 && d.getUTCHours() >= 17;
    })).toBe(true);
    // Still ascending, with the weekend as a jump rather than a hole.
    expect(kept.every((t, i) => i === 0 || t > kept[i - 1])).toBe(true);
    const jump = kept.findIndex((t, i) => i > 0 && t - kept[i - 1] > HOUR);
    expect(new Date(kept[jump - 1]).toISOString()).toBe("2026-08-28T21:00:00.000Z");
    expect(new Date(kept[jump]).toISOString()).toBe("2026-08-30T17:00:00.000Z");
  });

  // The four lines fetchSeries runs on the payload. Mirrored here because the
  // function itself lives inside a Deno edge function the suite cannot import;
  // the source assertions below are what keep the mirror honest.
  const parseAndFilter = (values: unknown[], intervalMs: number) => {
    const all = parseCandles(values);
    const candles = all.filter((c) => !barFullyClosed(
      Date.parse(c.datetime.includes("T") ? c.datetime : `${c.datetime.replace(" ", "T")}Z`),
      intervalMs,
    ));
    return { candles, rawCount: Math.max(0, values.length - (all.length - candles.length)) };
  };

  const row = (ms: number, over: Record<string, unknown> = {}) => ({
    datetime: new Date(ms).toISOString().slice(0, 19).replace("T", " "),
    open: 155, high: 155.4, low: 154.8, close: 155.1,
    ...over,
  });

  it("brings the raw count down with the deliberate drop, and only with it", () => {
    // 188 of 550 15min bars is 34%, well past the 5% gate `seriesHealth`
    // applies — so without this the entry series is unfit and every request
    // 502s on market_data_unhealthy. Deleting the gate instead would be worse:
    // it is the only thing that catches a payload that is not what it claims.
    const end = at("2026-09-09T12:00:00Z"); // a Wednesday
    const values = Array.from({ length: 480 }, (_, i) => row(end - (479 - i) * HOUR));
    const { candles, rawCount } = parseAndFilter(values, HOUR);
    expect(values.length - candles.length).toBeGreaterThan(80); // two weekends
    expect(rawCount).toBe(candles.length);
    const h = seriesHealth(candles, rawCount, 200, HOUR, end + HOUR);
    expect(h.issues.some((i) => i.startsWith("dropped:"))).toBe(false);
    expect(h.ok).toBe(true);

    // ...and a genuinely damaged payload still raises it. parseCandles refuses
    // a null price and a high under its own low; those rows were lost to the
    // feed, not chosen, and they stay in the raw count.
    const damaged = values.map((v, i) =>
      i % 10 === 0 ? row(Date.parse(`${v.datetime.replace(" ", "T")}Z`), { low: null }) : v
    );
    const broken = parseAndFilter(damaged, HOUR);
    expect(broken.rawCount - broken.candles.length).toBeGreaterThan(0);
    expect(
      seriesHealth(broken.candles, broken.rawCount, 200, HOUR, end + HOUR).issues
        .some((i) => i.startsWith("dropped:")),
    ).toBe(true);
  });

  it("agrees with itself in a non-UTC zone, which is the only place it can differ", () => {
    // 1day/1week/1month arrive as a bare "2026-09-05"; the intraday form is
    // "2026-09-05 00:00:00" and V8 reads THAT as local time without the T and
    // the Z. On a UTC runner the two spellings agree by construction, so the
    // whole hazard is invisible unless the zone is moved — the runner has no
    // TZ pin in vite.config.ts or package.json, so it is moved here.
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      const daily = ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"].map((d) => ({
        datetime: d, open: 155, high: 155.4, low: 154.8, close: 155.1,
      }));
      const { candles } = parseAndFilter(daily, DAY);
      // Only the day named Saturday holds no session.
      expect(candles.map((c) => c.datetime)).toEqual(["2026-09-04", "2026-09-06", "2026-09-07"]);
      const intraday = parseAndFilter(
        daily.map((c) => ({ ...c, datetime: `${c.datetime} 00:00:00` })),
        DAY,
      );
      expect(intraday.candles.map((c) => c.datetime.slice(0, 10)))
        .toEqual(candles.map((c) => c.datetime));
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it("re-bases the entry raw count on the series the overlay actually won with", () => {
    // GMO returns at most 250 bars and they arrive already interior-filtered,
    // so measuring them against the 480-row Twelve Data request reads as 48%
    // dropped — a 502 on every accepted-overlay run.
    const now = at("2026-09-09T12:00:00Z");
    const gmo = Array.from({ length: 250 }, (_, i) => row(now - (249 - i) * HOUR));
    const bars = parseCandles(gmo);
    expect(bars.length).toBe(250);
    expect(seriesHealth(bars, 480, 200, HOUR, now + HOUR).issues).toContain("dropped:230/480");
    expect(seriesHealth(bars, bars.length, 200, HOUR, now + HOUR).ok).toBe(true);
  });

  it("still leaves every rung 250 market bars at the worst instant of the week", () => {
    // The whole reason OUTPUTSIZE exists. At the old flat 250 the survivors are
    // 78 (15min), 164 (1h), 190 (4h) and 214 (1day): the first three below the
    // 200 that sma(closes, 200) needs, so SMA200 would vanish from every block
    // and render 算出不能. 1day is the one that would NOT have failed loudly,
    // and therefore the one that would have rotted quietly — so it is pinned
    // here too.
    const literal = analyze.match(/const OUTPUTSIZE: Record<string, number> = (\{[^}]*\});/);
    expect(literal, "analyze must declare OUTPUTSIZE").not.toBeNull();
    const sizes = JSON.parse(literal![1].replace(/,(\s*)\}/, "$1}")) as Record<string, number>;
    const intervals: Record<string, number> = {
      "15min": 15 * MIN, "1h": HOUR, "4h": 4 * HOUR, "1day": DAY,
    };
    const survivors = (raw: number, iv: number) => {
      let worst = Infinity;
      const base = at("2026-08-31T00:00:00Z"); // a Monday
      for (let k = 0; k < (14 * DAY) / iv; k++) {
        const now = base + k * iv;
        let kept = 0;
        for (let j = 0; j < raw; j++) if (!barFullyClosed(now - j * iv, iv)) kept += 1;
        worst = Math.min(worst, kept);
      }
      return worst;
    };
    for (const [tf, iv] of Object.entries(intervals)) {
      expect(sizes[tf], tf).toBeGreaterThan(0);
      expect(survivors(sizes[tf], iv), tf).toBeGreaterThanOrEqual(250);
    }
    expect(survivors(250, intervals["15min"])).toBe(78);
    expect(survivors(250, intervals["1h"])).toBe(164);
    expect(survivors(250, intervals["4h"])).toBe(190);
    expect(survivors(250, intervals["1day"])).toBe(214);
    // 1week and 1month are never filtered, so they ask for what they need.
    expect(sizes["1week"]).toBe(250);
    expect(sizes["1month"]).toBe(250);
  });
});

describe("the filter is wired into the one door all three rungs come through", () => {
  it("sits inside fetchSeries, on every path, not behind previewMode", () => {
    // The Monday 2026-09-07 01:07 production row ran with a GMO entry rung
    // that was already interior-filtered beside 4h and 1day rungs that were
    // not: one row carrying two definitions of "a bar".
    expect(analyze).toContain("const all = parseCandles(values);");
    expect(analyze).toContain("const candles = all.filter((c) => !barFullyClosed(");
    const fetchAt = analyze.indexOf("const fetchSeries = async (tf: string) => {");
    const filterAt = analyze.indexOf("const candles = all.filter((c) => !barFullyClosed(");
    const bindAt = analyze.indexOf("const entryCandles = seriesByTf[0];");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(filterAt).toBeGreaterThan(fetchAt);
    expect(filterAt).toBeLessThan(bindAt);
    // No second, per-rung filter anywhere downstream: one definition or none.
    expect(analyze.split("barFullyClosed(").length - 1).toBe(1);
    expect(analyze).not.toContain("if (previewMode) {");
    expect(analyze).not.toContain("closedTail");
  });

  it("passes the rung's own interval to the filter, which is the whole fix", () => {
    // The mirror below calls `barFullyClosed` with an interval it chooses
    // itself, so it cannot see what the source passes — and the source can be
    // reduced to a no-op without touching a line the mirror covers.
    // `const intervalMs = 0;` makes `barFullyClosed` bail on every bar and
    // restores the pre-fix behaviour byte for byte; `const intervalMs =
    // 3600000;` is worse than a no-op, filtering the 1day rung on a 1h span so
    // that the daily bar carrying the week's open is deleted every week.
    // Both used to leave the suite green.
    expect(analyze).toContain("const intervalMs = INTERVAL_MS[tf] ?? 0;");
    expect(analyze).toMatch(/\n {8}intervalMs,\n {6}\)\);/);
  });

  it("reads every stamp through the one idiom, at the source", () => {
    // "2026-09-05 00:00:00" without the T and the Z is LOCAL time to V8, so on
    // a non-UTC runner every intraday stamp shifts by the offset and the rung
    // is filtered against the wrong hours. The date-only coarse form is UTC
    // either way, which is exactly why a behavioural test cannot catch this:
    // on a UTC runner the two spellings agree by construction.
    expect(analyze).toContain(
      'Date.parse(c.datetime.includes("T") ? c.datetime : `${c.datetime.replace(" ", "T")}Z`),',
    );
  });

  it("subtracts the deliberate drop from the raw count, at the source", () => {
    // `rawCount: values.length` and `const dropped = 0;` both leave the mirror
    // green — it computes the expression itself — and both put `dropped:
    // 172/550` in front of a 5% gate, i.e. market_data_unhealthy on every
    // single request. `rawCount: candles.length` is green too and silently
    // deletes the broken-feed gate instead.
    expect(analyze).toContain("const dropped = all.length - candles.length;");
    expect(analyze).toContain("return { candles, rawCount: Math.max(0, values.length - dropped) };");
  });

  it("logs the drop, which is the only way a deploy can be confirmed live", () => {
    // OPERATIONS §9 H makes three of these lines on a weekday run the check
    // that the filter is actually running in production.
    expect(analyze).toContain('console.log("Dropped closed-market bars", { tf, dropped, kept: candles.length });');
  });

  it("takes the raw counts by index, never by completion order", () => {
    // They were pushed from inside fetchSeries, which recorded whichever
    // timeframe answered first; production 2026-09-06 12:33 stored
    // bars 241/248/250, so the counts genuinely differ and a misattributed one
    // is either a 502 or a silently mis-scored series.
    expect(analyze).not.toContain("rawCounts.push(");
    expect(analyze).toContain("seriesByTf = td.map((r) => r.candles);");
    expect(analyze).toContain("rawCounts = td.map((r) => r.rawCount);");
    expect(analyze).toContain("Promise.all(timeframes.map((tf) => fetchSeries(tf))),");
  });

  it("re-bases the entry raw count when the overlay wins", () => {
    const swap = analyze.indexOf("seriesByTf = [gmoRaw.bars.map(midCandle)");
    const rebase = analyze.indexOf("rawCounts[0] = seriesByTf[0].length;");
    expect(rebase).toBeGreaterThan(swap);
    expect(analyze.indexOf("const entryCandles = seriesByTf[0];")).toBeGreaterThan(rebase);
  });

  it("asks each rung for at least the bars its longest window needs", () => {
    // `2` for the higher rungs is what let the 130-bar regression run
    // undetected: it passed cleanly while SMA200 was absent from every block.
    expect(analyze).toContain('"15min": 200, "1h": 200, "4h": 200, "1day": 200, "1week": 52, "1month": 52,');
    expect(analyze).toContain("MIN_BARS[timeframes[i]] ?? 2,");
    expect(analyze).not.toContain("i === 0 ? 60 : 2,");
    // And what the promotion from 60 to 200 costs, stated rather than implied:
    // the entry rung's health is a hard 502, so a 199-bar entry series now
    // fails outright where 算出不能(足199本、200本必要) used to render. That is
    // the intended trade — worst-case survivors are 378/351/300/274 and the
    // GMO overlay is refused below MIN_OVERLAY_BARS = 200, so nothing that
    // reaches here can land in the 60-199 window — but it is a decision, not a
    // substring.
    const HOUR_MS = 3_600_000;
    const bar = (i: number) => ({
      datetime: new Date(Date.parse("2026-09-09T12:00:00Z") - i * HOUR_MS)
        .toISOString().slice(0, 19).replace("T", " "),
      open: 155, high: 155.4, low: 154.8, close: 155.1,
    });
    const short = parseCandles(Array.from({ length: 199 }, (_, i) => bar(198 - i)));
    expect(short.length).toBe(199);
    expect(seriesHealth(short, 199, 200, HOUR_MS, Date.parse("2026-09-09T12:30:00Z")).issues)
      .toContain("too_few_bars:199/200");
    expect(seriesHealth(short, 199, 60, HOUR_MS, Date.parse("2026-09-09T12:30:00Z")).ok).toBe(true);
  });

  it("tells the model the timestamps jump, on both blocks that count bars", () => {
    // 35 of the 40 rows printed on a Monday 1h run were near-identical frozen
    // bars; after the filter the block steps Friday 21:00 → Sunday 22:00 with
    // nothing saying so, and the model counts 「N本前」 off this list to
    // cross-check the server's structure block.
    // 原則, not a flat claim: the Friday 21:00-22:00Z band and the Sunday
    // pre-open band are both kept on purpose, so a series that says "closed
    // bars are removed" without qualification is telling the model something
    // the narrow predicate will not stand behind.
    expect(analyze).toContain("市場が閉まっていた足は原則除外済みなので週末を跨ぐ箇所で時刻が飛ぶ");
    expect(structure).toContain("「N本前」は市場が開いていた足で数えており、週末の足は原則として系列に入っていない。");
  });
});
