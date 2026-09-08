import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CLUSTER_REOPEN_MS,
  CLUSTER_WINDOW_MS,
  EPISODE_DEFINITION_VERSION,
  episodeCount,
  episodeIds,
} from "../../supabase/functions/_shared/episodes";
import {
  DECIDED_ROW_LIMIT,
  MIN_DECIDED_EPISODES,
  decidedRowsPath,
  promotionGate,
} from "../../supabase/functions/postmortem/promotion";
import { clusterIds, tally } from "../lib/outcomeStats";
import {
  parseConsolidation,
  summarizeRecord,
  withClusters,
  type LessonRow,
  type RecordRow,
} from "../../supabase/functions/postmortem/prompt";
import type { Rule } from "../../supabase/functions/analyze/rules";
import type { AnalysisRecord } from "../lib/types";

const postmortemIndex = readFileSync("supabase/functions/postmortem/index.ts", "utf8");
const promptSrc = readFileSync("supabase/functions/postmortem/prompt.ts", "utf8");
const outcomeStatsSrc = readFileSync("src/lib/outcomeStats.ts", "utf8");
// The NEWEST definition of performance_stats, which is the one that runs.
// Pinned to 20260907041000 until 20260908093000 redefined the function to
// split who declined from who refused: a pin left on a superseded file
// passes while the live definition drops the episode rule, and points the
// next bump at a migration that has already been applied.
const migration = readFileSync("supabase/migrations/20260908093000_who_declined_is_not_who_refused.sql", "utf8");
const settlementMigration = readFileSync("supabase/migrations/20260907040000_lesson_settlement_time.sql", "utf8");
const loopHealthMigration = readFileSync("supabase/migrations/20260907042000_loop_health_counts_episodes.sql", "utf8");
const loopHealthComponent = readFileSync("src/components/LoopHealth.tsx", "utf8");
const enCopy = readFileSync("src/lib/i18n/en.ts", "utf8");
const jaCopy = readFileSync("src/lib/i18n/ja.ts", "utf8");

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-03T00:00:00Z");
const at = (h: number) => new Date(T0 + h * HOUR).toISOString();
const sell = (h: number, closedH?: number) => ({
  pair: "USD/JPY",
  signal: "SELL",
  created_at: at(h),
  closed_at: closedH === undefined ? null : at(closedH),
});

