import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DIRECTION_DEAD_R,
  EARLY_ADVERSE_R,
  LUCKY_MAE_R,
  CAUSES,
  canonicalCause,
} from "../../supabase/functions/postmortem/facts.ts";
import {
  SCORE_FAMILY,
  SEPARATED_DEFINITION_VERSION,
  SEPARATED_MIN_N,
  readSeparatedScores,
  scoreFamily,
  separatedBasis,
  separatedHeadline,
  separatedUndecided,
} from "../lib/outcomeStats";

const MIGRATION = "supabase/migrations/20260910220000_score_direction_placement_and_timing_apart.sql";
const sql = readFileSync(MIGRATION, "utf8");

// The answer public.separated_scores() actually returned when the body of the
// migration was run as a read-only query against production on 2026-09-10,
// trimmed to the two contracts that exist. Kept verbatim rather than invented,
// so the reader below is tested against the shape the server really sends —
// including the parts a hand-written fixture always gets wrong: the snake_case
// keys, ci95 as a two-element array, and the fact that the three scores carry
// three different n over one graded population of 36.
const live = {
  generated_at: "2026-09-10T17:31:23.147621+00:00",
  live_contract: "market_v1",
  definition_version: 1,
  thresholds: { direction_dead_r: 0.1, early_adverse_r: 0.5, lucky_mae_r: 0.8 },
  population: {
    calls: 97,
    trades: 56,
    waits: 41,
    diagnosed_trades: 54,
    undiagnosed_trades: 2,
    pairs: ["USD/JPY"],
    intervals: ["15min", "1day", "1h", "4h"],
    signals: { BUY: 1, SELL: 55, WAIT: 41 },
    first_call_at: "2026-08-29T05:13:43.858491+00:00",
    last_call_at: "2026-09-10T14:51:10.62516+00:00",
  },
  scopes: {
    all_time: {
      graded_trades: 36,
      direction: { n: 33, hits: 18, rate: 55, ci95: [38, 70], unscored: 3, ran_past_stop: 11, never_came: 4, wrong_partial: 0, below_min_n: false },
      timing: {
        n: 26, hits: 14, rate: 54, ci95: [35, 71], unscored: 10, below_min_n: false,
        deep_mae: { n: 34, hits: 18, rate: 53, ci95: [37, 69], unscored: 2, below_min_n: false },
      },
      placement: { n: 24, hits: 13, rate: 54, ci95: [35, 72], unscored: 12, stop_bad: 4, target_bad: 7, stop_untested: 10, below_min_n: false },
      causes: {
        total: 65, waits: 29, direction: 8, timing: 1, placement: 6, neither: 50,
        by_cause: {
          good_call: 14, good_wait: 18, lucky_win: 6, chased_move: 1, inconclusive: 1,
          regime_misread: 1, stop_too_tight: 2, target_too_far: 4, direction_wrong: 7, wait_missed_trade: 11,
        },
      },
    },
  },
  by_contract: {
    market_v1: {
      graded_trades: 36,
      direction: { n: 33, hits: 18, rate: 55, ci95: [38, 70], unscored: 3, ran_past_stop: 11, never_came: 4, wrong_partial: 0, below_min_n: false },
      timing: {
        n: 26, hits: 14, rate: 54, ci95: [35, 71], unscored: 10, below_min_n: false,
        deep_mae: { n: 34, hits: 18, rate: 53, ci95: [37, 69], unscored: 2, below_min_n: false },
      },
      placement: { n: 24, hits: 13, rate: 54, ci95: [35, 72], unscored: 12, stop_bad: 4, target_bad: 7, stop_untested: 10, below_min_n: false },
      causes: { total: 65, waits: 29, direction: 8, timing: 1, placement: 6, neither: 50, by_cause: { direction_wrong: 7 } },
    },
    entry_chosen_v1: {
      graded_trades: 18,
      direction: { n: 16, hits: 9, rate: 56, ci95: [33, 77], unscored: 2, ran_past_stop: 7, never_came: 1, wrong_partial: 0, below_min_n: true },
      timing: {
        n: 11, hits: 9, rate: 82, ci95: [52, 95], unscored: 7, below_min_n: true,
        deep_mae: { n: 11, hits: 9, rate: 82, ci95: [52, 95], unscored: 7, below_min_n: true },
      },
      placement: { n: 11, hits: 7, rate: 64, ci95: [35, 85], unscored: 7, stop_bad: 1, target_bad: 3, stop_untested: 3, below_min_n: true },
      causes: { total: 18, waits: 0, direction: 4, timing: 0, placement: 7, neither: 7, by_cause: { direction_wrong: 4 } },
    },
  },
  other_contract_rows: 21,
  other_contracts: ["entry_chosen_v1"],
};

