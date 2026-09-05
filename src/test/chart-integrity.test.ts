import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  cloudAt,
  cloudSide,
  coherentBar,
  computeSnapshot,
  ichimoku,
  parseCandles,
  seriesHealth,
  type Candle,
} from "../../supabase/functions/analyze/indicators.ts";

const analyzeSrc = readFileSync("supabase/functions/analyze/index.ts", "utf8");

const bar = (datetime: string, open: number, high: number, low: number, close: number) =>
  ({ datetime, open, high, low, close });

describe("a price that cannot be true is not data", () => {
  it("refuses a null OHLC field instead of pricing it at zero", () => {
    // Number(null) is 0 and 0 is finite, so a missing field used to arrive as
    // a price of zero and every indicator was computed on it.
    expect(parseCandles([{ datetime: "2026-09-01 00:00:00", open: 155.1, high: 155.4, low: null, close: 155.2 }]))
      .toEqual([]);
    // the same hole in the realistic shape: one field of a real-looking bar
    const withHole = parseCandles([
      { datetime: "2026-09-01 01:00:00", open: "155.10", high: "155.40", low: "155.00", close: "155.20" },
      { datetime: "2026-09-01 00:00:00", open: 155.1, high: 155.4, low: null, close: 155.2 },
    ]);
    expect(withHole).toHaveLength(1);
    expect(withHole[0].datetime).toBe("2026-09-01 01:00:00");
  });

  it("refuses the other things Number() reads as a price", () => {
    for (const low of ["", "   ", [], true, false, 0, -1] as unknown[]) {
      expect(parseCandles([{ datetime: "t", open: 1, high: 2, low, close: 1.5 }])).toEqual([]);
    }
  });

  it("refuses a bar whose high is under its own low", () => {
    expect(coherentBar(bar("t", 155, 100, 200, 156))).toBe(false);
    expect(parseCandles([{ datetime: "t", open: 155, high: 100, low: 200, close: 156 }])).toEqual([]);
    // and one whose high does not contain its own close
    expect(coherentBar(bar("t", 155, 155.5, 154.5, 156))).toBe(false);
  });

  it("sorts by time and keeps one bar per timestamp", () => {
    const out = parseCandles([
      { datetime: "2026-09-01 02:00:00", open: 3, high: 3, low: 3, close: 3 },
      { datetime: "2026-09-01 00:00:00", open: 1, high: 1, low: 1, close: 1 },
      { datetime: "2026-09-01 01:00:00", open: 2, high: 2, low: 2, close: 2 },
      { datetime: "2026-09-01 01:00:00", open: 9, high: 9, low: 9, close: 9 },
    ]);
    expect(out.map((c) => c.datetime)).toEqual([
      "2026-09-01 00:00:00", "2026-09-01 01:00:00", "2026-09-01 02:00:00",
    ]);
    // newest-first on the wire, so the first row for a timestamp is the freshest
    expect(out[1].close).toBe(2);
  });

  it("reports a series that is too short, too holed or too old", () => {
    const now = Date.parse("2026-09-01T06:00:00Z");
    const hour = 60 * 60 * 1000;
    const fresh: Candle[] = Array.from({ length: 60 }, (_, i) =>
      bar(new Date(now - (59 - i) * hour).toISOString().slice(0, 19).replace("T", " "), 155, 155.5, 154.5, 155.2));
    expect(seriesHealth(fresh, 60, 60, hour, now).ok).toBe(true);
    expect(seriesHealth(fresh.slice(0, 30), 30, 60, hour, now).issues[0]).toMatch(/too_few_bars/);
    expect(seriesHealth(fresh, 100, 60, hour, now).issues.some((i) => i.startsWith("dropped"))).toBe(true);
    expect(seriesHealth(fresh, 60, 60, hour, now + 10 * hour).issues.some((i) => i.startsWith("stale"))).toBe(true);
  });
});