describe("one definition of an independent situation", () => {
  it("anchors the window on the episode's start, not on the previous plan", () => {
    // THE DIVERGENCE THIS FILE EXISTS FOR. postmortem/prompt.ts measured the
    // window from the PREVIOUS plan, so a plan every twenty hours chained
    // forever and a week of daily readings was one situation. The client
    // measured it from the start and cut every 24 hours. Four plans at 0h,
    // 20h, 40h and 60h: every gap is under 24 hours, so the chain fuses all
    // four into one situation; anchored on the start it is two, cut at 40h.
    const ids = episodeIds([sell(0), sell(20), sell(40), sell(60)]);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).not.toBe(ids[2]);
    expect(ids[2]).toBe(ids[3]);
  });

  it("lets a plan escape the window when the one before it had long settled", () => {
    // THE OTHER HALF. The client had no escape at all, so two plans six hours
    // apart with a finished trade between them were one situation on screen.
    const escaped = episodeIds([sell(0, 1), sell(6)]);
    expect(new Set(escaped).size).toBe(2);
    // ...and still one when the earlier plan settled only just before
    const same = episodeIds([sell(0, 5), sell(6)]);
    expect(new Set(same).size).toBe(1);
  });

  it("keeps the boundaries exactly where they were: 24h separates, 4h does not escape", () => {
    // `<` on the window and `>` on the escape. Both have been read the wrong
    // way round in review, and flipping either silently moves every count.
    const justInside = episodeIds([sell(0), { ...sell(0), created_at: new Date(T0 + CLUSTER_WINDOW_MS - 1).toISOString() }]);
    expect(new Set(justInside).size).toBe(1);
    const exactly24 = episodeIds([sell(0), { ...sell(0), created_at: new Date(T0 + CLUSTER_WINDOW_MS).toISOString() }]);
    expect(new Set(exactly24).size).toBe(2);
    const exactly4 = episodeIds([
      sell(0, 1),
      { ...sell(0), created_at: new Date(T0 + HOUR + CLUSTER_REOPEN_MS).toISOString() },
    ]);
    expect(new Set(exactly4).size).toBe(1);
    const justOver4 = episodeIds([
      sell(0, 1),
      { ...sell(0), created_at: new Date(T0 + HOUR + CLUSTER_REOPEN_MS + 1).toISOString() },
    ]);
    expect(new Set(justOver4).size).toBe(2);
  });

  it("never lets an older plan's settlement excuse a plan that is still open", () => {
    // prompt.ts carried the newest settlement forward with Math.max on the
    // JOIN path, so the plan at 6h escaped on the strength of the trade that
    // closed at 0.5h while the plan at 1h — the one immediately before it —
    // was still running. An open position is the strongest evidence there is
    // that we are still in the same bet, so it must block the escape.
    const ids = episodeIds([sell(0, 0.5), sell(1), sell(6)]);
    expect(new Set(ids).size).toBe(1);
    // ...while a predecessor that really had settled still escapes
    expect(new Set(episodeIds([sell(0, 0.5), sell(6)])).size).toBe(2);
  });

  it("keys on the situation, never on the account or the reviewer", () => {
    const ids = episodeIds([
      sell(1),
      { pair: "USD/JPY", signal: "BUY", created_at: at(1) },
      { pair: "EUR/USD", signal: "SELL", created_at: at(1) },
      // another account, same market, same moment: one decision, not two
      sell(1),
    ]);
    expect(ids[3]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(3);
  });

  it("counts a time-ordered prefix as a lower bound, which is what makes a truncated read safe", () => {
    // The rows have to actually JOIN for this to test anything. Four plans
    // 30 hours apart are four episodes under any rule that never merges,
    // including one that hands every row its own id, so the property held
    // vacuously and the assertion was carrying nothing.
    const full = [
      sell(0, 0.5), sell(6), sell(12), sell(30), sell(36, 37), sell(48), sell(72),
    ];
    const whole = episodeCount(full);
    expect(whole).toBe(5);
    for (let n = 1; n <= full.length; n++) {
      const prefix = episodeCount(full.slice(0, n));
      expect(prefix).toBeLessThanOrEqual(whole);
      // and never DECREASING as the prefix grows: a forward-only scan can add
      // episodes or join them, and can never revisit a decision already made
      expect(prefix).toBeGreaterThanOrEqual(episodeCount(full.slice(0, Math.max(1, n - 1))));
    }
  });

  it("is the SAME implementation everywhere, and the client passes the settlement time", () => {
    // The client's own entry point must now give the union answer, not the
    // fixed-anchor-only one it gave before.
    const rows = [
      { pair: "USD/JPY", signal: "SELL" as const, created_at: at(0), closed_at: at(1) },
      { pair: "USD/JPY", signal: "SELL" as const, created_at: at(6), closed_at: null },
    ];
    expect(new Set(clusterIds(rows)).size).toBe(2);
    expect(new Set(episodeIds(rows)).size).toBe(2);
    // and nobody has quietly grown a fifth copy of the rule
    expect(outcomeStatsSrc).not.toMatch(/const starts = new Map/);
    expect(promptSrc).not.toMatch(/const last = new Map<string, \{ id: string; t: number; closed: number \}>/);
    expect(outcomeStatsSrc).toContain('from "../../supabase/functions/_shared/episodes"');
    expect(promptSrc).toContain('from "../_shared/episodes.ts"');
  });

  it("says out loud that four hours is an aggregation threshold and not independence", () => {
    const shared = readFileSync("supabase/functions/_shared/episodes.ts", "utf8");
    expect(shared).toMatch(/not a claim of\s*\n\/\/ statistical independence|NOT a guarantee|not a claim of statistical independence/i);
    expect(shared).not.toMatch(/^import /m);
  });
});

