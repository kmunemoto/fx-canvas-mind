import type { AnalysisRecord, PerformanceGroup, PerformanceStats, PlanContract, PostmortemCause } from "./types";
// The episode rule, shared verbatim with the edge functions. That file is a
// LEAF on purpose — zero imports — because postmortem/prompt.ts, where this
// rule used to live in its second form, reaches facts.ts, analyze/entry.ts and
// analyze/rules.ts, and importing any of those here would pull the whole
// server graph into the browser bundle.
import { episodeIds } from "../../supabase/functions/_shared/episodes";

// Win/loss bookkeeping over history rows.
//
// THE INVARIANT THIS FILE EXISTS TO PROTECT: every call the analyst makes
// lands in exactly one bucket, and the share that produced an actual verdict
// (verdictRate) is published. Closing one way for a call to escape a verdict
// only moves the pressure somewhere else — an unreachable target expires, a
// plan the market never reaches goes untriggered, a WAIT is never wrong at
// all. Rather than trying to predict which hatch opens next, every non-verdict
// bucket carries its own rate and they sum with verdictRate to 1. A drop in
// verdictRate is the symptom to watch, whatever the cause turns out to be.
//
// An expired plan IS counted against the win rate. It was a call that did not
// work out; leaving it out let a target placed out of reach dodge the number.
//
// The rate alone is not the record, though. A handful of settled trades can
// show any rate at all, plans opened on the same pair in the same direction
// on the same day are one decision rather than several, and a 40% win rate
// at 2:1 beats a 60% one at 1:2. So every tally also carries how many
// trades it rests on, a confidence interval for the rate, the count of
// independent situations behind it, and what the plans made or lost in
// multiples of their risk.
//
// Shadow rows — plans the entry gate refused but still tracks — are not
// part of the record; they are counted apart (shadowTally) to show whether
// the gate is right.

export interface OutcomeTally {
  key: string;
  wins: number;
  losses: number;
  open: number;
  untriggered: number;
  ambiguous: number;
  expired: number;
  // Plans whose levels contradicted each other, so nothing could be judged.
  // Not a neutral outcome — a malformed plan is a defect, and its rate should
  // be zero.
  incoherent: number;
  // Calls that declined to trade at all
  waits: number;
  // Of those, the ones the tracker has reached a verdict on, and the ones
  // where the market then offered a trade this app would itself have taken
  // and it won. This is the record's only evidence of over-caution: every
  // other number here punishes being too bold, so without it the loop can
  // only ever push one way — toward trading less, until the analyst answers
  // WAIT to everything and is never wrong again.
  waitsJudged: number;
  waitsMissed: number;
  // Non-WAIT plans (what `total` has always meant)
  total: number;
  // EVERY call, WAIT included. The denominator for the bucket rates below.
  calls: number;
  // WAIT rows that were the gate's doing: the analyst asked for a trade and
  // the server published a WAIT instead
  rejected: number;
  // WAIT rows that were the analyst's own call. Kept apart from `rejected`
  // because the two answer opposite questions about who is being cautious,
  // and pooling them let the confidence floor's stamp on a model WAIT read as
  // the server overriding sixteen plans it had never been offered.
  selfDeclined: number;
  winRate: number | null;
  // Wilson 95% interval for the win rate, in percent
  winRateCi: [number, number] | null;
  // Settled trades counted once per market situation (same pair, same
  // direction, within a day of each other)
  clusters: number;
  // Share of settled plans that actually became a trade. A signal whose entry
  // the market never reaches teaches nothing, so this is tracked next to the
  // win rate rather than buried in the outcome counts.
  fillRate: number | null;
  // What the settled plans made or lost, in multiples of their planned risk
  // (a win pays TP1, a loss costs 1R, an expiry is marked where it closed;
  // no spread or slippage is charged)
  sumR: number | null;
  expectancy: number | null;
  // Which entry contracts the rows in this tally were made under. More than
  // one and every rate is null: the contracts are not comparable, so a pooled
  // number would describe a population that never existed.
  contracts: PlanContract[];
  // Share of ALL calls that ended in a win or a loss. The headline honesty
  // number: if it falls, calls are escaping judgement somewhere.
  verdictRate: number | null;
  // Where the rest went. These and verdictRate partition every call, so they
  // sum to 100 (bar rounding).
  waitRate: number | null;
  expiredRate: number | null;
  untriggeredRate: number | null;
  ambiguousRate: number | null;
  incoherentRate: number | null;
  openRate: number | null;
  // Share of judged WAITs that were missed trades
  waitMissRate: number | null;
}

export interface ShadowTally {
  total: number;
  untriggered: number;
  wins: number;
  losses: number;
  open: number;
  other: number;
}

export const TIMEFRAME_ORDER = ["15min", "1h", "4h", "1day"];
export const MODE_ORDER = ["full", "technical_only", "technical_fallback"];
export const NO_RULEBOOK = "none";

// Independent settled trades before a win rate is worth arguing about: the
// point where a 95% interval on a real edge stops including break-even
export const TARGET_CLUSTERS = 50;
// Plans on the same pair in the same direction inside this window are one
// decision about one situation. Both windows, and the rule that reads them,
// come from the shared leaf module: this file and postmortem/prompt.ts had
// each grown their own version of "one situation" and the two disagreed, so
// the count under the win rate on screen and the count that decides whether a
// rule survives a revision were different numbers with the same name.
export { CLUSTER_REOPEN_MS, CLUSTER_WINDOW_MS, EPISODE_DEFINITION_VERSION } from "../../supabase/functions/_shared/episodes";

// [lower bound, upper bound or null for open-ended]
export const CONFIDENCE_BANDS: Array<[number, number | null]> = [
  [0, 59],
  [60, 69],
  [70, 79],
  [80, null],
];

export const UNKNOWN_BAND = "unknown";

export const isShadow = (r: AnalysisRecord): boolean => r.shadow === true;
// A weekend read: the market was shut when it was asked for, so it carries no
// entry and can never be scored. It is kept in the history and excluded from
// every tally, for the same reason a shadow is — a record is a claim about
// what the analyst does when it can act, and a preview is what it says when
// it cannot. Counting one as a call would move the WAIT rate and the trades-
// per-call ratio without a single trade having been declined.
export const isPreview = (r: AnalysisRecord): boolean => r.preview === true;

