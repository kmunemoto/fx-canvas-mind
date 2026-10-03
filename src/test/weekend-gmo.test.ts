import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { barFullyClosed, barInsideClosure, isMarketClosed } from "../../supabase/functions/_shared/market-hours";
import { usableBars, type QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import { fetchYearQuotes } from "../../supabase/functions/signal-alerts/logic";
import { hourCloseOf } from "../../supabase/functions/signal-alerts/indicators";
import { barOpenMs } from "../../supabase/functions/analyze/state";
import { fetchLiveQuotes, liveRead } from "../../supabase/functions/live-chart/logic";

// #182: GMO's 4-hour bar stamped Sunday 20:00 UTC holds the week's first two
// hours of trading (GMO opens at 22:00) and is kept; the weekend's filler is
// still thrown away (docs §8.93)

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);

describe("#182 a GMO bar is thrown away only when the market was shut for all of it", () => {
  it("keeps the 4-hour bar stamped Sunday 20:00, which the open stamp alone threw away", () => {
    // 2026-09-27 20:00 UTC: GMO's bar O 157.287 H 157.635 L 157.276 C 157.425,
    // the 22:00 and 23:00 hourly bars put together
    expect(isMarketClosed(at("2026-09-27T20:00:00Z"))).toBe(true);
    expect(barInsideClosure(at("2026-09-27T20:00:00Z"), 4 * HOUR)).toBe(false);
  });

  it("still throws away the flat filler GMO filed in the weekend, which barFullyClosed would keep", () => {
    // HUF/JPY and SEK/JPY, 2026-09-13 16:00 (4 hours) and 2026-09-12 21:00 (a
    // day): one price for open, high, low and close
    expect(barInsideClosure(at("2026-09-13T16:00:00Z"), 4 * HOUR)).toBe(true);
    expect(barInsideClosure(at("2026-09-12T21:00:00Z"), DAY)).toBe(true);
    expect(barFullyClosed(at("2026-09-13T16:00:00Z"), 4 * HOUR)).toBe(false);
    expect(barFullyClosed(at("2026-09-12T21:00:00Z"), DAY)).toBe(false);
  });

  it("answers as the open stamp did for everything else on GMO's grids", () => {
    // two weeks, one of them in winter, every stamp on GMO's grids
    const grids: Array<[number, number]> = [
      [MIN, 0],
      [5 * MIN, 0],
      [10 * MIN, 0],
      [15 * MIN, 0],
      [30 * MIN, 0],
      [HOUR, 0],
      [4 * HOUR, 0], // 0, 4, 8 ... UTC
      [DAY, 21 * HOUR], // GMO's days open at 21:00 UTC
    ];
    const changed: string[] = [];
    for (const from of [at("2026-09-24T00:00:00Z"), at("2026-01-15T00:00:00Z")]) {
      for (const [len, offset] of grids) {
        for (let t = from + offset; t < from + 10 * DAY; t += len) {
          const before = isMarketClosed(t);
          const now = barInsideClosure(t, len);
          // never throws away a bar the open stamp kept
          if (now) expect(before).toBe(true);
          if (before !== now) changed.push(`${len / MIN}m ${new Date(t).toISOString()}`);
        }
      }
    }
    expect(changed).toEqual([
      "240m 2026-09-27T20:00:00.000Z",
      "240m 2026-01-18T20:00:00.000Z",
    ]);
  });

  it("is the open stamp alone for an unknown length, and never throws away a bar longer than the closure", () => {
    expect(barInsideClosure(at("2026-09-27T20:00:00Z"), 0)).toBe(true);
    expect(barInsideClosure(at("2026-09-26T02:00:00Z"), 0)).toBe(true);
    expect(barInsideClosure(at("2026-09-24T02:00:00Z"), 0)).toBe(false);
    expect(barInsideClosure(at("2026-09-26T02:00:00Z"), Number.NaN)).toBe(true);
    expect(barInsideClosure(at("2026-09-26T21:00:00Z"), 7 * DAY)).toBe(false);
    expect(barInsideClosure(Number.NaN, HOUR)).toBe(false);
  });
});

// GMO's 4-hour bars as GMO serves them: 0, 4, 8 ... UTC from Sunday 20:00
// (the week's first two hours) to Friday 20:00, none on Saturday, and the
// flat filler bar of 2026-09-13 put in a weekend too
const fourHourFile = (fromMs: number, toMs: number, withFiller: boolean, side: number) => {
  const data: Array<{ openTime: string; open: string; high: string; low: string; close: string }> = [];
  let px = 150;
  for (let t = fromMs; t < toMs; t += 4 * HOUR) {
    const d = new Date(t);
    const day = d.getUTCDay();
    const hour = d.getUTCHours();
    const filler = withFiller && day === 0 && hour === 16;
    const trading = !(day === 6 || (day === 0 && hour < 20) || (day === 5 && hour > 20));
    if (!trading && !filler) continue;
    const o = px;
    px = filler ? o : o + Math.sin(t / (9 * HOUR)) * 0.2;
    const hi = filler ? o : Math.max(o, px) + 0.05;
    const lo = filler ? o : Math.min(o, px) - 0.05;
    const s = (x: number) => (x + side).toFixed(3);
    data.push({ openTime: String(t), open: s(o), high: s(hi), low: s(lo), close: s(px) });
  }
  return { status: 0, data };
};
const gmo = (toMs: number) => async (url: string) => {
  const year = url.match(/date=(\d+)/)?.[1];
  if (!url.includes("interval=4hour") || year !== "2026") return { status: 0, data: [] };
  return fourHourFile(at("2026-01-02T00:00:00Z"), toMs, true, url.includes("priceType=ASK") ? 0.008 : 0);
};
const stamps = (qs: QuoteCandle[]) => qs.map((q) => new Date(barOpenMs(q.datetime)).toISOString());

