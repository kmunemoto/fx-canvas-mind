import { describe, expect, it } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import ModelMixPanel from "../components/ModelMix";
import { readModelMix, settledModels } from "../lib/outcomeStats";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja") =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const panel = (raw: unknown, locale: "ja" | "en" = "ja") =>
  render(<ModelMixPanel mix={readModelMix(raw)} />, locale);

// Every model identifier in this file is DATA: the string a server put in a
// column, copied into a fixture so the reader can be tested against the shape
// the record really has. None of them is a choice this code makes.

// public.model_mix('market_v1') as production answered it on 2026-09-11,
// copied verbatim. The single-analyst case, which is today's whole record: one
// model, nothing pooled, nothing unrecorded.
const live = {
  contract: "market_v1",
  calls: 80,
  models: [
    {
      model: "claude-opus-5",
      calls: 80,
      traded: 38,
      settled: 37,
      first_at: "2026-09-07T01:07:25.690121+00:00",
      last_at: "2026-09-11T02:07:57.042232+00:00",
    },
  ],
  pooled: false,
  models_with_settled: 1,
  unrecorded: 0,
  unrecorded_settled: 0,
};

// Production has no such row today, which is exactly why it is constructed
// here: the pooled branch is the reason the panel exists, and a branch with no
// fixture is a branch nobody has ever seen drawn.
const pooled = {
  contract: "market_v1",
  calls: 131,
  models: [
    {
      model: "claude-opus-5",
      calls: 80,
      traded: 38,
      settled: 37,
      first_at: "2026-09-07T01:07:25.690121+00:00",
      last_at: "2026-09-11T02:07:57.042232+00:00",
    },
    {
      model: "claude-sonnet-4-5",
      calls: 51,
      traded: 24,
      settled: 19,
      first_at: "2026-09-11T03:00:00.000000+00:00",
      last_at: "2026-09-18T09:12:00.000000+00:00",
    },
  ],
  pooled: true,
  models_with_settled: 2,
  unrecorded: 0,
  unrecorded_settled: 0,
};

// The 21 rows that predate the column, as they would look inside the visible
// contract. They are not in market_v1 in production — they are constructed for
// the same reason the pooled fixture is.
const unrecorded = {
  contract: "market_v1",
  calls: 105,
  models: [
    {
      model: "claude-opus-5",
      calls: 84,
      traded: 40,
      settled: 39,
      first_at: "2026-09-05T00:00:00.000000+00:00",
      last_at: "2026-09-11T02:07:57.042232+00:00",
    },
  ],
  pooled: false,
  models_with_settled: 1,
  unrecorded: 21,
  unrecorded_settled: 4,
};

// Both at once, which is the case where a mistake is easiest to make: an
// unrecorded bucket sitting in a list of named analysts reads as one more
// analyst.
const both = { ...pooled, calls: 152, unrecorded: 21, unrecorded_settled: 4 };