describe("the cloud at the price and the cloud drawn ahead are two clouds", () => {
  // Ichimoku plots the spans 26 bars forward, so the cloud standing at the
  // newest bar is the pair computed 26 bars earlier — not the pair this
  // window computes, which is what used to be handed over as 先行A/先行B.
  const series: Candle[] = [];
  for (let i = 0; i < 140; i++) {
    const price = i < 114 ? 149 : i < 130 ? 149 + (i - 113) * 0.3 : 154 - (i - 129) * 0.38;
    series.push(bar(`2026-08-${String((i % 28) + 1).padStart(2, "0")} 00:00:00`, price, price + 0.2, price - 0.2, price));
  }

  it("puts the current cloud 26 bars behind the projected one", () => {
    const projected = ichimoku(series);
    const standing = cloudAt(series, series.length - 1);
    expect(projected).not.toBeNull();
    expect(standing).not.toBeNull();
    // different windows, so different numbers
    expect(standing!.spanB).not.toBeCloseTo(projected!.spanB, 6);
    // and the standing cloud is exactly what the window ending 26 bars back projects
    const back = ichimoku(series.slice(0, series.length - 26));
    expect(standing!.spanA).toBeCloseTo(back!.spanA, 10);
    expect(standing!.spanB).toBeCloseTo(back!.spanB, 10);
  });

  it("says which side of the standing cloud the price is on", () => {
    const cloud = { top: 152, bottom: 150, spanA: 152, spanB: 150 };
    expect(cloudSide(153, cloud)).toBe("above");
    expect(cloudSide(151, cloud)).toBe("inside");
    expect(cloudSide(149, cloud)).toBe("below");
  });

  it("carries both clouds on the snapshot, named apart", () => {
    const snap = computeSnapshot(series);
    expect(snap).not.toBeNull();
    expect(snap!.cloudNow).not.toBeNull();
    expect(snap!.cloudAhead).not.toBeNull();
    expect(snap!.cloudSide).toMatch(/above|inside|below/);
    // spanA/spanB stay the projected pair, so nothing that read them changes meaning
    expect(snap!.spanA).toBeCloseTo(snap!.cloudAhead!.spanA, 10);
  });
});

describe("a forming bar is not a closed one", () => {
  const hour = 60 * 60 * 1000;
  const open = Date.parse("2026-09-01T10:00:00Z");
  const series: Candle[] = Array.from({ length: 60 }, (_, i) =>
    bar(new Date(open - (59 - i) * hour).toISOString().slice(0, 19).replace("T", " "), 155, 155.4, 154.6, 155));

  it("knows whether the newest bar had closed", () => {
    expect(computeSnapshot(series, hour, open + 20 * 60 * 1000)!.barClosed).toBe(false);
    expect(computeSnapshot(series, hour, open + hour + 1)!.barClosed).toBe(true);
    // without a clock it says nothing rather than guessing
    expect(computeSnapshot(series)!.barClosed).toBeNull();
  });

  it("gives the model the closed-bar reading alongside the live one", () => {
    expect(analyzeSrc).toContain("closedSnapshots");
    expect(analyzeSrc).toContain("[確定足のみ(形成中の足を除く)]");
    expect(analyzeSrc).toContain("この足はまだ形成中");
  });
});

describe("the analyst's own rules are enforced by the server", () => {
  it("refuses a plan the model itself rated below the stated floor", () => {
    expect(analyzeSrc).toContain("const MIN_CONFIDENCE = 60;");
    expect(analyzeSrc).toContain("const lowConfidence = normalizedAnalysis.confidence < MIN_CONFIDENCE;");
    // routed through the existing refusal, so it becomes a WAIT row that the
    // wait scorer grades and the credit is handed back
    expect(analyzeSrc).toContain('? "low_confidence"');
    expect(analyzeSrc).toContain("if (marketShut || lowConfidence || (!entryVerdict.ok && entryVerdict.rejection))");
  });

  it("drops a target that points the wrong way instead of showing it as profit", () => {
    expect(analyzeSrc).toContain("ladderDropped");
    expect(analyzeSrc).toContain("tp_ladder_dropped: ladderDropped");
    expect(analyzeSrc).toContain("const beyondEntry = (rung.value - marketEntry) * dir > 0;");
    expect(analyzeSrc).toContain("const beyondPrevious = bound === null || (rung.value - bound) * dir > 0;");
  });

  it("fetches enough bars for the higher timeframes to have an SMA200", () => {
    expect(analyzeSrc).toContain("const HIGHER_BARS = 250;");
    expect(analyzeSrc).toContain("i === 0 ? ENTRY_BARS : HIGHER_BARS");
    // and says so when it still cannot be computed
    expect(analyzeSrc).toContain("算出不能(足${s.barsUsed}本、200本必要)");
  });

  it("stops on market data it cannot believe", () => {
    expect(analyzeSrc).toContain('error_stage: "market_data_unhealthy"');
    expect(analyzeSrc).toContain("if (!health[0].ok)");
  });
});