// WHO DECLINED. Two different events, and the record used to print both as
// "the server overrode its analyst".
//
// The confidence floor stamps rejection = 'low_confidence' on a WAIT the MODEL
// ITSELF answered — the gate refused nothing there, it agreed. Measured in
// production 2026-09-08 on contract market_v1: 16 rows carried that stamp on a
// WAIT the model proposed, against exactly ONE row where the gate turned a
// SELL into a WAIT (poor_rr, RR 1.19 against a floor of 1.20). The screen said
// sixteen. Reading `rejection` alone cannot tell the two apart; what the model
// ASKED FOR can.
//
// A refusal is therefore a plan the analyst asked for and did not get.
export const isRejected = (r: AnalysisRecord): boolean => {
  const proposed = r.entry_check?.proposed_signal;
  return r.signal === "WAIT" &&
    (proposed === "BUY" || proposed === "SELL") &&
    typeof r.entry_check?.rejection === "string" && r.entry_check.rejection.length > 0;
};

// The analyst's own answer to stand aside: it proposed WAIT and a WAIT is what
// was published. A judgement the app made, never an override — whether or not
// a rejection string is also stamped on the row.
//
// ABSENT proposed_signal lands in NEITHER bucket, deliberately. 11 rows in
// production have no such field (measured 2026-09-08); every one of them is on
// the legacy contract entry_chosen_v1 and NONE carries a rejection, so no count
// moves either way today. The default is chosen for the row shape that does not
// exist yet: with the field missing there is no evidence of what was asked for,
// and both of these counts are claims about who decided. An unsupported claim
// that the server overrode the analyst is the exact defect being fixed here, so
// silence is the answer in both directions rather than a guess in one.
export const isSelfDeclined = (r: AnalysisRecord): boolean =>
  r.signal === "WAIT" && r.entry_check?.proposed_signal === "WAIT";

export const confidenceBandKey = (confidence: number | null): string => {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return UNKNOWN_BAND;
  const c = confidence;
  for (const [lo, hi] of CONFIDENCE_BANDS) {
    if (hi === null || c <= hi) return hi === null ? `${lo}+` : `${lo}-${hi}`;
  }
  return "0-59";
};

// Version 0 is the seeded, empty rulebook: no rules were in force either
// Rows written before the column existed, and rows read by an older client,
// are legacy by definition — the contract only ever moved forwards.
export const LEGACY_CONTRACT: PlanContract = "entry_chosen_v1";
// The contract plans are written under now. Mirrors PLAN_CONTRACT in
// supabase/functions/_shared/contract.ts; the parity test pins them together.
export const CURRENT_CONTRACT: PlanContract = "market_v1";
export const contractKey = (r: AnalysisRecord): PlanContract => r.plan_contract ?? LEGACY_CONTRACT;

// Keyed by contract AND rulebook version. Pooling the two would let a change
// of entry contract masquerade as a change of rulebook, which is precisely the
// question the before/after table exists to answer.
export const rulebookKey = (r: AnalysisRecord): string =>
  typeof r.rulebook_version === "number" && Number.isFinite(r.rulebook_version) && r.rulebook_version > 0
    ? `${contractKey(r)}|v${r.rulebook_version}`
    : `${contractKey(r)}|${NO_RULEBOOK}`;

const round2 = (v: number) => Number(v.toFixed(2));

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

// What a settled plan made or lost, in R (see the header)
export const realizedR = (r: AnalysisRecord): number | null => {
  const { stop_loss: stop, take_profit_1: tp1 } = r;
  // What the trade actually opened at, which for a market order is the price
  // on its own side of the book rather than the number written on the plan
  const filled = r.evaluation?.fill_price;
  const entry = typeof filled === "number" && Number.isFinite(filled) ? filled : r.entry_point;
  if (entry === null || stop === null || tp1 === null || ![entry, stop, tp1].every(Number.isFinite)) return null;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const sign = r.signal === "BUY" ? 1 : r.signal === "SELL" ? -1 : 0;
  if (sign === 0) return null;
  if (r.outcome === "win") return round2(Math.abs(tp1 - entry) / risk);
  if (r.outcome === "loss") return -1;
  if (r.outcome === "expired" && typeof r.outcome_price === "number" && Number.isFinite(r.outcome_price)) {
    return round2((sign * (r.outcome_price - entry)) / risk);
  }
  return null;
};

// Cluster ids, in input order. The rule itself is in the shared leaf module;
// what used to stand here had the right anchor (the cluster's start) and no
// reopen escape at all, so two plans a day apart on either side of a settled
// trade counted as one situation on screen while the learning path counted
// them as two — or, under its own chained window, as one across a whole week.
//
// The settlement time is passed now, which is what the escape half of the rule
// needs; a row that has none is still open, and an open position never opens
// the escape.
export const clusterIds = (items: Array<Pick<AnalysisRecord, "pair" | "signal" | "created_at" | "closed_at">>): string[] =>
  episodeIds(items.map((r) => ({
    pair: r.pair,
    signal: r.signal,
    created_at: r.created_at,
    closed_at: r.closed_at ?? null,
  })));

// A trade happened if the tracker saw the entry reached; an ambiguous row
// with a fill still counts as one
const wasFilled = (r: AnalysisRecord): boolean =>
  r.outcome === "win" || r.outcome === "loss" || r.outcome === "expired" ||
  (r.outcome === "ambiguous" && typeof r.evaluation?.filled_at === "string" && r.evaluation.filled_at.length > 0);

// A plan whose own levels contradict each other. The tracker records this as
// 'ambiguous' with reason 'incoherent'; it is separated out here because the
// two mean different things — one is "we could not tell", the other is
// "the plan was malformed".
const isIncoherent = (r: AnalysisRecord): boolean =>
  r.outcome === "ambiguous" && r.evaluation?.reason === "incoherent";

// The same tally, read off the server's answer instead of computed from the
// rows the client happened to fetch.
//
// Shaped as an OutcomeTally on purpose: every render site already knows how to
// draw one, so the whole panel switches source without a second set of
// branches to keep in step. tally() stays as the offline fallback — an RPC
// outage should show fewer, honestly-labelled numbers rather than none.
export const serverTally = (key: string, g: PerformanceGroup): OutcomeTally => ({
  key,
  wins: g.wins,
  losses: g.losses,
  open: g.open,
  untriggered: g.untriggered,
  ambiguous: g.ambiguous,
  expired: g.expired,
  incoherent: g.incoherent,
  waits: g.waits,
  waitsJudged: g.waits_judged,
  waitsMissed: g.waits_missed,
  total: g.total,
  calls: g.calls,
  // NEITHER count is taken from a server that predates the split, and
  // `self_declined` missing is how that server is recognised. Its `rejected`
  // is the OLD conflated number — the 17 this change exists to stop printing —
  // so republishing it under a name that now promises only overrides would put
  // the retired sentence back on the screen, this time above sixteen rows
  // badged AI見送り by the row-level predicates. Zero on both suppresses the
  // note entirely until the migration lands: no summary is the honest shape of
  // "this server cannot tell me", and the per-row badges are unaffected.
  rejected: typeof g.self_declined === "number" ? g.rejected : 0,
  selfDeclined: g.self_declined ?? 0,
  winRate: g.win_rate,
  winRateCi: g.win_rate_ci95,
  clusters: g.clusters,
  fillRate: g.fill_rate,
  sumR: g.sum_r,
  expectancy: g.expectancy,
  contracts: (Array.isArray(g.contracts) ? g.contracts : []) as PlanContract[],
  verdictRate: g.verdict_rate,
  waitRate: g.wait_rate,
  expiredRate: g.expired_rate,
  untriggeredRate: g.untriggered_rate,
  ambiguousRate: g.ambiguous_rate,
  incoherentRate: g.incoherent_rate,
  openRate: g.open_rate,
  waitMissRate: g.wait_miss_rate,
});

