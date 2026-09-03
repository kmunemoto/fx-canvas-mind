import type { AnalysisRecord, PostmortemCause } from "./types";

// Win/loss bookkeeping over history rows. Only WIN and LOSS count toward the
// rate: an entry that never filled or a bar that touched both levels says
// nothing about whether the call was right.
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
  total: number;
  // WAIT rows that were the gate's doing, not the model's
  rejected: number;
  winRate: number | null;
  // Share of settled plans that actually became a trade. A signal whose entry
  // the market never reaches teaches nothing, so this is tracked next to the
  // win rate rather than buried in the outcome counts.
  fillRate: number | null;
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

// A trade happened if the tracker saw the entry reached; an ambiguous row
// with a fill still counts as one
const wasFilled = (r: AnalysisRecord): boolean =>
  r.outcome === "win" || r.outcome === "loss" || r.outcome === "expired" ||
  (r.outcome === "ambiguous" && typeof r.evaluation?.filled_at === "string" && r.evaluation.filled_at.length > 0);

export const tally = (key: string, records: AnalysisRecord[]): OutcomeTally => {
  const t: OutcomeTally = { key, wins: 0, losses: 0, open: 0, untriggered: 0, ambiguous: 0, expired: 0, total: 0, rejected: 0, winRate: null, fillRate: null };
  let filled = 0;
  let settled = 0;
  for (const r of records) {
    if (isShadow(r)) continue;
    if (isRejected(r)) t.rejected++;
    if (r.signal === "WAIT" || r.outcome === "skipped") continue;
    t.total++;
    if (r.outcome === "win") t.wins++;
    else if (r.outcome === "loss") t.losses++;
    else if (r.outcome === "pending") t.open++;
    else if (r.outcome === "untriggered") t.untriggered++;
    else if (r.outcome === "ambiguous") t.ambiguous++;
    else if (r.outcome === "expired") t.expired++;
    if (wasFilled(r)) {
      filled++;
      settled++;
    } else if (r.outcome === "untriggered") {
      settled++;
    }
  }
  const closed = t.wins + t.losses;
  t.winRate = closed > 0 ? Math.round((t.wins / closed) * 100) : null;
  // 'ambiguous' without a fill is left out of both sides: it is precisely
  // the case where we could not establish whether the trade happened
  t.fillRate = settled > 0 ? Math.round((filled / settled) * 100) : null;
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
): OutcomeTally[] => {
  const buckets = new Map<string, AnalysisRecord[]>();
  for (const r of records) {
    if (isShadow(r)) continue;
    const k = keyOf(r);
    const list = buckets.get(k) ?? [];
    list.push(r);
    buckets.set(k, list);
  }
  const keys = [...order.filter((k) => buckets.has(k)), ...[...buckets.keys()].filter((k) => !order.includes(k))];
  return keys.map((k) => tally(k, buckets.get(k) ?? [])).filter((t) => t.total > 0);
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