describe("the separated-scores migration", () => {
  it("creates a new function instead of editing the applied performance_stats", () => {
    expect(sql).toContain("create or replace function public.separated_scores(live_contract text default 'market_v1')");
    // performance_stats is defined in an APPLIED migration. Rewriting it from
    // here would silently redefine a function four other migrations built up,
    // and the record on the history screen is drawn from it.
    expect(sql).not.toContain("create or replace function public.performance_stats");
  });

  it("is SECURITY INVOKER, like the function it was told to match actually is", () => {
    // The brief for this change said performance_stats was security definer.
    // pg_get_functiondef on production 2026-09-10 says otherwise
    // (prosecdef = false), and 20260908093000 spells out why: public.analyses
    // has RLS, so running as the caller IS the scoping and there is
    // deliberately no user_id = auth.uid() in the body.
    //
    // Copying "definer" here would have pooled two accounts into one owner's
    // scores — the loop_health defect, rebuilt. This test is what stops that
    // being quietly "fixed" later.
    expect(sql).toContain("security invoker");
    expect(sql).not.toMatch(/^\s*security definer/m);
    expect(sql).toContain("set search_path to 'public', 'pg_temp'");
  });

  it("never returns an analysis id, from any table", () => {
    // #46: the RPC must not hand a caller another user's analysis ids. The
    // strongest available form of that rule is having no id to hand out — the
    // output is counts, rates, interval bounds and threshold constants.
    const body = sql.split("as $function$")[1].split("$function$;")[0];
    const built = [...body.matchAll(/'([a-z0-9_]+)',/g)].map((m) => m[1]);
    expect(built).not.toContain("id");
    expect(built).not.toContain("ids");
    expect(built).not.toContain("analysis_id");
    expect(built).not.toContain("analysis_ids");
    expect(built).not.toContain("user_id");
  });

  it("is granted the way performance_stats is: authenticated only", () => {
    expect(sql).toContain("revoke all on function public.separated_scores(text) from public;");
    expect(sql).toContain("revoke all on function public.separated_scores(text) from anon;");
    expect(sql).toContain("grant execute on function public.separated_scores(text) to authenticated;");
  });

  it("excludes shadows and previews, exactly as the record does", () => {
    expect(sql).toContain("where a.shadow = false and a.preview = false");
  });

  it("reuses wilson95 rather than deriving a second interval", () => {
    expect(sql).toContain("public.wilson95(");
    // Two implementations of one interval is how one number with one name
    // becomes two. There must be no arithmetic here that recomputes it.
    expect(sql).not.toContain("1.96");
  });

  it("scores no WAIT: a call that declined to trade has no fill, stop or target", () => {
    expect(sql).toContain("where m.signal in ('BUY', 'SELL')");
  });
});

describe("the thresholds are facts.ts's, not new ones", () => {
  it("carries the same three constants the post-mortem already uses", () => {
    // If any of these drift, the rollup and the per-row diagnosis disagree
    // about the same row while both keep rendering a number.
    expect(sql).toContain(`${DIRECTION_DEAD_R}::numeric as direction_dead_r`);
    expect(sql).toContain(`${EARLY_ADVERSE_R}::numeric as early_adverse_r`);
    expect(sql).toContain(`${LUCKY_MAE_R}::numeric as lucky_mae_r`);
  });

  it("uses the LIFE-only favourable excursion for direction, never the one including the aftermath", () => {
    // facts.ts is explicit about this: measured over life + after-window, a
    // plan that died flat and bounced once the stop was already paid reads as
    // though the direction had been fine — post-decision noise deciding a
    // question about the decision.
    expect(sql).toContain("max_favorable_r_in_life");
    expect(sql).not.toMatch(/'from_signal'->>'max_favorable_r'/);
  });

  it("keeps leverMoved's tri-state, so an unanswered lever never reads as 'no'", () => {
    // 'untriggered' on a stop or target variant describes a trade that never
    // happened, and 'ambiguous' is the judge declining to say. Both are null,
    // and null must not collapse to false anywhere.
    const occurrences = sql.match(/in \('ambiguous', 'untriggered'\) then null/g) ?? [];
    expect(occurrences.length).toBe(3);
  });

  it("compares each variant against what the plan actually settled as, not against 'win'", () => {
    // "Did this lever change the ending" is a question about the difference
    // between two endings. On a loss an EXPIRED wider stop is a lever that
    // moved: the -1R never happens.
    expect(sql).toContain("<> g.res");
    expect(sql).not.toMatch(/->>'resolution'\) = 'win'/);
  });
});

