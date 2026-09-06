import { describe, expect, it } from "vitest";
import {
  AXES,
  type ContextLike,
  contextFromStored,
  footprintOf,
  hasReading,
  matchAxis,
  MIN_COMPARABLE_AXES,
  situationFor,
  UNCOMPARED,
  WIDE_FACTOR,
} from "../../supabase/functions/analyze/situation.ts";
import {
  orderRules,
  promptCharBudget,
  type Rule,
  selectPromptRules,
} from "../../supabase/functions/analyze/rules.ts";

// Snapshots lifted verbatim from production rows — the plans the live rulebook
// actually cites. Written in the stored shape on purpose: this is what a
// footprint is measured from, so a test that invented its own shape would
// agree with itself and with nothing else.
const stored = (
  entry: Record<string, number | null>,
  htfAdx: number | null = null,
): ContextLike => contextFromStored({
  entry: { tf: "1h", ...entry },
  higher: [{ tf: "4h", adx: htfAdx }],
});

// r11 — "if you enter a trend this stretched, put TP1 near one ATR". Three
// cited plans, all 1h sells into the same band-walk, and the readings are
// tight enough to describe one situation.
const R11 = [
  stored({ price: 155.682, sma20: 157.769, atr: 0.411, adx: 68.7, rsi: 8.6, bb_upper: 159.905, bb_lower: 155.633 }, 39),
  stored({ price: 155.626, sma20: 157.599, atr: 0.417, adx: 70.3, rsi: 10.8, bb_upper: 159.887, bb_lower: 155.311 }, 42.3),
  stored({ price: 155.687, sma20: 157.602, atr: 0.417, adx: 70.3, rsi: 12.7, bb_upper: 159.88, bb_lower: 155.324 }, 42.3),
];

// r10 — "when ADX is extreme (above 60), RSI around 10, price more than three
// ATR from SMA20 and outside the band, do not chase the trend". Five cited
// plans: four with a reading, and one written before the snapshot existed.
const R10 = [
  stored({ price: 155.596, sma20: 159.175, atr: 0.999, adx: 39, rsi: 25.8, bb_upper: 161.099, bb_lower: 157.252 }, 19.3),
  stored({ price: 155.533, sma20: 157.761, atr: 0.421, adx: 68.7, rsi: 8.2, bb_upper: 159.927, bb_lower: 155.595 }, 39),
  stored({ price: 155.426, sma20: 157.084, atr: 0.396, adx: 74.4, rsi: 8, bb_upper: 159.574, bb_lower: 154.595 }, 42.3),
  stored({ price: 155.412, sma20: 156.915, atr: 0.385, adx: 75.4, rsi: 10.4, bb_upper: 159.398, bb_lower: 154.431 }, 45.3),
];

// The most recent production analysis: a daily sell, stretched but nothing
// like the 1h band-walks above.
const TODAY = stored(
  { price: 156.357, sma20: 159.038, atr: 1.015, adx: 41, rsi: 31.6, bb_upper: 161.253, bb_lower: 156.823 },
  19.4,
);

const QUIET = stored(
  { price: 150.0, sma20: 150.05, atr: 0.4, adx: 14, rsi: 51, bb_upper: 151.2, bb_lower: 148.9 },
  16,
);

const axis = (key: string) => {
  const found = AXES.find((a) => a.key === key);
  if (!found) throw new Error(`no axis ${key}`);
  return found;
};

