import { describe, it, expect } from "vitest";
import {
  BLACKOUT_MS,
  affectsPair,
  blackoutAt,
  currenciesOf,
  eventInBar,
  eventId,
  parseEvents,
  renderEventBlock,
  upcomingFor,
  type EconEvent,
} from "../../supabase/functions/econ-calendar/events.ts";

// Rows exactly as the live Forex Factory feed returned them on 2026-09-03:
// an Eastern offset on `date`, empty strings rather than nulls, no `actual`
const FEED = [
  { title: "G20 Meetings", country: "All", date: "2026-08-30T11:15:00-04:00", impact: "Low", forecast: "", previous: "" },
  { title: "Retail Sales y/y", country: "JPY", date: "2026-08-30T19:50:00-04:00", impact: "Low", forecast: "3.2%", previous: "0.5%" },
  { title: "ISM Manufacturing PMI", country: "USD", date: "2026-09-01T10:00:00-04:00", impact: "High", forecast: "55.2", previous: "55.6" },
  { title: "Non-Farm Employment Change", country: "USD", date: "2026-09-04T08:30:00-04:00", impact: "High", forecast: "55K", previous: "-23K" },
  { title: "Unemployment Rate", country: "USD", date: "2026-09-04T08:30:00-04:00", impact: "High", forecast: "4.1%", previous: "4.1%" },
  { title: "Bank Holiday", country: "CHF", date: "2026-09-04T00:00:00-04:00", impact: "Holiday", forecast: "", previous: "" },
  { title: "German Prelim CPI m/m", country: "EUR", date: "2026-09-02T08:00:00-04:00", impact: "Medium", forecast: "0.1%", previous: "0.3%" },
];

const NFP = "2026-09-04T12:30:00.000Z";
const NOW = Date.parse("2026-09-03T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("reading the feed", () => {
  it("parses the live shape, converting the Eastern offset to UTC", () => {
    const events = parseEvents(FEED);
    expect(events).toHaveLength(7);
    const nfp = events.find((e) => e.title === "Non-Farm Employment Change");
    expect(nfp).toMatchObject({
      event_at: NFP, country: "USD", impact: "High", forecast: "55K", previous: "-23K", all_day: false,
    });
    // empty strings become null, not ""
    expect(events.find((e) => e.title === "G20 Meetings")?.forecast).toBeNull();
    // sorted by time
    expect(events[0].title).toBe("G20 Meetings");
  });

  it("marks holidays and midnight-stamped items as all-day, and keeps real releases timed", () => {
    const events = parseEvents(FEED);
    expect(events.find((e) => e.title === "Bank Holiday")?.all_day).toBe(true);
    // 08:30 Eastern is 12:30 UTC — a timed release, not an all-day item
    expect(events.find((e) => e.title === "Non-Farm Employment Change")?.all_day).toBe(false);
  });

  it("gives the same event the same id across refetches and drops duplicates", () => {
    const once = parseEvents(FEED);
    const twice = parseEvents([...FEED, FEED[3]]);
    expect(twice).toHaveLength(once.length);
    expect(eventId("USD", NFP, "Non-Farm Employment Change"))
      .toBe(once.find((e) => e.title === "Non-Farm Employment Change")?.id);
  });

  it("survives an error body or malformed rows", () => {
    expect(parseEvents(null)).toEqual([]);
    expect(parseEvents({ error: "rate limited" })).toEqual([]);
    expect(parseEvents([{ title: "x" }, null, { title: "y", country: "USD", date: "not a date" }])).toEqual([]);
  });
});