// Which population the panel should draw.
//
// Normally the live contract, all time. But every plan can predate the
// current contract — production is exactly that today — and filtering the
// record away because of it would show the owner nothing at all. So when the
// live contract has no calls and exactly one older contract does, that one is
// shown instead, and the caller is told which, so the label can say so.
export const headlineScope = (
  stats: PerformanceStats,
): { group: PerformanceGroup; contract: string | null } | null => {
  const live = stats.scopes?.all_time;
  if (live && live.calls > 0) return { group: live, contract: null };
  const others = Object.entries(stats.by_contract ?? {}).filter(([, g]) => g.calls > 0);
  if (others.length === 1) return { group: others[0][1], contract: others[0][0] };
  return live ? { group: live, contract: null } : null;
};

export const tally = (key: string, records: AnalysisRecord[]): OutcomeTally => {
  const t: OutcomeTally = {
    key, wins: 0, losses: 0, open: 0, untriggered: 0, ambiguous: 0, expired: 0,
    incoherent: 0, waits: 0, waitsJudged: 0, waitsMissed: 0, total: 0, calls: 0,
    rejected: 0, selfDeclined: 0, contracts: [],
    winRate: null, winRateCi: null, clusters: 0, fillRate: null, sumR: null, expectancy: null,
    verdictRate: null, waitRate: null, expiredRate: null, untriggeredRate: null,
    ambiguousRate: null, incoherentRate: null, openRate: null, waitMissRate: null,
  };
  let filled = 0;
  let settled = 0;
  let sumR = 0;
  let withR = 0;
  // Clustered over the rows that COUNT, not over everything fetched.
  //
  // One rule is not enough on its own; the population has to match too. This
  // used to hand every fetched row to the rule and skip the shadows and
  // previews inside the loop, while performance_stats — the number actually
  // shown, this being only the fallback — filters them out before it clusters.
  // A row taking part in the scan anchors an episode start and hides the
  // previous plan's settlement from the row after it, so a shadow between two
  // real plans moved a boundary here and not there: the same rule, two
  // populations, two answers under one name. Same filter, same order, both
  // sides.
  const counted = records.filter((r) => !isShadow(r) && !isPreview(r));
  const countedIds = clusterIds(counted);
  const clusterOf = new Map<AnalysisRecord, string>(counted.map((r, i) => [r, countedIds[i]]));
  const settledClusters = new Set<string>();
  const seenContracts = new Set<PlanContract>();
  records.forEach((r) => {
    if (isShadow(r) || isPreview(r)) return;
    seenContracts.add(contractKey(r));
    if (isRejected(r)) t.rejected++;
    if (isSelfDeclined(r)) t.selfDeclined++;
    // Every call counts, WAIT included: a call that declines to trade is
    // still a call, and one that is never counted can never be wrong.
    t.calls++;
    if (r.signal === "WAIT" || r.outcome === "skipped") {
      t.waits++;
      // 'pending' has not been judged yet, 'unknown' never can be, and
      // 'no_call' means nothing at the time named a side to grade — so none
      // of the three belongs on either side of the rate. Named here rather
      // than left to fall through the switch: a reader counting 0 of 3 judged
      // should be able to see it is by construction, not a stalled sweep.
      const verdict = r.wait_check?.verdict;
      // And only the current scorer's verdicts. The first one chose the
      // direction from whichever side paid, so its miss rate measured the
      // market's range; pooling the two rules would carry that in invisibly
      // and permanently — a verdict is never re-scored.
      const scored = (r.wait_check?.scorer ?? 0) >= 2;
      if (scored && (verdict === "missed" || verdict === "correct")) {
        t.waitsJudged++;
        if (verdict === "missed") t.waitsMissed++;
      }
      return;
    }
    t.total++;
    if (r.outcome === "win") t.wins++;
    else if (r.outcome === "loss") t.losses++;
    else if (r.outcome === "pending") t.open++;
    else if (r.outcome === "untriggered") t.untriggered++;
    else if (r.outcome === "ambiguous") {
      if (isIncoherent(r)) t.incoherent++;
      else t.ambiguous++;
    } else if (r.outcome === "expired") t.expired++;
    if (wasFilled(r)) {
      filled++;
      settled++;
    } else if (r.outcome === "untriggered") {
      settled++;
    }
    const cluster = clusterOf.get(r);
    if (cluster !== undefined && (r.outcome === "win" || r.outcome === "loss")) settledClusters.add(cluster);
    const rr = realizedR(r);
    if (rr !== null) {
      sumR += rr;
      withR++;
    }
  });
  t.contracts = [...seenContracts].sort();
  // An expiry is a call that did not work out, so it belongs in the
  // denominator. Excluding it let a target placed beyond reach sit out the
  // win rate entirely.
  const mixed = t.contracts.length > 1;
  const decided = t.wins + t.losses + t.expired;
  t.winRate = !mixed && decided > 0 ? Math.round((t.wins / decided) * 100) : null;
  t.winRateCi = mixed ? null : wilson(t.wins, decided);
  t.clusters = settledClusters.size;
  // 'ambiguous' without a fill is left out of both sides: it is precisely
  // the case where we could not establish whether the trade happened
  t.fillRate = !mixed && settled > 0 ? Math.round((filled / settled) * 100) : null;
  t.sumR = !mixed && withR > 0 ? round2(sumR) : null;
  t.expectancy = !mixed && withR > 0 ? round2(sumR / withR) : null;
  // Mixing contracts silently is the failure this column exists to prevent.
  // Under the old one a call could go unfilled and never be scored at all;
  // under the new one that is impossible. A rate over both answers a question
  // nobody asked — and an `untriggeredRate` of 37% rendered under a regime
  // where untriggered cannot happen is a lie in its own right, so the refusal
  // covers every rate, not just the win rate.
  if (t.contracts.length > 1) return t;
  const share = (n: number) => (t.calls > 0 ? Math.round((n / t.calls) * 100) : null);
  t.verdictRate = share(t.wins + t.losses);
  t.waitRate = share(t.waits);
  t.expiredRate = share(t.expired);
  t.untriggeredRate = share(t.untriggered);
  t.ambiguousRate = share(t.ambiguous);
  t.incoherentRate = share(t.incoherent);
  t.openRate = share(t.open);
  // Taken over judged WAITs, not over all calls: the others sit in waitRate
  // already, and mixing "not looked at yet" into the denominator would make
  // over-caution look rarer the slower the tracker runs.
  t.waitMissRate = t.waitsJudged > 0 ? Math.round((t.waitsMissed / t.waitsJudged) * 100) : null;
  return t;
};

