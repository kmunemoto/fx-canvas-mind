// Prompts and response contracts for the post-mortem model calls.
//
// Two calls. The diagnosis reads one plan and its facts and names a cause
// and a lesson; the consolidation reads every lesson and the record and
// rewrites the rulebook. Both use structured outputs, and both are parsed
// back defensively — a malformed answer becomes "no diagnosis", never a
// stored one.
//
// The consolidation is where a learning loop goes wrong quietly, so the
// numbers it is given and the numbers it may write back are both kept
// honest here: statistics below a sample floor are handed over as null, a
// rule's support is computed from the lessons it cites (and a citation
// only counts when the lesson is actually about the rule's failure), plans
// made in the same market situation count once, and a revision may add or
// drop only a couple of rules so that any version of the rulebook lives
// long enough to be measured.
//
// Deno-free on purpose: src/test/postmortem.test.ts imports this file
// directly.

import { WAIT_SCORER } from "../analyze/entry.ts";
import {
  CAUSES,
  CHOP_CROSSINGS,
  DIRECTION_DEAD_R,
  LATE_LIFE_RATIO,
  LUCKY_MAE_R,
  MARKET_CONTRACT,
  MIN_DANGER_BARS,
  PULLBACK_R,
  SPIKE_CLOSE_R,
  SPIKE_REVERSAL_R,
  UNDERWATER_RATIO,
  canonicalCause,
  causeGrounds,
  causesFor,
  causesForSignal,
  isCause,
  type Cause,
  type PostmortemFacts,
} from "./facts.ts";
import { MIN_RISK_REWARD, MIN_STOP_ATR, TREND_ADX } from "../analyze/entry.ts";
import { isRuleKind, orderRules, type Rule, type RuleKind } from "../analyze/rules.ts";
import { LEGACY_PLAN_CONTRACT } from "../_shared/contract.ts";
import { EPISODE_DEFINITION_VERSION, episodeIds } from "../_shared/episodes.ts";

export const MAX_RULES = 10;
// Storage caps, per language, because one number cannot serve both. The
// schema asks for 90-100 characters of Japanese and the same sentence in
// English; English renders that in roughly two to two and a half times the
// characters, so a shared 160 cut two rules in three and fifteen lessons in
// seventeen mid-word (measured 2026-09-05), while the Japanese never came
// within fifty characters of the cap. Each cap sits well above what its
// language is asked for, the way 160 sat above 100 for Japanese alone.
export const MAX_LESSON_CHARS = 160;
export const MAX_LESSON_CHARS_EN = 320;
export const MAX_RULE_CHARS = 160;
export const MAX_RULE_CHARS_EN = 320;
// The revision note has the same shape of problem one step behind: v8 stored
// 567 English characters against a shared 600 while its Japanese ran 304, so
// the next one cuts. Display-only, but displayed in the reader's language.
export const MAX_SUMMARY_CHARS = 600;
export const MAX_SUMMARY_CHARS_EN = 1200;
// Below this many settled trades a win rate is not a statistic
export const MIN_STAT_N = 20;
// Rules a single revision may add / drop
export const MAX_RULES_ADDED = 2;
export const MAX_RULES_REMOVED = 2;
// What "one situation" means lives in _shared/episodes.ts now, so that this
// file, src/lib/outcomeStats.ts and public.performance_stats cannot drift
// apart again — they had drifted into three different rules, and the one this
// file used decided which rules survive a revision. Re-exported because every
// caller here already reads them from this module.
export { CLUSTER_REOPEN_MS, CLUSTER_WINDOW_MS, EPISODE_DEFINITION_VERSION } from "../_shared/episodes.ts";
export type { Clusterable } from "../_shared/episodes.ts";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Trimmed on both sides of the cut: trimming only before it lets the cut
// itself leave a trailing space, and then the same sentence stored twice
// differs by that one character. That is not a hypothetical — it made the
// first live `reworded` a false positive (rulebook v8, rule r11).
const str = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max).trim() : "");

const strList = (v: unknown, max = 6, each = 300): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max) : [];

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(hi, Math.max(lo, n)));
};

const round2 = (v: number) => Number(v.toFixed(2));

// ---------------------------------------------------------------------------
// Clusters and statistics
// ---------------------------------------------------------------------------

// The one implementation, imported. What used to stand here anchored its
// window on the PREVIOUS plan rather than the episode's start — a chain that
// under a steady cadence fuses everything on a pair into a single episode —
// and carried an older plan's settlement forward through `Math.max`, so a plan
// could escape on the strength of some other, long-closed plan while the plan
// immediately before it was still open. Both are gone; see the module header
// in _shared/episodes.ts for what replaced them and why.
//
// Re-exported under the old name because summarizeRecord, ruleEvidence and the
// vitest suite all call it that.
export { episodeIds as clusterIds };

// One shared rulebook, many accounts: take the newest from each contributor
// in turn rather than the newest overall.
//
// The record and the lessons are read newest-first with a fixed limit. With
// one account that is simply "the recent past". With several it is "whoever
// analysed most", and the rulebook quietly becomes that person's — their
// pairs, their timeframes, their read of the market — while everyone else's
// results never enter the window at all.
//
// Round-robin needs no threshold and no notion of a fair share: it degenerates
// to plain newest-first when one account contributed, and it never lets a
// heavy account take a second row before every other account has taken a
// first. What it cannot fix is an account whose volume exceeds the fetch
// window entirely — hence the over-fetch at the call site and the contributor
// counts in the run summary, so crowding is visible rather than assumed away.
export const fairShare = <T>(items: T[], userOf: (x: T) => string, limit: number): T[] => {
  if (limit <= 0) return [];
  const byUser = new Map<string, T[]>();
  for (const item of items) {
    const key = userOf(item);
    const list = byUser.get(key);
    if (list) list.push(item);
    else byUser.set(key, [item]);
  }
  const queues = [...byUser.values()];
  if (queues.length <= 1) return items.slice(0, limit);
  const out: T[] = [];
  for (let round = 0; out.length < limit; round++) {
    let took = false;
    for (const queue of queues) {
      if (queue.length <= round) continue;
      out.push(queue[round]);
      took = true;
      if (out.length >= limit) break;
    }
    if (!took) break;
  }
  return out;
};

// Wilson score interval for a proportion, in percent
export const wilson = (successes: number, n: number, z = 1.96): [number, number] | null => {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.round(Math.max(0, centre - half) * 100), Math.round(Math.min(1, centre + half) * 100)];
};

export interface RecordRow {
  id?: string;
  user_id?: string | null;
  pair: string;
  signal: string;
  created_at: string;
  closed_at?: string | null;
  outcome: string;
  shadow: boolean;
  // A weekend preview: a reading taken while the market was shut, kept as a
  // record of a thing that happened and counted in nothing. It is read here
  // only so that it can be left OUT of the episode scan, which is where
  // performance_stats already leaves it — see summarizeRecord.
  preview?: boolean;
  rejection: string | null;
  // What the ANALYST asked for, before the gate answered. Without it a WAIT the
  // model itself proposed is indistinguishable here from a plan the gate took
  // away: the confidence floor stamps a rejection on both.
  proposed_signal?: string | null;
  filled: boolean;
  entry: number | null;
  stop: number | null;
  tp1: number | null;
  // What the judge saw the plan fill at, when it recorded one
  fill_price?: number | null;
  outcome_price: number | null;
  rulebook_version: number | null;
  // Which entry contract the plan was made under. Rows from any contract but
  // the live one are counted apart rather than pooled: under entry_chosen_v1
  // the model picked the entry price and a plan the market never reached was
  // never scored at all, which cannot happen under market_v1. A rate taken
  // over both describes a population that never existed.
  contract?: string | null;
  // The verdict on a call that declined to trade, once the tracker has
  // reached one. 'missed' means the market then offered a trade this app
  // would itself have allowed, and it won.
  wait_verdict?: string | null;
  wait_scorer?: number | null;
}

// What the plan made or lost, in multiples of its planned risk. A win is
// paid at TP1, a loss costs 1R, an expiry is marked where it closed.
// Frictionless: no spread or slippage is charged.
export const realizedR = (
  row: Pick<RecordRow, "signal" | "outcome" | "entry" | "stop" | "tp1" | "outcome_price" | "fill_price">,
): number | null => {
  const { stop, tp1 } = row;
  // The price the trade actually opened at, when the judge recorded one
  const entry = typeof row.fill_price === "number" && Number.isFinite(row.fill_price) ? row.fill_price : row.entry;
  if (entry === null || stop === null || tp1 === null || ![entry, stop, tp1].every(Number.isFinite)) return null;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const sign = row.signal === "BUY" ? 1 : row.signal === "SELL" ? -1 : 0;
  if (sign === 0) return null;
  if (row.outcome === "win") return round2(Math.abs(tp1 - entry) / risk);
  if (row.outcome === "loss") return -1;
  if (row.outcome === "expired" && row.outcome_price !== null && Number.isFinite(row.outcome_price)) {
    return round2((sign * (row.outcome_price - entry)) / risk);
  }
  return null;
};

export interface Bucket {
  plans: number;
  wins: number;
  losses: number;
  untriggered: number;
  open: number;
  sum_r: number;
}

const emptyBucket = (): Bucket => ({ plans: 0, wins: 0, losses: 0, untriggered: 0, open: 0, sum_r: 0 });

const addToBucket = (b: Bucket, row: RecordRow) => {
  b.plans++;
  if (row.outcome === "win") b.wins++;
  else if (row.outcome === "loss") b.losses++;
  else if (row.outcome === "untriggered") b.untriggered++;
  else if (row.outcome === "pending") b.open++;
  const r = realizedR(row);
  if (r !== null) b.sum_r = round2(b.sum_r + r);
};

// Rows written before the plan_contract column existed are legacy by
// definition: the contract only ever moved forwards.
export const LEGACY_CONTRACT = LEGACY_PLAN_CONTRACT;

