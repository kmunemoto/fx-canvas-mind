import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isPossiblyClosed, nextOpen } from "../../supabase/functions/_shared/market-hours.ts";
import { byTimeframe, causeCounts, isPreview, tally } from "../lib/outcomeStats";
import type { AnalysisRecord } from "../lib/types";

const analyze = readFileSync("supabase/functions/analyze/index.ts", "utf8");
const indexPage = readFileSync("src/pages/Index.tsx", "utf8");

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
