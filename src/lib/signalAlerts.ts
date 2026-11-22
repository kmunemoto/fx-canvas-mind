import { supabase } from "@/lib/supabase";
import { isStockSymbol } from "@/lib/stocks";

// #105: the email-alert settings as the signal-alerts function returns them.
// Everything arrives as JSON; anything malformed is dropped rather than drawn.

export const SIGNAL_ALERTS_URL = "https://endcqzewujdvimdlazhj.supabase.co/functions/v1/signal-alerts";

export type AlertStatus = "pending" | "sent" | "failed" | "not_configured" | "skipped";

// #112: RSI + SAR, or the GA-style rule beside it; #155: Q-Trend's and
// ULTRA's signals, on every pair of the live chart; #275: and the MACD
// peak-and-valley rule, on GMO's currency pairs (5 minutes; #324: 1 hour
// from signal-alerts v25, the charts the server sends; #345: and gold's
// 1 hour from v27); #291:
// and the owner's video's way (liquidity sweep + EMA cross), on gold's
// 1-minute chart; #385: and AMD Po3's DIST, on Q-Trend's and ULTRA's charts
// #387: and the owner's video's EMA 20 / 200 way, on the six's 15-minute chart
// #391: and the MACD email on shares, the 22 shares' 1-hour chart
// #395: and a sharp rise or fall of the 1-hour bar, on the six's 1-hour chart
// #397: the MACD peak-and-valley email is now the "MACD ride" (docs §8.150): two emails a ride,
// the keys macdx and stockmacd stay
export type AlertRule = "rsi_sar" | "gainz" | "qtrend" | "ultra" | "macdx" | "sweepx" | "amdpo3" | "emarm" | "stockmacd" | "spike";
export const ALERT_RULES: AlertRule[] = ["rsi_sar", "gainz", "qtrend", "ultra", "macdx", "sweepx", "amdpo3", "emarm", "stockmacd", "spike"];
export type IndicatorAlertRule = "qtrend" | "ultra" | "macdx" | "sweepx" | "amdpo3" | "emarm" | "stockmacd" | "spike";
export const isIndicatorAlertRule = (r: AlertRule): r is IndicatorAlertRule =>
  r === "qtrend" || r === "ultra" || r === "macdx" || r === "sweepx" || r === "amdpo3" || r === "emarm" || r === "stockmacd" || r === "spike";
const ruleOf = (v: unknown): AlertRule =>
  v === "gainz" || v === "qtrend" || v === "ultra" || v === "macdx" || v === "sweepx" || v === "amdpo3" || v === "emarm" || v === "stockmacd" || v === "spike" ? v : "rsi_sar";
// signal_alerts / signal_events store the rule's full id (analyze/gainz.ts
// GA_RULE_ID starts with "gainz", signal-alerts/indicators.ts's with
// "qtrend", "ultra", "macdx", "sweepx", "amdpo3", "emarm" and "spike";
// stocks.ts's with "stockmacd"); anything else is RSI + SAR's
const ruleOfId = (v: unknown): AlertRule => {
  if (typeof v !== "string") return "rsi_sar";
  for (const r of ["gainz", "qtrend", "ultra", "macdx", "sweepx", "amdpo3", "emarm", "stockmacd", "spike"] as const) if (v.startsWith(r)) return r;
  return "rsi_sar";
};

// #397: which of the MACD ride's three mails a row is, from the full rule id
// ("macdx_12_26_9_w600_1h_ride90to96of120_in_v9", "..._at_v9", "..._out_v9"; the
// shares' start with "stockmacd"); null for any other row, an old v8 one included.
// v10 (research/macdride10-spec.md sections 2 and 8): the pairs' and gold's ids say
// "touch90to95of120" (email 1 the moment the line touches 90%, email 2 at 95%:
// "macdx_12_26_9_w600_1h_touch90to95of120_in_v10"), the shares' "ride90to95of120"
// (from their v3); the level of email 2 and the notice is read from the id, so a v9
// row still says 96% and a v10 row 95%
export type RideMail = "in" | "at" | "out";
const RIDE_ID = /^(?:macdx|stockmacd)_.*_(?:touch|ride)(\d+)to(\d+)of120_(in|at|out)_/;
const rideOfId = (v: unknown): RideMail | null => {
  if (typeof v !== "string") return null;
  const m = RIDE_ID.exec(v);
  return m ? (m[3] as RideMail) : null;
};
// the level (in percent) of email 2 and the notice of the ride a row is of; null for
// any other row
const rideOutPctOfId = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const m = RIDE_ID.exec(v);
  return m ? Number(m[2]) : null;
};