export const rowContract = (row: Pick<RecordRow, "contract">): string =>
  typeof row.contract === "string" && row.contract.length > 0 ? row.contract : LEGACY_CONTRACT;

// Which contract the record is about: the one the most recent plan was made
// under. Derived rather than named by a constant so that the next change of
// contract needs no edit here — the day the first plan under a new contract
// is written, the old record stops being pooled into the new one on its own.
export const liveContract = (rows: RecordRow[]): string => {
  let contract = LEGACY_CONTRACT;
  let newest = -Infinity;
  for (const r of rows) {
    if (r.shadow) continue;
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t) || t <= newest) continue;
    newest = t;
    contract = rowContract(r);
  }
  return contract;
};

// Plans made under the seeded empty rulebook (version 0) had no rules in
// force either
export const versionKey = (v: number | null): string => (typeof v === "number" && Number.isFinite(v) && v > 0 ? String(v) : "none");

export interface LessonSummary {
  cause: string;
  cluster?: string | null;
  // The entry contract the plan was made under, so the editor can tell a
  // lesson whose remedy still exists from one whose remedy does not
  contract?: string | null;
  shadow?: boolean;
  rule_blamed?: string | null;
  rule_credited?: string | null;
}

export interface RecordStats {
  // Which entry contract every number below is about, and how many rows were
  // left out because they were made under a different one
  contract: string;
  other_contract_rows: number;
  total: number;
  wins: number;
  losses: number;
  untriggered: number;
  expired: number;
  ambiguous: number;
  open: number;
  // wins + losses: trades that reached one of their own levels
  settled: number;
  // wins + losses + expired — the win-rate denominator. An expiry is a call
  // that did not work out, and leaving it out let a target placed beyond
  // reach sit out the number entirely.
  decided: number;
  // Calls that declined to trade, and how they scored. A WAIT that is never
  // counted can never be wrong, which is the one escape hatch that costs
  // nothing to use; 'missed' is the record's only evidence of over-caution.
  waits: number;
  waits_judged: number;
  waits_missed: number;
  wait_miss_rate: number | null;
  // null until MIN_STAT_N decided trades exist
  win_rate: number | null;
  win_rate_ci95: [number, number] | null;
  fill_rate: number | null;
  realized_r: { n: number; sum: number; mean: number | null };
  // Settled trades counted once per market situation
  independent_clusters: number;
  // Which definition of "one situation" produced the two counts above and
  // by_cause_clusters below. This object is written into rulebook.stats and
  // kept there for the life of the version, and a change in how episodes are
  // counted is indistinguishable afterwards from the analyst getting better or
  // worse — unless the method is stamped beside the number.
  episode_definition_version: number;
  min_stat_n: number;
  // Lessons of live plans by cause (shadow plans apart)
  by_cause: Record<string, number>;
  // The same, counting each cluster once
  by_cause_clusters: Record<string, number>;
  shadow_by_cause: Record<string, number>;
  // How many lessons came from each entry contract. The causes above pool the
  // eras; this is what says in what proportion.
  lessons_by_contract: Record<string, number>;
  // The record of every plan made under each rulebook version — the
  // before/after comparison. It is the version's record, not any one rule's.
  by_rulebook_version: Record<string, Bucket>;
  // How often a diagnosis named a rule as the cause of, or a help to, a
  // result — the one per-rule signal there is
  rule_feedback: Record<string, { blamed: number; credited: number }>;
  // Plans the entry gate refused: the analyst asked for a trade and the server
  // published a WAIT instead. Measured in production 2026-09-08 on market_v1:
  // ONE row, against 16 the editor was being shown as refusals.
  rejected: number;
  // WAITs the analyst chose itself. The editor is asked to weigh standing aside
  // against trading, and it cannot do that if a decision the analyst made and
  // one the server imposed arrive as the same number — the correction for the
  // two is opposite.
  self_declined: number;
  shadow: { total: number; untriggered: number; wins: number; losses: number; open: number };
}

// The record as numbers, from the rows the consolidation is given
export const summarizeRecord = (rows: RecordRow[], lessons: LessonSummary[]): RecordStats => {
  const s: RecordStats = {
    contract: liveContract(rows), other_contract_rows: 0,
    total: 0, wins: 0, losses: 0, untriggered: 0, expired: 0, ambiguous: 0, open: 0,
    settled: 0, decided: 0, waits: 0, waits_judged: 0, waits_missed: 0, wait_miss_rate: null,
    win_rate: null, win_rate_ci95: null, fill_rate: null,
    realized_r: { n: 0, sum: 0, mean: null },
    independent_clusters: 0, episode_definition_version: EPISODE_DEFINITION_VERSION, min_stat_n: MIN_STAT_N,
    by_cause: {}, by_cause_clusters: {}, shadow_by_cause: {}, lessons_by_contract: {},
    by_rulebook_version: {}, rule_feedback: {},
    rejected: 0, self_declined: 0,
    shadow: { total: 0, untriggered: 0, wins: 0, losses: 0, open: 0 },
  };
  let filled = 0;
  let settledOrLapsed = 0;
  // ONE RULE IS NOT ENOUGH: the population has to match too.
  //
  // The rule itself now lives in one file, but this call used to hand it every
  // row it had fetched — shadows, previews, other contracts, WAITs — and drop
  // the ones that do not count inside the loop below. performance_stats
  // filters shadow and preview out BEFORE it clusters. That is not a
  // difference of taste: a row taking part in the scan anchors an episode
  // start and overwrites the previous plan's settlement, so a shadow plan
  // sitting between two real ones moves a boundary here and not there, and the
  // screen's count and the learning path's count go back to being different
  // numbers with the same name. The population is now the same one the SQL
  // uses: everything that is neither a shadow nor a preview, WAITs and other
  // contracts included.
  const scanned = rows.filter((r) => !r.shadow && r.preview !== true);
  const scannedIds = episodeIds(scanned);
  const clusterOf = new Map<RecordRow, string>(scanned.map((r, i) => [r, scannedIds[i]]));
  const settledClusters = new Set<string>();
  rows.forEach((r) => {
    // Before anything else: a plan made under another contract is not part of
    // this record. Counted, so that a record that suddenly shrinks is legible
    // as a contract change rather than as plans going missing.
    if (rowContract(r) !== s.contract) {
      s.other_contract_rows++;
      return;
    }
    if (r.shadow) {
      s.shadow.total++;
      if (r.outcome === "untriggered") s.shadow.untriggered++;
      else if (r.outcome === "win") s.shadow.wins++;
      else if (r.outcome === "loss") s.shadow.losses++;
      else if (r.outcome === "pending") s.shadow.open++;
      return;
    }
    if (r.signal === "WAIT") {
      // Who declined, kept apart. `rejection` alone cannot say: the confidence
      // floor writes 'low_confidence' onto a WAIT the model itself answered, so
      // counting the string made 16 of the analyst's own calls look like the
      // server overruling it. A row with no proposed_signal at all — written
      // before the field existed — is counted in neither, the same silence
      // isRejected/isSelfDeclined keep on the screen.
      //
      // And the same population the screen and performance_stats count over:
      // both exclude previews. This loop does not (only `scanned` above does),
      // so the four weekend reads in production — every one stamped
      // market_closed, two over a proposed SELL — would arrive as 3 refusals
      // and 18 self-declines beside a system prompt that says the refusals are
      // 1. Two numbers with one name is the failure being fixed, so the split
      // is measured over the population it is named after. `waits` and `total`
      // keep their older, wider population: that gap predates this split and
      // moving it would change rates nobody asked to have moved.
      const counted = r.preview !== true;
      if (counted && r.rejection && (r.proposed_signal === "BUY" || r.proposed_signal === "SELL")) s.rejected++;
      if (counted && r.proposed_signal === "WAIT") s.self_declined++;
      s.waits++;
      // 'pending' and 'unknown' are not verdicts, so they stay out of both
      // sides of the rate: the first has not been judged yet, the second
      // never can be. Nor is 'no_call' — nothing at the time named a side.
      //
      // And only the current scorer's verdicts count. The first scorer chose
      // the direction from whichever side paid, so its miss rate measured the
      // market's range; averaging the two rules into one number would carry
      // that in forever, invisibly.
      if ((r.wait_scorer ?? 0) >= WAIT_SCORER && (r.wait_verdict === "missed" || r.wait_verdict === "correct")) {
        s.waits_judged++;
        if (r.wait_verdict === "missed") s.waits_missed++;
      }
      return;
    }
    s.total++;
    if (r.outcome === "win") s.wins++;
    else if (r.outcome === "loss") s.losses++;
    else if (r.outcome === "untriggered") s.untriggered++;
    else if (r.outcome === "expired") s.expired++;
    else if (r.outcome === "ambiguous") s.ambiguous++;
    else if (r.outcome === "pending") s.open++;
    if (r.outcome === "win" || r.outcome === "loss" || r.outcome === "expired" || (r.outcome === "ambiguous" && r.filled)) {
      filled++;
      settledOrLapsed++;
    } else if (r.outcome === "untriggered") {
      settledOrLapsed++;
    }
    const cluster = clusterOf.get(r);
    if (cluster !== undefined && (r.outcome === "win" || r.outcome === "loss")) settledClusters.add(cluster);
    const rr = realizedR(r);
    if (rr !== null) {
      s.realized_r.n++;
      s.realized_r.sum = round2(s.realized_r.sum + rr);
    }
    addToBucket(s.by_rulebook_version[versionKey(r.rulebook_version)] ??= emptyBucket(), r);
  });
  s.settled = s.wins + s.losses;
  s.decided = s.settled + s.expired;
  s.win_rate = s.decided >= MIN_STAT_N ? Math.round((s.wins / s.decided) * 100) : null;
  s.win_rate_ci95 = wilson(s.wins, s.decided);
  s.fill_rate = settledOrLapsed >= MIN_STAT_N ? Math.round((filled / settledOrLapsed) * 100) : null;
  s.wait_miss_rate = s.waits_judged >= MIN_STAT_N
    ? Math.round((s.waits_missed / s.waits_judged) * 100)
    : null;
  s.realized_r.mean = s.realized_r.n > 0 ? round2(s.realized_r.sum / s.realized_r.n) : null;
  s.independent_clusters = settledClusters.size;
  const causeClusters = new Map<string, Set<string>>();
  lessons.forEach((l, i) => {
    // Counted under the live spelling, so a rename does not split one concept
    // across two buckets in a histogram this small.
    const cause = canonicalCause(l.cause);
    s.lessons_by_contract[l.contract ?? LEGACY_CONTRACT] =
      (s.lessons_by_contract[l.contract ?? LEGACY_CONTRACT] ?? 0) + 1;
    if (l.shadow) {
      s.shadow_by_cause[cause] = (s.shadow_by_cause[cause] ?? 0) + 1;
      return;
    }
    s.by_cause[cause] = (s.by_cause[cause] ?? 0) + 1;
    const set = causeClusters.get(cause) ?? new Set<string>();
    set.add(l.cluster ?? `lesson-${i}`);
    causeClusters.set(cause, set);
    // A cause that cannot support a rule cannot vote on one either.
    // rule_feedback is the per-rule signal the consolidation prompt tells the
    // editor to act on, and good_wait was declared evidence for nothing —
    // yet ten WAITs correctly declined under a rule would have credited it
    // ten times, outvoting the trades it actually lost. Same reasoning for
    // good_call, inconclusive and plan_incoherent, which reached it before,
    // and now for sound_call_lost: a loss no lever would have changed must not
    // blame the rule that was in force while it happened.
    if (!NOT_RULE_EVIDENCE.includes(cause)) {
      if (l.rule_blamed) (s.rule_feedback[l.rule_blamed] ??= { blamed: 0, credited: 0 }).blamed++;
      if (l.rule_credited) (s.rule_feedback[l.rule_credited] ??= { blamed: 0, credited: 0 }).credited++;
    }
  });
  for (const [cause, set] of causeClusters) s.by_cause_clusters[cause] = set.size;
  return s;
};

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

