import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { render as rtlRender, screen } from "@testing-library/react";
import { LocaleProvider } from "../lib/i18n";
import ConfidenceCalibration from "../components/ConfidenceCalibration";
import {
  AUC_CHANCE,
  aucEstablishesNothing,
  calibrationRoom,
  readConfidenceCalibration,
} from "../lib/outcomeStats";

const MIGRATION = "supabase/migrations/20260911040000_measure_whether_confidence_can_be_calibrated.sql";
const sql = readFileSync(MIGRATION, "utf8");

// This file has no JSX on purpose — createElement keeps the panel test in the
// same .ts file as the reader it is testing, so the payload fixture below is
// not duplicated into a second file where the two can drift apart.
const render = (calibration: unknown, locale: "ja" | "en" = "ja") =>
  rtlRender(
    createElement(LocaleProvider, {
      initial: locale,
      children: createElement(ConfidenceCalibration, {
        calibration: calibration as never,
      }) as ReactElement,
    }),
  );

// The answer public.confidence_calibration('market_v1') actually returned from
// production on 2026-09-11, copied verbatim. A hand-written fixture always
// gets the parts that matter wrong: snake_case keys, ci95 as a two-element
// array, an AUC on a 0..1 scale where every other rate here is a percentage,
// and the fact that the traded span is SIX distinct values wide.
const live = {
  contract: "market_v1",
  span: {
    all: { n: 80, lo: 42, hi: 70, width: 28, distinct_values: 11 },
    traded: { n: 38, lo: 62, hi: 70, width: 8, distinct_values: 6 },
    wait: { n: 42, lo: 42, hi: 63, width: 21, distinct_values: 6 },
  },
  by_value: [
    { confidence: 62, settled: 1, wins: 1, losses: 0, win_rate: 100, ci95: [21, 100] },
    { confidence: 63, settled: 9, wins: 5, losses: 4, win_rate: 56, ci95: [27, 81] },
    { confidence: 64, settled: 8, wins: 5, losses: 3, win_rate: 63, ci95: [31, 86] },
    { confidence: 66, settled: 11, wins: 5, losses: 6, win_rate: 45, ci95: [21, 72] },
    { confidence: 68, settled: 7, wins: 5, losses: 2, win_rate: 71, ci95: [36, 92] },
    { confidence: 70, settled: 1, wins: 0, losses: 1, win_rate: 0, ci95: [0, 79] },
  ],
  by_band: [
    { band_lo: 60, band_hi: 64, settled: 18, wins: 11, losses: 7, win_rate: 61, ci95: [39, 80], below_min_n: true },
    { band_lo: 65, band_hi: 69, settled: 18, wins: 10, losses: 8, win_rate: 56, ci95: [34, 75], below_min_n: true },
    { band_lo: 70, band_hi: 74, settled: 1, wins: 0, losses: 1, win_rate: 0, ci95: [0, 79], below_min_n: true },
  ],
  discrimination: {
    n_win: 21, n_loss: 16, total_pairs: 336, concordant: 120, ties: 75, discordant: 141,
    auc: 0.469, ci95: [0.278, 0.659], ci95_approximate: true, tie_share: 22,
  },
  gate: {
    applies: false, min_n_per_band: 20, need_bands: 3, have_bands: 0,
    need_settled: 60, have_settled: 37, met: false, preregistered: false,
  },
};