describe("the lesson carries the settlement time the escape needs", () => {
  it("groups two lessons a settled trade apart as two situations", () => {
    // Verified against the live shape: the same two lessons give ONE episode
    // when plan_closed_at is omitted, as the call site omitted it, and TWO
    // when it is supplied. That is the whole of what the dead escape cost.
    const lesson = (h: number, closedH: number | null) => ({
      analysis_id: `L${h}`,
      contract: "market_v1",
      pair: "USD/JPY",
      signal: "SELL",
      cause: "direction_wrong",
      outcome: "loss",
      interval: "1h",
      mode: null,
      order_type: null,
      lesson_ja: "x",
      lesson_en: "x",
      confidence: 70,
      avoidable: true,
      shadow: false,
      scope: null,
      created_at: at(50),
      plan_created_at: at(h),
      plan_closed_at: closedH === null ? null : at(closedH),
      rule_blamed: null,
      rule_credited: null,
    });
    const withTime = withClusters([lesson(0, 1), lesson(6, null)]);
    expect(withTime[0].cluster).not.toBe(withTime[1].cluster);
    const without = withClusters([lesson(0, null), lesson(6, null)]);
    expect(without[0].cluster).toBe(without[1].cluster);
  });

  it("selects, maps and persists it, so the column is not written to be ignored", () => {
    expect(postmortemIndex).toContain("analysis_created_at,plan_closed_at,rule_blamed");
    expect(postmortemIndex).toContain("plan_closed_at: strOrNull(l.plan_closed_at),");
    expect(postmortemIndex).toContain("plan_closed_at: row.closed_at ?? null,");
    // the repair path rebuilds lessons too, and must not write the very rows
    // this build exists to stop
    expect(postmortemIndex).toContain("plan_contract,created_at,closed_at,evaluation,postmortem");
    expect(postmortemIndex).toContain("closed_at: strOrNull(raw.closed_at),");
    // and the column exists to be selected from, backfilled from the plan
    expect(settlementMigration).toContain("add column if not exists plan_closed_at timestamptz");
    expect(settlementMigration).toContain("set plan_closed_at = a.closed_at");
  });
});

describe("the promotion gate counts situations, not rows", () => {
  it("does not promote on ten restatements of one afternoon", () => {
    const oneAfternoon = Array.from({ length: 12 }, (_, i) => sell(i * 1.5));
    expect(oneAfternoon.length).toBeGreaterThan(MIN_DECIDED_EPISODES);
    const gate = promotionGate(8, oneAfternoon);
    expect(gate.episodes).toBe(1);
    expect(gate.measured).toBe(false);
    expect(gate.needed).toBe(MIN_DECIDED_EPISODES - 1);
  });

  it("promotes once the evidence really is ten separate situations", () => {
    const spread = Array.from({ length: 10 }, (_, i) => sell(i * 30));
    const gate = promotionGate(8, spread);
    expect(gate.episodes).toBe(10);
    expect(gate.measured).toBe(true);
    expect(gate.needed).toBe(0);
  });

  it("treats a failed read as unknown, never as zero, and version 0 as measured", () => {
    const failed = promotionGate(8, null);
    expect(failed.episodes).toBeNull();
    expect(failed.measured).toBe(false);
    expect(promotionGate(0, null).measured).toBe(true);
    expect(promotionGate(0, []).measured).toBe(true);
  });

  it("asks for the columns clustering needs, bounds the population and orders it", () => {
    // `select=id` gave every row the identical episode id, so the count would
    // have been 1 for any population at all.
    const path = decidedRowsPath(8);
    expect(path).toContain("select=pair,signal,created_at,closed_at");
    expect(path).not.toContain("select=id");
    expect(path).toContain("preview=is.false");
    expect(path).toContain("order=created_at.asc");
    expect(path).toContain(`limit=${DECIDED_ROW_LIMIT}`);
    expect(DECIDED_ROW_LIMIT).toBeGreaterThan(100);
  });

  it("stamps how it counted, so a change of method cannot read as the analyst improving", () => {
    expect(promotionGate(8, [sell(0)]).episode_definition_version).toBe(EPISODE_DEFINITION_VERSION);
    expect(postmortemIndex).toContain("episode_definition_version: gate.episode_definition_version,");
    expect(postmortemIndex).toContain("decided_episodes_under_version: decidedEpisodes,");
    expect(promptSrc).toContain("episode_definition_version: EPISODE_DEFINITION_VERSION,");
    expect(migration).toContain("'episode_definition_version', 2,");
  });
});

