import type { AnalysisRecord, PlanContract, PostmortemCause } from "./types";

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
  // WAIT rows that were the gate's doing, not the model's
  rejected: number;
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
// decision about one situation
export const CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;

// [lower bound, upper bound or null for open-ended]
export const CONFIDENCE_BANDS: Array<[number, number | null]> = [
  [0, 59],
  [60, 69],
  [70, 79],
  [80, null],
];

export const UNKNOWN_BAND = "unknown";

export const isShadow = (r: AnalysisRecord): boolean => r.shadow === true;
export const isRejected = (r: AnalysisRecord): boolean =>
  r.signal === "WAIT" && typeof r.entry_check?.rejection === "string" && r.entry_check.rejection.length > 0;

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

// Cluster ids, in input order: same pair, same direction, opened within
// CLUSTER_WINDOW_MS of the cluster's first plan
export const clusterIds = (items: Array<Pick<AnalysisRecord, "pair" | "signal" | "created_at">>): string[] => {
  const order = items
    .map((item, i) => ({ i, t: Date.parse(item.created_at) }))
    .sort((a, b) => (Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0));
  const starts = new Map<string, { id: string; t: number }>();
  const out = new Array<string>(items.length);
  for (const { i, t } of order) {
    const item = items[i];
    const key = `${item.pair}|${item.signal}`;
    const current = starts.get(key);
    if (current && Number.isFinite(t) && t - current.t < CLUSTER_WINDOW_MS) {
      out[i] = current.id;
      continue;
    }
    const id = `${key}|${Number.isFinite(t) ? new Date(t).toISOString().slice(0, 13) : "unknown"}`;
    starts.set(key, { id, t: Number.isFinite(t) ? t : 0 });
    out[i] = id;
  }
  return out;
};

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

export const tally = (key: string, records: AnalysisRecord[]): OutcomeTally => {
  const t: OutcomeTally = {
    key, wins: 0, losses: 0, open: 0, untriggered: 0, ambiguous: 0, expired: 0,
    incoherent: 0, waits: 0, waitsJudged: 0, waitsMissed: 0, total: 0, calls: 0,
    rejected: 0, contracts: [],
    winRate: null, winRateCi: null, clusters: 0, fillRate: null, sumR: null, expectancy: null,
    verdictRate: null, waitRate: null, expiredRate: null, untriggeredRate: null,
    ambiguousRate: null, incoherentRate: null, openRate: null, waitMissRate: null,
  };
  let filled = 0;
  let settled = 0;
  let sumR = 0;
  let withR = 0;
  const clusters = clusterIds(records);
  const settledClusters = new Set<string>();
  const seenContracts = new Set<PlanContract>();
  records.forEach((r, i) => {
    if (isShadow(r)) return;
    seenContracts.add(contractKey(r));
    if (isRejected(r)) t.rejected++;
    // Every call counts, WAIT included: a call that declines to trade is
    // still a call, and one that is never counted can never be wrong.
    t.calls++;
    if (r.signal === "WAIT" || r.outcome === "skipped") {
      t.waits++;
      // 'pending' has not been judged yet and 'unknown' never can be, so
      // neither belongs on either side of the rate.
      const verdict = r.wait_check?.verdict;
      if (verdict === "missed" || verdict === "correct") {
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
    if (r.outcome === "win" || r.outcome === "loss") settledClusters.add(clusters[i]);
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
export const causeCounts = (records: AnalysisRecord[]): Array<{ cause: PostmortemCause; count: number }> => {
  const counts = new Map<PostmortemCause, number>();
  for (const r of records) {
    if (isShadow(r)) continue;
    const cause = r.postmortem?.status === "done" ? r.postmortem.cause : undefined;
    if (!cause) continue;
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
    if (isShadow(r)) continue;
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