describe("which events a pair is exposed to", () => {
  it("splits the pair and treats 'All' as everyone's business", () => {
    expect(currenciesOf("USD/JPY")).toEqual(["USD", "JPY"]);
    expect(currenciesOf("USD_JPY")).toEqual(["USD", "JPY"]);
    expect(affectsPair({ country: "JPY" }, "USD/JPY")).toBe(true);
    expect(affectsPair({ country: "All" }, "USD/JPY")).toBe(true);
    expect(affectsPair({ country: "EUR" }, "USD/JPY")).toBe(false);
  });

  it("looks ahead only as far as the timeframe's horizon, and only at what matters", () => {
    const events = parseEvents(FEED);
    // 12 hours from Thursday noon does not reach Friday's NFP
    expect(upcomingFor(events, "USD/JPY", NOW, 12 * HOUR).map((e) => e.title)).toEqual([]);
    // two days does
    const soon = upcomingFor(events, "USD/JPY", NOW, 48 * HOUR);
    expect(soon.map((e) => e.title)).toEqual(["Non-Farm Employment Change", "Unemployment Rate"]);
    // the euro release is filtered out by pair, the holiday by impact
    expect(upcomingFor(events, "EUR/USD", NOW, 48 * HOUR).map((e) => e.country)).toEqual(["USD", "USD"]);
  });
});

describe("the prompt block", () => {
  it("names the event, the consensus and how far off it is", () => {
    const events = upcomingFor(parseEvents(FEED), "USD/JPY", NOW, 48 * HOUR);
    const block = renderEventBlock(events, NOW, "ja");
    expect(block).toContain("今後の重要イベント");
    expect(block).toContain("2026-09-04 12:30 USD High — Non-Farm Employment Change");
    expect(block).toContain("予想 55K, 前回 -23K");
    expect(block).toContain("[24.5h]");
    const en = renderEventBlock(events, NOW, "en");
    expect(en).toContain("Scheduled events ahead");
    expect(en).toContain("forecast 55K, prev -23K");
    expect(en).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });

  it("says nothing when nothing is scheduled", () => {
    expect(renderEventBlock([], NOW)).toBe("");
  });
});

describe("blocking an entry around a release", () => {
  const events = parseEvents(FEED);

  it("refuses a fill inside the window and allows one outside it", () => {
    const nfp = Date.parse(NFP);
    expect(blackoutAt(events, "USD/JPY", nfp)?.title).toBe("Non-Farm Employment Change");
    expect(blackoutAt(events, "USD/JPY", nfp - BLACKOUT_MS + MIN)?.title).toBe("Non-Farm Employment Change");
    expect(blackoutAt(events, "USD/JPY", nfp + BLACKOUT_MS + MIN)).toBeNull();
    // a euro release does not block a dollar-yen plan
    expect(blackoutAt(events, "USD/JPY", Date.parse("2026-09-02T12:00:00Z"))).toBeNull();
    // and a medium-impact one does not block at all
    expect(blackoutAt(events, "EUR/USD", Date.parse("2026-09-02T12:00:00Z"))).toBeNull();
  });
});

describe("attributing a bar to a release", () => {
  const events = parseEvents(FEED);

  it("names the highest-impact event released inside the bar", () => {
    const open = Date.parse("2026-09-04T12:30:00Z");
    const found = eventInBar(events, "USD/JPY", open, open + 15 * MIN);
    // NFP and Unemployment Rate print together; both are High, the first wins
    expect(found?.impact).toBe("High");
    expect(["Non-Farm Employment Change", "Unemployment Rate"]).toContain(found?.title);
  });

  it("catches a print that landed just before the bar opened", () => {
    const open = Date.parse("2026-09-04T12:32:00Z");
    expect(eventInBar(events, "USD/JPY", open, open + 15 * MIN)?.impact).toBe("High");
  });

  it("finds nothing in a quiet bar", () => {
    const open = Date.parse("2026-09-03T03:00:00Z");
    expect(eventInBar(events, "USD/JPY", open, open + 15 * MIN)).toBeNull();
  });

  it("treats an all-day item as covering its session", () => {
    const chf: EconEvent[] = parseEvents(FEED).filter((e) => e.country === "CHF");
    const open = Date.parse("2026-09-04T10:00:00Z");
    expect(eventInBar(chf, "CHF/JPY", open, open + HOUR)?.title).toBe("Bank Holiday");
  });
});