describe("the server-side statistic uses the same rule", () => {
  it("replaces the applied definition rather than editing a migration that ran", () => {
    expect(migration).toContain("create or replace function public.performance_stats");
    expect(migration).toContain("security invoker");
    // RLS on public.analyses is what scopes this to the caller; a user filter
    // here would be redundant, and adding one to a stable SQL function that
    // the record is read through is how a record silently becomes empty.
    expect(migration.slice(migration.indexOf("as $function$"))).not.toContain("auth.uid()");
  });

  it("carries the episode's start AND the previous plan's settlement through the recursion", () => {
    expect(migration).toContain("o.created_at as cluster_start, o.closed_at as prev_closed");
    expect(migration).toContain("o.created_at - c.cluster_start < interval '24 hours'");
    expect(migration).toContain("o.created_at > c.prev_closed + interval '4 hours'");
    expect(migration).toContain("a.outcome, a.closed_at, a.entry_point");
  });
});

describe("one rule is not enough: every caller scans the same population", () => {
  // The rule is a single function now, but the ROWS handed to it were still
  // three different sets. That matters because a row taking part in the scan
  // is not inert: it anchors an episode start, and it overwrites the previous
  // plan's settlement for the row after it. So a row present on one side and
  // filtered out on the other moves a boundary on one side only — the same
  // divergence this run exists to end, under a new name.
  it("a row that only one side scans really does move a boundary", () => {
    const settled = { pair: "USD/JPY", signal: "SELL", created_at: at(0), closed_at: at(1) };
    const open = { pair: "USD/JPY", signal: "SELL", created_at: at(2), closed_at: null };
    const later = { pair: "USD/JPY", signal: "SELL", created_at: at(9), closed_at: null };
    // Scanned with the row in the middle, the settlement at 1h is hidden and
    // nothing escapes; scanned without it, the plan at 9h is a fresh reading.
    expect(new Set(episodeIds([settled, open, later])).size).toBe(1);
    expect(new Set(episodeIds([settled, later])).size).toBe(2);
  });

  const recordRow = (over: Partial<RecordRow>): RecordRow => ({
    pair: "USD/JPY", signal: "SELL", created_at: at(0), outcome: "pending", shadow: false,
    rejection: null, filled: false, entry: 150, stop: 151, tp1: 148, outcome_price: null,
    rulebook_version: 8, contract: "market_v1", ...over,
  });

  it("summarizeRecord leaves shadows and previews out BEFORE it clusters", () => {
    // performance_stats filters them in `mine`, before the recursion. This
    // side used to hand the rule everything and skip them inside the loop, so
    // the shadow below hid the 01:00 settlement and the two real plans came
    // out as one situation here and two there.
    const rows = [
      recordRow({ outcome: "win", filled: true, closed_at: at(1) }),
      recordRow({ created_at: at(2), shadow: true, outcome: "pending" }),
      recordRow({ created_at: at(3), preview: true, outcome: "skipped", signal: "WAIT" }),
      recordRow({ created_at: at(9), outcome: "loss", filled: true, closed_at: at(10) }),
    ];
    expect(summarizeRecord(rows, []).independent_clusters).toBe(2);
    // the shadow is still counted as a shadow, not quietly discarded
    expect(summarizeRecord(rows, []).shadow.total).toBe(1);
  });

  it("tally leaves them out before clustering too, on the same rows", () => {
    const record = (over: Partial<AnalysisRecord>): AnalysisRecord => ({
      id: Math.random().toString(36).slice(2),
      pair: "USD/JPY", interval: "1h", mode: "full", signal: "SELL", confidence: 70,
      thesis: null, entry_point: 150, stop_loss: 151, take_profit_1: 148,
      take_profit_2: null, take_profit_3: null, price_at_signal: 150,
      outcome: "pending", outcome_price: null, created_at: at(0), closed_at: null,
      evaluation: null, ...over,
    });
    const records = [
      record({ outcome: "win", closed_at: at(1) }),
      record({ created_at: at(2), shadow: true }),
      record({ created_at: at(3), preview: true, signal: "WAIT", outcome: "skipped" }),
      record({ created_at: at(9), outcome: "loss", closed_at: at(10) }),
    ];
    expect(tally("all", records).clusters).toBe(2);
  });
});

