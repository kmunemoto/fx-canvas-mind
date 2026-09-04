import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isMarketClosed, isPossiblyClosed } from "../../supabase/functions/_shared/market-hours";

const analyze = readFileSync("supabase/functions/analyze/index.ts", "utf8");

// These assert the CONTRACT, not the implementation detail. Each one is a
// specific way the change could half-land and still compile — which is how
// the previous entry rules kept producing plausible numbers while being wrong.
describe("the model can no longer choose an entry price", () => {
  it("does not ask for one in the response schema", () => {
    // Removing it from `properties` but leaving it in `required` would make
    // every structured-output call fail; leaving it in `properties` re-teaches
    // the old contract, because the schema is serialised into the prompt on
    // the web-search path.
    const schema = analyze.slice(analyze.indexOf("const RESPONSE_SCHEMA"), analyze.indexOf("additionalProperties: false"));
    expect(schema).not.toMatch(/entry_point:\s*\{/);
    expect(schema).not.toMatch(/entry_type:\s*\{/);
    expect(schema).not.toContain('"entry_point"');
    expect(schema).not.toContain('"entry_type"');
  });

  it("does not read one out of the model's JSON", () => {
    // The old coercion defaulted to "market" when the field was absent, so
    // deleting the schema field alone would have left every plan looking like
    // a market order with nothing appearing broken.
    expect(analyze).not.toMatch(/priceField\(source\.entry_point\)/);
    expect(analyze).not.toMatch(/source\.entry_type/);
  });

  it("has no snap or repair path left", () => {
    // The repair branch WAS the measured 1.74 -> 0.63 defect: it moved the
    // entry to the market while leaving the stop and target where the model
    // had put them relative to a pullback.
    expect(analyze).not.toContain("entryVerdict.repaired");
    expect(analyze).not.toContain("entrySnapped");
    expect(analyze).not.toContain("entryRepaired");
  });

  it("stops telling the model to wait for a pullback", () => {
    const prompt = analyze.slice(analyze.indexOf("const SYSTEM_PROMPT"), analyze.indexOf("const RESPONSE_SCHEMA"));
    expect(prompt).not.toContain("押し目・戻りを待つ");
    expect(prompt).toContain("エントリー価格は選ばない");
    // and it must say what to do instead
    expect(prompt).toContain("WAIT");
  });

  it("rounds the entry once and uses that one constant everywhere", () => {
    // Rounding after the gate let a plan be certified at RR 1.2006 and judged
    // at 1.1975, and the post-mortem's replay of the gate then reported that
    // the gate would not publish a plan the gate had published.
    expect(analyze).toContain("const marketEntry = Number(entrySnapshot.price.toFixed(decimals));");
    expect(analyze).toContain("price: marketEntry,");
    expect(analyze).toContain("Number.isFinite(marketEntry) ? marketEntry : null");
  });

  it("stamps the contract on every row it writes", () => {
    // Two inserts: the published plan and the shadow row. A writer that omits
    // it joins the legacy bucket silently, because the column defaults.
    const writes = analyze.match(/plan_contract: "market_v1"/g) ?? [];
    expect(writes).toHaveLength(2);
  });

  it("prices from the wall clock, never from the forming bar's own stamp", () => {
    // The candle's datetime is the OPEN of a bar still being built, so on a
    // daily plan it back-dates the fill up to 24 hours into known price action.
    expect(analyze).toContain("pricedAtIso = new Date().toISOString();");
    expect(analyze).not.toMatch(/priced_at:\s*entrySnapshot\.datetime/);
    expect(analyze).not.toMatch(/Date\.parse\(entrySnapshot\.datetime\)/);
  });

  it("refuses to publish an 'enter now' plan while the market is shut", () => {
    // The WIDE predicate. isMarketClosed names only the hours shut under every
    // daylight-saving rule, which is right for deciding whether to discard a
    // bar and wrong for deciding whether to publish: it left a one-hour window
    // each week in which an "enter now" plan went out into a market that may
    // already have closed, and the weekend gap then reads as a trade.
    expect(analyze).toContain("const marketShut = isPossiblyClosed(Date.now());");
    expect(analyze).toContain("marketShut ? L.marketClosed");
    expect(analyze).not.toContain("isMarketClosed(Date.now())");
  });

  it("refuses before spending a model call, not after", () => {
    // The late check alone meant every shut-market request paid for a model
    // turn and was then refunded — free analyses all weekend, and a minute of
    // waiting for an answer that was never available.
    const early = analyze.indexOf('stage = "check_market_hours"');
    const model = analyze.indexOf("https://api.anthropic.com/v1/messages");
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(model);
  });

  it("records WHY the server refused, not just that the gate was happy", () => {
    // A market_closed refusal used to be logged and dropped, leaving the row
    // indistinguishable from a plan the model itself declined — so the WAIT
    // scorer graded the server's refusal as the analyst's judgement.
    expect(analyze).toContain("rejection: entryRejected ? rejectionReason : entryVerdict.rejection");
  });
});

describe("the shared market week", () => {
  it("gives analyze and the tracker the same answer", () => {
    // A Friday evening plan must be refused by the gate for the same reason
    // the tracker will not judge across the gap.
    const fridayNight = Date.parse("2026-09-04T23:00:00Z");
    expect(isMarketClosed(fridayNight)).toBe(true);
    const tuesday = Date.parse("2026-09-01T09:00:00Z");
    expect(isMarketClosed(tuesday)).toBe(false);
    // and the wide predicate is still wider
    const band = Date.parse("2026-09-04T21:30:00Z");
    expect(isMarketClosed(band)).toBe(false);
    expect(isPossiblyClosed(band)).toBe(true);
  });
});