// The MACD fade (research/macdfade1h-prod-spec.md section 5): one email when the blue line closes at 96% of the newest
// 120 1-hour bars' pane with the bar before not at 96%, the fade side, no take-profit and no stop price. Its ids say
// "fade96of120_in" (the pairs' and gold's "macdx_12_26_9_w600_1h_fade96of120_in_v11", the shares'
// "stockmacd_12_26_9_w600_1h_fade96of120_in_v4"); the level is read from the id. RIDE_ID never matches them and this
// never matches a ride's id, so a v9 row reads as before and a v8 or older row as an earlier rule's
export interface FadeOf {
  pct: number;
}
const FADE_ID = /^(?:macdx|stockmacd)_.*_fade(\d+)(?:tp[0-9a-z]+)?of120_in_/;
const fadeOfId = (v: unknown): FadeOf | null => {
  if (typeof v !== "string") return null;
  const m = FADE_ID.exec(v);
  return m ? { pct: Number(m[1]) } : null;
};

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

export interface RuleRecord {
  mine: RecordSummary;
  all: RecordSummary;
  costly: RecordSummary;
  byTf: Record<string, RecordSummary>;
  backtest: { period: string; n: number; winRate: number; meanR: number; breakeven: number } | null;
}

// RSI + SAR's record at the top level (as before #112), the GA rule's beside it
export interface Performance extends RuleRecord {
  days: number;
  gainz: RuleRecord | null;
}

export interface AlertRow {
  id: string;
  kind: "signal" | "test";
  rule: AlertRule;
  // #397: the MACD ride's mail this row is: "in" = email 1 (an entry), "at" = the
  // notice (already at the exit level), "out" = email 2 (the line reached the exit
  // level; entry = the first email's price, target = the price when seen); null for
  // every other row
  ride: RideMail | null;
  // v10: the exit level of that ride in percent, from the row's id (v9 96, v10 95);
  // null for every other row
  rideOutPct: number | null;
  // the MACD fade's email (its one mail: an entry with no take-profit or stop price), with its level in percent from
  // the row's id (96); null for every other row, a ride's included
  fade: FadeOf | null;
  pair: string | null;
  interval: string | null;
  side: "BUY" | "SELL" | null;
  closedAt: string | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  // #155: a Q-Trend signal that was a STRONG one
  strong: boolean;
  status: AlertStatus;
  skipReason: string | null;
  createdAt: string;
  // null until the row is linked to a recorded signal (#108)
  result: AlertResult | null;
}

// v42 (research/allstocks-prod-spec.md 4.2, 6.1): a followed share's line of the stock MACD block
export interface StockShare {
  name: string | null;
  lastBarAt: string | null;
  bars: number | null;
  stale: boolean;
}