describe("a gate that cannot place its rows says so instead of counting them", () => {
  it("refuses a population whose rows carry no situation, rather than reporting one", () => {
    // What `select=id` produced: five hundred rows, no pair, no direction, no
    // timestamp, one shared episode id — a confident 1 for any population at
    // all, and `measured` false forever with nothing on `errors` to say why.
    const blank = Array.from({ length: 500 }, () => ({ pair: "", signal: "", created_at: "", closed_at: null }));
    expect(new Set(episodeIds(blank)).size).toBe(1);
    const gate = promotionGate(8, blank);
    expect(gate.episodes).toBeNull();
    expect(gate.unplaceable).toBe(500);
    expect(gate.measured).toBe(false);
    // an unreadable timestamp is the same kind of failure
    const undated = promotionGate(8, [{ pair: "USD/JPY", signal: "SELL", created_at: "not-a-date", closed_at: null }]);
    expect(undated.episodes).toBeNull();
    expect(undated.unplaceable).toBe(1);
    // ...and rows that CAN be placed are still counted, unplaceable at zero
    const good = promotionGate(8, [sell(0), sell(30)]);
    expect(good.episodes).toBe(2);
    expect(good.unplaceable).toBe(0);
  });

  it("names it in the run summary, where a wrong count would otherwise pass as a real one", () => {
    expect(postmortemIndex).toContain("decided rows carry no situation, count refused");
  });
});

describe("an unreadable lessons table is not an empty one", () => {
  it("keeps the lesson pool read's failure, rather than coercing it to no lessons", () => {
    // `?? []` here was the whole of a silent stop: readRowsOrNull returns null
    // when the read FAILED, and the run then reported reason "no_lessons" with
    // nothing pushed onto `errors`. This build's own new column would have
    // been the first thing to trip it — PostgREST rejects a select naming a
    // column that does not exist, so deploying ahead of the migration takes
    // out the learning path and calls it an absence of lessons.
    const readAt = postmortemIndex.indexOf("lessons?select=${lessonSelect}&order=created_at.desc");
    expect(readAt).toBeGreaterThan(-1);
    expect(postmortemIndex.slice(readAt, readAt + 300)).not.toMatch(/\)\) \?\? \[\];/);
    expect(postmortemIndex).toContain("const lessonsUnavailable = lessonPoolOrNull === null;");
    expect(postmortemIndex).toContain('errors.push("rulebook: lessons unavailable, not revised")');
  });

  it("tests for it BEFORE the emptiness test, which an unreadable table also passes", () => {
    const unavailable = postmortemIndex.indexOf('reason: "lessons_unavailable"');
    const empty = postmortemIndex.indexOf('reason: "no_lessons"');
    expect(unavailable).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(-1);
    expect(unavailable).toBeLessThan(empty);
  });
});

