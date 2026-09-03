import { describe, it, expect } from "vitest";
import { formatCandleLabel, formatJst, parseUtcCandleTime, pipSize, priceDecimals, toPips } from "../lib/candleTime";

describe("candle time (UTC in, JST out)", () => {
  it("parses provider timestamps as UTC", () => {
    expect(parseUtcCandleTime("2026-09-03 04:49:03")).toBe(Date.parse("2026-09-03T04:49:03Z"));
    expect(parseUtcCandleTime("2026-09-03")).toBe(Date.parse("2026-09-03T00:00:00Z"));
    expect(parseUtcCandleTime("2026-09-03T04:49:03.408Z")).toBe(Date.parse("2026-09-03T04:49:03.408Z"));
    expect(Number.isNaN(parseUtcCandleTime(""))).toBe(true);
  });

  it("formats in Japan Standard Time for both locales", () => {
    expect(formatJst("2026-09-03T04:49:03Z", "ja-JP")).toBe("09/03 13:49");
    expect(formatJst("2026-09-03T04:49:03Z", "en-US")).toBe("09/03, 13:49");
    expect(formatJst("2026-09-03 04:49:03.408921+00", "ja-JP")).toBe("09/03 13:49");
  });

  it("writes midnight as 00:00, never 24:00", () => {
    expect(formatJst("2026-09-02T15:00:00Z", "ja-JP")).toBe("09/03 00:00");
    expect(formatJst("2026-09-02T15:00:00Z", "en-US")).toBe("09/03, 00:00");
  });

  it("labels daily bars by date and intraday bars by JST time", () => {
    expect(formatCandleLabel("2026-08-25", "ja-JP")).toBe("08/25");
    expect(formatCandleLabel("2026-09-03 07:15:00", "ja-JP")).toBe("09/03 16:15");
    expect(formatCandleLabel("2026-09-03T07:15:00.000Z", "en-US")).toBe("09/03, 16:15");
  });

  it("falls back to the raw text for an unparseable stamp", () => {
    expect(formatCandleLabel("not-a-date", "ja-JP")).toBe("not-a-date".slice(5, 16));
  });

  it("sizes pips and decimals by quote currency", () => {
    expect(pipSize("USD/JPY")).toBe(0.01);
    expect(pipSize("EUR/USD")).toBe(0.0001);
    expect(toPips("USD/JPY", 0.55)).toBeCloseTo(55, 6);
    expect(toPips("EUR/USD", 0.0021)).toBeCloseTo(21, 6);
    expect(priceDecimals("GBP/JPY")).toBe(3);
    expect(priceDecimals("AUD/USD")).toBe(5);
  });
});
