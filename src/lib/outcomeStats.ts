import type { AnalysisRecord } from "./types";

// Win/loss bookkeeping over history rows. Only WIN and LOSS count toward the
// rate: an entry that never filled or a bar that touched both levels says
// nothing about whether the call was right.

export interface OutcomeTally {
  key: string;
  wins: number;
  losses: number;
  open: number;
  untriggered: number;
  ambiguous: number;
  expired: number;
  total: number;
  winRate: number | null;
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

export const confidenceBandKey = (confidence: number | null): string => {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return UNKNOWN_BAND;
  const c = confidence;
  for (const [lo, hi] of CONFIDENCE_BANDS) {
    if (hi === null || c <= hi) return hi === null ? `${lo}+` : `${lo}-${hi}`;
  }
  return "0-59";
};

export const tally = (key: string, records: AnalysisRecord[]): OutcomeTally => {
  const t: OutcomeTally = { key, wins: 0, losses: 0, open: 0, untriggered: 0, ambiguous: 0, expired: 0, total: 0, winRate: null };
  for (const r of records) {
    if (r.signal === "WAIT" || r.outcome === "skipped") continue;
    t.total++;
    if (r.outcome === "win") t.wins++;
    else if (r.outcome === "loss") t.losses++;
    else if (r.outcome === "pending") t.open++;
    else if (r.outcome === "untriggered") t.untriggered++;
    else if (r.outcome === "ambiguous") t.ambiguous++;
    else if (r.outcome === "expired") t.expired++;
  }
  const closed = t.wins + t.losses;
  t.winRate = closed > 0 ? Math.round((t.wins / closed) * 100) : null;
  return t;
};

const groupBy = (
  records: AnalysisRecord[],
  keyOf: (r: AnalysisRecord) => string,
  order: string[],
): OutcomeTally[] => {
  const buckets = new Map<string, AnalysisRecord[]>();
  for (const r of records) {
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