describe("situation axes", () => {
  it("reads the five axes off a stored snapshot", () => {
    expect(axis("adx").of(TODAY)).toBe(41);
    expect(axis("rsi").of(TODAY)).toBe(31.6);
    // Signed: price is below its mean, and a rule learned five ATR BELOW does
    // not transfer to a market five ATR above.
    expect(axis("stretch").of(TODAY)).toBeCloseTo((156.357 - 159.038) / 1.015, 6);
    expect(axis("bb_pos").of(TODAY)).toBeCloseTo((156.357 - 156.823) / (161.253 - 156.823), 6);
    expect(axis("htf_adx").of(TODAY)).toBe(19.4);
  });

  it("measures nothing rather than zero when the reading is missing", () => {
    const blank = contextFromStored({ entry: { tf: "1h", unavailable: true }, higher: [] });
    for (const a of AXES) expect(a.of(blank)).toBeNull();
    expect(hasReading(blank)).toBe(false);
    expect(hasReading(TODAY)).toBe(true);
  });

  it("refuses a stretch or band position it cannot divide", () => {
    const flatAtr = stored({ price: 150, sma20: 149, atr: 0, adx: 20, rsi: 50 });
    expect(axis("stretch").of(flatAtr)).toBeNull();
    const flatBand = stored({ price: 150, sma20: 149, atr: 0.3, bb_upper: 151, bb_lower: 151 });
    expect(axis("bb_pos").of(flatBand)).toBeNull();
  });

  it("survives rows written by older builds", () => {
    expect(contextFromStored(null)).toEqual({ entry: null, higher: [] });
    expect(contextFromStored("junk")).toEqual({ entry: null, higher: [] });
    expect(contextFromStored({ entry: {}, higher: "nope" })).toEqual({ entry: {}, higher: [] });
    // A number that arrived as a string is still a number
    const asText = contextFromStored({ entry: { adx: "41.5" }, higher: [] });
    expect(axis("adx").of(asText)).toBe(41.5);
    // …but a non-finite one is not measured
    expect(axis("adx").of(contextFromStored({ entry: { adx: "NaN" }, higher: [] }))).toBeNull();
  });
});

describe("footprints, measured from the plans a rule cites", () => {
  it("spans the readings of r11's three citations", () => {
    const print = footprintOf(R11);
    expect(print.cases).toBe(3);
    expect(print.cited).toBe(3);
    expect(print.axes.adx).toMatchObject({ min: 68.7, max: 70.3, n: 3, wide: false });
    expect(print.axes.rsi).toMatchObject({ min: 8.6, max: 12.7, n: 3, wide: false });
    expect(print.axes.stretch.wide).toBe(false);
    expect(print.axes.stretch.max - print.axes.stretch.min).toBeLessThan(1);
  });

  it("counts the citations it could not read, rather than shrinking the rule", () => {
    // r10 cites five plans; one predates the snapshot and has nothing to read.
    // The footprint is measured from four and says so — a rule whose evidence
    // is partly unreadable must not look better-evidenced than it is.
    const print = footprintOf(R10, 5);
    expect(print.cases).toBe(4);
    expect(print.cited).toBe(5);
  });

  it("marks an axis too broad to tell situations apart", () => {
    // r10's own text claims "ADX above 60". Its citations run 39 to 75.4 —
    // a spread of 36 on an axis whose tolerance is 10. Anything at all would
    // land inside that, so the axis is excluded from the verdict instead of
    // handing back a match it did not earn.
    const print = footprintOf(R10, 5);
    expect(print.axes.adx.min).toBe(39);
    expect(print.axes.adx.max).toBe(75.4);
    expect(print.axes.adx.max - print.axes.adx.min).toBeGreaterThan(WIDE_FACTOR * axis("adx").tolerance);
    expect(print.axes.adx.wide).toBe(true);
    // The tighter axes still count
    expect(print.axes.rsi.wide).toBe(false);
    expect(print.axes.stretch.wide).toBe(false);
  });

  it("leaves out an axis no citation ever measured", () => {
    const print = footprintOf([stored({ price: 150, sma20: 149, atr: 0.5 })]);
    expect(print.axes.stretch).toBeDefined();
    expect(print.axes.adx).toBeUndefined();
    expect(print.axes.rsi).toBeUndefined();
  });
});