describe("readModelMix", () => {
  it("reads production's real answer, contract and all", () => {
    const m = readModelMix(live);
    expect(m).not.toBeNull();
    expect(m!.contract).toBe("market_v1");
    expect(m!.calls).toBe(80);
    expect(m!.models).toHaveLength(1);
    expect(m!.models[0]).toEqual({
      model: "claude-opus-5",
      calls: 80,
      traded: 38,
      settled: 37,
      firstAt: "2026-09-07T01:07:25.690121+00:00",
      lastAt: "2026-09-11T02:07:57.042232+00:00",
    });
    // The three facts the panel branches on.
    expect(m!.pooled).toBe(false);
    expect(m!.modelsWithSettled).toBe(1);
    expect(m!.unrecorded).toBe(0);
    expect(m!.unrecordedSettled).toBe(0);
  });

  it("reads a pooled record as pooled, with both models kept apart", () => {
    const m = readModelMix(pooled)!;
    expect(m.pooled).toBe(true);
    expect(m.modelsWithSettled).toBe(2);
    // Ordered by the settled split, which is what the pooled line is about.
    expect(m.models.map((e) => e.model)).toEqual(["claude-opus-5", "claude-sonnet-4-5"]);
    expect(m.models.map((e) => e.settled)).toEqual([37, 19]);
    expect(settledModels(m)).toHaveLength(2);
  });

  it("calls a record pooled from the split itself when the flag never said so", () => {
    // A server that sent the models and forgot the flag must not produce a
    // record that reads as one analyst's. The warning is derived from the two
    // settled counts, which is the evidence the flag was summarising.
    const m = readModelMix({ ...pooled, pooled: false, models_with_settled: null })!;
    expect(m.pooled).toBe(true);
  });

  it("does not invent a blend out of models that have settled nothing", () => {
    // Called and never settled is not a second track record: nothing of the
    // win rate is that model's yet.
    const m = readModelMix({
      ...pooled,
      pooled: false,
      models: [
        { model: "claude-opus-5", calls: 80, traded: 38, settled: 37 },
        { model: "claude-sonnet-4-5", calls: 3, traded: 0, settled: 0 },
      ],
    })!;
    expect(m.pooled).toBe(false);
    expect(settledModels(m).map((e) => e.model)).toEqual(["claude-opus-5"]);
  });

  it("keeps the unrecorded count out of the model list entirely", () => {
    const m = readModelMix(unrecorded)!;
    expect(m.unrecorded).toBe(21);
    expect(m.unrecordedSettled).toBe(4);
    // The bucket is not a model and never becomes one.
    expect(m.models).toHaveLength(1);
    expect(m.models.map((e) => e.model)).toEqual(["claude-opus-5"]);
    expect(m.models.some((e) => e.settled === 21 || e.calls === 21)).toBe(false);
    // And it does not make the record a blend: 21 rows of "not recorded" are
    // an absence, not a second analyst.
    expect(m.pooled).toBe(false);
  });

  it("answers null only when the payload is not an object", () => {
    for (const bad of [null, undefined, "error", 42, true, [], [live]]) {
      expect(readModelMix(bad)).toBeNull();
    }
    // An object it cannot understand is still an object: it reads as "nothing
    // could be read", which the panel can draw, rather than as a null the
    // caller would have to tell apart from an RPC failure.
    expect(readModelMix({ message: "function does not exist" })).not.toBeNull();
  });

  it("reads an empty payload as nulls and an empty list, never as zeroes", () => {
    const m = readModelMix({})!;
    // "No models were reported" and "no model has settled anything" are
    // different findings. A 0 here would be the second one asserted from the
    // first.
    expect(m.calls).toBeNull();
    expect(m.models).toEqual([]);
    expect(m.modelsWithSettled).toBeNull();
    expect(m.unrecorded).toBeNull();
    expect(m.unrecordedSettled).toBeNull();
    expect(m.contract).toBeNull();
    // The claim that costs least: not pooled, because nothing shows a blend.
    expect(m.pooled).toBe(false);
  });

  it("tolerates every field being the wrong type", () => {
    const m = readModelMix({
      contract: 7,
      calls: "80",
      models: { "claude-opus-5": 80 },
      pooled: "true",
      models_with_settled: "1",
      unrecorded: [],
      unrecorded_settled: {},
    })!;
    expect(m.contract).toBeNull();
    expect(m.calls).toBeNull();
    expect(m.models).toEqual([]);
    // "true" is not true. A blend claimed from a string would be as wrong as
    // a blend hidden.
    expect(m.pooled).toBe(false);
    expect(m.modelsWithSettled).toBeNull();
    expect(m.unrecorded).toBeNull();
    expect(m.unrecordedSettled).toBeNull();
  });

  it("refuses strings and NaN where counts belong, and does not call them zero", () => {
    const m = readModelMix({
      calls: NaN,
      models: [
        { model: "claude-opus-5", calls: "80", traded: NaN, settled: undefined, first_at: 1, last_at: null },
      ],
      unrecorded: "21",
    })!;
    expect(m.calls).toBeNull();
    expect(m.models[0].calls).toBeNull();
    expect(m.models[0].traded).toBeNull();
    // Unreadable is not settled-nothing: a model whose settled count could not
    // be read has not been shown to have written nothing.
    expect(m.models[0].settled).toBeNull();
    expect(m.models[0].firstAt).toBeNull();
    expect(m.models[0].lastAt).toBeNull();
    expect(m.unrecorded).toBeNull();
    expect(settledModels(m)).toEqual([]);
  });

  it("drops an entry with no readable identifier rather than naming it", () => {
    const m = readModelMix({
      models: [
        { model: "claude-opus-5", calls: 80, settled: 37 },
        { model: null, calls: 21, settled: 4 },
        { model: "", calls: 3, settled: 1 },
        { calls: 9, settled: 2 },
        "claude-opus-5",
        null,
      ],
    })!;
    // A nameless row drawn beside the named ones is read as one more analyst,
    // or worse, as the usual one.
    expect(m.models.map((e) => e.model)).toEqual(["claude-opus-5"]);
  });

  it("keeps a real zero as a zero", () => {
    const m = readModelMix({
      calls: 0,
      models: [{ model: "claude-opus-5", calls: 3, traded: 0, settled: 0 }],
      unrecorded: 0,
      unrecorded_settled: 0,
      models_with_settled: 0,
    })!;
    expect(m.calls).toBe(0);
    expect(m.models[0].settled).toBe(0);
    expect(m.unrecorded).toBe(0);
    expect(m.modelsWithSettled).toBe(0);
  });

  it("never throws, whatever it is handed", () => {
    const nasty: unknown[] = [
      {}, { models: null }, { models: [null, 1, "x", {}, []] }, { models: [{ model: {} }] },
      { pooled: {} }, { unrecorded: Infinity }, { calls: -1, models: [{ model: "x", settled: -3 }] },
    ];
    for (const v of nasty) expect(() => readModelMix(v)).not.toThrow();
  });
});

