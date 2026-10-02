import { describe, it, expect } from "vitest";
import {
  CHART_GMO,
  LIVE_INTERVALS as SERVER_INTERVALS,
  LIVE_STEP_MS,
  NO_KLINE_FILE,
  TWELVE_SERVED,
  barEndMs as serverBarEnd,
  bucketOpenMs,
  buildCandles,
  buildQuotes,
  builtFresh,
  extendWithTicks,
  fetchChartQuotes,
  fetchLiveQuotes,
  isChartGmoInterval,
  isTwelveServed,
  liveRead,
  newestBarFresh,
  twelveCapFor,
  twelveMinBars,
  twelveSourceOf,
  FALLBACK_TTL_MS,
  type TickMinute,
} from "../../supabase/functions/live-chart/logic";
import { INTERVAL_STEP_MS, LIVE_INTERVALS, barEndMs, normalizeLiveRead, tickLive } from "../lib/liveChart";
import { LONG_BAR_MS, formatCandleLabel, medianGapMs } from "../lib/candleTime";
import { ja } from "../lib/i18n/ja";
import { en } from "../lib/i18n/en";

// #181: the broker's (楽天FX) 15 bar timeframes on the live chart
// (「足の種類、これだけ追加して」; docs §8.92)

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OLD = ["1min", "5min", "15min", "1h", "4h", "1day"];
const ADDED = ["2min", "3min", "4min", "10min", "30min", "2h", "8h", "1week", "1month"];

// GMO as measured on 2026-10-02 (feed-check runs 37009518910 and
// 37009733230): its week opens at 22:00 UTC on Sunday and closes at 21:00
// UTC on Friday; a day's file runs from 06:00 JST (21:00 UTC the day
// before); 8-hour bars at 0, 8 and 16 UTC (the Sunday 16:00 one holds the
// week's first hours), weeks from Saturday 21:00 UTC, months from 06:00 JST
// on the 1st; files from 2023 (2022: 404).
const gmoOpen = (t: number) => {
  const d = new Date(t);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && h >= 21) return false;
  if (day === 0 && h < 22) return false;
  return true;
};
const price = (t: number) => 150 + Math.sin(t / (37 * HOUR)) + Math.sin(t / (3 * HOUR)) / 10;
const row = (t: number, len: number) => {
  // the bar's prices over its open minutes (a long bar: sampled hourly)
  const sample = len > HOUR ? HOUR : MIN;
  const ps: number[] = [];
  for (let s = t; s < t + len; s += sample) if (gmoOpen(s)) ps.push(price(s));
  if (ps.length === 0) return null;
  return {
    openTime: String(t),
    open: ps[0].toFixed(3),
    high: Math.max(...ps).toFixed(3),
    low: Math.min(...ps).toFixed(3),
    close: ps[ps.length - 1].toFixed(3),
  };
};
const GMO_LEN: Record<string, number> = { "1min": MIN, "10min": 10 * MIN, "30min": 30 * MIN, "1hour": HOUR, "8hour": 8 * HOUR, "1week": 7 * DAY };
const fakeGmo = (now: number) => {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    const u = new URL(url);
    const date = u.searchParams.get("date")!;
    const interval = u.searchParams.get("interval")!;
    const side = u.searchParams.get("priceType")!;
    asked.push(`${interval}:${date}`);
    const lift = side === "ASK" ? 0.003 : 0;
    const shift = (r: ReturnType<typeof row>) =>
      r && { ...r, open: (Number(r.open) + lift).toFixed(3), high: (Number(r.high) + lift).toFixed(3), low: (Number(r.low) + lift).toFixed(3), close: (Number(r.close) + lift).toFixed(3) };
    const data: unknown[] = [];
    if (date.length === 4) {
      const y = Number(date);
      if (y < 2023) return NO_KLINE_FILE;
      const from = Date.UTC(y - 1, 11, 31, 21);
      const to = Date.UTC(y, 11, 31, 21);
      if (interval === "1month") {
        for (let m = 0; m < 12; m++) {
          const t = Date.UTC(y, m, 1) - 3 * HOUR;
          const r = shift(row(t, Date.UTC(y, m + 1, 1) - 3 * HOUR - t));
          if (t <= now && r) data.push(r);
        }
      } else {
        const len = GMO_LEN[interval];
        // weeks from the Saturday 21:00 UTC their JST Sunday starts on
        let t = interval === "1week" ? from + ((6 - new Date(from).getUTCDay() + 7) % 7) * DAY : from - (from % len);
        for (; t < to && t <= now; t += len) {
          const r = shift(row(t, len));
          if (t >= from && r) data.push(r);
        }
      }
      return { status: 0, data };
    }
    const start = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))) - 3 * HOUR;
    if (start > now) return NO_KLINE_FILE;
    const len = GMO_LEN[interval];
    for (let t = start; t < start + DAY && t <= now; t += len) {
      if (!gmoOpen(t)) continue;
      const r = shift(row(t, len));
      if (r) data.push(r);
    }
    return { status: 0, data };
  };
  return { asked, fetcher };
};