// The analyst's own claim about which rules it used, taken back out of the
// context before the diagnosis sees it.
//
// analyze records that claim on the plan as context.rule_fit.claimed_by_analyst
// (2026-09-08). The plan goes into both diagnosis prompts WHOLE — the payload
// is JSON.stringify of the PlanSummary, context included — and the diagnosis is
// then asked for rule_blamed and rule_credited. That is not a hypothetical
// path: 23 of the 31 lessons written under rulebook version 8 set one of those
// two fields (9 blamed, 14 credited). Leaving the claim in would let the
// diagnosis blame or credit a rule because the analyst said it used it.
//
// A SELF-REPORT IS NOT EVIDENCE ABOUT A RULE. The only thing it is worth
// recording for is the comparison afterwards — what the analyst said it used,
// against what the server measured about the same rules — and that comparison
// is destroyed the moment the claim has already fed the judgement it would be
// compared with. So it is stripped HERE, at the handoff, and never from the
// stored row: the row keeps the claim, the diagnosis simply never sees it.
//
// Nothing else in postmortem/ picks the claim up by another route. The plan's
// context is read in one place (postmortem/index.ts), the rulebook editor's
// digest does not select the column at all (see the record pool query), and the
// rules a plan was shown reach the diagnosis by id from the rulebook table,
// not from this object.
export const withoutAnalystClaim = (context: JsonRecord | null): JsonRecord | null => {
  if (context === null) return null;
  const fit = context.rule_fit;
  if (!isRecord(fit) || !("claimed_by_analyst" in fit)) return context;
  const { claimed_by_analyst: _claimed, ...measured } = fit;
  return { ...context, rule_fit: measured };
};

export interface PlanSummary {
  id: string;
  pair: string;
  interval: string;
  signal: string;
  mode: string | null;
  confidence: number | null;
  thesis: string | null;
  entry: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number | null;
  take_profit_3: number | null;
  price_at_signal: number | null;
  created_at: string;
  outcome: string;
  reason: string | null;
  filled_at: string | null;
  resolved_at: string | null;
  mfe_r: number | null;
  mae_r: number | null;
  tps_hit: number[];
  key_factors: string[];
  warnings: string[];
  analysis: string;
  market_context_detail: JsonRecord | null;
  timeframe_alignment: unknown[];
  entry_check: JsonRecord | null;
  context: JsonRecord | null;
  // Which entry contract the plan was made under. Old plans chose their own
  // entry price; new ones cannot, so the levers a lesson may move differ.
  contract?: string | null;
  // A plan the entry gate refused, tracked to check the refusal
  shadow: boolean;
  // The rules the plan was actually shown, so the diagnosis can say whether
  // one of them caused the miss
  rules_in_force?: Array<{ id: string; text_ja: string }>;
}

export interface Diagnosis {
  cause: Cause;
  secondary_causes: Cause[];
  avoidable: boolean;
  confidence: number;
  verdict_ja: string;
  verdict_en: string;
  evidence_ja: string[];
  evidence_en: string[];
  lesson_ja: string;
  lesson_en: string;
  scope: string | null;
  // Rule ids (from rules_in_force) the diagnosis blames or credits
  rule_blamed: string | null;
  rule_credited: string | null;
}

// The vocabulary the MODEL is offered, which is the row's own vocabulary minus
// sound_call_lost.
//
// "No lever we can move would have changed this outcome" is a claim about the
// whole lever table — four counterfactuals and the eight tests around them,
// all of them arithmetic — and the one thing it must never become is a place
// to put a loss nobody could explain. So it is earned by noFaultGrounds or not at all: the
// model cannot name it, and parseDiagnosis will not accept it if the schema is
// somehow bypassed. It reaches a row only as facts.hints[0], and only when the
// server's own table says every lever was tested and none of them moved.
const modelCauses = (contract?: string | null, signal?: string | null): Cause[] =>
  causesForSignal(contract, signal).filter((c) => c !== "sound_call_lost");

export const diagnosisSchema = (contract?: string | null, signal?: string | null) => ({
  type: "object",
  properties: {
    cause: { type: "string", enum: modelCauses(contract, signal) },
    secondary_causes: { type: "array", items: { type: "string", enum: modelCauses(contract, signal) } },
    avoidable: { type: "boolean", description: "分析時点の情報だけで回避できたか" },
    confidence: { type: "integer", description: "診断の確からしさ 0-100" },
    verdict_ja: { type: "string", description: "何が起きたかの結論。日本語、120字以内" },
    verdict_en: { type: "string", description: "The same conclusion in English, one or two sentences" },
    evidence_ja: { type: "array", items: { type: "string" }, description: "根拠 2-4 点。facts の数値を引用する。日本語" },
    evidence_en: { type: "array", items: { type: "string" }, description: "The same evidence in English" },
    lesson_ja: { type: "string", description: "次回に使う一般則。「条件 → 行動」の形、90字以内、日本語。個別の価格・日付を含めない" },
    lesson_en: { type: "string", description: "The same lesson in English, 220 characters or fewer" },
    scope: { type: ["string", "null"], description: "ルールが当てはまる範囲を短く（例: '1h/4h の戻り売り', 'レンジ相場'）。無ければ null" },
    rule_blamed: { type: ["string", "null"], description: "plan.rules_in_force のうち、この結果を招いたルールの id。無ければ null" },
    rule_credited: { type: ["string", "null"], description: "plan.rules_in_force のうち、この結果に貢献したルールの id。無ければ null" },
  },
  required: [
    "cause", "secondary_causes", "avoidable", "confidence",
    "verdict_ja", "verdict_en", "evidence_ja", "evidence_en",
    "lesson_ja", "lesson_en", "scope", "rule_blamed", "rule_credited",
  ],
  additionalProperties: false,
});

// The legacy-era shape, kept as the name the tests and older callers use.
export const DIAGNOSIS_SCHEMA = diagnosisSchema();