describe("both timestamps come off the plan's own clock", () => {
  it("never measures an escape across the plan clock and the review clock", () => {
    // created_at fell back to the DIAGNOSIS time when a lesson had no plan
    // time, while closed_at stayed on the plan clock. Reviews run hours or
    // days late — lesson 94bdcfaa was written five days after its plan — so
    // the pair placed the row after its own settlement and opened the escape
    // on nothing but review latency.
    const lesson = (over: Partial<LessonRow>): LessonRow => ({
      analysis_id: Math.random().toString(36).slice(2),
      user_id: null, contract: "market_v1", pair: "USD/JPY", signal: "SELL",
      cause: "direction_wrong", outcome: "loss", interval: "1h", mode: null, order_type: null,
      lesson_ja: "x", lesson_en: "x", confidence: 70, avoidable: true, shadow: false, scope: null,
      created_at: at(0), plan_created_at: at(0), plan_closed_at: null,
      rule_blamed: null, rule_credited: null, ...over,
    });
    const clustered = withClusters([
      lesson({ plan_created_at: at(0), plan_closed_at: null }),
      // no plan time: placed on the review clock at 20h, and its settlement
      // is unknown from there — an unknown settlement never escapes
      lesson({ plan_created_at: null, created_at: at(20), plan_closed_at: at(1) }),
      lesson({ plan_created_at: at(23), plan_closed_at: null }),
    ]);
    expect(new Set(clustered.map((l) => l.cluster)).size).toBe(1);
  });
});

describe("which rule goes is decided by one count, not two", () => {
  it("spends the removal allowance by today's evidence, not by a number counted another way", () => {
    // `previous[].support` is whatever was stored when the rule was last
    // written — possibly under definition 1, the four divergent
    // implementations. Ordering the removals by that while writing the
    // survivors back with a recounted number mixes two definitions inside one
    // revision, and the mix is not uniform across rules: here it drops the
    // rule with three episodes behind it and keeps one with a single episode.
    const lessons = [
      { analysis_id: "L1", cluster: "c1", cause: "entry_too_far" },
      { analysis_id: "L2", cluster: "c2", cause: "entry_too_far" },
      { analysis_id: "L3", cluster: "c3", cause: "entry_too_far" },
      { analysis_id: "L4", cluster: "c4", cause: "entry_too_far" },
    ];
    const stored = (id: string, support: number, supported_by: string[]): Rule => ({
      id, text_ja: `旧${id}`, text_en: `old ${id}`, cause: "entry_too_far", support,
      scope: null, since: "2026-08-01T00:00:00Z", contract: null, evidence_contracts: [],
      kind: "heuristic", supported_by,
    });
    const previous = [
      // stored weakest, strongest by the evidence in front of us
      stored("keeps", 1, ["L1", "L2", "L3"]),
      stored("weak", 5, ["L1"]),
      stored("weaker", 6, ["L2"]),
      // stored strongest of all, and its citations no longer count at all
      stored("vanished", 9, ["ghost"]),
    ];
    const out = parseConsolidation(
      { rules: [{ id: "alive", text_ja: "新", text_en: "new", cause: "entry_too_far", kind: "heuristic", scope: null, supported_by: ["L4"] }], summary_ja: "s", summary_en: "s" },
      previous,
      "2026-09-07T00:00:00Z",
      lessons,
    );
    // the three-episode rule survives; the two one-episode rules spend the allowance
    expect(out?.changes.restored).toEqual(["keeps"]);
    expect(out?.rules.find((r) => r.id === "keeps")?.support).toBe(3);
    expect(out?.changes.removed.sort()).toEqual(["vanished", "weak", "weaker"]);
    // and a rule removed because its evidence went says that, not "omitted" —
    // it did not spend a slot that a rule with evidence could have used
    expect(out?.changes.reasons.vanished).toBe("evidence_gone");
    expect(out?.changes.reasons.weak).toBe("omitted");
  });
});