describe("the calibration migration measures and applies nothing", () => {
  it("writes no row anywhere: it is a read, not a correction", () => {
    // #68's title is "correct confidence against the record". The first step
    // is measuring whether a correction can be DEFINED, and a measurement that
    // can write is not a measurement.
    expect(sql).toContain("create or replace function public.confidence_calibration(live_contract text default 'market_v1')");
    // STABLE is the property Postgres itself enforces: a stable function
    // cannot write. Asserting it is worth more than any keyword grep.
    expect(sql).toMatch(/language sql\s+stable/);
    // The keyword sweep is scoped to the function BODY. Run over the whole
    // file it also reads the Japanese header comment, so it would pass or
    // fail on prose rather than on code.
    const body = sql.slice(sql.indexOf("as $function$"), sql.lastIndexOf("$function$"));
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/\bupdate\b/i);
    expect(body).not.toMatch(/\binsert\b/i);
    expect(body).not.toMatch(/\bdelete\b/i);
  });

  it("hard-codes 'no correction is applied' and 'this is not a preregistration'", () => {
    // Both are facts about the instrument rather than about the data, so they
    // are in the payload — a caveat that lives only in a doc is a caveat
    // nobody reads.
    expect(sql).toContain("'applies', false");
    expect(sql).toContain("'preregistered', false");
    // The interval is a Hanley-McNeil normal approximation and says so.
    expect(sql).toContain("'ci95_approximate', true");
  });

  it("is SECURITY INVOKER and authenticated-only, like the panels beside it", () => {
    // public.analyses has RLS, and that RLS is the only thing scoping this
    // function to one account. DEFINER would pool two accounts into one
    // owner's calibration curve.
    expect(sql).toContain("security invoker");
    expect(sql).not.toMatch(/^\s*security definer/m);
    expect(sql).toContain("set search_path to 'public', 'pg_temp'");
    expect(sql).toContain("revoke all on function public.confidence_calibration(text) from public;");
    expect(sql).toContain("revoke all on function public.confidence_calibration(text) from anon;");
    expect(sql).toContain("grant execute on function public.confidence_calibration(text) to authenticated;");
  });

  it("reuses wilson95 rather than deriving a second interval for the win rates", () => {
    expect(sql).toContain("public.wilson95(");
  });
});