// What became of the plans the gate refused: a refusal was right if the
// market never reached the entry, wrong if the plan went on to win
export const shadowTally = (records: AnalysisRecord[]): ShadowTally => {
  const s: ShadowTally = { total: 0, untriggered: 0, wins: 0, losses: 0, open: 0, other: 0 };
  for (const r of records) {
    if (!isShadow(r)) continue;
    s.total++;
    if (r.outcome === "untriggered") s.untriggered++;
    else if (r.outcome === "win") s.wins++;
    else if (r.outcome === "loss") s.losses++;
    else if (r.outcome === "pending") s.open++;
    else s.other++;
  }
  return s;
};

// How often each cause came up in the post-mortems of the visible record
// The server renamed entry_too_early to chased_move and keeps counting them
// as one; the breakdown has to agree, or the same failure shows as two bars.
export const canonicalCause = (c: PostmortemCause): PostmortemCause =>
  c === "entry_too_early" ? "chased_move" : c;

export const causeCounts = (records: AnalysisRecord[]): Array<{ cause: PostmortemCause; count: number }> => {
  const counts = new Map<PostmortemCause, number>();
  for (const r of records) {
    if (isShadow(r) || isPreview(r)) continue;
    // Settled plans only. This histogram is rendered under "why plans
    // missed", and a WAIT diagnosis answers a different question — listing
    // "standing aside was right" as a cause of plans missing is a category
    // error, not a small mislabel. The WAIT verdicts have their own strip.
    if (r.signal === "WAIT" || r.outcome === "skipped" || r.postmortem?.subject === "wait") continue;
    const raw = r.postmortem?.status === "done" ? r.postmortem.cause : undefined;
    if (!raw) continue;
    const cause = canonicalCause(raw);
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count);
};

const groupBy = (
  records: AnalysisRecord[],
  keyOf: (r: AnalysisRecord) => string,
  order: string[],
  sortRest: (a: string, b: string) => number = () => 0,
): OutcomeTally[] => {
  const buckets = new Map<string, AnalysisRecord[]>();
  for (const r of records) {
    if (isShadow(r) || isPreview(r)) continue;
    const k = keyOf(r);
    const list = buckets.get(k) ?? [];
    list.push(r);
    buckets.set(k, list);
  }
  const rest = [...buckets.keys()].filter((k) => !order.includes(k)).sort(sortRest);
  const keys = [...order.filter((k) => buckets.has(k)), ...rest];
  // `calls`, not `total`: a bucket that is entirely WAIT has no trades but is
  // still something the analyst did, and dropping it hides exactly the
  // behaviour the WAIT rate exists to show.
  return keys.map((k) => tally(k, buckets.get(k) ?? [])).filter((t) => t.calls > 0);
};

export const byTimeframe = (records: AnalysisRecord[]): OutcomeTally[] =>
  groupBy(records, (r) => r.interval, TIMEFRAME_ORDER);

export const byMode = (records: AnalysisRecord[]): OutcomeTally[] =>
  groupBy(records, (r) => r.mode ?? "full", MODE_ORDER);

export const byConfidence = (records: AnalysisRecord[]): OutcomeTally[] =>
  groupBy(
    records,
    (r) => confidenceBandKey(r.confidence),
    [...CONFIDENCE_BANDS.map(([lo, hi]) => (hi === null ? `${lo}+` : `${lo}-${hi}`)), UNKNOWN_BAND],
  );

// The record split by the rulebook version the plans were made under:
// before any rules first, then each version in order — the before/after
// comparison that says whether a revision helped
// The old comparator was Number(key.slice(1)), which on a composite key is
// NaN — leaving the before/after table in whatever order the Map happened to
// iterate. Parse the tuple and sort on it.
const rulebookOrder = (key: string): [string, number] => {
  const [contract, version] = key.split("|");
  return [contract, version === NO_RULEBOOK ? 0 : Number(version.slice(1)) || 0];
};

export const byRulebookVersion = (records: AnalysisRecord[]): OutcomeTally[] =>
  groupBy(records, rulebookKey, [], (a, b) => {
    const [ca, va] = rulebookOrder(a);
    const [cb, vb] = rulebookOrder(b);
    // Legacy contract first, then by version inside each contract
    if (ca !== cb) return ca === LEGACY_CONTRACT ? -1 : cb === LEGACY_CONTRACT ? 1 : ca.localeCompare(cb);
    return va - vb;
  });

export const byContract = (records: AnalysisRecord[]): OutcomeTally[] =>
  groupBy(records, contractKey, [LEGACY_CONTRACT]);

// ---------------------------------------------------------------------------
// THREE SCORES KEPT APART: DIRECTION, TIMING, PLACEMENT
// ---------------------------------------------------------------------------
//
// Win/loss collapses three different questions into one number. A plan can be
// right about which way price went and wrong about where the stop went, and
// today both come out as "loss" with nothing to separate them.
//
// Nothing here computes anything. public.separated_scores() rolls up facts the
// post-mortem already wrote (analyses.postmortem->facts), and this file only
// reads that answer into a shape the panel can draw. There is deliberately NO
// client-side fallback that recomputes the three from the forty rows on
// screen: tally() can be a fallback because it and performance_stats agree on
// one definition, and there is no second implementation of these three to
// disagree with. Without the RPC the panel says it has no answer.
//
// WHAT THE THREE MAY NOT CLAIM — the same three sentences the migration, the
// panel and docs/SEPARATED_SCORES.md carry, because a caveat that lives in one
// of the three is a caveat nobody reads:
//   * direction can be right while the trade LOST. That is the point.
//   * timing is adverse excursion: how much HEAT the entry took, not whether
//     the entry was wrong. A trend entry takes heat by construction.
//   * placement is partly a consequence of direction and timing. The three are
//     NOT independent and NOT a decomposition. They do not add up to the win
//     rate and they partition nothing.

// Bumped only when the SCORING CHANGES. A change in how something is counted
// looks exactly like the analyst getting better or worse, and nothing else on
// the object can tell them apart. Pinned against the migration by
// src/test/separated-scores.test.ts.
export const SEPARATED_DEFINITION_VERSION = 1;