describe("comparing today against a footprint", () => {
  it("calls a single case thin rather than a range", () => {
    const one = footprintOf([R11[0]]);
    expect(one.axes.adx.n).toBe(1);
    expect(matchAxis(axis("adx"), one.axes.adx, 68.7)).toBe("thin");
    // …and the rule as a whole is unknown, not a match
    expect(situationFor(one, R11[0]).fit).toBe("unknown");
  });

  it("separates inside the range from beside it from outside it", () => {
    const print = footprintOf(R11);
    expect(matchAxis(axis("adx"), print.axes.adx, 69)).toBe("in");
    expect(matchAxis(axis("adx"), print.axes.adx, 62)).toBe("near");
    expect(matchAxis(axis("adx"), print.axes.adx, 41)).toBe("out");
    expect(matchAxis(axis("adx"), print.axes.adx, null)).toBe("unknown");
  });

  it("finds today's daily market is not the 1h band-walk r11 was learned in", () => {
    const fit = situationFor(footprintOf(R11), TODAY);
    expect(fit.fit).toBe("off");
    expect(fit.comparable).toHaveLength(5);
    expect(fit.missed).toEqual(["adx", "rsi", "stretch", "htf_adx"]);
    expect(fit.axes.bb_pos).toBe("near");
  });

  it("finds today inside r10's much broader evidence, on the axes that discriminate", () => {
    const fit = situationFor(footprintOf(R10, 5), TODAY);
    expect(fit.fit).toBe("match");
    // The one axis whose range is too broad to mean anything is not counted,
    // in either direction
    expect(fit.axes.adx).toBe("wide");
    expect(fit.comparable).not.toContain("adx");
    expect(fit.missed).toEqual([]);
    expect(fit.cases).toBe(4);
    expect(fit.cited).toBe(5);
  });

  it("calls a quiet range market off both rules", () => {
    expect(situationFor(footprintOf(R11), QUIET).fit).toBe("off");
    expect(situationFor(footprintOf(R10, 5), QUIET).fit).toBe("off");
  });

  it("answers unknown when too few axes can be compared", () => {
    const print = footprintOf(R11);
    const barely = contextFromStored({ entry: { tf: "1h", adx: 69 }, higher: [] });
    const fit = situationFor(print, barely);
    expect(fit.comparable.length).toBeLessThan(MIN_COMPARABLE_AXES);
    expect(fit.fit).toBe("unknown");
  });

  it("has an explicit verdict for a rule with nothing to compare against", () => {
    expect(UNCOMPARED.fit).toBe("unknown");
    expect(situationFor(footprintOf([], 4), TODAY)).toMatchObject({ fit: "unknown", cases: 0, cited: 4 });
  });
});

const rule = (over: Partial<Rule> & { id: string }): Rule => ({
  text_ja: `${over.id}の本文`,
  text_en: `body of ${over.id}`,
  cause: "direction_wrong",
  support: 5,
  scope: null,
  since: null,
  kind: "heuristic",
  contract: "market_v1",
  evidence_contracts: ["market_v1"],
  supported_by: [],
  ...over,
});

const fitsOf = (map: Record<string, "match" | "off" | "unknown">) =>
  Object.fromEntries(Object.entries(map).map(([id, fit]) => [id, { ...UNCOMPARED, fit }]));

