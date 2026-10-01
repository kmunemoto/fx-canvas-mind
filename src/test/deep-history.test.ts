import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { DEEP_HISTORY_BARS, DEEP_YEARS, GOLD_BARS, deepDaySpan, fetchDeepQuotes } from "../../supabase/functions/live-chart/logic";
import { ZLT_SETTLE_BARS } from "../lib/zlTema";

// #176: the deep history the Zero-lag TEMA reads (live-chart/logic.ts)

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-01T12:00:00Z");

// A fake GMO: each file's bars, every `step` from `from` to `to`, both sides;
// years before `firstYear` have nothing
const bars = (from: number, to: number, step: number) => {
  const out: Array<{ openTime: string; open: string; high: string; low: string; close: string }> = [];
  for (let t = from; t < to && t <= NOW; t += step) {
    const p = 150 + Math.sin(t / (37 * HOUR));
    out.push({ openTime: String(t), open: String(p), high: String(p + 0.1), low: String(p - 0.1), close: String(p + 0.01) });
  }
  return out;
};
const fakeGmo = (opts: { firstYear?: number; fail?: (date: string) => boolean } = {}) => {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    const u = new URL(url);
    const date = u.searchParams.get("date")!;
    const interval = u.searchParams.get("interval")!;
    asked.push(`${u.searchParams.get("priceType")}:${date}`);
    if (opts.fail?.(date)) return null;
    if (date.length === 4) {
      if (Number(date) < (opts.firstYear ?? 2024)) return { status: 0, data: [] };
      const step = interval === "4hour" ? 4 * HOUR : 24 * HOUR;
      return { status: 0, data: bars(Date.UTC(Number(date), 0, 1) - 3 * HOUR, Date.UTC(Number(date) + 1, 0, 1) - 3 * HOUR, step) };
    }
    // a day's file: 06:00 JST (21:00 UTC the day before) for 24 hours
    const start = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))) - 3 * HOUR;
    return { status: 0, data: bars(start, start + 24 * HOUR, HOUR) };
  };
  return { asked, fetcher };
};

afterEach(() => vi.restoreAllMocks());

describe("#176 the deep history (live-chart/logic.ts fetchDeepQuotes)", () => {
  it("reads enough for the slow line: DEEP_HISTORY_BARS, past the bars it needs to settle and the chart's own", () => {
    expect(DEEP_HISTORY_BARS).toBeGreaterThanOrEqual(ZLT_SETTLE_BARS + 120);
    // and Twelve Data's pairs and gold read that many at once
    expect(GOLD_BARS).toBeGreaterThanOrEqual(DEEP_HISTORY_BARS);
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
    expect(fn).toMatch(/if \(got\.complete\) \{\s*if \(historyCache\.size > CACHE_KEYS\) historyCache\.clear\(\);\s*historyCache\.set\(key/);
  });
});