describe("readConfidenceCalibration", () => {
  it("reads production's real answer, span and all", () => {
    const c = readConfidenceCalibration(live);
    expect(c).not.toBeNull();
    // THE FINDING: 38 traded plans, six distinct values, eight points wide —
    // on a gauge drawn over 0..100.
    expect(c!.span.traded).toEqual({ n: 38, lo: 62, hi: 70, width: 8, distinctValues: 6 });
    expect(c!.span.all.n).toBe(80);
    expect(c!.span.wait.lo).toBe(42);
    expect(c!.contract).toBe("market_v1");
  });

  it("keeps every stated value apart instead of banding them", () => {
    const c = readConfidenceCalibration(live)!;
    expect(c.byValue).toHaveLength(6);
    expect(c.byValue.map((r) => r.confidence)).toEqual([62, 63, 64, 66, 68, 70]);
    // The n=1 row survives as an n=1 row, with its own interval spanning
    // nearly the whole range.
    expect(c.byValue[0]).toEqual({
      confidence: 62, settled: 1, wins: 1, losses: 0, winRate: 100, ci: [21, 100],
    });
    expect(c.byBand).toHaveLength(3);
    expect(c.byBand.every((b) => b.belowMinN)).toBe(true);
  });

  it("carries the discrimination number on its own 0..1 scale, unrounded", () => {
    const d = readConfidenceCalibration(live)!.discrimination;
    // 0.469, NOT rounded to 0 the way a percentage is rounded to an integer.
    expect(d.auc).toBe(0.469);
    expect(d.ci).toEqual([0.278, 0.659]);
    expect(d.tieShare).toBe(22);
    expect(d.nWin).toBe(21);
    expect(d.nLoss).toBe(16);
    expect(d.totalPairs).toBe(336);
    expect(d.ciApproximate).toBe(true);
  });

  it("reads the gate as it is: nothing applied, nothing met, nothing preregistered", () => {
    const g = readConfidenceCalibration(live)!.gate;
    expect(g.applies).toBe(false);
    expect(g.met).toBe(false);
    // The threshold was chosen after the numbers were seen. This must never
    // read as true from a payload that simply did not say.
    expect(g.preregistered).toBe(false);
    expect(g.minNPerBand).toBe(20);
    expect(g.needBands).toBe(3);
    expect(g.haveBands).toBe(0);
    expect(g.needSettled).toBe(60);
    expect(g.haveSettled).toBe(37);
  });

  it("answers null only when the payload is not an object", () => {
    for (const bad of [null, undefined, "error", 42, true, [], [live]]) {
      expect(readConfidenceCalibration(bad)).toBeNull();
    }
    // An object it cannot understand is still an object: it reads as "nothing
    // could be read", which the panel can draw, rather than as a null the
    // caller would have to distinguish from an RPC failure.
    expect(readConfidenceCalibration({ message: "function does not exist" })).not.toBeNull();
  });

  it("reads an empty payload as nulls and empty lists, never as zeroes", () => {
    const c = readConfidenceCalibration({})!;
    // "No span was reported" and "the span is zero wide" are different
    // findings. A width of 0 would claim the model says the same number every
    // single time, which is a measurement nobody took.
    expect(c.span.traded).toEqual({ n: null, lo: null, hi: null, width: null, distinctValues: null });
    expect(c.span.all.n).toBeNull();
    expect(c.byValue).toEqual([]);
    expect(c.byBand).toEqual([]);
    expect(c.discrimination.auc).toBeNull();
    expect(c.discrimination.ci).toBeNull();
    expect(c.discrimination.nWin).toBeNull();
    expect(c.gate.minNPerBand).toBeNull();
    expect(c.contract).toBeNull();
  });

  it("defaults every flag to the answer that claims less", () => {
    const g = readConfidenceCalibration({})!.gate;
    expect(g.applies).toBe(false);
    expect(g.met).toBe(false);
    expect(g.preregistered).toBe(false);
    // An interval with no word about how it was derived is treated as the
    // approximation it is, not as an exact one.
    expect(readConfidenceCalibration({})!.discrimination.ciApproximate).toBe(true);
  });

  it("tolerates every field being the wrong type", () => {
    const junk = {
      contract: 7,
      span: "wide",
      by_value: { "62": 1 },
      by_band: "none",
      discrimination: [1, 2, 3],
      gate: null,
    };
    const c = readConfidenceCalibration(junk)!;
    expect(c.contract).toBeNull();
    expect(c.span.traded.lo).toBeNull();
    expect(c.byValue).toEqual([]);
    expect(c.byBand).toEqual([]);
    expect(c.discrimination.auc).toBeNull();
    expect(c.gate.preregistered).toBe(false);
  });

  it("refuses strings and NaN where numbers belong, and does not call them zero", () => {
    const c = readConfidenceCalibration({
      span: { traded: { n: "38", lo: null, hi: NaN, width: "8", distinct_values: undefined } },
      by_value: [{ confidence: "62", settled: "1", wins: null, losses: "0", win_rate: "100", ci95: ["21", 100] }],
      by_band: [{ band_lo: "60", settled: "18" }],
      discrimination: { auc: "0.469", ci95: [0.278], tie_share: Infinity, n_win: "21" },
      gate: { applies: "false", met: "true", preregistered: "true", min_n_per_band: "20" },
    })!;
    expect(c.span.traded.n).toBeNull();
    expect(c.span.traded.hi).toBeNull();
    expect(c.span.traded.width).toBeNull();
    expect(c.byValue[0].settled).toBeNull();
    expect(c.byValue[0].winRate).toBeNull();
    // A two-element interval where one end is a string is not an interval.
    expect(c.byValue[0].ci).toBeNull();
    expect(c.discrimination.auc).toBeNull();
    expect(c.discrimination.ci).toBeNull();
    expect(c.discrimination.tieShare).toBeNull();
    // "true" is not true. A gate that claims to be met, or preregistered,
    // from a string is the one failure this whole instrument exists to avoid.
    expect(c.gate.met).toBe(false);
    expect(c.gate.preregistered).toBe(false);
    expect(c.gate.minNPerBand).toBeNull();
  });

  it("keeps a real zero as a zero", () => {
    const c = readConfidenceCalibration({
      span: { traded: { n: 0, lo: null, hi: null, width: null, distinct_values: 0 } },
      by_value: [{ confidence: 70, settled: 1, wins: 0, losses: 1, win_rate: 0, ci95: [0, 79] }],
      gate: { have_bands: 0, have_settled: 0 },
    })!;
    // 0% over one settled trade is a finding; no rate at all is the absence of
    // one. They must not share a rendering, and they do not share a value.
    expect(c.byValue[0].winRate).toBe(0);
    expect(c.byValue[0].ci).toEqual([0, 79]);
    expect(c.span.traded.n).toBe(0);
    expect(c.span.traded.distinctValues).toBe(0);
    expect(c.gate.haveBands).toBe(0);
  });

  it("applies the thin-band floor itself when the server never sent the flag", () => {
    const c = readConfidenceCalibration({
      by_band: [{ band_lo: 60, band_hi: 64, settled: 18 }, { band_lo: 65, band_hi: 69, settled: 40 }],
      gate: { min_n_per_band: 20 },
    })!;
    expect(c.byBand[0].belowMinN).toBe(true);
    expect(c.byBand[1].belowMinN).toBe(false);
    // A band whose n cannot be read is treated as thin, which is the cautious
    // direction.
    const unreadable = readConfidenceCalibration({ by_band: [{ band_lo: 60 }] })!;
    expect(unreadable.byBand[0].belowMinN).toBe(true);
  });

  it("never throws, whatever it is handed", () => {
    const nasty: unknown[] = [
      {}, { span: {} }, { by_value: [null, 1, "x", {}] }, { by_band: [undefined] },
      { discrimination: { ci95: [] } }, { gate: { applies: null } },
      { span: { traded: [] }, by_value: [[]] },
    ];
    for (const v of nasty) expect(() => readConfidenceCalibration(v)).not.toThrow();
  });
});