describe("the cause families", () => {
  // The SQL and the TS table are two statements of one grouping; a divergence
  // would put one split on the screen and a different one in any later reader.
  const fromSql = (): Record<string, string> => {
    const block = sql.split("lesson_family as (")[1].split("),")[0];
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/when '([a-z_]+)'\s+then '([a-z]+)'/g)) out[m[1]] = m[2];
    return out;
  };

  it("matches the migration's CASE exactly", () => {
    const mapped = fromSql();
    expect(Object.keys(mapped).length).toBeGreaterThan(0);
    for (const [cause, family] of Object.entries(mapped)) {
      expect(SCORE_FAMILY[cause as keyof typeof SCORE_FAMILY], cause).toBe(family);
    }
    // The other direction too, minus entry_too_early: the SQL folds it into
    // chased_move before the CASE (canonicalCause does the same in TS), so it
    // is never seen by the CASE and cannot appear there.
    for (const cause of Object.keys(SCORE_FAMILY)) {
      if (cause === "entry_too_early") continue;
      expect(mapped[cause], cause).toBe(SCORE_FAMILY[cause as keyof typeof SCORE_FAMILY]);
    }
  });

  it("folds the dead spelling exactly as canonicalCause does", () => {
    expect(canonicalCause("entry_too_early")).toBe("chased_move");
    expect(scoreFamily("entry_too_early")).toBe(scoreFamily("chased_move"));
    expect(sql).toContain("when l.cause = 'entry_too_early' then 'chased_move'");
  });

  it("places every cause in the taxonomy, and files the credits under 'neither'", () => {
    for (const cause of CAUSES) expect(typeof scoreFamily(cause)).toBe("string");
    // A win is not evidence about where the stop went, and standing aside is
    // not evidence about anything these three measure.
    for (const cause of ["good_call", "lucky_win", "good_wait", "wait_missed_trade", "inconclusive", "sound_call_lost"] as const) {
      expect(scoreFamily(cause), cause).toBe("neither");
    }
  });
});