// Below this many scored rows the rate is real and its interval spans most of
// the range. Same floor performance_stats uses for below_min_n, and the same
// treatment: the number is REPORTED with the interval, never withheld —
// hiding it would hide how little there is.
export const SEPARATED_MIN_N = 20;

// Which of the three a stored cause speaks to. A grouping of the EXISTING
// taxonomy on public.lessons.cause — nothing is re-derived and nothing is
// re-diagnosed here. Mirrors the CASE in
// 20260910220000_score_direction_placement_and_timing_apart.sql; the test pins
// the two together.
//
// It is not a partition and it should not be read as one. stop_too_tight is a
// fact about where the stop sat AND about how much noise the entry sat in; it
// is filed under placement because a stop's location is placement. Both
// entry_too_far and entry_too_early are legacy vocabulary market_v1 cannot
// produce, kept because stored rows carry them — entry_too_early folded into
// chased_move exactly as canonicalCause() folds it everywhere else.
export type ScoreFamily = "direction" | "timing" | "placement" | "neither";

export const SCORE_FAMILY: Partial<Record<PostmortemCause, ScoreFamily>> = {
  direction_wrong: "direction",
  regime_misread: "direction",
  chased_move: "timing",
  entry_too_early: "timing",
  stop_too_tight: "placement",
  target_too_far: "placement",
  entry_too_far: "placement",
};

export const scoreFamily = (cause: PostmortemCause): ScoreFamily =>
  SCORE_FAMILY[canonicalCause(cause)] ?? "neither";

// One score, with everything needed to read it honestly in the same object:
// how many rows it was taken over, how many of those it counted, the interval,
// and how many rows of the population it could NOT be taken on.
export interface SeparatedScore {
  // Rows the score was actually taken over. THE DENOMINATOR, and the three
  // scores never share one.
  n: number;
  hits: number;
  rate: number | null;
  ci: [number, number] | null;
  // Rows in the graded population that carried no usable measurement. Shown
  // rather than dropped (#38, #25).
  unscored: number;
  belowMinN: boolean;
}

export interface SeparatedDirection extends SeparatedScore {
  // The two positive tests for a wrong direction, kept apart so a reader can
  // see which one fired: price kept running past the stop, or it never came
  // DIRECTION_DEAD_R our way while the plan was live.
  ranPastStop: number;
  neverCame: number;
  // Rows in `n` that could only ever have been a MISS: a wrong-direction test
  // fired on the one measurement present, and the row could not have joined
  // the denominator as a hit because the other measurement is missing. That
  // asymmetry is causeGrounds' own trichotomy read verbatim and is not
  // corrected here — it is counted, so that the day it stops being zero the
  // screen says so instead of the rate quietly drifting down.
  wrongPartial: number;
}

export interface SeparatedTiming extends SeparatedScore {
  // The deeper excursion (mae_r against LUCKY_MAE_R), over its OWN rows. Beside
  // the early one and never merged into it: different window, different
  // denominator.
  deepMae: SeparatedScore;
}

export interface SeparatedPlacement extends SeparatedScore {
  // Both counted over `n` — the placement rate's own denominator — and not
  // over the wider graded population, because they are printed beside that
  // rate.
  stopBad: number;
  targetBad: number;
  // Of `hits`, how many passed the stop leg WITHOUT the stop being simulated.
  // A trade that did not lose scores its stop "defensible" by construction:
  // causeGrounds('stop_too_tight') refuses to answer about a stop that was
  // never hit, so `bad` is unreachable on a win. Measured 2026-09-10 that is
  // 10 of the 13 hits, which means most of this score is "did not lose"
  // wearing a second name. Rendered on the row rather than left in a comment.
  stopUntested: number;
}

export interface SeparatedCauses {
  total: number;
  // How many of `total` came from a WAIT. The three scores exclude WAITs; this
  // histogram does not, and on 2026-09-10 the gap is 29 of 65. Without it the
  // block reads as a fourth view of the same trades.
  waits: number;
  direction: number;
  timing: number;
  placement: number;
  neither: number;
  byCause: Array<{ cause: PostmortemCause; count: number }>;
}

export interface SeparatedBlock {
  // The population the three were drawn FROM, before any of them dropped a row
  // for want of a measurement. Every `unscored` is this minus that score's n.
  gradedTrades: number;
  direction: SeparatedDirection;
  timing: SeparatedTiming;
  placement: SeparatedPlacement;
  causes: SeparatedCauses;
}

// What the numbers rest on. Rendered ABOVE the scores, not under a disclosure:
// three confident percentages over one pair in one direction over two weeks is
// the shape of the thing this screen has already had to have removed twice.
export interface SeparatedPopulation {
  calls: number;
  trades: number;
  waits: number;
  diagnosedTrades: number;
  undiagnosedTrades: number;
  pairs: string[];
  intervals: string[];
  signals: Array<{ signal: string; count: number }>;
  firstCallAt: string | null;
  lastCallAt: string | null;
}

export interface SeparatedScores {
  generatedAt: string | null;
  liveContract: string | null;
  definitionVersion: number | null;
  thresholds: { directionDeadR: number | null; earlyAdverseR: number | null; luckyMaeR: number | null };
  population: SeparatedPopulation;
  scopes: Record<string, SeparatedBlock>;
  byContract: Record<string, SeparatedBlock>;
  otherContractRows: number;
  otherContracts: string[];
}

// supabase.rpc() hands back `unknown`, and a client deployed ahead of the
// migration gets an error rather than an object. Everything below reads
// defensively and answers with a number the caller can render, never with a
// throw — the same discipline serverTally() follows for a server that predates
// a field.
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

// A rate, or null. NOT coerced to 0: "no rows to take this over" and "0% of
// them" are different findings and must not share a rendering.
const rate = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;

const ci = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x))
    ? [v[0] as number, v[1] as number]
    : null;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const score = (v: unknown): SeparatedScore => {
  const o = obj(v);
  const n = num(o.n);
  return {
    n,
    hits: num(o.hits),
    rate: rate(o.rate),
    ci: ci(o.ci95),
    unscored: num(o.unscored),
    // Computed here rather than trusted from the payload, so an older server
    // that never sent the flag still gets the floor applied.
    belowMinN: typeof o.below_min_n === "boolean" ? o.below_min_n : n < SEPARATED_MIN_N,
  };
};

const causes = (v: unknown): SeparatedCauses => {
  const o = obj(v);
  const by = obj(o.by_cause);
  return {
    total: num(o.total),
    waits: num(o.waits),
    direction: num(o.direction),
    timing: num(o.timing),
    placement: num(o.placement),
    neither: num(o.neither),
    byCause: Object.entries(by)
      .map(([cause, count]) => ({ cause: cause as PostmortemCause, count: num(count) }))
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count),
  };
};