export const DIAGNOSIS_SYSTEM_PROMPT = `あなたはFXトレードの検証担当（ポストモーテム）です。AIアナリストが出したトレードプランと、その後の実際の値動きから計算した事実（facts）を突き合わせ、なぜその予想が外れた（または当たった）のかを厳密に診断します。

原則:
- 負けたこと自体は、判断が間違っていた証拠ではない。損失は結果であって、原因ではない。原因を名指しできるのは、動かせるレバー（方向・損切り幅・利確幅・そもそも入るか）のどれかが実際に結果を変えていたと facts が示すときだけ。示していないなら、その回について書けることは「動かせるレバーはどれも結果を変えなかった」か「まだ材料が足りない」のどちらかであって、方向のせいにして埋めない。
- 反実仮想が「勝っていた」ことは、仮説の材料であって、次のプランでレバーを動かす理由ではない。同じ変更は別の場面で損失を大きくしうる。1件の反実仮想から「次回は損切りを広げる／利確を近づける」と書かない。lesson にするのは、同じ条件が繰り返し同じ結果を出していると facts と stats が示すときだけ。
- 根拠にしてよいのは facts と plan に書かれていることだけ。事実に無い出来事（ニュース等）を推測で作らない。ニュース要因（news_shock）は、plan の warnings/key_factors に指標やイベントへの言及があり、かつ facts.abnormal_bar が観測された場合に限る。
- 次の順に検討する: (1) 方向は合っていたか (2) その場面で入ったこと自体が妥当だったか（伸びきった動きに飛び乗っていないか。旧契約 entry_chosen_v1 のプランでは、約定したか・逃したかも見る） (3) 損切り幅は適切だったか (4) 利確は届く距離だったか (5) 相場環境（トレンド/レンジ）の読みは正しかったか。
- facts.counterfactual は原因の切り分けに使う最重要の証拠。market_entry（成行で入っていたら）、market_entry_same_risk（成行で入り損切り幅を元のプランと同じにしていたら）、stop_x1_5 / stop_x2（損切りを広げていたら）、tp_half（利確を半分にしていたら）、limit_pullback（同じプランを ${PULLBACK_R}R 有利な値で約定していたら。損切り幅は同じ。現行契約では出せる注文ではなく、「伸びきったところを掴んだ」ことの尺度）。各項目の rr はその案自体のリスクリワード、viable はサーバーのエントリーゲートを通る案かどうか、gate は通らない理由（poor_rr: RR ${MIN_RISK_REWARD} 未満、stop_too_tight: 損切り幅 ATR${MIN_STOP_ATR}倍未満、too_far: 指値が現在値から遠すぎる、should_be_market: トレンド局面ではサーバーが指値を成行に修正する）。viable=false の案は「勝っていた」としても採用できない案なので、それを根拠に「成行にすべきだった」「指値にすべきだった」等の教訓を書かない。limit_pullback が win なら「その値位置で入るには遅すぎた」という事実であって、指値・押し目待ちの推奨ではない。ここから書ける lesson は「その条件では見送る（WAIT）」の形だけ。gate はその案が当時のゲートを通るかを示すだけで、「指値にすべきだった」の根拠にはならない。
- facts.hints は決定論的な事前分類で、通常はその中から選ぶ。覆す場合は evidence で理由を示す。facts.notes には判定の補足がある。
- facts.early_adverse_r は約定直後 3 本以内の最大逆行（R、取引中のみ）。即座に逆行した場合、伸びきった動きに乗った（chased_move）を疑う。
- lesson は「条件 → 行動」の形で、次回以降のプラン作成に直接使える一般則にする。個別の価格・日付・その日固有の出来事は書かない。同じ状況が来たときに何を変えるかを書く。
- lesson の「条件」は指標由来の観測量（ADX、ATR、SMA20/50の並び、上位足との整合、RSI、直近の値幅）で書く。アナリスト自身の自己申告（confidence の高さ、mode の宣言）を条件にしない。
- lesson は、アナリストが実際に出力できる範囲の指示にする。プランは1つのエントリー価格・1つの損切り・3つの利確で構成され、分割エントリー・ナンピン・両建て・トレーリングストップは表現できない。「一部を成行、残りを指値」のような分割指示は書かない。基本手順（損切りの幅、RR の下限）は lesson で上書きできない。その範囲内で書く。
- plan.contract が "market_v1" のプランでは、エントリー価格はアナリストが選んでいない。分析した瞬間の現在値がそのまま成行の約定価格になったものであり、「もっと引きつけて入るべきだった」「押し目を待つべきだった」は実行できない指示なので lesson にしない。動かせるのは方向・損切り幅・利確幅・そもそも入るか（WAIT）の4つだけで、lesson はそのいずれかを動かす形にする。反実仮想の limit_pullback も、この契約のプランでは「その状況では入らない（WAIT）」の根拠としてのみ読む。
- plan.contract が "entry_chosen_v1"（または未記載）の古いプランは、アナリストがエントリー価格を選んでいた時代のもの。当時の事実として検証してよいが、そこから引く lesson は上の4つの範囲に翻訳して書く。entry_too_far / entry_too_early はこの契約でのみ起こりうる原因で、market_v1 のプランでは選べない（スキーマの enum からも除いてある）。
- facts.danger は約定したプランの「危うさ」を約定から決着までの足で測ったもの。bars_in_trade（保有した足の本数）、underwater_bars / underwater_ratio（終値がエントリーより不利な側にあった足の本数と割合）、longest_underwater_bars（含み損が続いた最長の本数）、entry_crossings（終値がエントリー価格をまたいだ回数）、closest_to_stop_r（損切りまで最も近づいたときの残り R = 1 − mae_r）、target_bar_close_r（勝ちのみ。TP1 に届いた足の終値と TP1 の差を R で表したもの。負なら終値は TP1 に届いていない）、reversed_after_r（勝ちのみ。決着後の足で TP1 からどれだけ戻したか、R）、life_used_ratio（決着までに使った時間を、その時間足の期限に対する割合で表したもの）。flags は勝ちのときだけ立ち、各フラグの意味は: deep_mae（mae_r ≥ ${LUCKY_MAE_R}。損切り直前まで逆行した）、mostly_underwater（underwater_ratio ≥ ${UNDERWATER_RATIO} かつ ${MIN_DANGER_BARS} 本以上保有。保有期間の大半が含み損だった）、chop（entry_crossings ≥ ${CHOP_CROSSINGS}。エントリー価格を何度もまたいだ）、spike_target（target_bar_close_r ≤ −${SPIKE_CLOSE_R} かつ reversed_after_r ≥ ${SPIKE_REVERSAL_R}。利確はヒゲだけで、その後 ${SPIKE_REVERSAL_R}R 以上戻した）、late_win（life_used_ratio ≥ ${LATE_LIFE_RATIO}。期限の大半を使ってようやく届いた）。
- lucky_win は facts.danger.flags に実際に立っているフラグで根拠づける（evidence でそのフラグ名と数値を挙げる）。立っていないフラグを理由にしない。フラグが一つも無い勝ちは、plan や facts の他の項目に問題が見えない限り good_call とする。
- plan.rules_in_force があれば、そのプランがどのルールの影響下で作られたかを踏まえ、結果を招いた／貢献したルールがあれば rule_blamed / rule_credited に id を書く。無ければ null。
- confidence は診断の確からしさ。決着後の足が無い、反実仮想が ambiguous 等、事実が少ないときは下げる。
- shadow=true のプランは、サーバー側のエントリーゲートが「約定しない」等の理由で却下したものを検証用に追跡した結果である。却下が正しかったか（未約定なら正しい、勝っていたなら誤り）を verdict に含める。

原因の定義（下の条件を facts が明確に否定している原因を選ぶと、サーバー側で却下され、決定論的な hint に差し戻される。そのとき verdict と lesson も破棄される。facts から判定できない原因は却下されないので、plan を読んで言えることは書いてよい）:
- direction_wrong: 方向そのものが逆。損切り後も逆行が続いた（after.beyond_sl_r ≥ 1 かつ after.reached_tp1 が null）か、そもそも順行が ${DIRECTION_DEAD_R}R も出ていない（from_signal.max_favorable_r < ${DIRECTION_DEAD_R}）かのどちらか。約定前に損切り側へ到達（reason=invalidated）した未約定プランも同じ。「他に説明が付かないから方向のせい」は理由にならない。
- stop_too_tight: 方向は合っていたが損切りが近すぎた。損切り到達後に TP1 へ到達（after.reached_tp1）、または損切りを広げた反実仮想（stop_x1_5 / stop_x2）が win。そのどちらも無ければこの原因は選べない。広げた案が viable でない（RR 不足）場合、lesson は「損切りを広げる」だけでなく利確の置き方も併せて書く。
- entry_too_far:（entry_chosen_v1 の旧プランのみ）方向は合っていたがエントリーが約定しなかった。成行の反実仮想（market_entry または market_entry_same_risk）が viable かつ win。market_v1 のプランでは起こりえない。
- chased_move: 伸びきった動きに乗ってしまい、約定直後の逆行で損切り。early_adverse_r が大きく、limit_pullback（${PULLBACK_R}R 有利な約定）が win。同じ方向・同じ損切り幅でも、より良い値なら勝っていたということ。remedy は「その場面では入らない（WAIT）」であって、押し目を待つことではない。旧プランでは entry_too_early と呼んでいた同じ事象。
- target_too_far: 約定して順行したが TP1 に届かず反転。利確を半分にした反実仮想（tp_half）が win であることが必須で、mfe_r が大きいだけでは足りない。
- regime_misread: トレンド/レンジの読み違い。facts.regime.conflict、レンジ相場でのトレンドフォロー等。
- news_shock: 指標・イベントの異常な値幅でプランが無効化された。facts.abnormal_bar.event があれば、その足で実際に発表された経済指標なので、推測ではなく事実として名指ししてよい。event が null の異常足は「原因不明の急変動」であって、指標のせいだと断定しない。
- plan_incoherent: 水準の矛盾で判定不能。
- good_call: 想定通りに勝った。
- lucky_win: 勝ったがプロセスに問題があった。
- inconclusive: 事実が足りず断定できない。`;

const compactAnalysis = (text: string, max = 1400): string =>
  text.length <= max ? text : `${text.slice(0, max)}…（以下省略）`;

export const buildDiagnosisPrompt = (
  plan: PlanSummary,
  facts: PostmortemFacts,
): { system: string; user: string; schema: ReturnType<typeof diagnosisSchema> } => {
  const payload = {
    plan: {
      ...plan,
      analysis: compactAnalysis(plan.analysis),
    },
    facts,
  };
  const user = [
    "次のトレードプランを検証してください。plan は AI が出したプラン（と、その時点で見ていた指標 context、適用されていたルール rules_in_force）、facts は実際の値動きから計算した事実です。",
    "数値の単位: *_r はプランのリスク幅（エントリー〜損切り）を 1 とした倍率。時刻は UTC。",
    "",
    JSON.stringify(payload),
  ].join("\n");
  return { system: DIAGNOSIS_SYSTEM_PROMPT, user, schema: diagnosisSchema(plan.contract, plan.signal) };
};