describe("#181 the timeframes listed", () => {
  it("are the broker's 15, in its menu's order, on the function and the client alike, each with its length and its names", () => {
    expect(LIVE_INTERVALS).toEqual([
      "1min", "2min", "3min", "4min", "5min", "10min", "15min", "30min",
      "1h", "2h", "4h", "8h", "1day", "1week", "1month",
    ]);
    expect([...SERVER_INTERVALS]).toEqual(LIVE_INTERVALS);
    expect(INTERVAL_STEP_MS).toEqual(LIVE_STEP_MS);
    for (const iv of LIVE_INTERVALS) {
      expect(LIVE_STEP_MS[iv]).toBeGreaterThan(0);
      expect((ja.control.intervals as Record<string, string>)[iv]).toBeTruthy();
      expect((en.control.intervals as Record<string, string>)[iv]).toBeTruthy();
      expect(ja.live.intervalShort[iv]).toBeTruthy();
      expect(en.live.intervalShort[iv]).toBeTruthy();
    }
    expect(ja.control.intervals["1week"]).toBe("週足");
    expect(ja.control.intervals["1month"]).toBe("月足");
    expect(ja.control.intervals["8h"]).toBe("8時間足");
  });

  it("close where their open and length say; a month's where the next month opens, at the same time of day", () => {
    const t = Date.parse("2026-10-01T12:00:00Z");
    for (const iv of LIVE_INTERVALS.filter((x) => x !== "1month")) {
      expect(serverBarEnd(iv, t)).toBe(t + LIVE_STEP_MS[iv]);
      expect(barEndMs(iv, t)).toBe(t + LIVE_STEP_MS[iv]);
    }
    // GMO's months open at 06:00 JST on the 1st (21:00 UTC the day before)
    const gmo: Array<[string, string]> = [
      ["2025-12-31T21:00:00Z", "2026-01-31T21:00:00Z"],
      ["2026-01-31T21:00:00Z", "2026-02-28T21:00:00Z"],
      ["2026-02-28T21:00:00Z", "2026-03-31T21:00:00Z"],
      ["2026-09-30T21:00:00Z", "2026-10-31T21:00:00Z"],
      ["2026-11-30T21:00:00Z", "2026-12-31T21:00:00Z"],
    ];
    // Twelve Data's on the 1st, read as 00:00 UTC
    const twelve: Array<[string, string]> = [
      ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
      ["2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"],
      ["2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z"],
    ];
    for (const [open, end] of [...gmo, ...twelve]) {
      expect(new Date(serverBarEnd("1month", Date.parse(open))).toISOString()).toBe(new Date(Date.parse(end)).toISOString());
      expect(barEndMs("1month", Date.parse(open))).toBe(Date.parse(end));
    }
    expect(serverBarEnd("tick", t)).toBeNaN();
  });
});

