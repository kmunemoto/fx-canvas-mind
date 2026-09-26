import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { render as rtlRender, screen, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import {
  isGoldBreak,
  isPossiblyClosed,
  isPossiblyClosedFor,
  lastClose,
  lastCloseFor,
  nextOpen,
  nextOpenFor,
  nyOffsetMs,
} from "../../supabase/functions/_shared/market-hours";
import { formatDistance, pipSize, priceDecimals } from "../lib/candleTime";
import { lossPer10k } from "../lib/costs";
import ReviewFacts from "../components/ReviewFacts";
import type { ReviewMechanical } from "../lib/types";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);
const t = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString();

describe("#128 gold's market hours (market-hours.ts, *For)", () => {
  it("knows New York's summer and winter time", () => {
    expect(nyOffsetMs(t("2026-09-24T12:00:00Z"))).toBe(-4 * 3_600_000);
    expect(nyOffsetMs(t("2026-01-14T12:00:00Z"))).toBe(-5 * 3_600_000);
    // the switches: 2026-03-08 07:00Z and 2026-11-01 06:00Z
    expect(nyOffsetMs(t("2026-03-08T06:59:00Z"))).toBe(-5 * 3_600_000);
    expect(nyOffsetMs(t("2026-03-08T07:00:00Z"))).toBe(-4 * 3_600_000);
    expect(nyOffsetMs(t("2026-11-01T05:59:00Z"))).toBe(-4 * 3_600_000);
    expect(nyOffsetMs(t("2026-11-01T06:00:00Z"))).toBe(-5 * 3_600_000);
  });

  it("shuts gold for its hour at 17:00 New York (21:00Z in summer, 22:00Z in winter), and no currency pair", () => {
    expect(isGoldBreak(t("2026-09-24T20:59:00Z"))).toBe(false);
    expect(isGoldBreak(t("2026-09-24T21:00:00Z"))).toBe(true);
    expect(isGoldBreak(t("2026-09-24T21:59:00Z"))).toBe(true);
    expect(isGoldBreak(t("2026-09-24T22:00:00Z"))).toBe(false);
    expect(isGoldBreak(t("2026-01-14T22:30:00Z"))).toBe(true);
    expect(isGoldBreak(t("2026-01-14T21:30:00Z"))).toBe(false);
    expect(isPossiblyClosedFor("XAU/USD", t("2026-09-24T21:30:00Z"))).toBe(true);
    expect(isPossiblyClosedFor("USD/JPY", t("2026-09-24T21:30:00Z"))).toBe(false);
  });

  it("is exactly the FX predicates for every currency pair, hour by hour over a year", () => {
    const start = t("2026-01-01T00:00:00Z");
    for (let h = 0; h < 366 * 24; h += 1) {
      const ms = start + h * 3_600_000 + 17 * 60_000;
      for (const pair of ["USD/JPY", "EUR/USD", "AUD/JPY"]) {
        if (isPossiblyClosedFor(pair, ms) !== isPossiblyClosed(ms)) throw new Error(`${pair} ${iso(ms)}`);
        if (isPossiblyClosed(ms) && lastCloseFor(pair, ms) !== lastClose(ms)) throw new Error(`last ${pair} ${iso(ms)}`);
        if (isPossiblyClosed(ms) && nextOpenFor(pair, ms) !== nextOpen(ms)) throw new Error(`next ${pair} ${iso(ms)}`);
      }
      // gold is shut whenever FX is, and more
      if (isPossiblyClosed(ms) && !isPossiblyClosedFor("XAU/USD", ms)) throw new Error(`gold ${iso(ms)}`);
    }
  });

  it("reopens gold at the end of its hour — and on a winter Sunday, an hour after FX", () => {
    expect(iso(nextOpenFor("XAU/USD", t("2026-09-24T21:10:00Z")))).toBe("2026-09-24T22:00:00.000Z");
    expect(iso(nextOpenFor("XAU/USD", t("2026-09-26T16:00:00Z")))).toBe("2026-09-27T22:00:00.000Z");
    // winter: FX's wide open is Sunday 22:00Z, gold's 23:00Z (18:00 New York)
    expect(iso(nextOpen(t("2026-01-17T12:00:00Z")))).toBe("2026-01-18T22:00:00.000Z");
    expect(iso(nextOpenFor("XAU/USD", t("2026-01-17T12:00:00Z")))).toBe("2026-01-18T23:00:00.000Z");
    expect(isPossiblyClosedFor("XAU/USD", t("2026-01-18T22:30:00Z"))).toBe(true);
    expect(isPossiblyClosedFor("XAU/USD", t("2026-01-18T23:05:00Z"))).toBe(false);
  });

  it("measures a series against the start of gold's hour while it lasts", () => {
    expect(iso(lastCloseFor("XAU/USD", t("2026-09-24T21:40:00Z")))).toBe("2026-09-24T21:00:00.000Z");
    expect(iso(lastCloseFor("XAU/USD", t("2026-01-14T22:40:00Z")))).toBe("2026-01-14T22:00:00.000Z");
    // the weekend is the weekend's close
    expect(lastCloseFor("XAU/USD", t("2026-09-26T16:00:00Z"))).toBe(lastClose(t("2026-09-26T16:00:00Z")));
  });
});