// Diagnosing a call that declined to trade.
//
// A WAIT has no fill, no stop and no target of its own, so the trade prompt's
// five questions ("was the stop too tight", "did the target come") describe
// nothing that happened. What it does have is the trade it declined — fixed
// at the moment of the call and stored on the row — and what the market then
// did to that trade. So the question narrows to one: was declining right?
//
// The facts handed over are the ones computed for that hypothetical trade, so
// the prompt must be explicit that it never existed. A diagnosis that reads
// as though the trade was taken would produce lessons about managing a
// position nobody held.
export const WAIT_DIAGNOSIS_SYSTEM_PROMPT = `あなたはFXトレードの検証担当（ポストモーテム）です。今回検証するのは「見送った（WAIT）」という判断です。

前提:
- plan.wait_plan は、見送った時点で確定して保存された「もし入っていたらこのトレードだった」という想定です。方向・エントリー・損切り・利確はすべて判断した時点の情報だけで決めてあり、その後の値動きを見て選んだものではありません。
- facts は、その想定トレードを実際の値動きに当てはめて計算した事実です。**このトレードは実行されていません。** 建玉があったかのような書き方をしないでください。
- plan.wait_check.verdict は採点結果です。missed = 想定したトレードは利確に届いていた（見送りが機会損失になった）。correct = 損切りに掛かったか、期間内に届かなかった（見送りは妥当だった）。

原則:
- 根拠にしてよいのは facts と plan に書かれていることだけ。事実に無い出来事（ニュース等）を推測で作らない。news_shock は plan の warnings/key_factors に指標やイベントへの言及があり、かつ facts.abnormal_bar が観測された場合に限る。
- cause は次から選ぶ: wait_missed_trade（見送ったが取れていた）、good_wait（見送りは妥当だった）、regime_misread（相場環境の読み違いが見送りの理由になっていた）、news_shock（イベントが値動きを支配した）、inconclusive（判断材料が足りない）。
- 見送りが妥当だった回に無理やり教訓を作らない。good_wait のときの lesson は「この条件では見送ってよい」という確認で足り、行動を変える指示は書かない。
- 「見送るべきではなかった」と書けるのは、想定トレードが利確に届いており、かつ判断時点の指標からその方向が読めた場合だけです。値動きを見てから「あの方向だった」と言わないでください。
- lesson は「条件 → 行動」の形で、次回以降のプラン作成に直接使える一般則にする。個別の価格・日付・その日固有の出来事は書かない。
- lesson の「条件」は指標由来の観測量（ADX、ATR、SMA20/50の並び、上位足との整合、RSI、直近の値幅）で書く。アナリスト自身の自己申告（confidence の高さ、mode の宣言）を条件にしない。
- 動かせるレバーは4つだけです: 方向、損切りの幅、利確の距離、そもそも取引するかどうか。エントリー価格は選べません（サーバーが分析時点の現在値で入ります）。
- 見送りの検証は、放っておくと「常に見送る」が最善手になってしまうことへの唯一の歯止めです。ただし歯止めを効かせたいあまり、根拠のない「取れていた」を書かないでください。

出力は JSON スキーマに従ってください。`;

export const buildWaitDiagnosisPrompt = (
  plan: PlanSummary & { wait_plan: JsonRecord | null; wait_check: JsonRecord | null },
  facts: PostmortemFacts,
): { system: string; user: string; schema: ReturnType<typeof diagnosisSchema> } => {
  const payload = {
    plan: { ...plan, analysis: compactAnalysis(plan.analysis) },
    facts,
  };
  const user = [
    "次の「見送り（WAIT）」の判断を検証してください。plan は AI が出した判断（と、その時点で見ていた指標 context、適用されていたルール rules_in_force、見送った時点で確定した想定トレード wait_plan、その採点結果 wait_check）、facts はその想定トレードを実際の値動きに当てはめて計算した事実です。",
    "このトレードは実行されていません。facts の数値はすべて「もし入っていたら」の話です。",
    "数値の単位: *_r は想定トレードのリスク幅（エントリー〜損切り）を 1 とした倍率。時刻は UTC。",
    "",
    JSON.stringify(payload),
  ].join("\n");
  return { system: WAIT_DIAGNOSIS_SYSTEM_PROMPT, user, schema: diagnosisSchema(plan.contract, "WAIT") };
};

// A cause the facts REFUSE, the model may not assert.
//
// Deleting the loss branch's fallback stops the SERVER filing a loss it cannot
// explain as direction_wrong. It does nothing about the model, which reads the
// same facts and can write the same sentence, and its reading of them is not
// independent of the fallback: three of rule r10's five citations are rows the
// fallback filed as direction_wrong.
//
// This started as a list of three — direction_wrong, stop_too_tight,
// target_too_far — and a list of three was the wrong shape. On a row the lever
// table had just cleared, causeGrounds already answered "contradicted" for
// news_shock, chased_move AND regime_misread as well (they are refused by
// clauses 6, 8 and 7 of noFaultGrounds by construction), and every one of the
// three was accepted verbatim, carried avoidable=true, and was back inside
// CONSTRAINT_CAUSES where r10 could cite it again. Naming three causes fenced
// the three doors the model was least likely to need and left the three next
// to them open.
//
// So the rule is the general one: whatever the model names, if the row's own
// arithmetic contradicts it, the deterministic hint stands instead. "unknown"
// stays permissive — the model is meant to be able to read the plan for
// things these numbers cannot see, and most causes are undecidable from them.
const grounds = (c: Cause, facts?: PostmortemFacts | null) =>
  facts ? causeGrounds(c, facts) : "unknown";

// A malformed answer is not stored. The cause must be one of ours; when the
// model's pick is not, the deterministic hint stands.
export const parseDiagnosis = (
  raw: unknown,
  hints: Cause[],
  ruleIds: string[] = [],
  contract?: string | null,
  signal?: string | null,
  // The row's own facts, for the three causes above. Optional: a caller with
  // no facts (the older tests, a hand-run) gets the previous behaviour rather
  // than a veto it cannot answer.
  facts?: PostmortemFacts | null,
): Diagnosis | null => {
  if (!isRecord(raw)) return null;
  const lessonJa = str(raw.lesson_ja, MAX_LESSON_CHARS);
  const lessonEn = str(raw.lesson_en, MAX_LESSON_CHARS_EN);
  const verdictJa = str(raw.verdict_ja);
  const verdictEn = str(raw.verdict_en);
  if (!lessonJa && !lessonEn) return null;
  if (!verdictJa && !verdictEn) return null;
  // Canonicalised in both eras, so no new row ever stores the dead spelling;
  // a cause the row's own contract cannot produce falls through to the
  // deterministic hint, which is contract-correct by construction.
  const allowed = modelCauses(contract, signal);
  const hint = hints[0] ?? "inconclusive";
  const grounded = (c: Cause): boolean => grounds(c, facts) !== "contradicted";
  const pick = (v: unknown): Cause | null => {
    if (!isCause(v)) return null;
    const k = canonicalCause(v);
    return isCause(k) && allowed.includes(k) && grounded(k) ? k : null;
  };
  // "inconclusive" is the absence of a finding, and causeGrounds can never
  // contradict it, so it was the one word that could still overwrite a
  // finished review with nothing. The server's own lever table has either
  // earned sound_call_lost or not; when it has, the model — which cannot name
  // that cause and is not shown a definition of it — must not be able to
  // answer "not enough basis" about a question the server already answered.
  const downgrades = (k: Cause | null) => k === "inconclusive" && hint === "sound_call_lost";
  const picked = pick(raw.cause);
  const model: Cause | null = picked !== null && !downgrades(picked) ? picked : null;
  // Whether the model named a cause and we refused it — as opposed to naming
  // none, or naming one we kept. Only a refusal makes its prose untrustworthy.
  const overruled = model === null && isCause(raw.cause) && canonicalCause(raw.cause) !== hint;
  const cause: Cause = model ?? hint;
  const secondary = Array.isArray(raw.secondary_causes)
    ? [...new Set(raw.secondary_causes.map(pick).filter((c): c is Cause => c !== null && c !== cause))].slice(0, 3)
    : [];
  const ruleRef = (v: unknown): string | null => {
    const id = str(v, 20);
    return id && ruleIds.includes(id) ? id : null;
  };
  // Refusing the model's CAUSE and keeping its prose stores a row that argues
  // against its own verdict: the badge says one thing and the sentence under
  // it recommends the lever the facts just refused. Worse than the display,
  // that sentence is what the lessons table carries into the next rulebook
  // revision, where it is read as evidence about the hint's cause. So the
  // narrative goes with the cause it was written for. The evidence list is
  // kept — it quotes facts numbers, and those are true whatever was concluded
  // from them — and the scope and the blamed rule are dropped, because both
  // were chosen to fit the refused reading.
  const refusedJa = `モデルは別の原因を挙げたが、facts がそれを支持しないため、サーバー側の判定（${cause}）に差し戻した。`;
  const refusedEn = `The model named a different cause; the facts do not support it, so the server's own reading (${cause}) stands.`;
  return {
    cause,
    secondary_causes: secondary,
    // sound_call_lost is exactly the finding that no lever we can move would
    // have changed the outcome, so "avoidable with what was known at the time"
    // is the one answer it cannot carry. The model never names this cause, but
    // it does answer `avoidable` about whatever it thought the cause was, and
    // that boolean used to pass through verbatim — which would have printed
    // 「分析時点の情報で回避できた」under a verdict that says the opposite.
    // A refused cause loses it for the same reason: the only reading that said
    // this loss was avoidable is the one the facts just refused.
    avoidable: cause === "sound_call_lost" || overruled ? false : raw.avoidable === true,
    confidence: overruled ? Math.min(clampInt(raw.confidence, 0, 100, 50), 30) : clampInt(raw.confidence, 0, 100, 50),
    verdict_ja: overruled ? refusedJa : verdictJa || verdictEn,
    verdict_en: overruled ? refusedEn : verdictEn || verdictJa,
    evidence_ja: strList(raw.evidence_ja),
    evidence_en: strList(raw.evidence_en),
    lesson_ja: overruled ? refusedJa : lessonJa || lessonEn,
    lesson_en: overruled ? refusedEn : lessonEn || lessonJa,
    scope: overruled ? null : str(raw.scope, 60) || null,
    rule_blamed: overruled ? null : ruleRef(raw.rule_blamed),
    rule_credited: ruleRef(raw.rule_credited),
  };
};

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export interface LessonRow {
  analysis_id: string;
  user_id?: string | null;
  pair: string;
  cause: string;
  contract: string | null;
  outcome: string;
  interval: string;
  signal: string;
  mode: string | null;
  order_type: string | null;
  lesson_ja: string;
  lesson_en: string;
  confidence: number | null;
  avoidable: boolean | null;
  shadow: boolean;
  scope: string | null;
  // When the review ran
  created_at: string;
  // When the plan was made (what clustering is about)
  plan_created_at: string | null;
  plan_closed_at?: string | null;
  rule_blamed: string | null;
  rule_credited: string | null;
  // How many bars of aftermath the diagnosis was written on, and the build
  // that wrote it. A diagnosis is made soon after settlement by design
  // (AFTER_WAIT_MS in facts.ts), and depth is the difference between a
  // reading and a guess: 2026-09-07, four losses first diagnosed at 8 bars
  // were re-read at 48-95 bars. TWO changed cause outright (c8788083
  // direction_wrong -> stop_too_tight, 1b003cf3 direction_wrong ->
  // chased_move) and ONE kept the cause but flipped avoidable to false
  // (c14cdb0a). Nothing is on record for the fourth (32d167d3), and it cannot
  // be recovered: the re-read overwrote the earlier document, which is the
  // reason `prior` exists at all. The same build had also changed the cause
  // vocabulary, so depth and that change are not separated, and n is 4. This
  // is why the depth question is being measured rather than answered — see
  // docs/POSTMORTEM_DEPTH_PREREGISTRATION.md. Optional because a lesson
  // written before the column existed carries neither.
  bars_after_settlement?: number | null;
  postmortem_version?: string | null;
  // Filled in by withClusters
  cluster?: string;
}

