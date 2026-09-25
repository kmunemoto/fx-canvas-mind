import { supabase } from "@/lib/supabase";

// #105: the email-alert settings as the signal-alerts function returns them.
// Everything arrives as JSON; anything malformed is dropped rather than drawn.

export const SIGNAL_ALERTS_URL = "https://endcqzewujdvimdlazhj.supabase.co/functions/v1/signal-alerts";

export type AlertStatus = "pending" | "sent" | "failed" | "not_configured" | "skipped";

// #108: what a recorded signal did after it fired
export type SignalOutcome = "win" | "loss" | "ambiguous" | "expired" | "no_data";

export interface AlertResult {
  outcome: SignalOutcome | null;
  r: number | null;
  bars: number | null;
}

export interface RecordSummary {
  n: number;
  wins: number;
  losses: number;
  expired: number;
  open: number;
  winRate: number | null;
  meanR: number | null;
  ciR: number | null;
  sumR: number;
}

export interface Performance {
  days: number;
  mine: RecordSummary;
  all: RecordSummary;
  costly: RecordSummary;
  byTf: Record<string, RecordSummary>;
  backtest: { period: string; n: number; winRate: number; meanR: number; breakeven: number } | null;
}

export interface AlertRow {
  id: string;
  kind: "signal" | "test";
  pair: string | null;
  interval: string | null;
  side: "BUY" | "SELL" | null;
  closedAt: string | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  status: AlertStatus;
  skipReason: string | null;
  createdAt: string;
  // null until the row is linked to a recorded signal (#108)
  result: AlertResult | null;
}

export interface AlertSettings {
  allowed: boolean;
  emailConfigured: boolean;
  email: string | null;
  pairs: string[];
  intervals: string[];
  subscriptions: Array<{ pair: string; interval: string }>;
  alerts: AlertRow[];
  // the outcome of a test send, when the call was one
  test: AlertStatus | null;
  performance: Performance | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const STATUSES: AlertStatus[] = ["pending", "sent", "failed", "not_configured", "skipped"];
const statusOf = (v: unknown): AlertStatus | null => (STATUSES as unknown[]).includes(v) ? (v as AlertStatus) : null;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const OUTCOMES: SignalOutcome[] = ["win", "loss", "ambiguous", "expired", "no_data"];
const resultOf = (v: unknown): AlertResult | null => {
  const e = rec(v);
  if (!e) return null;
  return {
    outcome: (OUTCOMES as unknown[]).includes(e.outcome) ? (e.outcome as SignalOutcome) : null,
    r: num(e.r),
    bars: num(e.bars),
  };
};

const summaryOf = (v: unknown): RecordSummary | null => {
  const x = rec(v);
  if (!x) return null;
  const n = num(x.n);
  if (n === null) return null;
  return {
    n,
    wins: num(x.wins) ?? 0,
    losses: num(x.losses) ?? 0,
    expired: num(x.expired) ?? 0,
    open: num(x.open) ?? 0,
    winRate: num(x.winRate),
    meanR: num(x.meanR),
    ciR: num(x.ciR),
    sumR: num(x.sumR) ?? 0,
  };
};

export const normalizePerformance = (v: unknown): Performance | null => {
  const p = rec(v);
  if (!p) return null;
  const mine = summaryOf(p.mine);
  const all = summaryOf(p.all);
  const costly = summaryOf(p.costly);
  if (!mine || !all || !costly) return null;
  const byTf: Record<string, RecordSummary> = {};
  const tf = rec(p.byTf);
  if (tf) {
    for (const [k, val] of Object.entries(tf)) {
      const sm = summaryOf(val);
      if (sm) byTf[k] = sm;
    }
  }
  const b = rec(p.backtest);
  const backtest = b && typeof b.period === "string" && num(b.winRate) !== null && num(b.meanR) !== null
    ? { period: b.period, n: num(b.n) ?? 0, winRate: num(b.winRate)!, meanR: num(b.meanR)!, breakeven: num(b.breakeven) ?? 0.4 }
    : null;
  return { days: num(p.days) ?? 365, mine, all, costly, byTf, backtest };
};

const alertRow = (v: unknown): AlertRow | null => {
  const r = rec(v);
  const id = str(r?.id);
  const status = statusOf(r?.status);
  const createdAt = str(r?.created_at);
  if (!r || !id || !status || !createdAt || (r.kind !== "signal" && r.kind !== "test")) return null;
  return {
    id,
    kind: r.kind,
    pair: str(r.pair),
    interval: str(r.interval),
    side: r.side === "BUY" || r.side === "SELL" ? r.side : null,
    closedAt: str(r.closed_at),
    entry: num(r.entry),
    stop: num(r.stop),
    target: num(r.target),
    status,
    skipReason: str(r.skip_reason),
    createdAt,
    result: resultOf(r.event),
  };
};

export const normalizeAlertSettings = (value: unknown): AlertSettings | null => {
  const s = rec(value);
  if (!s || s.ok !== true || typeof s.allowed !== "boolean" || typeof s.email_configured !== "boolean") return null;
  const subs = Array.isArray(s.subscriptions)
    ? s.subscriptions
      .map(rec)
      .filter((x): x is Record<string, unknown> => x !== null && typeof x.pair === "string" && typeof x.interval === "string")
      .map((x) => ({ pair: x.pair as string, interval: x.interval as string }))
    : [];
  return {
    allowed: s.allowed,
    emailConfigured: s.email_configured,
    email: str(s.email),
    pairs: strings(s.pairs),
    intervals: strings(s.intervals),
    subscriptions: subs,
    alerts: Array.isArray(s.alerts) ? s.alerts.map(alertRow).filter((x): x is AlertRow => x !== null) : [],
    test: statusOf(s.test),
    performance: normalizePerformance(s.performance),
  };
};

export const isFollowing = (settings: AlertSettings, pair: string, interval: string): boolean =>
  settings.subscriptions.some((s) => s.pair === pair && s.interval === interval);

export class AlertRequestError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// One call to the function with the signed-in user's token
export const callSignalAlerts = async (body: Record<string, unknown>): Promise<AlertSettings> => {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new AlertRequestError("login_required");
  const res = await fetch(SIGNAL_ALERTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  const settings = normalizeAlertSettings(data);
  if (!res.ok || !settings) {
    const code = rec(data) && typeof (data as Record<string, unknown>).error === "string" ? String((data as Record<string, unknown>).error) : `http_${res.status}`;
    throw new AlertRequestError(code);
  }
  return settings;
};