export interface AlertSettings {
  allowed: boolean;
  emailConfigured: boolean;
  email: string | null;
  pairs: string[];
  intervals: string[];
  // #155: Q-Trend's and ULTRA's charts: every pair of the live chart on
  // these timeframes, some pairs (those read from Twelve Data) on fewer
  // #275: and the charts the MACD peak-and-valley rule may be followed on
  // (#324: the owner's five pairs on 1 hour, from signal-alerts v25; before
  // it GMO's currency pairs on 5 minutes; #345: and gold from v27), null from
  // a server that does not send them;
  // #291: and the video's way's (gold, 1 minute), likewise
  // v41 per pair (research/macdfade15min-prod-spec.md section 5): the MACD fade's block also says which of its
  // timeframes each pair is offered on (`limited`, read as the base block's is): USD/JPY and AUD/USD on 15 minutes,
  // EUR/JPY, AUD/JPY, EUR/USD and gold on 1 hour; a server that does not send it (v40 and before) leaves it empty,
  // and then every pair is offered on every timeframe of the block, as before
  indicator: {
    pairs: string[];
    intervals: string[];
    limited: Record<string, string[]>;
    macdx: { pairs: string[]; intervals: string[]; limited: Record<string, string[]> } | null;
    sweepx: { pairs: string[]; intervals: string[] } | null;
    // #387: the EMA 20 / 200 way's (the six, 15 minutes), likewise
    emarm: { pairs: string[]; intervals: string[] } | null;
    // #391: the MACD email on shares, likewise (v41: their 15-minute chart). v42 (research/allstocks-prod-spec.md 4.2,
    // 6.1): any share Yahoo's search finds, at most `cap` distinct shares for all users together: `pairs` the 22 listed
    // from the start, then this user's own shares beyond them; `followed` the shares followed by all users together
    // (null when the server could not read it); `shares` each share this user follows, keyed by its symbol: its stored
    // name (null for the 22, which the screen names itself), the newest bar the run read from Yahoo and the count of its
    // closed bars, and whether that bar is more than 7 days old. A v41 server sends none of the three: `cap` and
    // `followed` null, `shares` empty
    stockmacd: { pairs: string[]; intervals: string[]; cap: number | null; followed: number | null; shares: Record<string, StockShare> } | null;
    // #395: a sharp rise or fall's (the six, 1 hour), likewise
    spike: { pairs: string[]; intervals: string[] } | null;
  } | null;
  subscriptions: Array<{ pair: string; interval: string; rule: AlertRule }>;
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

const ruleRecordOf = (v: unknown, defaultBreakeven: number): RuleRecord | null => {
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
    ? { period: b.period, n: num(b.n) ?? 0, winRate: num(b.winRate)!, meanR: num(b.meanR)!, breakeven: num(b.breakeven) ?? defaultBreakeven }
    : null;
  return { mine, all, costly, byTf, backtest };
};

export const normalizePerformance = (v: unknown): Performance | null => {
  const p = rec(v);
  const base = ruleRecordOf(p, 0.4);
  if (!p || !base) return null;
  return { days: num(p.days) ?? 365, ...base, gainz: ruleRecordOf(p.gainz, 1 / 3) };
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
    rule: ruleOfId(r.rule),
    ride: rideOfId(r.rule),
    rideOutPct: rideOutPctOfId(r.rule),
    fade: fadeOfId(r.rule),
    pair: str(r.pair),
    interval: str(r.interval),
    side: r.side === "BUY" || r.side === "SELL" ? r.side : null,
    closedAt: str(r.closed_at),
    entry: num(r.entry),
    stop: num(r.stop),
    target: num(r.target),
    strong: r.strong === true,
    status,
    skipReason: str(r.skip_reason),
    createdAt,
    result: resultOf(r.event),
  };
};

// v42 (research/allstocks-prod-spec.md 6.1): the stock MACD block, read from the server's object keyed by the symbol
// with snake_case fields; a key that is not a share symbol, or a value that is not an object, is dropped, and so is a
// field of the wrong kind (it reads as null, `stale` as false)
const stockShareOf = (v: unknown): StockShare | null => {
  const x = rec(v);
  if (!x) return null;
  const at = str(x.last_bar_at);
  const bars = num(x.bars);
  return {
    name: str(x.name),
    lastBarAt: at !== null && Number.isFinite(Date.parse(at)) ? at : null,
    bars: bars !== null && Number.isInteger(bars) && bars >= 0 ? bars : null,
    stale: x.stale === true,
  };
};
const stockmacdOf = (v: unknown): NonNullable<AlertSettings["indicator"]>["stockmacd"] => {
  const b = rec(v);
  if (!b) return null;
  const shares: Record<string, StockShare> = {};
  for (const [p, sv] of Object.entries(rec(b.shares) ?? {})) {
    const s = isStockSymbol(p) ? stockShareOf(sv) : null;
    if (s) shares[p] = s;
  }
  const cap = num(b.cap);
  const followed = num(b.followed);
  return {
    pairs: strings(b.pairs),
    intervals: strings(b.intervals),
    cap: cap !== null && Number.isInteger(cap) && cap > 0 ? cap : null,
    followed: followed !== null && Number.isInteger(followed) && followed >= 0 ? followed : null,
    shares,
  };
};