// Episodes are about WHEN THE PLAN WAS MADE, so both timestamps have to come
// off the plan's own clock. The fallback to l.created_at is the diagnosis
// clock — hours or days later; lesson 94bdcfaa was reviewed five days after
// its plan — and pairing that with a settlement time taken from the plan puts
// the row after its own close, which opens the reopen escape on nothing but
// review latency. A lesson with no plan time is placed on the review clock and
// carries no settlement at all: unknown, and an unknown settlement never
// escapes. Latent today, since every lesson has analysis_created_at and
// writeLesson always sets it, so only a legacy or hand-written row can reach
// it.
export const withClusters = (lessons: LessonRow[]): LessonRow[] => {
  const ids = episodeIds(lessons.map((l) => ({
    pair: l.pair,
    signal: l.signal,
    created_at: l.plan_created_at ?? l.created_at,
    closed_at: l.plan_created_at ? l.plan_closed_at ?? null : null,
  })));
  return lessons.map((l, i) => ({ ...l, cluster: ids[i] }));
};
// A cause that names no lever to move cannot support a rule. good_wait is
// good_call's mirror: "standing aside was right" tells the next plan nothing
// it can act on. wait_missed_trade is deliberately NOT here — it is the only
// evidence of over-caution the system has, and a rule is exactly what should
// come of it.
//
// sound_call_lost belongs here for the plainest reason of all: its entire
// content is that no lever we can move would have changed the outcome. A rule
// is an instruction to move one. Letting a loss like that support a rule would
// re-open the door the verdict was built to close — the loss counting as
// evidence for a change, purely because it was a loss.
//
// Renamed from UNCITABLE_CAUSES: the old name read as a property of the
// LESSON, and the list is now asked about the RULE's cause as well.
export const NOT_RULE_EVIDENCE: readonly string[] = ["inconclusive", "plan_incoherent", "good_call", "good_wait", "sound_call_lost"];


export const CONSOLIDATION_SCHEMA = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "既存ルールを引き継ぐ場合はその id、新規は r + 番号（既存と重複しない）" },
          text_ja: { type: "string", description: "「条件 → 行動」の一般則。100字以内、日本語。個別の価格・日付を含めない" },
          text_en: { type: "string", description: "The same rule in English, 240 characters or fewer" },
          // The causes a rule may be filed under, which is not every cause.
          // NOT_RULE_EVIDENCE is exactly the set that is evidence for nothing,
          // and citationAllowed refuses every citation of a rule filed under
          // one — so offering them here bought a rule that is deleted at the
          // next revision for want of support, one wasted slot per revision.
          cause: { type: "string", enum: [...CAUSES.filter((c) => !NOT_RULE_EVIDENCE.includes(c)), "general"] },
          kind: { type: "string", enum: ["constraint", "heuristic"], description: "constraint: 見送る・リスクを絞る歯止め。heuristic: こう取るという指針" },
          scope: { type: ["string", "null"], description: "適用範囲を短く。無ければ null" },
          supported_by: { type: "array", items: { type: "string" }, description: "このルールの根拠となる lessons の analysis_id（そのルールの cause と同じ原因の lesson に限る）" },
        },
        required: ["id", "text_ja", "text_en", "cause", "kind", "scope", "supported_by"],
        additionalProperties: false,
      },
    },
    summary_ja: { type: "string", description: "実績から見た現状の弱点と、今回の改訂内容。日本語、200字以内" },
    summary_en: { type: "string", description: "The same summary in English, 480 characters or fewer" },
  },
  required: ["rules", "summary_ja", "summary_en"],
  additionalProperties: false,
};

// Causes that a "don't trade / cut the risk" rule may draw on beyond its own.
// Canonical spellings only — citationAllowed canonicalises both operands
// before testing, so "entry_too_early" is covered by "chased_move".
// Declared ABOVE CONSOLIDATION_SYSTEM_PROMPT because that template
// interpolates both lists and is evaluated at module load: moving either back
// below it is a ReferenceError that takes down the whole function.
export const CONSTRAINT_CAUSES: readonly string[] = ["lucky_win", "direction_wrong", "regime_misread", "news_shock", "chased_move"];
// Lessons that are about nothing in particular are evidence for nothing.

// The contract stamp — ENTRY_LEVER_PHRASES, `unfollowableUnder` and
// `stampFor` — moved to ./stamp.ts on 2026-09-12 and is re-exported here
// unchanged, so every existing import path keeps working. The move was for
// bundle weight, not behaviour: see the header of stamp.ts for the measured
// numbers. Nothing about which rules are vetoed changed.
import { stampFor, unfollowableUnder, type Stamp, type StampRefusal } from "./stamp.ts";
export {
  stampFor,
  unfollowableUnder,
  type Stamp,
  type StampRefusal,
} from "./stamp.ts";