describe("what the AUC is allowed to claim", () => {
  it("says nothing is established while the interval contains 0.5", () => {
    const d = readConfidenceCalibration(live)!.discrimination;
    expect(AUC_CHANCE).toBe(0.5);
    // 0.469 with [0.278, 0.659]. The measured value is BELOW chance and that
    // is still not evidence of anything — the interval covers both sides.
    expect(d.auc).toBeLessThan(AUC_CHANCE);
    expect(aucEstablishesNothing(d)).toBe(true);
  });

  it("only lets go of that once the interval clears 0.5", () => {
    const ranked = readConfidenceCalibration({
      discrimination: { auc: 0.72, ci95: [0.61, 0.83], ci95_approximate: true },
    })!.discrimination;
    expect(aucEstablishesNothing(ranked)).toBe(false);
  });

  it("treats a missing measurement as 'nothing established', never as a clean result", () => {
    expect(aucEstablishesNothing(null)).toBe(true);
    expect(aucEstablishesNothing(readConfidenceCalibration({})!.discrimination)).toBe(true);
    // An AUC with no interval establishes nothing either.
    const noCi = readConfidenceCalibration({ discrimination: { auc: 0.9 } })!.discrimination;
    expect(aucEstablishesNothing(noCi)).toBe(true);
  });

  it("measures the room a correction would have from the span itself", () => {
    const c = readConfidenceCalibration(live)!;
    expect(calibrationRoom(c.span.traded)).toBe(8);
    // Derived from the bounds when the server sent no width...
    expect(calibrationRoom(readConfidenceCalibration({ span: { traded: { lo: 62, hi: 70 } } })!.span.traded)).toBe(8);
    // ...and null, not 0, when there is nothing to measure.
    expect(calibrationRoom(readConfidenceCalibration({})!.span.traded)).toBeNull();
  });
});

