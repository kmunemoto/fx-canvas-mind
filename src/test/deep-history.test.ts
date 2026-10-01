import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { DEEP_HISTORY_BARS, DEEP_YEARS, GOLD_BARS, NO_KLINE_FILE, TWELVE_CHART_BARS, deepDaySpan, fetchDeepQuotes } from "../../supabase/functions/live-chart/logic";
import { ZLT_SETTLE_BARS } from "../lib/zlTema";

// #176: the deep history the Zero-lag TEMA reads (live-chart/logic.ts)

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-01T12:00:00Z");

// A fake GMO: each file's bars, every `step` from `from` to `to`, both sides;
// years before `firstYear` have nothing. `missing`: the days whose file GMO
// does not have (its 404, which the function gives as NO_KLINE_FILE); with
// `now`, a day whose 06:00 JST start is still to come is one of them, as
// GMO answers before its roll (track-outcomes/quotes.ts jstDayKey)
const bars = (from: number, to: number, step: number, now = NOW) => {
  const out: Array<{ openTime: string; open: string; high: string; low: string; close: string }> = [];
  for (let t = from; t < to && t <= now; t += step) {
    const p = 150 + Math.sin(t / (37 * HOUR));
    out.push({ openTime: String(t), open: String(p), high: String(p + 0.1), low: String(p - 0.1), close: String(p + 0.01) });
  }
  return out;
};
const fakeGmo = (opts: { firstYear?: number; fail?: (date: string) => boolean; missing?: (date: string) => boolean; now?: number } = {}) => {
  const now = opts.now ?? NOW;
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    const u = new URL(url);
    const date = u.searchParams.get("date")!;
    const interval = u.searchParams.get("interval")!;
    asked.push(`${u.searchParams.get("priceType")}:${date}`);
    if (opts.fail?.(date)) return null;
    if (opts.missing?.(date)) return NO_KLINE_FILE;
    if (date.length === 4) {
      if (Number(date) < (opts.firstYear ?? 2024)) return { status: 0, data: [] };
      const step = interval === "4hour" ? 4 * HOUR : 24 * HOUR;
      return { status: 0, data: bars(Date.UTC(Number(date), 0, 1) - 3 * HOUR, Date.UTC(Number(date) + 1, 0, 1) - 3 * HOUR, step, now) };
    }
    // a day's file: 06:00 JST (21:00 UTC the day before) for 24 hours
    const start = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))) - 3 * HOUR;
    if (opts.now !== undefined && start > now) return NO_KLINE_FILE;
    const step = interval === "1min" ? 60_000 : interval === "5min" ? 300_000 : interval === "15min" ? 900_000 : HOUR;
    return { status: 0, data: bars(start, start + 24 * HOUR, step, now) };
  };
  return { asked, fetcher };
};

afterEach(() => vi.restoreAllMocks());

