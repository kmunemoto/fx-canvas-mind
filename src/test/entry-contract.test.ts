import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isMarketClosed, isPossiblyClosed } from "../../supabase/functions/_shared/market-hours";
import { PLAN_CONTRACT } from "../../supabase/functions/_shared/contract";
import { CAUSES, causeOutsideContract } from "../../supabase/functions/postmortem/facts";

const analyze = readFileSync("supabase/functions/analyze/index.ts", "utf8");
const repairSql = readFileSync("supabase/migrations/20260904150000_rule_contract_repair.sql", "utf8");
const trackRecordSql = readFileSync("supabase/migrations/20260904150100_public_track_record_in_force.sql", "utf8");

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
    const writes = analyze.match(/plan_contract: PLAN_CONTRACT,/g) ?? [];
    expect(writes).toHaveLength(2);
    // The string itself lives in one place now, because three things agree on
    // it: what analyze writes, which rules the prompt may show, and which
    // rows the statistics may pool.
    expect(PLAN_CONTRACT).toBe("market_v1");
    expect(analyze).not.toMatch(/"market_v1"/);
  });

  it("shows the analyst only the rules its own contract allows it to follow", () => {
    // Seven of the nine rules in the live book were about placing a limit
    // entry when this shipped — a move that no longer exists — and all nine
    // were being rendered into the prompt.
    //
    // The filter now runs where the book is read, and the rendering waits for
    // the indicators so each rule can be compared against the market it was
    // learned in. Both halves are pinned: a rendering that read the whole book
    // instead of the in-force list would restore the original defect.
    expect(analyze).toContain("inForceRules = inForce(parseRules(rulebook.rules), PLAN_CONTRACT)");
    expect(analyze).toContain("selectPromptRules(\n      inForceRules,");
  });

  it("keeps shadow rows out of the evidence a rule's situation is measured from", () => {
    // A shadow row is the plan the other contract would have produced. It is
    // excluded from the statistics and from a rule's support; reading its
    // snapshot here would let it back in through the situation check.
    expect(analyze).toContain("&shadow=is.false&select=id,context");
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

// The one-time repair of rulebook v7 re-implements half of stampFor in SQL,
// because the rules it must fix are already stored and the parser only runs at
// the next revision. Two implementations of one predicate drift silently, and
// the drift is invisible: the migration would simply fix fewer rules than the
// parser holds back, and the difference would sit in production prompts.
describe("the rulebook repair agrees with the code that replaced it", () => {
  it("unstamps exactly the causes the live contract cannot produce", () => {
    const list = repairSql.match(/e->>'cause' in \(([^)]*)\)/);
    expect(list).not.toBeNull();
    const causes = (list?.[1] ?? "").split(",").map((c) => c.trim().replace(/^'|'$/g, "")).filter(Boolean);
    // Behavioural parity, not a literal copy: for every cause the taxonomy
    // has, the SQL's answer must equal the function's.
    for (const c of CAUSES) {
      expect([c, causes.includes(c)]).toEqual([c, causeOutsideContract(c, PLAN_CONTRACT)]);
    }
    // The migration only ever touches rows stamped for the live contract
    expect(repairSql).toContain(`e->>'contract' = '${PLAN_CONTRACT}'`);
  });

  it("does not bump the version or move the revision clock", () => {
    // A repair is not a revision. Bumping invents a cohort in
    // by_rulebook_version that no plan was made under; touching updated_at
    // postpones the next real revision, which is what fixes this properly.
    expect(repairSql).not.toMatch(/set[\s\S]*\bversion\s*=/);
    expect(repairSql).not.toMatch(/updated_at\s*=/);
  });

  it("cannot write NULL into rulebook.rules on a fresh replay", () => {
    // jsonb_agg over zero rows returns SQL NULL and rules is NOT NULL, so on
    // any environment where the seed row still holds '[]' — a db reset, a new
    // local DB, a staging project — an unguarded aggregate aborts the file and
    // takes the repair above with it.
    const updates = repairSql.split(/update public\.rulebook/).slice(1);
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u).toMatch(/jsonb_typeof\(r\.rules\) = 'array'/);
    }
    // The backfill has no cause predicate to narrow it, so it needs both the
    // outer coalesce and the non-empty guard.
    expect(updates[1]).toContain("'[]'::jsonb)");
    expect(updates[1]).toContain("jsonb_array_length(r.rules) > 0");
  });

  it("counts rules in force on the public badge, not rules stored", () => {
    expect(trackRecordSql).toContain(`e->>'contract' = '${PLAN_CONTRACT}'`);
    // One contract literal only: a second would mean the badge and the prompt
    // could disagree about which era is live.
    const literals = trackRecordSql.match(/'(market_v1|entry_chosen_v1)'/g) ?? [];
    expect(new Set(literals)).toEqual(new Set([`'${PLAN_CONTRACT}'`]));
    // Asserted on the statements only: the comment above them names the old
    // expression in order to explain what changed.
    const body = trackRecordSql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(body).not.toContain("jsonb_array_length(rules)");
  });
});