describe("rule selection, once the situation is known", () => {
  it("keeps a constraint above a heuristic that fits better", () => {
    // A constraint says when NOT to trade. The situation check compares
    // against the handful of plans a rule happens to cite; letting a thin
    // match promote a heuristic over a constraint would turn that into
    // permission.
    const rules = [
      rule({ id: "h", kind: "heuristic" }),
      rule({ id: "c", kind: "constraint" }),
    ];
    const ordered = orderRules(rules, fitsOf({ h: "match", c: "off" }));
    expect(ordered.map((r) => r.id)).toEqual(["c", "h"]);
  });

  it("ranks a fit above a rule it could not check, and that above a mismatch", () => {
    const rules = ["off", "unknown", "match"].map((id) => rule({ id }));
    const ordered = orderRules(rules, fitsOf({ off: "off", unknown: "unknown", match: "match" }));
    expect(ordered.map((r) => r.id)).toEqual(["match", "unknown", "off"]);
  });

  it("falls back to support when the situation says the same about both", () => {
    const rules = [rule({ id: "weak", support: 1 }), rule({ id: "strong", support: 9 })];
    const ordered = orderRules(rules, fitsOf({ weak: "match", strong: "match" }));
    expect(ordered.map((r) => r.id)).toEqual(["strong", "weak"]);
  });

  it("says in the prompt whether each rule fits, and where that came from", () => {
    const rules = [rule({ id: "a" }), rule({ id: "b" })];
    const out = selectPromptRules(rules, "ja", "market_v1", 12, 1600, fitsOf({ a: "match", b: "off" }));
    expect(out.text).toContain("今の相場に該当");
    expect(out.text).toContain("今は別局面");
    // The marker is a measurement, and the block says so. Without this the
    // model cannot tell it apart from a claim the rule makes about itself.
    expect(out.text).toContain("ルール本文の主張ではない");
    expect(out.ids).toEqual(["a", "b"]);
  });

  it("says it cannot compare, rather than staying silent, when there is no footprint", () => {
    const out = selectPromptRules([rule({ id: "a" })], "ja", "market_v1", 12, 1600, {});
    expect(out.text).toContain("今との照合不可");
  });

  it("renders exactly as before when the comparison was not made", () => {
    const rules = [rule({ id: "a" }), rule({ id: "b" })];
    const before = selectPromptRules(rules, "ja", "market_v1", 12, 1600, null);
    expect(before.text).not.toContain("今の相場");
    expect(before.text).not.toContain("ルール本文の主張ではない");
    expect(before.heldBack).toBe(0);
  });

  it("names what the budget cut instead of quietly showing a shorter book", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      rule({ id: `r${i}`, text_ja: `${"あ".repeat(90)}${i}`, text_en: `${"word ".repeat(40)}${i}` }));
    const fits = fitsOf(Object.fromEntries(many.map((r, i) => [r.id, i < 3 ? "match" : "off"])));
    const out = selectPromptRules(many, "ja", "market_v1", 12, promptCharBudget("ja"), fits);
    expect(out.heldBack).toBeGreaterThan(0);
    expect(out.text).toContain(`このほかに${out.heldBack}件`);
    expect(out.text).toContain("今の相場から遠いものから順に省いている");
    // The sentence that discloses the cut lives inside the budget it is
    // disclosing, not outside it
    expect(out.text.length).toBeLessThanOrEqual(promptCharBudget("ja"));
    // …and the rules that fit are the ones that survived
    expect(out.ids.slice(0, 3)).toEqual(["r0", "r1", "r2"]);
  });

  it("does not promise situation-ordered cuts when it did not order by situation", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      rule({ id: `r${i}`, text_ja: `${"あ".repeat(90)}${i}` }));
    const out = selectPromptRules(many, "ja", "market_v1", 12, promptCharBudget("ja"), null);
    expect(out.text).toContain("文字数の都合で省略した");
    expect(out.text).not.toContain("今の相場から遠いもの");
  });

  it("keeps the English block inside its own budget with the markers on", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      rule({ id: `r${i}`, text_en: `${"word ".repeat(40)}${i}` }));
    const fits = fitsOf(Object.fromEntries(many.map((r) => [r.id, "match" as const])));
    const out = selectPromptRules(many, "en", "market_v1", 12, promptCharBudget("en"), fits);
    expect(out.text.length).toBeLessThanOrEqual(promptCharBudget("en"));
    expect(out.text).toContain("fits now");
    expect(out.text).toContain("It is not a claim made by the rule's own text");
  });
});

describe("the block stays inside the budget it reports", () => {
  // The accounting counted each rule's characters but not the newline joining
  // it to the next, so a full block ran up to one character per rule over the
  // limit it claims to respect. Reachable, not theoretical: English rules of
  // 231 characters rendered 3211 characters against a 3200 budget. The sweep
  // is wide enough to cross that region rather than sampling around it.
  it("never exceeds the character budget, at any rule length", () => {
    for (const locale of ["ja", "en"] as const) {
      const budget = promptCharBudget(locale);
      for (let len = 5; len <= 400; len += 1) {
        const many = Array.from({ length: 40 }, (_, i) =>
          rule({ id: `r${i}`, text_ja: "あ".repeat(len), text_en: "w".repeat(len) }));
        const fits = fitsOf(Object.fromEntries(many.map((r) => [r.id, "match" as const])));
        for (const f of [null, fits]) {
          const out = selectPromptRules(many, locale, "market_v1", 12, budget, f);
          expect(out.text.length).toBeLessThanOrEqual(budget);
        }
      }
    }
  });
});