describe("readSeparatedScores", () => {
  it("reads the server's real answer, keeping the three denominators apart", () => {
    const s = readSeparatedScores(live);
    expect(s).not.toBeNull();
    const block = s!.scopes.all_time;
    // THE POINT OF THE WHOLE CHANGE: one graded population, three different n.
    expect(block.gradedTrades).toBe(36);
    expect(block.direction.n).toBe(33);
    expect(block.timing.n).toBe(26);
    expect(block.placement.n).toBe(24);
    expect(new Set([block.direction.n, block.timing.n, block.placement.n]).size).toBe(3);
    // ...and each carries the rows it could NOT be taken on, rather than
    // dropping them into a denominator that pretends they were measured.
    expect(block.direction.unscored).toBe(36 - 33);
    expect(block.timing.unscored).toBe(36 - 26);
    expect(block.placement.unscored).toBe(36 - 24);
  });

  it("keeps the deeper excursion on its own denominator", () => {
    const block = readSeparatedScores(live)!.scopes.all_time;
    // 34, not 26: mae_r and early_adverse_r are measured on different rows.
    expect(block.timing.deepMae.n).toBe(34);
    expect(block.timing.deepMae.n).not.toBe(block.timing.n);
  });

  it("carries every interval through, and reads the population it rests on", () => {
    const s = readSeparatedScores(live)!;
    expect(s.scopes.all_time.direction.ci).toEqual([38, 70]);
    expect(s.scopes.all_time.timing.ci).toEqual([35, 71]);
    expect(s.scopes.all_time.placement.ci).toEqual([35, 72]);
    expect(s.population.pairs).toEqual(["USD/JPY"]);
    expect(s.population.calls).toBe(97);
    expect(s.population.undiagnosedTrades).toBe(2);
    // Sorted biggest first, so the mix reads as a mix and not as a list.
    expect(s.population.signals[0]).toEqual({ signal: "SELL", count: 55 });
    expect(s.definitionVersion).toBe(SEPARATED_DEFINITION_VERSION);
    expect(s.thresholds.directionDeadR).toBe(DIRECTION_DEAD_R);
    expect(s.thresholds.earlyAdverseR).toBe(EARLY_ADVERSE_R);
    expect(s.thresholds.luckyMaeR).toBe(LUCKY_MAE_R);
  });

  it("tells 'no rows to take this over' from '0% of them'", () => {
    const empty = readSeparatedScores({
      scopes: { all_time: { graded_trades: 0, direction: { n: 0, hits: 0, rate: null, ci95: null, unscored: 0 } } },
      by_contract: {},
    })!;
    // null, never 0. A rate of 0% is a finding; no rate is the absence of one,
    // and rendering the second as the first is how an empty record starts
    // reading as a catastrophic one.
    expect(empty.scopes.all_time.direction.rate).toBeNull();
    expect(empty.scopes.all_time.direction.ci).toBeNull();
    // A real 0% survives.
    const zero = readSeparatedScores({
      scopes: { all_time: { graded_trades: 4, direction: { n: 4, hits: 0, rate: 0, ci95: [0, 49], unscored: 0 } } },
      by_contract: {},
    })!;
    expect(zero.scopes.all_time.direction.rate).toBe(0);
  });

  it("applies the thin-n floor itself when the server never sent the flag", () => {
    const old = readSeparatedScores({
      scopes: { all_time: { graded_trades: 5, direction: { n: 5, hits: 3, rate: 60, ci95: [23, 88], unscored: 0 } } },
      by_contract: {},
    })!;
    expect(SEPARATED_MIN_N).toBe(20);
    expect(old.scopes.all_time.direction.belowMinN).toBe(true);
  });

  it("answers null rather than a shell of zeroes when the RPC did not answer", () => {
    // Three 0% scores on the screen labelled as measurements is exactly the
    // failure this panel exists to avoid.
    for (const bad of [null, undefined, "error", 42, [], { message: "function does not exist" }]) {
      expect(readSeparatedScores(bad)).toBeNull();
    }
  });

  it("sorts the cause histogram and drops the empty buckets", () => {
    const s = readSeparatedScores(live)!;
    const causes = s.scopes.all_time.causes;
    expect(causes.byCause[0].count).toBeGreaterThanOrEqual(causes.byCause[1].count);
    expect(causes.byCause.every((c) => c.count > 0)).toBe(true);
    expect(causes.direction + causes.timing + causes.placement + causes.neither).toBe(causes.total);
  });
});