describe("#181 where each is read from", () => {
  it("GMO: the nine added the new way (its own files, or made of shorter ones), the six as before", () => {
    expect(Object.keys(CHART_GMO).sort()).toEqual([...ADDED].sort());
    for (const iv of OLD) expect(isChartGmoInterval(iv)).toBe(false);
    // measured: GMO has 10min, 30min, 8hour, 1week and 1month; not 2, 3 or
    // 4 minutes or 2 hours
    expect(CHART_GMO["10min"]).toMatchObject({ name: "10min", key: "day", of: 1 });
    expect(CHART_GMO["30min"]).toMatchObject({ name: "30min", key: "day", of: 1 });
    expect(CHART_GMO["8h"]).toMatchObject({ name: "8hour", key: "year", of: 1 });
    expect(CHART_GMO["1week"]).toMatchObject({ name: "1week", key: "year", of: 1 });
    expect(CHART_GMO["1month"]).toMatchObject({ name: "1month", key: "year", of: 1 });
    for (const [iv, n] of [["2min", 2], ["3min", 3], ["4min", 4]] as const) expect(CHART_GMO[iv]).toMatchObject({ name: "1min", base: "1min", of: n, offsetMs: 0 });
    expect(CHART_GMO["2h"]).toMatchObject({ name: "1hour", base: "1h", of: 2, offsetMs: 0 });
    for (const iv of ADDED) {
      const s = CHART_GMO[iv];
      if (iv !== "1month") expect(s.of * LIVE_STEP_MS[s.base]).toBe(LIVE_STEP_MS[iv]);
    }
  });

  it("Twelve Data: asked only for what it has; the others made of a shorter one's kept bars, read and counted as that one", () => {
    expect([...TWELVE_SERVED]).toEqual(["1min", "5min", "15min", "1h", "4h", "1day", "1week", "1month"]);
    for (const iv of ["2min", "3min", "4min", "10min", "30min", "2h", "8h", "tick"]) expect(isTwelveServed(iv)).toBe(false);
    for (const iv of LIVE_INTERVALS) {
      const from = twelveSourceOf(iv);
      expect(isTwelveServed(from.base)).toBe(true);
      if (iv !== "1month") expect(from.of * LIVE_STEP_MS[from.base]).toBe(LIVE_STEP_MS[iv]);
    }
    expect(twelveSourceOf("2min")).toEqual({ base: "1min", of: 2, offsetMs: 0 });
    expect(twelveSourceOf("10min")).toEqual({ base: "5min", of: 2, offsetMs: 0 });
    expect(twelveSourceOf("30min")).toEqual({ base: "15min", of: 2, offsetMs: 0 });
    // on the grid of Twelve Data's own 4-hour bars (01, 05, 09 ... UTC)
    expect(twelveSourceOf("2h")).toEqual({ base: "1h", of: 2, offsetMs: HOUR });
    expect(twelveSourceOf("8h")).toEqual({ base: "4h", of: 2, offsetMs: 5 * HOUR });
    expect(twelveSourceOf("1week")).toEqual({ base: "1week", of: 1, offsetMs: 0 });
    // the day's caps: the read is the shorter one's, so is its cap
    expect(twelveCapFor(twelveSourceOf("2min").base)).toBe(450);
    expect(twelveCapFor(twelveSourceOf("4min").base)).toBe(450);
    expect(twelveCapFor(twelveSourceOf("10min").base)).toBe(600);
    for (const iv of ["30min", "2h", "8h", "1week", "1month"]) expect(twelveCapFor(twelveSourceOf(iv).base)).toBe(720);
    // a week's or a month's answer is kept with fewer bars than the others'
    expect(twelveMinBars("1month")).toBe(12);
    expect(twelveMinBars("1week")).toBe(12);
    expect(twelveMinBars("1h")).toBe(60);
  });
});