const block = (v: unknown): SeparatedBlock => {
  const o = obj(v);
  const timing = obj(o.timing);
  const placement = obj(o.placement);
  const direction = obj(o.direction);
  return {
    gradedTrades: num(o.graded_trades),
    direction: {
      ...score(direction),
      ranPastStop: num(direction.ran_past_stop),
      neverCame: num(direction.never_came),
      wrongPartial: num(direction.wrong_partial),
    },
    timing: { ...score(timing), deepMae: score(timing.deep_mae) },
    placement: {
      ...score(placement),
      stopBad: num(placement.stop_bad),
      targetBad: num(placement.target_bad),
      stopUntested: num(placement.stop_untested),
    },
    causes: causes(o.causes),
  };
};

const blocks = (v: unknown): Record<string, SeparatedBlock> =>
  Object.fromEntries(Object.entries(obj(v)).map(([k, g]) => [k, block(g)]));

export const readSeparatedScores = (raw: unknown): SeparatedScores | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  // No scopes and no by_contract means this is not the object we asked for —
  // an error body, or a server that does not have the function. Answering with
  // a shell of zeroes would put three 0% scores on the screen and call them
  // measurements.
  if (!("scopes" in o) && !("by_contract" in o)) return null;
  const pop = obj(o.population);
  const th = obj(o.thresholds);
  const signals = obj(pop.signals);
  return {
    generatedAt: typeof o.generated_at === "string" ? o.generated_at : null,
    liveContract: typeof o.live_contract === "string" ? o.live_contract : null,
    definitionVersion: typeof o.definition_version === "number" ? o.definition_version : null,
    thresholds: {
      directionDeadR: typeof th.direction_dead_r === "number" ? th.direction_dead_r : null,
      earlyAdverseR: typeof th.early_adverse_r === "number" ? th.early_adverse_r : null,
      luckyMaeR: typeof th.lucky_mae_r === "number" ? th.lucky_mae_r : null,
    },
    population: {
      calls: num(pop.calls),
      trades: num(pop.trades),
      waits: num(pop.waits),
      diagnosedTrades: num(pop.diagnosed_trades),
      undiagnosedTrades: num(pop.undiagnosed_trades),
      pairs: strings(pop.pairs),
      intervals: strings(pop.intervals),
      signals: Object.entries(signals)
        .map(([signal, count]) => ({ signal, count: num(count) }))
        .sort((a, b) => b.count - a.count),
      firstCallAt: typeof pop.first_call_at === "string" ? pop.first_call_at : null,
      lastCallAt: typeof pop.last_call_at === "string" ? pop.last_call_at : null,
    },
    scopes: blocks(o.scopes),
    byContract: blocks(o.by_contract),
    otherContractRows: num(o.other_contract_rows),
    otherContracts: strings(o.other_contracts),
  };
};

// Which population the panel should draw, by the same rule headlineScope()
// uses for the record: the live contract, unless it has nothing and exactly
// one older contract does — in which case that one is drawn and the caller is
// told which, so the label can say so. Filtering a record away because every
// plan predates the current contract shows the owner nothing at all.
export const separatedHeadline = (
  s: SeparatedScores | null,
): { block: SeparatedBlock; contract: string | null } | null => {
  if (!s) return null;
  const live = s.scopes?.all_time;
  if (live && live.gradedTrades > 0) return { block: live, contract: null };
  const others = Object.entries(s.byContract ?? {}).filter(([, g]) => g.gradedTrades > 0);
  if (others.length === 1) return { block: others[0][1], contract: others[0][0] };
  return live ? { block: live, contract: null } : null;
};

// ---------------------------------------------------------------------------
// WHAT THE NUMBERS REST ON, DERIVED FROM THE NUMBERS
// ---------------------------------------------------------------------------
//
// The panel used to print "one currency pair, almost one direction, about two
// weeks" as a constant string, three lines under the pair list and the date
// span it was describing. That is the #83 shape exactly — a factual claim with
// no data behind it, sitting in the one sentence a reader trusts most, going
// stale the moment a second pair is analysed or the record reaches a month.
// The caveat is now MEASURED from the same population object it sits next to,
// so it cannot outlive its data.
export interface SeparatedBasis {
  // How many pairs the record covers. "One" is the finding; two is a different
  // finding and must not be printed as one.
  pairs: number;
  // Calendar days from the first call to the last. Null when either end is
  // missing — an unknown span must not render as 0 days.
  days: number | null;
  // The most common signal and its share of all calls, so "almost one
  // direction" is a percentage the reader can check rather than an adjective.
  topSignal: string | null;
  topShare: number | null;
}

const MS_PER_DAY = 86_400_000;

export const separatedBasis = (p: SeparatedPopulation): SeparatedBasis => {
  const from = p.firstCallAt ? Date.parse(p.firstCallAt) : NaN;
  const to = p.lastCallAt ? Date.parse(p.lastCallAt) : NaN;
  // Both ends, both parseable, and forwards. A negative or unparseable span is
  // no span, not a zero.
  const days = Number.isFinite(from) && Number.isFinite(to) && to >= from
    ? Math.max(1, Math.round((to - from) / MS_PER_DAY))
    : null;
  const top = p.signals.length > 0
    ? p.signals.reduce((a, b) => (b.count > a.count ? b : a))
    : null;
  return {
    pairs: p.pairs.length,
    days,
    topSignal: top ? top.signal : null,
    // Share of ALL calls, the same denominator `calls` reports. Null rather
    // than 0 when there is nothing to take a share of.
    topShare: top && p.calls > 0 ? Math.round((top.count * 100) / p.calls) : null,
  };
};

// Does any of the three intervals still contain 50%? While one does, the score
// it belongs to has not established anything in either direction, and the
// panel says so — instead of asserting from a constant that the record is too
// short, which stops being true at some point nobody will notice.
export const separatedUndecided = (b: SeparatedBlock | null): boolean => {
  if (!b || b.gradedTrades === 0) return true;
  return [b.direction, b.timing, b.placement].some(
    (s) => s.ci !== null && s.ci[0] <= 50 && s.ci[1] >= 50,
  );
};