export const CONSOLIDATION_SYSTEM_PROMPT = `あなたはFX分析AIの「ルールブック」の編集者です。個々のプランの検証結果（lessons）と実績統計（stats）から、次回以降のプラン作成で AI アナリストが従う一般則を最大${MAX_RULES}個にまとめます。ルールブックは AI のシステムプロンプトに、基本手順とリスク規定の後ろに「補助的な指針」として入ります。基本手順（トレンド局面での成行、損切り幅、RR の下限）を上書きすることはできないので、その範囲内で書きます。

証拠の数え方:
- 証拠の単位は「独立クラスタ」。同じ通貨ペア・同じ方向で近い時間に作られたプランは同じ局面についての同じ判断であり、lessons が何件あっても証拠としては1件。各 lesson には cluster が付いている。stats.by_cause_clusters が原因別のクラスタ数。
- 各ルールには supported_by として根拠の lesson の analysis_id を列挙する。数えられるのは、そのルールの cause と同じ原因の lesson（cause が general のルールは、${NOT_RULE_EVIDENCE.join(" / ")} 以外のどの原因でも可。constraint のルールは ${CONSTRAINT_CAUSES.join(" / ")} も可）だけで、shadow の lesson は数えない。実績件数（support）はサーバーがその条件で独立クラスタ数を数える。無関係な lesson を引用しても数えられず、根拠が1件も残らないルールは削除される。
- stats.win_rate / fill_rate は決着数が ${MIN_STAT_N} 未満のとき null。null や小さい n の統計を根拠にルールを強めない。stats.win_rate_ci95 は勝率の95%信頼区間。
- stats は stats.contract のエントリー契約で作られたプランだけを集計している。別の契約のプランは stats.other_contract_rows として件数だけ数え、勝率にも件数にも入れていない。契約をまたいだ比較はできない。
- 勝率の分母は stats.decided（WIN + LOSS + 期限切れ）。期限切れは「届かない利確を置いた」結果であり、勝率から外れる逃げ道にはならない。
- 見送り（WAIT）も採点される。stats.waits_missed は「見送った後、このアプリ自身が許す最小のトレード（損切り ATR${MIN_STOP_ATR}倍・RR ${MIN_RISK_REWARD}）なら勝っていた」局面の数、stats.wait_miss_rate はその割合。これが実績の中で唯一「慎重すぎた」ことを示す証拠なので、見送りを増やすルールを足すときは必ずこの数字を見る。損失を減らすルールばかりを積むと、この数字だけが増えていく。
- 見送りの内訳: stats.self_declined は AI 自身が「見送る」と答えた件数、stats.rejected は AI が出したプランをサーバーの入口チェックが却下して WAIT にした件数。前者はアナリストの判断、後者はサーバーの強制で、ルールで直せるのは前者だけ。この2つを1つの数にまとめていた間、AI 自身の見送り16件が「サーバーが却下した」件数として渡っていた（実際の却下は1件）。
- 各 lesson には contract（作られた時のエントリー契約）が付いている。別の契約の lesson は「同じ状況がまた起きる」証拠としては使えるが、その remedy が今は存在しない操作（押し目待ち・指値）を指している場合があるので、ルールの文言はそのまま写さない。stats.lessons_by_contract が契約別の件数。
- 各 lesson には bars_after_settlement（その診断が見た決着後の足数）が付いている。診断は決着の直後に走る設計なので、この数が小さい lesson は「その後どうなったか」をほとんど見ていない。実測（2026-09-07、n=4）では、8足で書かれた診断を48〜95足まで待って読み直したところ、4件中2件は原因そのものが変わり（うち1件は「一度も含み益にならなかった」から「23足後に利確1に到達していた」へ）、残る2件も原因は同じまま avoidable や副次原因が変わった。ただしこの4件は原因語彙を変えた版で読み直しているので、深さの効果とコード変更の効果を分離できていない。lesson の confidence はこの深さを織り込んでいない。null は列ができる前に書かれた lesson。
- entry_too_far / entry_too_early は旧契約の語彙。entry_too_early は chased_move として集計されている。
- current_rules の各ルールには contract（実行できる契約）・evidence_contracts（根拠 lesson の契約）・in_force（現行契約 ${MARKET_CONTRACT} のプロンプトに実際に入っているか）が付いている。in_force が false のルールはアナリストのプロンプトに入っていない。原因が現行契約では起こりえないか、文言が「押し目を待つ・指値で入る・どこで入るか」というアナリストが動かせない対象を指しているためで、同じ文言のまま出し直しても false のままになる。残す価値があるなら方向・損切り幅・利確幅・見送りの4つのどれかを動かす形に書き直し、書き直せないなら出力から外す。
- evidence_contracts が現行契約以外だけのルールは、根拠が旧契約の記録しかない。使ってよいが、プロンプトには「旧契約含む」と表示され、証拠としては弱い。
- stats.by_rulebook_version は「その版のもとで作られたプラン全体」の実績（決着数・勝敗・実現R合計 sum_r）。版の比較（ルールを足す前と後）には使えるが、版の中のどのルールのせいかは区別できない。個別ルールの証拠は stats.rule_feedback（診断がそのルールを結果の原因 blamed / 貢献 credited と名指しした回数）と、lessons の rule_blamed / rule_credited。blamed が credited を上回るルールは弱めるか削除する。
- 対称性: untriggered の lesson は「約定を妨げた」側、loss の lesson は「損を招いた」側の証拠。片方だけを見ない。反実仮想の「成行なら勝っていた」は viable=true の案だけが根拠になる（lesson 側で考慮済み）。

ルールの書き方:
- kind: "constraint" は「見送る・リスクを絞る」側の歯止め、"heuristic" は「こう取る」側の指針。執行を促すルールが増えるほど、歯止めのルールも必要になる。
- 条件は指標由来の観測量（ADX、ATR、SMA20/50の並び、上位足との整合、RSI、直近の値幅）に限る。アナリスト自身の自己申告値（confidence、mode の宣言、direction）を条件にしない。
- 「条件 → 行動」の形、100字以内。個別の価格・日付・銘柄固有の出来事は書かない。
- アナリストが実際に出力できる形式に限る。プランはエントリー1つ・損切り1つ・利確3つで、分割エントリー・ナンピン・両建て・トレーリングストップは表現できない。
- ゲートとの整合: 現行契約（market_v1）では、エントリー価格はアナリストが選ばない。分析した瞬間の現在値がそのまま成行の約定価格になる。したがって「押し目を待つ」「浅い指値で入る」「エントリーを引きつける」形のルールは実行できないので書かない。アナリストが決められるのは方向・損切り幅・利確幅と、そもそも入るかどうか（WAIT）の4つだけであり、ルールもその4つのいずれかを動かす形にする。損切り幅は ATR${MIN_STOP_ATR}倍以上、RR は ${MIN_RISK_REWARD} 以上をサーバーが強制する。トレンド局面（ADX ${TREND_ADX} 以上で SMA が方向に並ぶ）の判定は、入るか見送るかの条件としてのみ使う。
- 同じ趣旨のルールは1つに統合する。
- id は既存ルールを引き継ぐ場合そのまま、新規は "r" + 通し番号（既存と重複しない）。既存ルールを別の id で書き直さない。

改訂の制限:
- 1回の改訂で追加は最大${MAX_RULES_ADDED}本、削除は最大${MAX_RULES_REMOVED}本（サーバー側でも強制される）。既存ルールの文言変更は、新しい lessons の裏付けがあるときだけ。
- 並び順: constraint を先に、次に根拠の強い順。`;

export const buildConsolidationPrompt = (
  rules: Rule[],
  lessons: LessonRow[],
  stats: RecordStats,
): { system: string; user: string } => {
  const payload = {
    // contract / evidence_contracts / in_force are shown because without them
    // the editor cannot tell a suppressed rule from a live one, and re-emitting
    // a held-back rule verbatim forever is its path of least resistance.
    current_rules: rules.map((r) => ({
      id: r.id, kind: r.kind, text_ja: r.text_ja, text_en: r.text_en, cause: r.cause,
      support: r.support, supported_by: r.supported_by, scope: r.scope, since: r.since,
      contract: r.contract,
      evidence_contracts: r.evidence_contracts,
      in_force: r.contract === MARKET_CONTRACT,
    })),
    lessons: lessons.map((l) => ({
      analysis_id: l.analysis_id,
      cluster: l.cluster ?? null,
      plan_created_at: l.plan_created_at ?? l.created_at,
      pair: l.pair,
      interval: l.interval,
      signal: l.signal,
      order_type: l.order_type,
      outcome: l.outcome,
      cause: l.cause,
      contract: l.contract,
      shadow: l.shadow,
      confidence: l.confidence,
      avoidable: l.avoidable,
      scope: l.scope,
      rule_blamed: l.rule_blamed,
      rule_credited: l.rule_credited,
      lesson_ja: l.lesson_ja,
      lesson_en: l.lesson_en,
      // One number per line, so the shape and the budget of the digest are
      // what they were: how much aftermath this lesson rests on.
      bars_after_settlement: l.bars_after_settlement ?? null,
    })),
    stats,
  };
  const user = [
    "現在のルールブック、検証結果の一覧、実績統計は次のとおりです。改訂後のルールブック全体を出力してください。",
    "",
    JSON.stringify(payload),
  ].join("\n");
  return { system: CONSOLIDATION_SYSTEM_PROMPT, user };
};

// Why a rule the editor named is not in the new book.
//   add_cap      — a new rule beyond MAX_RULES_ADDED for one revision
//   no_evidence  — none of its citations counted (missing, shadow, wrong cause)
//   book_full    — MAX_RULES already filled by better-supported rules
//   omitted      — the editor left it out and the removal allowance covered it
//   evidence_gone — omitted, and its stored citations no longer count either
//   no_room      — omitted, would have been restored, but the book was full
export type DropReason =
  | "add_cap"
  | "no_evidence"
  | "book_full"
  | "omitted"
  | "evidence_gone"
  | "no_room";

// Why a rule that IS in the book reaches no analyst prompt. Not a drop — the
// rule survived the revision — but the same question, about the same id, and
// it belongs in the same map: r12 was in the book at v7 and at v8 and reached
// nobody either time, and nothing on the run said why.
export type ChangeReason = DropReason | StampRefusal;

export interface Consolidation {
  rules: Rule[];
  summary_ja: string;
  summary_en: string;
  // held_back: rules that ARE in the book but which stampFor refused a stamp,
  // so no prompt will show them. Recorded because a rule that silently never
  // reaches the analyst is the failure mode this whole field exists to make
  // visible.
  //
  // reworded: rules kept under their own id whose text or cause the editor
  // changed. Not an addition and not a removal, so before this field a
  // rewrite left `changes` completely empty — a version bump whose diff said
  // nothing, while the sentence the analyst follows had been replaced and its
  // `since` still claimed the older date.
  //
  // reasons: why each id in `dropped`, `removed` or `held_back` is there,
  // keyed by id. For a held-back rule that is the veto stampFor applied, which
  // was previously recorded nowhere at all — a rule can sit in the book for
  // versions on end, be printed in every artefact, and reach no prompt. The
  // lists alone say a rule did not make it and stop there, which is enough to
  // notice a rule failing twice and not enough to say why — the editor
  // proposed the same new rule r12 at v7 and at v8 and it was dropped both
  // times, and nothing on record could tell "its citations did not count"
  // from "the book was full".
  changes: {
    added: string[];
    removed: string[];
    restored: string[];
    dropped: string[];
    held_back: string[];
    reworded: string[];
    reasons: Record<string, ChangeReason>;
  };
}

export interface CitableLesson {
  analysis_id: string;
  cluster?: string | null;
  cause?: string;
  shadow?: boolean;
  // The era of the plan this lesson came from. NOT a citation gate: a failure
  // observed under the old contract is still evidence that the same situation
  // recurs. Read only to fill Rule.evidence_contracts, which labels a rule
  // rather than suppressing it.
  contract?: string | null;
}

// Whether a lesson is evidence for a rule: same failure, or a general rule
// (any real failure), or a constraint drawing on the risk causes. Never a
// shadow plan's lesson — those are about the gate, not the analyzer.
export const citationAllowed = (rule: { cause: string; kind: RuleKind }, lesson: CitableLesson): boolean => {
  if (lesson.shadow) return false;
  // The rule side, tested first. CONSOLIDATION_SCHEMA's cause enum is
  // [...CAUSES, "general"], so the editor may file a rule under a cause that
  // is evidence for nothing — and a constraint rule filed under one of these
  // would then draw on the whole of CONSTRAINT_CAUSES through the clause
  // below, collecting evidence for a rule whose own subject names no lever.
  // The lesson-side test was never going to catch that: it asks about the
  // lesson.
  if (NOT_RULE_EVIDENCE.includes(canonicalCause(rule.cause))) return false;
  const cause = canonicalCause(lesson.cause ?? "");
  if (!cause || NOT_RULE_EVIDENCE.includes(cause)) return false;
  if (canonicalCause(rule.cause) === cause) return true;
  if (rule.cause === "general") return true;
  if (rule.kind === "constraint" && CONSTRAINT_CAUSES.includes(cause)) return true;
  return false;
};