describe("#181 bars made of shorter ones", () => {
  it("each the first one's open, the highest high, the lowest low, the last one's close; the first left out (it may be short of its start)", () => {
    // Twelve Data's hourly bars, 00:00 to 06:00 UTC, made into 2 hours on its odd-hour grid
    const hours = Array.from({ length: 7 }, (_, k) => ({
      datetime: `2026-10-01 0${k}:00:00`,
      open: 10 + k,
      high: 20 + k,
      low: 5 - k,
      close: 11 + k,
    }));
    const two = buildCandles(hours, 2 * HOUR, HOUR);
    // 00:00 belongs to the 23:00 bar, short of its start: left out
    expect(two.map((c) => c.datetime)).toEqual(["2026-10-01 01:00:00", "2026-10-01 03:00:00", "2026-10-01 05:00:00"]);
    expect(two[0]).toEqual({ datetime: "2026-10-01 01:00:00", open: 11, high: 22, low: 3, close: 13 });
    expect(two[2]).toEqual({ datetime: "2026-10-01 05:00:00", open: 15, high: 26, low: -1, close: 17 });
    // Twelve Data's 4-hour bars (01, 05 ... UTC) into 8 hours from 21:00 UTC
    const fours = ["2026-09-30 21:00:00", "2026-10-01 01:00:00", "2026-10-01 05:00:00", "2026-10-01 09:00:00", "2026-10-01 13:00:00"].map((datetime, k) => ({
      datetime, open: k, high: k + 1, low: k - 1, close: k + 0.5,
    }));
    expect(buildCandles(fours, 8 * HOUR, 5 * HOUR).map((c) => c.datetime)).toEqual(["2026-10-01 05:00:00", "2026-10-01 13:00:00"]);
    expect(bucketOpenMs(Date.parse("2026-10-01T04:59:00Z"), 8 * HOUR, 5 * HOUR)).toBe(Date.parse("2026-09-30T21:00:00Z"));
  });

  it("GMO's bid and ask bars, each side alike, stamped as GMO stamps", () => {
    const q = (iso: string, b: number) => ({
      datetime: iso,
      bid: { datetime: iso, open: b, high: b + 1, low: b - 1, close: b + 0.5 },
      ask: { datetime: iso, open: b + 0.01, high: b + 1.01, low: b - 0.99, close: b + 0.51 },
    });
    const ones = ["2026-10-01T12:00:00.000Z", "2026-10-01T12:01:00.000Z", "2026-10-01T12:02:00.000Z", "2026-10-01T12:03:00.000Z", "2026-10-01T12:04:00.000Z"].map((t, k) => q(t, 100 + k));
    const two = buildQuotes(ones, 2 * MIN, 0);
    // 12:00 is the first: left out
    expect(two.map((x) => x.datetime)).toEqual(["2026-10-01T12:02:00.000Z", "2026-10-01T12:04:00.000Z"]);
    expect(two[0].bid).toEqual({ datetime: "2026-10-01T12:02:00.000Z", open: 102, high: 104, low: 101, close: 103.5 });
    expect(two[0].ask.close).toBeCloseTo(103.51, 10);
  });
});