describe("the confidence-calibration panel", () => {
  const c = readConfidenceCalibration(live);

  it("draws nothing at all when the RPC did not answer", () => {
    const { container } = render(null);
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("confidence-calibration")).toBeNull();
  });

  // 1. THE RANGE.
  it("says first that the system has only ever said 62 to 70 on a plan it traded", () => {
    render(c);
    const traded = screen.getByTestId("calibration-traded");
    expect(traded).toHaveTextContent("62");
    expect(traded).toHaveTextContent("70");
    expect(traded).toHaveTextContent("38");
    // Six distinct values, eight points wide.
    expect(traded).toHaveTextContent("6");
    expect(traded).toHaveTextContent("8");
    // And the scale the gauge implies, which the record has never used.
    expect(screen.getByTestId("calibration-gauge-note")).toHaveTextContent("100");
  });

  it("takes those numbers from the payload rather than from a sentence", () => {
    // The same panel on a different span must say different numbers. A
    // hardcoded "62 to 70" survives the day the model starts saying 40.
    render(readConfidenceCalibration({
      ...live,
      span: { ...live.span, traded: { n: 400, lo: 12, hi: 96, width: 84, distinct_values: 55 } },
    }));
    const traded = screen.getByTestId("calibration-traded");
    expect(traded).toHaveTextContent("12");
    expect(traded).toHaveTextContent("96");
    expect(traded).toHaveTextContent("400");
    expect(traded).not.toHaveTextContent("62");
  });

  // 2. THE PER-VALUE TABLE.
  it("gives every stated value its own row, its own n and its own interval", () => {
    render(c);
    for (const v of [62, 63, 64, 66, 68, 70]) {
      expect(screen.getByTestId(`calibration-value-${v}`)).toBeInTheDocument();
    }
    const row63 = screen.getByTestId("calibration-value-63");
    expect(screen.getByTestId("calibration-value-63-n")).toHaveTextContent("9");
    expect(screen.getByTestId("calibration-value-63-rate")).toHaveTextContent("56%");
    expect(row63).toHaveTextContent("27");
    expect(row63).toHaveTextContent("81");
  });

  it("makes a row of one settled trade look like a row of one", () => {
    render(c);
    // 100% over a single trade. The n is beside the rate, inside the rate,
    // and said again in words on the row.
    expect(screen.getByTestId("calibration-value-62-n")).toHaveTextContent("1");
    expect(screen.getByTestId("calibration-value-62-rate")).toHaveTextContent("1/1");
    expect(screen.getByTestId("calibration-value-62-thin")).toHaveTextContent("1");
    // ...and the 0% row too: one loss is not a 0% win rate anyone can use.
    expect(screen.getByTestId("calibration-value-70-rate")).toHaveTextContent("0/1");
    expect(screen.getByTestId("calibration-value-70-thin")).toBeInTheDocument();
  });

  // 3. DISCRIMINATION.
  it("says what the discrimination number means, in a sentence, with its interval", () => {
    render(c);
    expect(screen.getByTestId("calibration-disc-meaning")).toHaveTextContent("0.469");
    // The definition, not just the number: 0.5 is "does not rank outcomes".
    expect(screen.getByTestId("calibration-disc-meaning")).toHaveTextContent("0.5");
    const ci = screen.getByTestId("calibration-disc-ci");
    expect(ci).toHaveTextContent("0.278");
    expect(ci).toHaveTextContent("0.659");
    // The tie share, because 22% ties is why the approximation is coarse.
    expect(ci).toHaveTextContent("22");
    expect(screen.getByTestId("calibration-disc-pairs")).toHaveTextContent("336");
  });

  it("carries that the interval is approximate and that nothing is established", () => {
    render(c);
    expect(screen.getByTestId("calibration-disc-approximate")).toHaveTextContent("Hanley-McNeil");
    const nothing = screen.getByTestId("calibration-disc-nothing");
    expect(nothing).toHaveTextContent("0.5");
    // The reading a number below 0.5 invites, refused in the same sentence
    // that reports it.
    expect(nothing).toHaveTextContent("証拠ではありません");
    expect(screen.queryByTestId("calibration-disc-established")).toBeNull();
  });

  it("stops saying 'nothing is established' when the interval finally clears 0.5", () => {
    render(readConfidenceCalibration({
      ...live,
      discrimination: { ...live.discrimination, auc: 0.74, ci95: [0.62, 0.86] },
    }));
    expect(screen.queryByTestId("calibration-disc-nothing")).toBeNull();
    // ...but never stops saying the interval is an approximation.
    expect(screen.getByTestId("calibration-disc-approximate")).toBeInTheDocument();
  });

  // 4. THE GATE.
  it("says what is required, what is here, and that no correction is applied", () => {
    render(c);
    expect(screen.getByTestId("calibration-gate-applies")).toBeInTheDocument();
    const need = screen.getByTestId("calibration-gate-need");
    expect(need).toHaveTextContent("3");
    expect(need).toHaveTextContent("20");
    expect(need).toHaveTextContent("60");
    const have = screen.getByTestId("calibration-gate-have");
    expect(have).toHaveTextContent("0");
    expect(have).toHaveTextContent("37");
    expect(screen.getByTestId("calibration-gate-met")).toBeInTheDocument();
  });

  it("says the threshold was written after the data was seen", () => {
    render(c);
    const note = screen.getByTestId("calibration-gate-preregistration");
    expect(note).toHaveTextContent("事前登録ではありません");
    // And never files it beside the real one.
    expect(note).toHaveTextContent("NOISE_FLOOR_PREREGISTRATION");
  });

  it("puts the four in order: range, values, discrimination, gate", () => {
    render(c);
    const panel = screen.getByTestId("confidence-calibration");
    const order = Array.from(panel.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid"));
    const at = (id: string) => order.indexOf(id);
    // The range comes before any percentage a reader could otherwise believe.
    expect(at("calibration-range")).toBeLessThan(at("calibration-values"));
    expect(at("calibration-values")).toBeLessThan(at("calibration-discrimination"));
    expect(at("calibration-discrimination")).toBeLessThan(at("calibration-gate"));
  });

  it("renders an empty record without crashing and without inventing a rate", () => {
    const empty = readConfidenceCalibration({
      contract: "market_v1",
      span: {
        all: { n: 0, lo: null, hi: null, width: null, distinct_values: 0 },
        traded: { n: 0, lo: null, hi: null, width: null, distinct_values: 0 },
        wait: { n: 0, lo: null, hi: null, width: null, distinct_values: 0 },
      },
      by_value: [],
      by_band: [],
      discrimination: {
        n_win: 0, n_loss: 0, total_pairs: 0, concordant: 0, ties: 0, discordant: 0,
        auc: null, ci95: null, ci95_approximate: true, tie_share: null,
      },
      gate: { applies: false, min_n_per_band: 20, need_bands: 3, have_bands: 0, need_settled: 60, have_settled: 0, met: false, preregistered: false },
    });
    render(empty);
    expect(screen.getByTestId("calibration-no-values")).toBeInTheDocument();
    expect(screen.getByTestId("calibration-disc-none")).toBeInTheDocument();
    expect(screen.getByTestId("calibration-traded")).toBeInTheDocument();
    // No rate anywhere: an empty record must not put a percentage on screen.
    expect(screen.queryByTestId("calibration-value-62")).toBeNull();
    // The gate is still stated, which is the point of an empty record.
    expect(screen.getByTestId("calibration-gate-preregistration")).toBeInTheDocument();
  });

  it("renders a malformed payload without crashing", () => {
    // Everything absent or the wrong type. The panel draws placeholders, not
    // zeroes, and does not throw on the way.
    expect(() => render(readConfidenceCalibration({ span: "wide", gate: 3, discrimination: null }))).not.toThrow();
    expect(screen.getByTestId("calibration-traded")).toBeInTheDocument();
    expect(screen.getByTestId("calibration-gate-preregistration")).toBeInTheDocument();
  });

  it("renders in English with the same four sections and no Japanese left in it", () => {
    render(c, "en");
    const panel = screen.getByTestId("confidence-calibration");
    expect(screen.getByTestId("calibration-traded")).toHaveTextContent("only ever said 62 to 70");
    expect(screen.getByTestId("calibration-disc-meaning")).toHaveTextContent("does not rank outcomes at all");
    expect(screen.getByTestId("calibration-disc-nothing")).toHaveTextContent("NOT evidence that confidence works in reverse");
    expect(screen.getByTestId("calibration-gate-applies")).toHaveTextContent("No correction is applied");
    expect(screen.getByTestId("calibration-gate-preregistration")).toHaveTextContent("not a preregistration");
    expect(panel.textContent ?? "").not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });

  // ------------------------------------------------------------------
  // Verdicts must be derived from the payload, never asserted as constants.
  // A sentence that is true today and printed unconditionally becomes a lie
  // the day the data moves — the #83 failure, twice over.
  // ------------------------------------------------------------------

  it("says there is no mapping to fit only while the span is too narrow for the gate", () => {
    // Live: 8 points wide against a gate asking for 3 bands x 5 = 15.
    render(c);
    expect(screen.getByTestId("calibration-room")).toHaveTextContent("8");
    expect(screen.getByTestId("calibration-room-narrow")).toBeInTheDocument();
  });

  it("stops saying it the moment the span is wide enough, on the same panel", () => {
    render(readConfidenceCalibration({
      ...live,
      span: { ...live.span, traded: { n: 400, lo: 12, hi: 96, width: 84, distinct_values: 55 } },
    }));
    // The width is still reported — that is a fact, not a verdict.
    expect(screen.getByTestId("calibration-room")).toHaveTextContent("84");
    // The verdict is gone.
    expect(screen.queryByTestId("calibration-room-narrow")).toBeNull();
  });

  it("never says 'the interval contains 0.5' when no interval was read", () => {
    render(readConfidenceCalibration({
      ...live,
      discrimination: { ...live.discrimination, ci95: null },
    }));
    expect(screen.queryByTestId("calibration-disc-nothing")).toBeNull();
    expect(screen.queryByTestId("calibration-disc-established")).toBeNull();
    const none = screen.getByTestId("calibration-disc-no-interval");
    // Nothing is established either way — but the panel does not describe the
    // shape of a measurement it does not have.
    expect(none).not.toHaveTextContent("0.5");
  });

  it("withholds a win rate whose denominator could not be read", () => {
    render(readConfidenceCalibration({
      ...live,
      by_value: [{ confidence: 66, settled: null, wins: null, losses: null, win_rate: 63, ci95: null }],
    }));
    // 63% with no n beside it is the single reading this panel exists to
    // prevent, so the rate is withheld rather than printed bare.
    expect(screen.getByTestId("calibration-value-66-rate")).not.toHaveTextContent("63");
  });

  it("keeps the thin-row warning when the payload carries no gate at all", () => {
    const { gate: _dropped, ...noGate } = live;
    render(readConfidenceCalibration(noGate));
    // Falls back to the shared floor. A missing gate must not silently delete
    // every warning on a table of one- and seven-trade rows.
    expect(screen.getByTestId("calibration-value-63-thin")).toBeInTheDocument();
  });

  it("agrees in English when exactly one band qualifies", () => {
    render(readConfidenceCalibration({
      ...live,
      gate: { ...live.gate, have_bands: 1 },
    }), "en");
    const have = screen.getByTestId("calibration-gate-have");
    expect(have).toHaveTextContent("1 band qualifies");
    expect(have.textContent ?? "").not.toContain("band qualify");
  });
});