// ---------------------------------------------------------------------------
// WHETHER CONFIDENCE COULD BE CORRECTED AT ALL
// ---------------------------------------------------------------------------
//
// #68 asks for confidence to be corrected against the record once enough of it
// exists. Before applying a correction there is one thing to check: a
// correction is a MAPPING from what the model said to what actually happened,
// and a mapping needs the stated number to MOVE. If it does not move, the
// correction is not weak — it is undefined.
//
// public.confidence_calibration() answers that question and APPLIES NOTHING.
// Nothing in this file applies anything either, and nothing here recomputes a
// rate: the panel draws the server's answer, exactly as SeparatedScores does,
// for the same reason (two implementations of one number is how one number
// with one name becomes two).
//
// WHAT THE ANSWER MAY NOT BE READ AS — carried here, in the panel and in the
// migration, because a caveat that lives in one of the three is a caveat
// nobody reads:
//   * the AUC is the chance a winning call carried a HIGHER stated confidence
//     than a losing one, ties counted as half. 0.5 is "does not rank outcomes
//     at all". An interval containing 0.5 establishes NOTHING — in particular
//     a measured value under 0.5 is NOT evidence that confidence is inverted.
//   * the AUC interval is a Hanley-McNeil normal approximation and gets worse
//     the more ties there are. Whatever prints the interval must print that.
//   * the gate was written AFTER the numbers were seen. It is not a
//     preregistration and must never be set beside docs/NOISE_FLOOR_PREREGISTRATION.md.

// The same floor performance_stats and the separated scores use, and the same
// treatment: a thin band is REPORTED as thin, never withheld. Only a fallback
// here — the gate carries the server's own min_n_per_band, and that is what is
// rendered when it arrives.
export const CONFIDENCE_MIN_N = 20;

// The AUC of a number that ranks nothing. Named rather than spelled 0.5 in
// aucEstablishesNothing below, so the constant and the sentence the panel
// renders about it cannot drift apart.
export const AUC_CHANCE = 0.5;

// How far confidence actually ranges over one population. Every bound is
// nullable: an empty population has no lowest value, and rendering that as 0
// would put a confidence of zero on the screen that no call ever carried.
export interface CalibrationSpan {
  n: number | null;
  lo: number | null;
  hi: number | null;
  width: number | null;
  distinctValues: number | null;
}

// One stated confidence value and what became of the calls carrying it. The
// value itself, NOT a band: the whole finding is how few distinct values there
// are, and a band hides exactly that.
export interface CalibrationValueRow {
  confidence: number | null;
  settled: number | null;
  wins: number | null;
  losses: number | null;
  winRate: number | null;
  ci: [number, number] | null;
}

export interface CalibrationBandRow extends CalibrationValueRow {
  bandLo: number | null;
  bandHi: number | null;
  belowMinN: boolean;
}

export interface CalibrationDiscrimination {
  nWin: number | null;
  nLoss: number | null;
  totalPairs: number | null;
  concordant: number | null;
  ties: number | null;
  discordant: number | null;
  // 0.5 = the stated confidence does not rank outcomes at all.
  auc: number | null;
  ci: [number, number] | null;
  // True unless the server says otherwise, and the server currently always
  // says true. Defaulting the other way would let a payload that forgot the
  // flag print an approximate interval as an exact one.
  ciApproximate: boolean;
  tieShare: number | null;
}

export interface CalibrationGate {
  // Whether a correction is being applied. The server hard-codes false; it is
  // read rather than assumed so that the day it changes, the screen changes.
  applies: boolean;
  minNPerBand: number | null;
  needBands: number | null;
  haveBands: number | null;
  needSettled: number | null;
  haveSettled: number | null;
  met: boolean;
  // FALSE on this instrument: the thresholds were chosen after the numbers
  // were seen. Defaults to false when absent — an unstated preregistration is
  // not a preregistration.
  preregistered: boolean;
}

export interface ConfidenceCalibration {
  contract: string | null;
  span: { all: CalibrationSpan; traded: CalibrationSpan; wait: CalibrationSpan };
  byValue: CalibrationValueRow[];
  byBand: CalibrationBandRow[];
  discrimination: CalibrationDiscrimination;
  gate: CalibrationGate;
}

// A number, or null. NOT num(): on this payload every field is a count of real
// rows or a bound of a real range, and a field the server did not send,
// rendered as 0, reads as "there are none of those" — a finding, where the
// truth is the absence of one. The same rule rate() already follows, applied
// to the counts as well.
const maybeNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const flag = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

const span = (v: unknown): CalibrationSpan => {
  const o = obj(v);
  return {
    n: maybeNum(o.n),
    lo: maybeNum(o.lo),
    hi: maybeNum(o.hi),
    // The server sends null for an empty population rather than 0. Kept null:
    // "no calls, so no width" and "every call carried the same number" are
    // different findings and must not share a rendering.
    width: maybeNum(o.width),
    distinctValues: maybeNum(o.distinct_values),
  };
};

const valueRow = (v: unknown): CalibrationValueRow => {
  const o = obj(v);
  return {
    confidence: maybeNum(o.confidence),
    settled: maybeNum(o.settled),
    wins: maybeNum(o.wins),
    losses: maybeNum(o.losses),
    winRate: rate(o.win_rate),
    ci: ci(o.ci95),
  };
};

const bandRow = (v: unknown, minN: number | null): CalibrationBandRow => {
  const o = obj(v);
  const settled = maybeNum(o.settled);
  return {
    ...valueRow(v),
    bandLo: maybeNum(o.band_lo),
    bandHi: maybeNum(o.band_hi),
    // Computed here when the server did not send the flag, against the gate's
    // own floor when it sent one, so an older server still gets the floor
    // applied. A band whose n cannot be read is treated as thin — the
    // cautious direction.
    belowMinN: typeof o.below_min_n === "boolean"
      ? o.below_min_n
      : settled === null || settled < (minN ?? CONFIDENCE_MIN_N),
  };
};

const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const readConfidenceCalibration = (raw: unknown): ConfidenceCalibration | null => {
  // The only reason to answer null. supabase.rpc() hands back `unknown`, and a
  // client deployed ahead of the migration gets an error body or a string;
  // neither is an object and neither can be drawn. Everything past this point
  // reads defensively and renders "not readable" rather than throwing.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const sp = obj(o.span);
  const disc = obj(o.discrimination);
  const g = obj(o.gate);
  const minNPerBand = maybeNum(g.min_n_per_band);
  return {
    contract: typeof o.contract === "string" ? o.contract : null,
    span: { all: span(sp.all), traded: span(sp.traded), wait: span(sp.wait) },
    byValue: rows(o.by_value).map(valueRow),
    byBand: rows(o.by_band).map((b) => bandRow(b, minNPerBand)),
    discrimination: {
      nWin: maybeNum(disc.n_win),
      nLoss: maybeNum(disc.n_loss),
      totalPairs: maybeNum(disc.total_pairs),
      concordant: maybeNum(disc.concordant),
      ties: maybeNum(disc.ties),
      discordant: maybeNum(disc.discordant),
      // NOT rounded to a whole number the way a percentage is: this one lives
      // between 0 and 1, and Math.round would turn every value it can take
      // into 0 or 1.
      auc: maybeNum(disc.auc),
      ci: ci(disc.ci95),
      ciApproximate: flag(disc.ci95_approximate, true),
      tieShare: maybeNum(disc.tie_share),
    },
    gate: {
      // Both default to the answer that claims less: no correction is being
      // applied, and nothing has been met.
      applies: flag(g.applies, false),
      minNPerBand,
      needBands: maybeNum(g.need_bands),
      haveBands: maybeNum(g.have_bands),
      needSettled: maybeNum(g.need_settled),
      haveSettled: maybeNum(g.have_settled),
      met: flag(g.met, false),
      preregistered: flag(g.preregistered, false),
    },
  };
};