export const normalizeAlertSettings = (value: unknown): AlertSettings | null => {
  const s = rec(value);
  if (!s || s.ok !== true || typeof s.allowed !== "boolean" || typeof s.email_configured !== "boolean") return null;
  const subs = Array.isArray(s.subscriptions)
    ? s.subscriptions
      .map(rec)
      .filter((x): x is Record<string, unknown> => x !== null && typeof x.pair === "string" && typeof x.interval === "string")
      .map((x) => ({ pair: x.pair as string, interval: x.interval as string, rule: ruleOf(x.rule) }))
    : [];
  const ind = rec(s.indicator);
  const limited: Record<string, string[]> = {};
  for (const [p, ivs] of Object.entries(rec(ind?.limited) ?? {})) limited[p] = strings(ivs);
  // v41 per pair: the MACD fade's own `limited`, read the same way
  const macdx = rec(ind?.macdx);
  const macdxLimited: Record<string, string[]> = {};
  for (const [p, ivs] of Object.entries(rec(macdx?.limited) ?? {})) macdxLimited[p] = strings(ivs);
  return {
    allowed: s.allowed,
    emailConfigured: s.email_configured,
    email: str(s.email),
    pairs: strings(s.pairs),
    intervals: strings(s.intervals),
    indicator: ind
      ? {
        pairs: strings(ind.pairs),
        intervals: strings(ind.intervals),
        limited,
        macdx: macdx ? { pairs: strings(macdx.pairs), intervals: strings(macdx.intervals), limited: macdxLimited } : null,
        sweepx: rec(ind.sweepx) ? { pairs: strings(rec(ind.sweepx)!.pairs), intervals: strings(rec(ind.sweepx)!.intervals) } : null,
        emarm: rec(ind.emarm) ? { pairs: strings(rec(ind.emarm)!.pairs), intervals: strings(rec(ind.emarm)!.intervals) } : null,
        stockmacd: stockmacdOf(ind.stockmacd),
        spike: rec(ind.spike) ? { pairs: strings(rec(ind.spike)!.pairs), intervals: strings(rec(ind.spike)!.intervals) } : null,
      }
      : null,
    subscriptions: subs,
    alerts: Array.isArray(s.alerts) ? s.alerts.map(alertRow).filter((x): x is AlertRow => x !== null) : [],
    test: statusOf(s.test),
    performance: normalizePerformance(s.performance),
  };
};

export const isFollowing = (settings: AlertSettings, pair: string, interval: string, rule: AlertRule = "rsi_sar"): boolean =>
  settings.subscriptions.some((s) => s.pair === pair && s.interval === interval && s.rule === rule);

// #155: whether Q-Trend's and ULTRA's alerts can be had on this chart;
// #275: with `rule` "macdx", the MACD peak-and-valley rule's, which has its
// own charts (the server sends them); #291: "sweepx", the video's way's
// (#385: "amdpo3" on Q-Trend's and ULTRA's; #387: "emarm", its own)
// v41 per pair (research/macdfade15min-prod-spec.md section 5): "macdx" on a pair's own timeframe only, where the
// server limits it (`macdx.limited`); with no limit, every timeframe of the block, as before
export const indicatorChartOffered = (settings: AlertSettings, pair: string, interval: string, rule?: AlertRule): boolean => {
  const ind = settings.indicator;
  if (rule === "macdx") {
    if (!ind?.macdx || !ind.macdx.pairs.includes(pair) || !ind.macdx.intervals.includes(interval)) return false;
    const only = ind.macdx.limited[pair];
    return !only || only.includes(interval);
  }
  if (rule === "sweepx") return !!ind?.sweepx && ind.sweepx.pairs.includes(pair) && ind.sweepx.intervals.includes(interval);
  if (rule === "emarm") return !!ind?.emarm && ind.emarm.pairs.includes(pair) && ind.emarm.intervals.includes(interval);
  if (rule === "stockmacd") return !!ind?.stockmacd && ind.stockmacd.pairs.includes(pair) && ind.stockmacd.intervals.includes(interval);
  if (rule === "spike") return !!ind?.spike && ind.spike.pairs.includes(pair) && ind.spike.intervals.includes(interval);
  if (!ind || !ind.pairs.includes(pair) || !ind.intervals.includes(interval)) return false;
  const only = ind.limited[pair];
  return !only || only.includes(interval);
};

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