describe("separatedHeadline", () => {
  it("draws the live contract when it has graded trades", () => {
    const h = separatedHeadline(readSeparatedScores(live));
    expect(h?.contract).toBeNull();
    expect(h?.block.gradedTrades).toBe(36);
  });

  it("falls back to the one older contract rather than showing the owner nothing", () => {
    const legacyOnly = readSeparatedScores({
      ...live,
      scopes: { all_time: { graded_trades: 0, direction: { n: 0 }, timing: { n: 0, deep_mae: { n: 0 } }, placement: { n: 0 }, causes: {} } },
      by_contract: { entry_chosen_v1: live.by_contract.entry_chosen_v1 },
    });
    const h = separatedHeadline(legacyOnly);
    // ...and says WHICH, so the label can name it instead of passing an old
    // contract's record off as the live one.
    expect(h?.contract).toBe("entry_chosen_v1");
    expect(h?.block.gradedTrades).toBe(18);
  });

  it("has no answer at all when there is nothing to draw", () => {
    expect(separatedHeadline(null)).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// THE JOINTS A REVIEW FOUND, PINNED SO THEY CANNOT QUIETLY CLOSE AGAIN
// ---------------------------------------------------------------------------
describe("what the rollup refuses to let the screen imply", () => {
  it("counts the placement extras over the placement rate's own denominator", () => {
    // stop_bad and target_bad are printed beside `13/24`, so they must be
    // taken over those 24 rows. Counted over the whole graded population they
    // happened to equal pl_n - pl_ok on 2026-09-10 by coincidence, which is
    // how a reader is taught to add up numbers that need not add up.
    const body = sql.split("as $function$")[1];
    const stop = body.split("as pl_stop_bad")[0].split("as pl_ok")[1];
    const target = body.split("as pl_target_bad")[0].split("as pl_stop_bad")[1];
    for (const clause of [stop, target]) {
      expect(clause).toContain("t.stop_verdict <> 'unknown' and t.target_verdict <> 'unknown'");
    }
  });

  it("publishes how much of the placement score is a stop that was never tested", () => {
    // `res <> 'loss' then 'ok'` means a win passes the stop leg without the
    // stop being simulated at all — 10 of 13 hits today. The count must exist
    // in the payload, or the only place that fact lives is a SQL comment.
    expect(sql).toContain("as pl_stop_untested");
    expect(sql).toContain("'stop_untested', a.pl_stop_untested");
    const s = readSeparatedScores(live);
    expect(s?.scopes.all_time.placement.stopUntested).toBe(10);
    expect(s?.scopes.all_time.placement.hits).toBe(13);
  });

  it("counts the rows that could only ever have been a direction miss", () => {
    // A row missing beyond_sl_r joins dir_n when never_came fires, but could
    // never have joined it as a hit. That is causeGrounds' own trichotomy and
    // it is not corrected here — it is counted, so the day it stops being zero
    // the screen says so rather than the rate drifting down unexplained.
    expect(sql).toContain("as dir_wrong_partial");
    expect(sql).toContain("'wrong_partial', a.dir_wrong_partial");
    expect(readSeparatedScores(live)?.scopes.all_time.direction.wrongPartial).toBe(0);
  });

  it("says how many lessons in the cause histogram came from a WAIT", () => {
    // The three scores exclude WAITs on principle; this histogram does not,
    // and on 2026-09-10 that is 29 of 65 rows. Printed without its own n the
    // block reads as a fourth view of the same trades.
    expect(sql).toContain("'waits', count(*) filter (where lt.signal = 'WAIT')::int");
    const s = readSeparatedScores(live);
    expect(s?.scopes.all_time.causes.total).toBe(65);
    expect(s?.scopes.all_time.causes.waits).toBe(29);
  });

  it("filters lessons through the same population the scores use", () => {
    // public.lessons has `shadow` but NO `preview` column, so the preview
    // filter can only be applied by joining the already-filtered analyses.
    // Without the join a lesson under a weekend preview would count in the
    // histogram and in none of the scores beside it.
    const rows = sql.split("lesson_rows as (")[1].split("),")[0];
    expect(rows).toContain("join mine m on m.id = l.analysis_id");
    expect(rows).toContain("l.shadow = false");
  });

  it("reads facts.resolution, exactly as causeGrounds does - not the outcome column", () => {
    // causeGrounds computes `const outcome = facts.resolution ?? null` and
    // branches on that. Reading analyses.outcome here instead would be a
    // second definition of what a row settled as, on rows where the two
    // disagree.
    const body = sql.split("as $function$")[1];
    expect(body).toContain("nullif(m.f->>'resolution', '') as res");
    expect(body).not.toMatch(/\ba\.outcome\b/);
    expect(body).not.toMatch(/\bm\.outcome\b/);
  });
});

describe("the population the panel draws is measured, not asserted", () => {
  it("derives the narrowness of the record from the record", () => {
    const s = readSeparatedScores(live)!;
    const b = separatedBasis(s.population);
    expect(b.pairs).toBe(1);
    // 2026-08-29 to 2026-09-10.
    expect(b.days).toBe(12);
    expect(b.topSignal).toBe("SELL");
    // 55 of 97.
    expect(b.topShare).toBe(57);
  });

  it("has no span rather than a span of zero when a date is missing", () => {
    const s = readSeparatedScores({ ...live, population: { ...live.population, last_call_at: null } })!;
    expect(separatedBasis(s.population).days).toBeNull();
    const none = readSeparatedScores({ ...live, population: { ...live.population, calls: 0, signals: {} } })!;
    expect(separatedBasis(none.population).topSignal).toBeNull();
    expect(separatedBasis(none.population).topShare).toBeNull();
  });

  it("calls nothing decided while an interval still contains even odds", () => {
    const s = readSeparatedScores(live)!;
    // All three of today's intervals straddle 50%.
    expect(separatedUndecided(s.scopes.all_time)).toBe(true);
    expect(separatedUndecided(null)).toBe(true);
    const settled = readSeparatedScores({
      ...live,
      scopes: {
        all_time: {
          ...live.scopes.all_time,
          direction: { n: 300, hits: 240, rate: 80, ci95: [75, 84], unscored: 0 },
          timing: { n: 300, hits: 210, rate: 70, ci95: [65, 75], unscored: 0, deep_mae: { n: 300, hits: 60, rate: 20, ci95: [16, 25], unscored: 0 } },
          placement: { n: 300, hits: 225, rate: 75, ci95: [70, 80], unscored: 0 },
        },
      },
    })!;
    expect(separatedUndecided(settled.scopes.all_time)).toBe(false);
  });
});