// Does the AUC interval still contain 0.5? While it does, the number has
// established nothing IN EITHER DIRECTION — a measured 0.469 is not evidence
// that confidence is inverted, only that 37 settled calls cannot tell 0.469
// from chance. Derived from the interval rather than asserted from a sentence
// that stops being true without anyone noticing (#83).
//
// No interval, or no AUC, is also "nothing established": the absence of a
// measurement must never read as a measurement that came out clean.
export const aucEstablishesNothing = (d: CalibrationDiscrimination | null): boolean => {
  if (!d || d.auc === null || d.ci === null) return true;
  return d.ci[0] <= AUC_CHANCE && d.ci[1] >= AUC_CHANCE;
};

// How much room a correction would have to work in. A mapping from stated
// confidence to observed win rate needs the stated number to MOVE; over a
// span of one distinct value there is no mapping to fit, whatever the record
// says. Null when the span could not be read — not 0, which would claim the
// model says the same thing every time.
export const calibrationRoom = (s: CalibrationSpan): number | null =>
  s.width !== null ? s.width : s.lo !== null && s.hi !== null ? s.hi - s.lo : null;

// ---------------------------------------------------------------------------
// WHICH ANALYST WROTE THE RECORD
// ---------------------------------------------------------------------------
//
// performance_stats partitions the record on plan_contract and rulebook
// version, and on nothing else. The analyst behind the calls was never part of
// the key, so the day a second one starts answering, both of their track
// records land in one win rate with nothing left to separate them by — the
// exact confound the contract key already guards against, one column short.
//
// public.model_mix() answers the one question that prevents it: how many
// distinct analysts have settled trades inside the live contract, and how many
// rows carry no record of who wrote them. Nothing here corrects anything and
// nothing here re-derives a rate; the panel draws the server's answer, for the
// same reason every other panel on this screen does.
//
// THE ONE READING THIS MUST NEVER PERMIT: a row whose model is NULL means "not
// recorded". It does NOT mean "the usual one". Those rows predate the column
// and can never be filled in, so an unrecorded count rendered as, or folded
// into, a named analyst's total would be a claim about the record invented out
// of a gap in it.

// One analyst's slice of the record. Every count is nullable for the reason
// maybeNum() exists: a field the payload never sent, drawn as 0, reads as
// "this model settled nothing" — a finding, where the truth is the absence of
// one.
export interface ModelMixEntry {
  // The identifier the server stored, rendered verbatim. Data, never a label
  // this app chooses.
  model: string;
  calls: number | null;
  traded: number | null;
  // Wins plus losses. THE number that feeds the win rate, which is why the
  // whole panel is keyed on it rather than on `calls`: a model that was merely
  // called has not moved the record.
  settled: number | null;
  firstAt: string | null;
  lastAt: string | null;
}

export interface ModelMix {
  contract: string | null;
  calls: number | null;
  models: ModelMixEntry[];
  // More than one model has SETTLED trades here, so the headline win rate is
  // already a blend and cannot be read as either analyst's.
  pooled: boolean;
  // Models with settled trades. Excludes the unrecorded bucket — that bucket
  // is not a model.
  modelsWithSettled: number | null;
  // Rows whose model is NULL: not recorded, never "the default".
  unrecorded: number | null;
  unrecordedSettled: number | null;
}

const modelEntry = (v: unknown): ModelMixEntry | null => {
  const o = obj(v);
  const model = typeof o.model === "string" && o.model.length > 0 ? o.model : null;
  // An entry with no readable identifier is dropped rather than kept under a
  // placeholder. The panel's whole job is to say WHO wrote the record, and a
  // nameless row drawn beside the named ones is read as one more analyst — or,
  // worse, as the usual one.
  if (model === null) return null;
  return {
    model,
    calls: maybeNum(o.calls),
    traded: maybeNum(o.traded),
    settled: maybeNum(o.settled),
    firstAt: typeof o.first_at === "string" ? o.first_at : null,
    lastAt: typeof o.last_at === "string" ? o.last_at : null,
  };
};

// Models with settled trades, which is the only population the pooling
// question is about. A model that was called and never settled anything has
// not written a line of the record.
export const settledModels = (m: ModelMix): ModelMixEntry[] =>
  m.models.filter((e) => e.settled !== null && e.settled > 0);

export const readModelMix = (raw: unknown): ModelMix | null => {
  // The only reason to answer null, exactly as readConfidenceCalibration()
  // does: supabase.rpc() hands back `unknown`, and a client deployed ahead of
  // the migration gets an error body or a string. Neither is an object and
  // neither can be drawn. Everything past this point renders "not readable"
  // rather than throwing.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const models = rows(o.models)
    .map(modelEntry)
    .filter((e): e is ModelMixEntry => e !== null)
    // Ordered by what the reader is being asked to see — the settled split —
    // rather than by call volume, so the model that actually wrote the win
    // rate is the first one named. Unreadable counts sort last; ties break on
    // the identifier so the list cannot reorder itself between renders.
    .sort((a, b) => (b.settled ?? -1) - (a.settled ?? -1) || (b.calls ?? -1) - (a.calls ?? -1) || a.model.localeCompare(b.model));
  const withSettled = models.filter((e) => e.settled !== null && e.settled > 0).length;
  return {
    contract: typeof o.contract === "string" ? o.contract : null,
    calls: maybeNum(o.calls),
    models,
    // OR, not a trust. The server's flag is authoritative when it says the
    // record is pooled, and the visible split is authoritative when it shows
    // two analysts a flag forgot to mention. Both directions matter, but they
    // are not symmetric: a blend drawn as one analyst's record is the failure
    // this panel exists to prevent, and a warning shown one render early is
    // not.
    pooled: flag(o.pooled, false) || withSettled > 1,
    modelsWithSettled: maybeNum(o.models_with_settled),
    unrecorded: maybeNum(o.unrecorded),
    unrecordedSettled: maybeNum(o.unrecorded_settled),
  };
};