describe("the stamp travels with the count it describes", () => {
  it("stamps the candidate where the counting happened, and promotes on that stamp", () => {
    // A candidate waits several runs and its rules are promoted verbatim,
    // support and all. Stamping the promotion with today's constant would
    // label definition-1 numbers as definition 2 — the exact confusion the
    // stamp exists to prevent, on the number that decides whether a rule
    // survives.
    expect(postmortemIndex).toContain("episode_definition_version: EPISODE_DEFINITION_VERSION,");
    expect(postmortemIndex).toContain("episode_definition_version: numberOrNull(priorCandidate.episode_definition_version) ?? 1,");
  });

  it("stamps the archived rules too, whose support is an episode count nobody recounts", () => {
    // history[] holds each version's rules forever. A v8 rule reading
    // support 2 is otherwise indistinguishable from a v9 rule reading
    // support 2 counted a different way.
    // BOTH archive sites: the promotion path and the revision path each build
    // their own history entry, and a stamp on one of them is a rulebook whose
    // history is half labelled.
    expect(postmortemIndex.match(/episode_definition_version: liveEpisodeDefinition,/g)?.length).toBe(2);
    // ...taken from what the live rulebook recorded, not from today's constant:
    // these rules were counted when they were written, possibly under
    // definition 1, and a rulebook with no stamp at all IS definition 1.
    expect(postmortemIndex).toContain("(isRecord(current?.stats) ? current.stats : {}).episode_definition_version,");
    expect(postmortemIndex).toMatch(/liveEpisodeDefinition = numberOrNull\([\s\S]{0,200}\) \?\? 1;/);
  });

  it("keeps the SQL's stamp tied to the constant, so a bump cannot leave it behind", () => {
    // The migration writes the number as a literal, and a test that also
    // hardcoded it would have gone on passing while the SQL stamped 2 and the
    // TS stamped 3.
    expect(migration).toContain(`'episode_definition_version', ${EPISODE_DEFINITION_VERSION},`);
    expect(loopHealthMigration).toContain(`'episode_definition_version', ${EPISODE_DEFINITION_VERSION},`);
  });
});

describe("the dashboard reads the number the gate decides on", () => {
  it("teaches loop_health the episode rule without touching how it is scoped", () => {
    // SECURITY DEFINER, so every per-account counter MUST keep its explicit
    // auth.uid() filter — the opposite of performance_stats, where RLS does
    // the scoping and a filter would be redundant.
    expect(loopHealthMigration).toContain("create or replace function public.loop_health");
    expect(loopHealthMigration).toContain("security definer");
    // Four in the body, exactly where the applied definition has them:
    // open_plans, awaiting_review, reviewed, lessons. decided_under_version
    // has never been per-account and must not become one — the gate it is
    // compared against runs service-role across every account.
    const body = loopHealthMigration.slice(loopHealthMigration.indexOf("as $function$"));
    expect(body.match(/auth\.uid\(\)/g)?.length).toBe(4);
    expect(body).not.toMatch(/decided_episodes_under_version[\s\S]{0,900}auth\.uid\(\)/);
    // the same recursion, the same two boundaries
    expect(loopHealthMigration).toContain("o.created_at as cluster_start, o.closed_at as prev_closed");
    expect(loopHealthMigration).toContain("o.created_at - c.cluster_start < interval '24 hours'");
    expect(loopHealthMigration).toContain("o.created_at > c.prev_closed + interval '4 hours'");
    expect(loopHealthMigration).toContain("'decided_episodes_under_version'");
    // and the old row count stays, so a client built before the migration is
    // not left reading a confident zero
    expect(loopHealthMigration).toContain("'decided_under_version'");
  });

  it("compares episodes against the gate's floor, and falls back rather than to zero", () => {
    expect(loopHealthComponent).toContain("MIN_DECIDED_EPISODES = 10");
    expect(loopHealthComponent).not.toContain("MIN_DECIDED_PER_VERSION");
    expect(loopHealthComponent).toContain(
      "health.decided_episodes_under_version ?? health.decided_under_version ?? 0",
    );
    expect(MIN_DECIDED_EPISODES).toBe(10);
  });

  it("stops telling the reader that same-day plans always count once", () => {
    // True before the escape was alive in the learning path; false now, in the
    // one direction this build added.
    expect(enCopy).not.toContain("plans on the same day in the same direction count once");
    expect(enCopy).toMatch(/unless the earlier trade had already finished/);
    expect(jaCopy).not.toContain("同じ日・同じ方向のプランは1件と数える");
  });
});