describe("#181 GMO's bars for the added timeframes (fetchChartQuotes)", () => {
  // a Thursday, 21:03:30 JST
  const NOW = Date.parse("2026-10-01T12:03:30Z");

  it("2min: from GMO's 1-minute files, on the 2-minute grid, the forming one last", async () => {
    const g = fakeGmo(NOW);
    const r = (await fetchChartQuotes("USD/JPY", "2min", 201, NOW, Date.now() + 60_000, g.fetcher))!;
    expect(r.complete).toBe(true);
    expect(r.bars).toHaveLength(201);
    expect(new Set(g.asked.map((a) => a.split(":")[0]))).toEqual(new Set(["1min"]));
    const t = r.bars.map((b) => Date.parse(b.datetime));
    for (const x of t) expect(x % (2 * MIN)).toBe(0);
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBe(2 * MIN);
    // the forming one: 12:02, with the minute still forming in it
    expect(new Date(t[t.length - 1]).toISOString()).toBe("2026-10-01T12:02:00.000Z");
    const read = liveRead("USD/JPY", "2min", r.bars, NOW);
    expect(read.next_close).toBe("2026-10-01T12:04:00.000Z");
    expect(read.forming_open).toBe("2026-10-01T12:02:00.000Z");
    // each bar its two minutes' (the bid's first open and last close)
    const b = r.bars[r.bars.length - 2];
    const m0 = Date.parse(b.datetime);
    expect(b.bid.open).toBeCloseTo(Number(price(m0).toFixed(3)), 10);
    expect(b.bid.close).toBeCloseTo(Number(price(m0 + MIN).toFixed(3)), 10);
    // the old timeframes' way (fetchLiveQuotes) leads here for these
    const via = await fetchLiveQuotes("USD/JPY", "2min", NOW, Date.now() + 60_000, fakeGmo(NOW).fetcher);
    expect(via?.length).toBe(201);
  });

  it("2h: from the hourly files on the even UTC hours, the week's first hours (from Sunday 22:00 UTC) kept", async () => {
    const g = fakeGmo(NOW);
    const r = (await fetchChartQuotes("USD/JPY", "2h", 201, NOW, Date.now() + 60_000, g.fetcher))!;
    expect(new Set(g.asked.map((a) => a.split(":")[0]))).toEqual(new Set(["1hour"]));
    expect(r.bars).toHaveLength(201);
    const t = r.bars.map((b) => Date.parse(b.datetime));
    for (const x of t) expect(x % (2 * HOUR)).toBe(0);
    // the Sunday bars: 22:00 UTC, the week's first two hours
    const sundays = t.filter((x) => new Date(x).getUTCDay() === 0).map((x) => new Date(x).toISOString());
    expect(sundays).toContain("2026-09-27T22:00:00.000Z");
    // none while the market is shut
    for (const x of t) expect(new Date(x).getUTCDay()).not.toBe(6);
  });

  it("10min and 30min: GMO's own day files", async () => {
    for (const iv of ["10min", "30min"]) {
      const g = fakeGmo(NOW);
      const r = (await fetchChartQuotes("EUR/USD", iv, 201, NOW, Date.now() + 60_000, g.fetcher))!;
      expect(new Set(g.asked.map((a) => a.split(":")[0]))).toEqual(new Set([iv]));
      expect(r.bars).toHaveLength(201);
      const t = r.bars.map((b) => Date.parse(b.datetime));
      for (let i = 1; i < t.length; i++) expect((t[i] - t[i - 1]) % LIVE_STEP_MS[iv]).toBe(0);
    }
  });

  it("8h: GMO's year files; the Sunday 16:00 UTC bar holding the week's first hours is kept", async () => {
    const g = fakeGmo(NOW);
    const r = (await fetchChartQuotes("USD/JPY", "8h", 201, NOW, Date.now() + 60_000, g.fetcher))!;
    expect(new Set(g.asked.map((a) => a.split(":")[0]))).toEqual(new Set(["8hour"]));
    expect(r.bars).toHaveLength(201);
    const iso = r.bars.map((b) => b.datetime);
    expect(iso).toContain("2026-09-27T16:00:00.000Z");
    expect(iso[iso.length - 1]).toBe("2026-10-01T08:00:00.000Z");
  });

  it("1week: GMO's weeks, stamped Saturday 21:00 UTC, kept; read back to where GMO has none", async () => {
    const g = fakeGmo(NOW);
    const r = (await fetchChartQuotes("USD/JPY", "1week", 201, NOW, Date.now() + 60_000, g.fetcher))!;
    expect(r.complete).toBe(true);
    // 2026 back to 2023, and 2022, which GMO has no file for: no further
    expect([...new Set(g.asked.map((a) => a.split(":")[1]))]).toEqual(["2026", "2025", "2024", "2023", "2022"]);
    const t = r.bars.map((b) => Date.parse(b.datetime));
    for (const x of t) {
      expect(new Date(x).getUTCDay()).toBe(6);
      expect(new Date(x).getUTCHours()).toBe(21);
    }
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBe(7 * DAY);
    expect(r.bars.length).toBeGreaterThan(190);
    const read = liveRead("USD/JPY", "1week", r.bars, NOW);
    expect(read.forming_open).toBe("2026-09-26T21:00:00.000Z");
    expect(read.next_close).toBe("2026-10-03T21:00:00.000Z");
  });

  it("1month: GMO's months, closing where the next month opens", async () => {
    const g = fakeGmo(NOW);
    const r = (await fetchChartQuotes("USD/JPY", "1month", 201, NOW, Date.now() + 60_000, g.fetcher))!;
    // all GMO has: 2023 to this month
    expect(r.bars[0].datetime).toBe("2022-12-31T21:00:00.000Z");
    expect(r.bars).toHaveLength(46);
    const read = liveRead("USD/JPY", "1month", r.bars, NOW);
    expect(read.forming_open).toBe("2026-09-30T21:00:00.000Z");
    expect(read.next_close).toBe("2026-10-31T21:00:00.000Z");
    // the closed ones: every month before (September's closed at 21:00 UTC on the 30th)
    expect(read.candles).toHaveLength(46);
    // RSI + SAR's reading needs 60 bars: said, not drawn wrong
    expect(read.ok).toBe(false);
  });
});