describe("the model-mix panel", () => {
  it("draws nothing at all when the RPC did not answer", () => {
    const { container } = render(<ModelMixPanel mix={null} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("model-mix")).toBeNull();
  });

  // 1. THE ORDINARY CASE: one analyst, nothing missing.
  it("states in one line which model wrote the record, and over how many settled trades", () => {
    panel(live);
    const line = screen.getByTestId("model-mix-single");
    expect(line).toHaveTextContent("claude-opus-5");
    expect(line).toHaveTextContent("37");
    // Information, not an alarm: no blend warning and no missing-rows note.
    expect(screen.queryByTestId("model-mix-pooled")).toBeNull();
    expect(screen.queryByTestId("model-mix-unrecorded")).toBeNull();
    expect(line.className).not.toContain("text-warning");
    // One line is the whole statement — no table repeating the same fact.
    expect(screen.queryByTestId("model-mix-models")).toBeNull();
    expect(screen.getByTestId("model-mix-scope")).toHaveTextContent("80");
  });

  // 2. THE CASE THE PANEL EXISTS FOR.
  it("says plainly that a pooled record is a blend, and shows the split", () => {
    panel(pooled);
    const warn = screen.getByTestId("model-mix-pooled");
    // Two analysts, said prominently and in the warning colour.
    expect(warn).toHaveTextContent("2");
    expect(warn.className).toContain("text-warning");
    // Never readable as one analyst's record.
    expect(screen.queryByTestId("model-mix-single")).toBeNull();
    // The split itself, so the reader can see who contributed what.
    expect(screen.getByTestId("model-mix-row-claude-opus-5-n")).toHaveTextContent("37");
    expect(screen.getByTestId("model-mix-row-claude-sonnet-4-5-n")).toHaveTextContent("19");
  });

  it("warns of the blend even when the payload's own flag missed it", () => {
    panel({ ...pooled, pooled: false, models_with_settled: null });
    expect(screen.getByTestId("model-mix-pooled")).toBeInTheDocument();
    expect(screen.queryByTestId("model-mix-single")).toBeNull();
  });

  // 3. ROWS NOBODY STAMPED.
  it("reports unrecorded rows as missing, not as a default model", () => {
    panel(unrecorded, "en");
    const note = screen.getByTestId("model-mix-unrecorded");
    expect(note).toHaveTextContent("21");
    expect(note).toHaveTextContent("no model recorded");
    // The one sentence this note exists for.
    expect(note).toHaveTextContent("not that a default model was used");
    // The settled share of them, because those rows are inside the win rate.
    expect(note).toHaveTextContent("4");
    // It must never borrow a name from the model that IS recorded.
    expect(note.textContent ?? "").not.toContain("claude-opus-5");
    // The record is NOT one analyst's: 4 of the settled trades in the win
    // rate's denominator have no recorded author. The exclusive line must be
    // withdrawn, and the hedged one must name both numbers.
    expect(screen.queryByTestId("model-mix-single")).toBeNull();
    const line = screen.getByTestId("model-mix-single-gap");
    expect(line).toHaveTextContent("claude-opus-5");
    expect(line).toHaveTextContent("4");
    expect(line.textContent ?? "").not.toContain("alone");
    expect(line.textContent ?? "").not.toContain("21");
  });

  it("never says 「単独で」 in Japanese either when settled trades are unattributed", () => {
    panel(unrecorded, "ja");
    const line = screen.getByTestId("model-mix-single-gap");
    expect(line.textContent ?? "").not.toContain("単独");
    expect(line).toHaveTextContent("4");
  });

  it("never renders the unrecorded count as a model", () => {
    panel(both);
    const rows = Array.from(document.querySelectorAll("[data-testid^='model-mix-row-']"))
      .map((e) => e.getAttribute("data-testid") ?? "")
      .filter((id) => !id.endsWith("-n"));
    // Exactly the models the payload named, and nothing else. A row for the
    // unrecorded bucket would be an analyst nobody ever ran.
    expect(rows).toEqual(["model-mix-row-claude-opus-5", "model-mix-row-claude-sonnet-4-5"]);
    expect(screen.queryByTestId("model-mix-row-21")).toBeNull();
    // The blend is counted over the named models only — 21 unrecorded rows do
    // not make a third analyst.
    expect(screen.getByTestId("model-mix-pooled")).toHaveTextContent("2");
    expect(screen.getByTestId("model-mix-unrecorded")).toHaveTextContent("21");
  });

  // 4. NOTHING TO REPORT YET.
  it("handles a record with no calls at all without crashing", () => {
    panel({ contract: "market_v1", calls: 0, models: [], pooled: false, models_with_settled: 0, unrecorded: 0, unrecorded_settled: 0 });
    expect(screen.getByTestId("model-mix")).toBeInTheDocument();
    expect(screen.getByTestId("model-mix-none")).toBeInTheDocument();
    // No win rate has been written, so no analyst is named.
    expect(screen.queryByTestId("model-mix-single")).toBeNull();
    expect(screen.queryByTestId("model-mix-pooled")).toBeNull();
    expect(screen.queryByTestId("model-mix-scope")).toBeNull();
  });

  it("names nobody when calls exist but nothing has settled", () => {
    panel({ contract: "market_v1", calls: 4, models: [{ model: "claude-opus-5", calls: 4, traded: 0, settled: 0 }], pooled: false, models_with_settled: 0, unrecorded: 0, unrecorded_settled: 0 });
    expect(screen.getByTestId("model-mix-none")).toBeInTheDocument();
    expect(screen.queryByTestId("model-mix-single")).toBeNull();
    expect(screen.getByTestId("model-mix-scope")).toHaveTextContent("4");
  });

  it("says a payload it could not read was unreadable, not that nothing settled", () => {
    // Every field here is the wrong type, so the normalizer reads nothing out
    // of it. "No trade has settled yet" would be a positive claim about the
    // record manufactured from a payload that said nothing — the same error as
    // guessing a model for a row whose model is NULL.
    expect(() => panel({ contract: 7, models: "none", pooled: "true", unrecorded: "21" })).not.toThrow();
    expect(screen.getByTestId("model-mix")).toBeInTheDocument();
    expect(screen.getByTestId("model-mix-unreadable")).toBeInTheDocument();
    expect(screen.queryByTestId("model-mix-none")).toBeNull();
    expect(screen.queryByTestId("model-mix-single")).toBeNull();
    // An unreadable count is not 21 rows of anything.
    expect(screen.queryByTestId("model-mix-unrecorded")).toBeNull();
  });

  it("keeps 'nothing settled yet' for a payload that really says so", () => {
    // The distinction the test above turns on: this payload IS readable and
    // genuinely reports zero, and must still read as zero.
    panel({ contract: "market_v1", calls: 4, models: [], pooled: false, models_with_settled: 0, unrecorded: 0, unrecorded_settled: 0 });
    expect(screen.getByTestId("model-mix-none")).toBeInTheDocument();
    expect(screen.queryByTestId("model-mix-unreadable")).toBeNull();
  });

  // 5. THE BRANCHES WITH NO PRODUCTION DATA BEHIND THEM.
  it("does not promise a split it cannot draw", () => {
    // The server said the record is a blend but itemised nothing. Promising
    // "the split is below" over an empty space is a broken promise the reader
    // cannot check.
    panel({ contract: "market_v1", calls: 40, models: [], pooled: true, models_with_settled: 2, unrecorded: 0, unrecorded_settled: 0 }, "en");
    expect(screen.getByTestId("model-mix-pooled")).toBeInTheDocument();
    expect(screen.queryByTestId("model-mix-models")).toBeNull();
    expect(screen.getByTestId("model-mix-pooled-note")).toHaveTextContent("not reported");
  });

  it("warns about unattributed settled trades even when the row count is unreadable", () => {
    // The settled count is the one inside the win rate. Losing the row count
    // must not take the whole warning off the screen with it.
    panel({ contract: "market_v1", calls: 40, models: [{ model: "claude-opus-5", calls: 40, traded: 20, settled: 18 }], pooled: false, models_with_settled: 1, unrecorded: "?", unrecorded_settled: 3 }, "en");
    const note = screen.getByTestId("model-mix-unrecorded");
    expect(note).toHaveTextContent("3");
    expect(note).toHaveTextContent("not that a default model was used");
    // And the headline is hedged, because 3 settled trades are unattributed.
    expect(screen.queryByTestId("model-mix-single")).toBeNull();
    expect(screen.getByTestId("model-mix-single-gap")).toBeInTheDocument();
  });

  it("pins the no-default sentence in Japanese, the default locale", () => {
    panel(unrecorded, "ja");
    expect(screen.getByTestId("model-mix-unrecorded")).toHaveTextContent(
      "既定のモデルが使われたという意味ではありません",
    );
  });

  it("renders two entries carrying the same identifier without duplicate keys", () => {
    // Only reachable through a server bug, but a duplicate React key silently
    // drops a row, and a dropped row is a missing analyst.
    panel({ contract: "market_v1", calls: 40, models: [
      { model: "claude-opus-5", calls: 20, traded: 10, settled: 9 },
      { model: "claude-opus-5", calls: 20, traded: 10, settled: 8 },
    ], pooled: true, models_with_settled: 2, unrecorded: 0, unrecorded_settled: 0 });
    expect(document.querySelectorAll("[data-testid='model-mix-row-claude-opus-5']").length).toBe(2);
  });

  it("draws a model whose call count could not be read, without inventing one", () => {
    panel({ contract: "market_v1", models: [
      { model: "claude-opus-5", calls: null, settled: 37 },
      { model: "claude-sonnet-4-5", calls: null, settled: 19 },
    ] });
    const n = screen.getByTestId("model-mix-row-claude-opus-5-n");
    expect(n).toHaveTextContent("37");
    expect(n.textContent ?? "").not.toContain("0");
  });

  it("renders in English with nothing Japanese left in it", () => {
    panel(pooled, "en");
    const p = screen.getByTestId("model-mix");
    expect(screen.getByTestId("model-mix-pooled")).toHaveTextContent("blend of 2 different models");
    expect(p.textContent ?? "").not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });

  it("renders in Japanese by default and still names the model verbatim", () => {
    panel(live);
    // The identifier is data and is never translated or prettified.
    expect(screen.getByTestId("model-mix-single")).toHaveTextContent("claude-opus-5");
    expect(screen.getByTestId("model-mix")).toHaveTextContent("market_v1");
  });
});