describe("#128 gold in the analysis", () => {
  const analyze = readFileSync("supabase/functions/analyze/index.ts", "utf8");
  const review = readFileSync("supabase/functions/analyze/review.ts", "utf8");
  const structure = readFileSync("supabase/functions/analyze/structure.ts", "utf8");

  it("is an allowed pair, priced to the cent, its distances in dollars", () => {
    expect(analyze).toMatch(/const ALLOWED_PAIRS = new Set\(\[[\s\S]*?"XAU\/USD",[\s\S]*?\]\);/);
    expect(analyze).toContain('const pairDecimals = (pair: string) => (isGoldPair(pair) ? 2 :');
    expect(analyze).toContain("const pipSize = decimals === 2 ? 1 : decimals === 3 ? 0.01 : 0.0001;");
    expect(review).toContain("const pipFor = (decimals: number): number => (decimals === 2 ? 1 :");
    expect(structure).toContain("decimals === 2 ? `${v.toFixed(2)}ドル`");
  });

  it("is not refused at GMO's costly FX hours, which were never measured on gold", () => {
    expect(analyze).toContain('(proposedSignal === "BUY" || proposedSignal === "SELL") && !isGoldPair(currencyPair) &&');
  });

  it("formats gold in dollars on screen, and currency pairs as before", () => {
    expect(priceDecimals("XAU/USD")).toBe(2);
    expect(pipSize("XAU/USD")).toBe(0.01);
    expect(formatDistance("XAU/USD", 12.345)).toBe("$12.35");
    expect(formatDistance("XAU/USD", -3.2, { signed: true })).toBe("−$3.20");
    expect(formatDistance("USD/JPY", 0.123, { signed: true, digits: 1 })).toBe("+12.3pips");
    expect(formatDistance("EUR/USD", -0.00123, { signed: true, digits: 1 })).toBe("−12.3pips");
    // not sized per 10,000 units
    expect(lossPer10k("XAU/USD", 4280, 4270)).toBeNull();
    expect(lossPer10k("EUR/USD", 1.1, 1.099)).toEqual({ amount: expect.closeTo(10, 6), currency: "USD" });
  });

  it("shows a position review's distances for gold in dollars", () => {
    const facts = {
      subject: "held", feed: "twelvedata", feed_delta_atr: null, price: 4285.2, priced_at: "2026-09-25T10:00:00Z",
      direction: "BUY", entry: 4280, stop: 4270, tp1: 4300, risk: 10,
      move_pips: 5.2, move_r: 0.52, to_stop_pips: 15.2, to_tp1_pips: -14.8,
      anchor_at: null, anchor_source: null, covers_anchor: false, bars_examined: 0, as_of: null,
      stop_touch: { measured: false, reason: "no_anchor" }, tp1_touch: { measured: false, reason: "no_anchor" },
    } as unknown as ReviewMechanical;
    render(<ReviewFacts facts={facts} pair="XAU/USD" />);
    expect(document.body.textContent).toContain("+$5.20");
    expect(document.body.textContent).toContain("+$15.20");
    expect(document.body.textContent).not.toContain("pips");
    expect(screen.getAllByText(/\$/).length).toBeGreaterThan(0);
  });
});