describe("#181 Twelve Data's kept bars, fresh or not", () => {
  it("a timeframe made of a shorter one's: fresh while none of its own bars has closed since they were read", () => {
    const now = Date.parse("2026-10-01T12:30:00Z");
    // 2 hours on the odd hours: the bar now is 11:00-13:00
    expect(builtFresh(Date.parse("2026-10-01T11:05:00Z"), now, "2h", false)).toBe(true);
    expect(builtFresh(Date.parse("2026-10-01T10:59:00Z"), now, "2h", false)).toBe(false);
    // 4 minutes on the epoch grid: 12:28-12:32
    expect(builtFresh(Date.parse("2026-10-01T12:28:10Z"), now, "4min", false)).toBe(true);
    expect(builtFresh(Date.parse("2026-10-01T12:27:59Z"), now, "4min", false)).toBe(false);
    // while the market may be shut, FALLBACK_TTL_MS
    expect(builtFresh(now - FALLBACK_TTL_MS + 1000, now, "2h", true)).toBe(true);
    expect(builtFresh(now - FALLBACK_TTL_MS - 1000, now, "2h", true)).toBe(false);
    // not one of those
    expect(builtFresh(now, now, "1h", false)).toBe(false);
  });

  it("a week's or a month's, Twelve Data's own: by the newest bar read", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    const months = [{ datetime: "2026-09-01 00:00:00" }, { datetime: "2026-10-01 00:00:00" }].map((b) => ({ ...b, open: 1, high: 1, low: 1, close: 1 }));
    // forming: read again once a UTC day
    expect(newestBarFresh(Date.parse("2026-10-14T00:10:00Z"), now, "1month", months, false)).toBe(true);
    expect(newestBarFresh(Date.parse("2026-10-13T23:50:00Z"), now, "1month", months, false)).toBe(false);
    // it has closed since it was read: at once
    expect(newestBarFresh(Date.parse("2026-10-31T23:00:00Z"), Date.parse("2026-11-01T00:30:00Z"), "1month", months, false)).toBe(false);
    // read when it had already closed (the next not listed yet): after a while
    expect(newestBarFresh(Date.parse("2026-11-01T00:10:00Z"), Date.parse("2026-11-01T00:30:00Z"), "1month", months, false)).toBe(true);
    expect(newestBarFresh(Date.parse("2026-11-01T00:10:00Z"), Date.parse("2026-11-01T00:41:00Z"), "1month", months, false)).toBe(false);
    expect(newestBarFresh(Date.parse("2026-10-14T00:10:00Z"), now, "1month", [], false)).toBe(false);
  });

  it("a month's bars go on from the prices recorded since, by the calendar", () => {
    const bars = [{ datetime: "2026-09-01 00:00:00", open: 1.3, high: 1.4, low: 1.2, close: 1.35 }];
    const minutes: TickMinute[] = [
      { minute: "2026-09-30T23:58:00.000Z", open: 1.36, high: 1.41, low: 1.35, close: 1.37, lastAt: "2026-09-30T23:58:40.000Z" },
      { minute: "2026-10-01T00:05:00.000Z", open: 1.38, high: 1.39, low: 1.37, close: 1.385, lastAt: "2026-10-01T00:05:50.000Z" },
    ];
    const ext = extendWithTicks(bars, "1month", "2026-09-30T23:57:10.000Z", minutes);
    expect(ext.bars.map((b) => b.datetime)).toEqual(["2026-09-01 00:00:00", "2026-10-01 00:00:00"]);
    expect(ext.bars[0]).toMatchObject({ open: 1.3, high: 1.41, low: 1.2, close: 1.37 });
    expect(ext.bars[1]).toMatchObject({ open: 1.38, close: 1.385 });
  });
});