// The model's rewrite, checked against what it was given: every cited
// lesson must exist and be about the rule's failure, support is counted from
// those citations by cluster, a rule left with no evidence is dropped, and
// a revision may not add or drop more than a couple of rules — the surplus
// additions are dropped and the surplus removals put back (with their
// support recounted the same way), weakest rules going first.
export const parseConsolidation = (
  raw: unknown,
  previous: Rule[],
  nowIso: string,
  lessons: CitableLesson[] = [],
  // The contract the emitted rules are TESTED against — the question, not the
  // answer. Whether any given rule receives it is decided by stampFor, from
  // that rule's own cause and its own text. Passing PLAN_CONTRACT here no
  // longer means "stamp everything with today's build".
  writingContract: string | null = null,
): Consolidation | null => {
  if (!isRecord(raw) || !Array.isArray(raw.rules)) return null;
  const prior = new Map(previous.map((r) => [r.id, r]));
  const byId = new Map(lessons.map((l) => [l.analysis_id, l]));
  const evidence = (
    rule: { cause: string; kind: RuleKind },
    ids: string[],
  ): { cited: string[]; support: number; eras: string[] } => {
    const cited = [...new Set(ids.filter((id) => {
      const lesson = byId.get(id);
      return lesson !== undefined && citationAllowed(rule, lesson);
    }))];
    const clusters = new Set(cited.map((id) => byId.get(id)?.cluster ?? id));
    // Eras of the citations that actually COUNTED. A lesson the gate rejected
    // must not leak its era into the label, or a rule would be marked as
    // resting on evidence it is not allowed to rest on. A lesson with no
    // recorded contract predates the column and is legacy by definition, the
    // same convention summarizeRecord uses.
    const eras = [...new Set(cited.map((id) => byId.get(id)?.contract || LEGACY_PLAN_CONTRACT))].sort();
    return { cited, support: clusters.size, eras };
  };
  const seen = new Set<string>();
  const rules: Rule[] = [];
  const added: string[] = [];
  const dropped: string[] = [];
  const reworded: string[] = [];
  const reasons: Record<string, ChangeReason> = {};
  // Kept beside the stamps as they are derived, so the held_back list below can
  // say why each id is on it without re-deriving anything.
  const stampRefusals = new Map<string, StampRefusal>();
  for (const item of raw.rules) {
    if (!isRecord(item)) continue;
    const textJa = str(item.text_ja, MAX_RULE_CHARS);
    const textEn = str(item.text_en, MAX_RULE_CHARS_EN);
    if (!textJa && !textEn) continue;
    let id = str(item.id, 20);
    if (!id) {
      // A made-up id must not land on an existing rule and take it over
      id = `r${rules.length + 1}`;
      while (prior.has(id) || seen.has(id)) id = `${id}_`;
    }
    while (seen.has(id)) id = `${id}_`;
    const isNew = !prior.has(id);
    if (isNew && previous.length > 0 && added.length >= MAX_RULES_ADDED) {
      dropped.push(id);
      reasons[id] = "add_cap";
      continue;
    }
    const cause = typeof item.cause === "string" && (isCause(item.cause) || item.cause === "general")
      ? canonicalCause(item.cause)
      : "general";
    const kind: RuleKind = isRuleKind(item.kind) ? item.kind : prior.get(id)?.kind ?? "heuristic";
    const citedIds = Array.isArray(item.supported_by) ? item.supported_by.filter((v): v is string => typeof v === "string") : [];
    const { cited, support, eras } = evidence({ cause, kind }, citedIds);
    if (support === 0) {
      // No evidence, no rule: a continuing rule that lost its evidence goes
      // through the removal accounting below like any other omission
      dropped.push(id);
      reasons[id] = "no_evidence";
      continue;
    }
    // The book is full. Recorded as dropped rather than breaking out of the
    // loop, so a rule squeezed out of the book leaves a trace instead of
    // vanishing from `changes` entirely.
    if (rules.length >= MAX_RULES) {
      dropped.push(id);
      reasons[id] = "book_full";
      continue;
    }
    seen.add(id);
    if (isNew) added.push(id);
    const textJaFinal = textJa || textEn;
    const textEnFinal = textEn || textJa;
    // A rule kept under an existing id is a continuation: it keeps its `since`
    // and does not spend the addition allowance. That is right for a rule the
    // editor refined, and it is also what happens when the editor rewrites the
    // sentence into something else entirely, so the change is recorded rather
    // than inferred from a diff nobody stores. The cause counts too: it decides
    // which lessons may cite the rule, so moving it moves the rule's evidence.
    // Compared trimmed on both sides: a rule stored before str() trimmed after
    // the cut can carry a trailing space that no reader would call a change.
    const before = prior.get(id);
    const same = (a: string, b: string) => a.trim() === b.trim();
    const emitted = stampFor({ cause, text_ja: textJaFinal, text_en: textEnFinal }, writingContract);
    if (emitted.reason !== null) stampRefusals.set(id, emitted.reason);
    if (before && (!same(before.text_ja, textJaFinal) || !same(before.text_en, textEnFinal) || before.cause !== cause)) {
      reworded.push(id);
    }
    rules.push({
      id,
      text_ja: textJaFinal,
      text_en: textEnFinal,
      cause,
      support,
      scope: str(item.scope, 60) || null,
      since: prior.get(id)?.since ?? nowIso,
      contract: emitted.contract,
      evidence_contracts: eras,
      kind,
      supported_by: cited,
    });
  }

  // Omitted prior rules. Every one of them is recounted against this run's
  // evidence FIRST; then those left with nothing go for cause, the removal
  // allowance is spent on the weakest of what remains, and the rest come back.
  //
  // Weakest by TODAY'S count. `p.support` is the number
  // stored on the rule when it was last written, which may have been counted
  // under an older definition of "one situation" — the four divergent
  // implementations were definition 1, this file is definition 2. Choosing
  // which rules to spend the removal allowance on by the stored number while
  // writing back a recounted one mixes two definitions inside a single
  // revision, and the mix is not uniform across rules, so it can drop a
  // different rule than either definition would have on its own. Every rule
  // here is recounted once, against the same evidence, before anything is
  // ordered by it; the stored number breaks ties so the order stays stable.
  const missing = previous
    .filter((p) => !seen.has(p.id))
    .map((rule) => ({ rule, ev: evidence(rule, rule.supported_by) }));
  // A rule with no evidence left goes for cause, not out of the budget, and
  // says which. The allowance exists to stop one revision throwing away half a
  // working rulebook on the editor's say-so; a rule whose citations no longer
  // count is not a judgement call, and letting it eat a slot meant a rule that
  // still had evidence was dropped in its place — and dropped under the
  // reason "omitted", which is not what happened to it. Rules removed this way
  // were already removed on top of the allowance when they happened to reach
  // the restore path, so this only makes the two paths agree.
  const gone = missing.filter((m) => m.ev.support === 0);
  const removed = gone.map((m) => m.rule.id);
  // `??`, not `=`: a rule the editor RE-PROPOSED whose citations then failed
  // already said "no_evidence" up in the emit loop, and that is the more
  // specific fact — the editor argued for it and could not support it, as
  // against simply leaving it out. Overwriting it would lose the difference.
  for (const id of removed) reasons[id] = reasons[id] ?? "evidence_gone";
  const judged = missing
    .filter((m) => m.ev.support > 0)
    .sort((a, b) => a.ev.support - b.ev.support || a.rule.support - b.rule.support);
  for (const m of judged.slice(0, MAX_RULES_REMOVED)) {
    removed.push(m.rule.id);
    reasons[m.rule.id] = reasons[m.rule.id] ?? "omitted";
  }
  const restored: string[] = [];
  for (const { rule, ev } of judged.slice(MAX_RULES_REMOVED).reverse()) {
    if (rules.length >= MAX_RULES) {
      // No room left: it leaves the book, and says so.
      removed.push(rule.id);
      reasons[rule.id] = "no_room";
      continue;
    }
    const { cited, support, eras } = ev;
    const stamp = stampFor(rule, writingContract);
    if (stamp.reason !== null) stampRefusals.set(rule.id, stamp.reason);
    // The stamp is re-derived here too, from the STORED rule's own cause and
    // text. A restored rule must not carry a stamp forward: inheriting it is
    // what let a rule keep an endorsement that only ever existed because a
    // defective build wrote it.
    rules.push({
      ...rule,
      support,
      supported_by: cited,
      evidence_contracts: eras,
      contract: stamp.contract,
    });
    restored.push(rule.id);
  }
  if (rules.length === 0) return null;

  // With writingContract null every stamp is null and this is empty, which is
  // the right answer: a caller that named no contract asked no question.
  const held_back = writingContract === null ? [] : rules.filter((r) => r.contract !== writingContract).map((r) => r.id);
  // The rule is in the book, so this is the live fact about the id; a drop
  // reason already under it belongs to some other proposal that never made it
  // into `rules` at all.
  for (const id of held_back) {
    const why = stampRefusals.get(id);
    if (why !== undefined) reasons[id] = why;
  }

  return {
    rules: orderRules(rules),
    summary_ja: str(raw.summary_ja, MAX_SUMMARY_CHARS),
    summary_en: str(raw.summary_en, MAX_SUMMARY_CHARS_EN),
    changes: { added, removed, restored, dropped, held_back, reworded, reasons },
  };
};

// Whether the rulebook is due for a rewrite: enough new lessons since the
// last version, or a day with at least one. Any single lesson used to
// rewrite the whole book, which meant no version ever lasted long enough for
// its plans to settle.
export const MIN_NEW_LESSONS = 5;
export const MIN_REVISION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const revisionDue = (
  newLessonsSinceVersion: number,
  lastUpdatedIso: string | null,
  nowMs: number,
): boolean => {
  if (newLessonsSinceVersion <= 0) return false;
  if (!lastUpdatedIso) return true;
  const last = Date.parse(lastUpdatedIso);
  if (!Number.isFinite(last)) return true;
  if (newLessonsSinceVersion >= MIN_NEW_LESSONS) return true;
  return nowMs - last >= MIN_REVISION_INTERVAL_MS;
};