describe("#176 the deep history (live-chart/logic.ts fetchDeepQuotes)", () => {
  it("reads enough for the slow line: DEEP_HISTORY_BARS, past the bars it needs to settle and the chart's own", () => {
    expect(DEEP_HISTORY_BARS).toBeGreaterThanOrEqual(ZLT_SETTLE_BARS + 120);
    // and Twelve Data's pairs and gold read that many at once; the chart's
    // own reads use the newest 800 of them, as many as they read before
    expect(GOLD_BARS).toBeGreaterThanOrEqual(DEEP_HISTORY_BARS);
    expect(TWELVE_CHART_BARS).toBe(800);
    expect(DEEP_YEARS).toBe(8);
  });

  it("4h: this year's file and as many years before as it takes, oldest first", async () => {
    const g = fakeGmo();
    const r = (await fetchDeepQuotes("USD/JPY", "4h", 1401, NOW, Date.now() + 60_000, g.fetcher))!;
    expect(r.complete).toBe(true);
    expect(r.bars).toHaveLength(1401);
    expect(new Set(g.asked.map((a) => a.split(":")[1]))).toEqual(new Set(["2026", "2025"]));
    const t = r.bars.map((b) => Date.parse(b.datetime));
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
    expect(t[t.length - 1]).toBeLessThanOrEqual(NOW);
  });

  it("stops where GMO has no more, and says that is all", async () => {
    const g = fakeGmo({ firstYear: 2025 });
    const r = (await fetchDeepQuotes("USD/JPY", "1day", 1401, NOW, Date.now() + 60_000, g.fetcher))!;
    // 2026, 2025, then 2024 empty: no further
    expect(new Set(g.asked.map((a) => a.split(":")[1]))).toEqual(new Set(["2026", "2025", "2024"]));
    expect(r.complete).toBe(true);
    expect(r.bars.length).toBeLessThan(1401);
    expect(r.bars.length).toBeGreaterThan(400);
  });

  it("1h: the day files newest first, the weekend's skipped, until there are enough", async () => {
    const g = fakeGmo();
    const r = (await fetchDeepQuotes("USD/JPY", "1h", 1401, NOW, Date.now() + 60_000, g.fetcher))!;
    expect(r.complete).toBe(true);
    expect(r.bars).toHaveLength(1401);
    const days = [...new Set(g.asked.map((a) => a.split(":")[1]))];
    // newest first
    expect(days[0]).toBe("20261001");
    for (let i = 1; i < days.length; i++) expect(days[i] < days[i - 1]).toBe(true);
    // no request for a JST day wholly inside the weekend break (Sunday)
    expect(days).not.toContain("20260927");
    // and within the span the walk allows
    expect(days.length).toBeLessThanOrEqual(deepDaySpan("1h", 1401) + 1);
  });

  it("past its time, gives what it has and says it stopped short", async () => {
    const g = fakeGmo();
    const real = Date.now();
    let calls = 0;
    const counted = async (url: string) => {
      calls++;
      return g.fetcher(url);
    };
    vi.spyOn(Date, "now").mockImplementation(() => real + calls * 1_000);
    const r = (await fetchDeepQuotes("USD/JPY", "1h", 1401, NOW, real + 10_000, counted))!;
    expect(r.complete).toBe(false);
    expect(r.bars.length).toBeGreaterThan(0);
    expect(r.bars.length).toBeLessThan(1401);
    // the newest bars, the same as the whole read's
    vi.restoreAllMocks();
    const all = (await fetchDeepQuotes("USD/JPY", "1h", 1401, NOW, Date.now() + 60_000, fakeGmo().fetcher))!;
    expect(r.bars.at(-1)).toEqual(all.bars.at(-1));
  });

  it("a file GMO did not answer: what it has, and stopped short", async () => {
    const g = fakeGmo({ fail: (d) => d === "20260925" });
    const r = (await fetchDeepQuotes("USD/JPY", "1h", 1401, NOW, Date.now() + 60_000, g.fetcher))!;
    expect(r.complete).toBe(false);
    expect(r.bars.every((b) => Date.parse(b.datetime) >= Date.parse("2026-09-25T21:00:00Z"))).toBe(true);
  });

  it("before GMO's day has begun (00:00 JST to its 06:00 roll), today's file is not there yet: read on from yesterday's", async () => {
    // 02:00 JST Thu 1 Oct, and 01:00 JST Mon 5 Oct (before the week opens)
    for (const now of [Date.parse("2026-09-30T17:00:00Z"), Date.parse("2026-10-04T16:00:00Z")]) {
      for (const interval of ["1min", "5min", "15min", "1h"]) {
        const g = fakeGmo({ now });
        const r = (await fetchDeepQuotes("USD/JPY", interval, 1401, now, Date.now() + 60_000, g.fetcher))!;
        expect(r).not.toBeNull();
        expect(r.complete).toBe(true);
        expect(r.bars).toHaveLength(1401);
        // asked for today's (not there), then went on
        const days = [...new Set(g.asked.map((a) => a.split(":")[1]))];
        expect(days[0]).toBe(now === Date.parse("2026-09-30T17:00:00Z") ? "20261001" : "20261005");
        expect(days.length).toBeGreaterThan(1);
        expect(Date.parse(r.bars.at(-1)!.datetime)).toBeLessThanOrEqual(now);
      }
    }
  });

  it("a day GMO has no file for (its 404) is a day without bars, not a read stopped short", async () => {
    const g = fakeGmo({ missing: (d) => d === "20260925" });
    const r = (await fetchDeepQuotes("USD/JPY", "1h", 1401, NOW, Date.now() + 60_000, g.fetcher))!;
    expect(r.complete).toBe(true);
    expect(r.bars).toHaveLength(1401);
    // none from that day (GMO's 20260925: 06:00 JST on the 25th, for 24 hours)
    const from = Date.parse("2026-09-24T21:00:00Z");
    expect(r.bars.some((b) => Date.parse(b.datetime) >= from && Date.parse(b.datetime) < from + 24 * HOUR)).toBe(false);
    expect(r.bars.some((b) => Date.parse(b.datetime) >= from + 24 * HOUR)).toBe(true);
    expect(r.bars.some((b) => Date.parse(b.datetime) < Date.parse("2026-09-24T21:00:00Z"))).toBe(true);
  });

  it("is GMO's pairs only (not those read as gold is, nor the pairs taken away)", async () => {
    const g = fakeGmo();
    expect(await fetchDeepQuotes("HKD/JPY", "1h", 1401, NOW, Date.now() + 60_000, g.fetcher)).toBeNull();
    expect(await fetchDeepQuotes("XAU/USD", "1h", 1401, NOW, Date.now() + 60_000, g.fetcher)).toBeNull();
    expect(await fetchDeepQuotes("EUR/USD", "1h", 1401, NOW, Date.now() + 60_000, g.fetcher)).toBeNull();
    expect(g.asked).toHaveLength(0);
  });

  it("the function keeps the ended files and does not keep a partial answer (index.ts)", () => {
    const fn = readFileSync("supabase/functions/live-chart/index.ts", "utf8");
    expect(fn).toContain("const deep = body?.deep === true;");
    expect(fn).toContain('gmo_kline_files?on_conflict=symbol,price_type,interval,date_key');
    expect(fn).toContain("if (!f || !klineFileEnded(f.date, nowMs)) return paced(url);");
    // GMO's 404 is a file with no bars for the deep read alone (the regular
    // reads still get null), and is never kept
    expect(fn).toContain("return r.status === 404 ? missing : null;");
    expect(fn).toContain("const gmoFetcher: Fetcher = gmoFetch(null);");
    expect(fn).toContain("const gmoDeepFetcher: Fetcher = gmoFetch(NO_KLINE_FILE);");
    expect(fn).toContain("const deepFetcher = watched(gmoDeepFetcher);");
    expect(fn).toContain("if (got !== NO_KLINE_FILE && keepableKlines(got)) {");
    // a failed read of the table or store to it is logged, not thrown; the
    // stores are waited for after the walk, before the answer
    expect(fn).toContain('console.error("kline preload failed:", err);');
    expect(fn).toContain('.catch((err) => console.error("kline store failed:", err)),');
    expect(fn).toMatch(/const got = await fetchDeepQuotes\([^\n]+\);\n\s*await Promise\.all\(stores\);/);
    // the pairs read as gold is: every read but the deep one uses the newest
    // TWELVE_CHART_BARS (the Dow reading's and the chart's bars by default)
    expect(fn).toContain("const read = await fallbackBars(pair, interval, fresh, GOLD_BARS, room);");
    expect(fn).toContain("const fb = read && read.bars.length > depth ? { ...read, bars: read.bars.slice(-depth) } : read;");
    expect(fn).toContain("const fb = await twelveBars(pair, interval, 0, deep ? GOLD_BARS : TWELVE_CHART_BARS);");
    expect(fn.match(/twelveBars\(pair, (interval|tf)(, DOW_ROOM)?\)/g)).toEqual(["twelveBars(pair, interval)", "twelveBars(pair, tf, DOW_ROOM)"]);
    expect(fn).toMatch(/if \(got\.complete\) \{\s*if \(historyCache\.size > CACHE_KEYS\) historyCache\.clear\(\);\s*historyCache\.set\(key/);
  });
});