describe("#181 the client", () => {
  it("moves a month's forming bar until the next month opens, then starts the next one there", () => {
    const endOf = (o: number) => barEndMs("1month", o);
    const live = {
      candles: [{ datetime: "2026-09-30T21:00:00.000Z", open: 150, high: 151, low: 149, close: 150.5 }],
      formingOpen: Date.parse("2026-09-30T21:00:00Z"),
    };
    const a = tickLive(live, 152, Date.parse("2026-10-31T20:59:00Z"), LIVE_STEP_MS["1month"], endOf);
    expect(a.candles).toHaveLength(1);
    expect(a.candles[0]).toMatchObject({ high: 152, close: 152 });
    const b = tickLive(a, 153, Date.parse("2026-10-31T21:01:00Z"), LIVE_STEP_MS["1month"], endOf);
    expect(b.candles).toHaveLength(2);
    expect(b.candles[1]).toEqual({ datetime: "2026-10-31 21:00:00", open: 153, high: 153, low: 153, close: 153 });
    expect(b.formingOpen).toBe(Date.parse("2026-10-31T21:00:00Z"));
    // a fixed length: as before, the bar the price falls in
    const c = tickLive({ candles: [{ datetime: "2026-10-01 12:00:00", open: 1, high: 1, low: 1, close: 1 }], formingOpen: Date.parse("2026-10-01T12:00:00Z") }, 2, Date.parse("2026-10-01T12:07:30Z"), 2 * MIN);
    expect(c.candles[1].datetime).toBe("2026-10-01 12:06:00");
  });

  it("takes the forming bar's open from the read", () => {
    const base = { pair: "USD/JPY", interval: "1month", candles: [{ datetime: "2026-09-30T21:00:00.000Z", open: 1, high: 1, low: 1, close: 1 }] };
    expect(normalizeLiveRead({ ...base, forming_open: "2026-09-30T21:00:00.000Z" })!.formingOpen).toBe(Date.parse("2026-09-30T21:00:00Z"));
    expect(normalizeLiveRead(base)!.formingOpen).toBeNull();
  });

  it("labels a chart of weeks or months with the year", () => {
    const weeks = ["2026-09-12T21:00:00.000Z", "2026-09-19T21:00:00.000Z", "2026-09-26T21:00:00.000Z"];
    expect(medianGapMs(weeks)).toBe(7 * DAY);
    expect(medianGapMs(weeks)).toBeGreaterThanOrEqual(LONG_BAR_MS);
    expect(medianGapMs(["2026-10-01 00:00:00", "2026-10-02 00:00:00"])).toBeLessThan(LONG_BAR_MS);
    expect(formatCandleLabel("2026-09-26T21:00:00.000Z", "ja-JP", { long: true })).toBe("2026/09/27");
    expect(formatCandleLabel("2026-09-26T21:00:00.000Z", "ja-JP")).toBe("09/27 06:00");
  });
});