describe("#182 GMO's 4-hour bars through usableBars, the e-mails' read and the chart's", () => {
  it("usableBars keeps Sunday 20:00 and throws away the Sunday 16:00 filler and nothing else", async () => {
    const now = at("2026-09-28T00:30:00Z");
    const got = await fetchYearQuotes("USD/JPY", "4h", 400, now, gmo(now));
    expect(got).not.toBeNull();
    const s = stamps(got!);
    expect(s).toContain("2026-09-27T20:00:00.000Z");
    expect(s).not.toContain("2026-09-27T16:00:00.000Z");
    // the week: Friday 16:00, Friday 20:00, Sunday 20:00, Monday 00:00 (forming)
    expect(s.slice(-4)).toEqual([
      "2026-09-25T16:00:00.000Z",
      "2026-09-25T20:00:00.000Z",
      "2026-09-27T20:00:00.000Z",
      "2026-09-28T00:00:00.000Z",
    ]);
    // 31 bars a week now (30 before)
    const week = s.filter((x) => x >= "2026-09-20T21:00:00.000Z" && x < "2026-09-27T21:00:00.000Z");
    expect(week).toHaveLength(31);
    // the same bars with no length: the open stamp alone, as before
    const old = usableBars(got!, 0, now).map((q) => new Date(barOpenMs(q.datetime)).toISOString());
    expect(old).not.toContain("2026-09-27T20:00:00.000Z");
  });

  it("the chart: on Sunday night the bar forming is GMO's Sunday 20:00, closing at Monday 00:00; after it, it is the newest closed bar", async () => {
    const night = at("2026-09-27T23:00:00Z");
    const q1 = await fetchLiveQuotes("USD/JPY", "4h", night, night + 20_000, gmo(night));
    expect(q1).not.toBeNull();
    const r1 = liveRead("USD/JPY", "4h", q1!, night);
    expect(r1.forming_open).toBe("2026-09-27T20:00:00.000Z");
    expect(r1.next_close).toBe("2026-09-28T00:00:00.000Z");
    const monday = at("2026-09-28T00:30:00Z");
    const q2 = await fetchLiveQuotes("USD/JPY", "4h", monday, monday + 20_000, gmo(monday));
    const r2 = liveRead("USD/JPY", "4h", q2!, monday);
    expect(barOpenMs(r2.now.datetime!)).toBe(at("2026-09-27T20:00:00Z"));
    expect(r2.forming_open).toBe("2026-09-28T00:00:00.000Z");
    expect(r2.next_close).toBe("2026-09-28T04:00:00.000Z");
  });

  it("the e-mails: at Monday 00:00 the Sunday 20:00 bar has just closed, so the 4-hour charts are judged", () => {
    expect(hourCloseOf(at("2026-09-27T20:00:00Z"), "4h", at("2026-09-28T00:00:01Z"))).toBe("closed");
    expect(hourCloseOf(at("2026-09-27T20:00:00Z"), "4h", at("2026-09-28T00:06:00Z"))).toBe("closed");
    // on Sunday night it is still forming: nothing closed at 22:00 or 23:00
    expect(hourCloseOf(at("2026-09-25T20:00:00Z"), "4h", at("2026-09-27T22:00:01Z"))).toBe("unknown");
  });
});

describe("#182 pinned at the source", () => {
  const quotes = readFileSync("supabase/functions/track-outcomes/quotes.ts", "utf8");
  const marketHours = readFileSync("supabase/functions/_shared/market-hours.ts", "utf8");
  it("usableBars asks barInsideClosure of the bar's length", () => {
    expect(quotes).toContain("return !barInsideClosure(t, intervalMs);");
    expect(quotes).not.toContain("_intervalMs");
  });
  it("barInsideClosure tests both ends on the narrow predicate, without the Sunday pre-open band", () => {
    const body = marketHours.slice(marketHours.indexOf("export const barInsideClosure"));
    expect(body).toContain("return isMarketClosed(openMs) && isMarketClosed(openMs + intervalMs - 1);");
    expect(body.slice(0, body.indexOf("};"))).not.toContain("SUNDAY_PREOPEN_UTC_HOUR");
  });
});
