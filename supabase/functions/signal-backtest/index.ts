// signal-backtest — how often did each bounce condition actually work, over
// a stretch of history long enough to say?
//
// analyze/signals.ts counts the conditions over the window a single analysis
// reads (a few hundred bars). That is what the analyst is shown and what the
// panel draws, and it is honest about being one window. This function is
// the yardstick behind the constants in that file: it pulls a longer stretch
// of GMO's public bid/ask history for one pair and one interval, runs the
// same detector over all of it, and answers with the counts — whole, and
// split into an older and a newer half, so a rule that only worked in one
// regime shows up as one that only worked in one half.
//
// WHAT IT MUST NEVER DO, because it is deployed beside production:
//   * never write anything — no table, no row, no log line with a price in it
//   * never spend a rationed key — GMO's endpoint is public and Twelve Data is
//     not touched
//   * never answer without the sweep token — it does hundreds of outbound
//     fetches per call, and an open endpoint that does that is a cost bug
//
// Invocation: a SQL statement that reads the token out of the vault, like the
// other sweep functions (docs/OPERATIONS.md §5):
//
//   select net.http_post(
//     url := 'https://<ref>.supabase.co/functions/v1/signal-backtest',
//     headers := jsonb_build_object('Content-Type','application/json',
//                                   'x-sweep-token', public.track_outcomes_sweep_token()),
//     body := '{"pair":"USD/JPY","interval":"1h","days":365}'::jsonb);
//
// Deno-free apart from Deno.serve and Deno.env: everything it computes is in
// analyze/signals.ts, which the vitest suite covers.

import { RR, SIGNAL_HORIZON_BARS, computeSignals, smaSeries, wilson, type Signal, type SignalSide } from "../analyze/signals.ts";
import type { Candle } from "../analyze/indicators.ts";
import {
  GMO_INTERVALS,
  GMO_SYMBOLS,
  dateKeys,
  jstDayKey,
  klineUrl,
  mergeSides,
  parseKlines,
  usableBars,
  type QuoteCandle,
} from "../track-outcomes/quotes.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INTERVAL_MS: Record<string, number> = {
  "1min": MINUTE,
  "5min": 5 * MINUTE,
  "15min": 15 * MINUTE,
  "1h": HOUR,
  "4h": 4 * HOUR,
  "1day": DAY,
};
// Parallel GMO requests. The endpoint is public and quick; eight keeps a
// year of hourly files (~500 requests) inside the function's wall clock.
const CONCURRENCY = 8;
// Stop fetching past this and answer with what was gathered, saying so.
const FETCH_BUDGET_MS = 150_000;
const MAX_DAYS = 800;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sweep-token",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// The same reduction analyze/price-source.ts makes for the overlay: a mid bar
// in Twelve Data's datetime shape, which is what signals.ts and the tests use.
const midCandle = (q: QuoteCandle): Candle => ({
  datetime: q.datetime.slice(0, 19).replace("T", " "),
  open: (q.bid.open + q.ask.open) / 2,
  high: (q.bid.high + q.ask.high) / 2,
  low: (q.bid.low + q.ask.low) / 2,
  close: (q.bid.close + q.ask.close) / 2,
});

interface Tally {
  rule: string;
  side: SignalSide;
  n: number;
  wins: number;
  losses: number;
  ambiguous: number;
  expired: number;
  open: number;
  rate: number | null;
  lo: number | null;
  hi: number | null;
  expectancy_r: number | null;
  avg_bars: number | null;
  // Share of decided signals whose best excursion before resolution reached
  // each multiple of the stop: the hit rate the rule would have had at that
  // target. 1.5 is the rate above; 1.0 says what a 1:1 target would have done.
  mfe_ge: Record<string, number | null>;
}

const MFE_STEPS = [0.5, 1, 1.5];

const round = (v: number | null, d: number): number | null => (v === null ? null : Number(v.toFixed(d)));

// Counts over a subset of signals (a half), in the shape of RuleStat minus
// the untradable column, which is only known for the whole run.
const tally = (list: Signal[]): Tally[] => {
  const keys = new Map<string, Signal[]>();
  for (const s of list) {
    const k = `${s.rule}|${s.side}`;
    keys.set(k, [...(keys.get(k) ?? []), s]);
  }
  return [...keys.entries()].map(([k, sigs]) => {
    const [rule, side] = k.split("|") as [string, SignalSide];
    const wins = sigs.filter((s) => s.outcome === "win").length;
    const losses = sigs.filter((s) => s.outcome === "loss").length;
    const n = wins + losses;
    const ci = wilson(wins, n);
    const decided = sigs.filter((s) => s.outcome === "win" || s.outcome === "loss");
    const mfe_ge: Record<string, number | null> = {};
    for (const step of MFE_STEPS) {
      mfe_ge[String(step)] = n > 0
        ? round(decided.filter((s) => (s.mfeR ?? 0) >= step - 1e-9).length / n, 3)
        : null;
    }
    return {
      rule,
      side,
      n,
      wins,
      losses,
      ambiguous: sigs.filter((s) => s.outcome === "ambiguous").length,
      expired: sigs.filter((s) => s.outcome === "expired").length,
      open: sigs.filter((s) => s.outcome === "open").length,
      rate: n > 0 ? round(wins / n, 3) : null,
      lo: round(ci?.lo ?? null, 3),
      hi: round(ci?.hi ?? null, 3),
      expectancy_r: n > 0 ? round((wins * RR - losses) / n, 2) : null,
      avg_bars: n > 0 ? round(decided.reduce((a, s) => a + (s.bars ?? 0), 0) / n, 1) : null,
      mfe_ge,
    };
  }).sort((a, b) => b.n - a.n);
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "POST のみ" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ ok: false, error: "サーバー設定エラー" }, 500);

  // ---- who is asking: the sweep token and nothing else --------------------
  // Same gate as noise-floor/index.ts, for the same reason: the caller this
  // is designed for is a SQL statement reading the vault, not a browser.
  const sweepToken = req.headers.get("x-sweep-token");
  if (!sweepToken) return json({ ok: false, error: "認証が必要です" }, 401);
  const tokenRes = await fetch(`${supabaseUrl}/rest/v1/rpc/track_outcomes_sweep_token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const expectedToken = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
  if (
    typeof expectedToken !== "string" ||
    expectedToken.length === 0 ||
    !constantTimeEqual(sweepToken, expectedToken)
  ) {
    return json({ ok: false, error: "認証に失敗しました" }, 401);
  }

  // ---- the request --------------------------------------------------------
  const bodyRaw = await req.json().catch(() => null);
  const body = bodyRaw && typeof bodyRaw === "object" ? bodyRaw as Record<string, unknown> : {};
  const pair = typeof body.pair === "string" ? body.pair : "USD/JPY";
  const interval = typeof body.interval === "string" ? body.interval : "1h";
  const days = Math.min(MAX_DAYS, Math.max(7, typeof body.days === "number" ? Math.floor(body.days) : 365));
  const horizon = typeof body.horizon === "number" && body.horizon > 0 ? Math.floor(body.horizon) : SIGNAL_HORIZON_BARS;
  const symbol = GMO_SYMBOLS[pair];
  const spec = GMO_INTERVALS[interval];
  const intervalMs = INTERVAL_MS[interval];
  if (!symbol || !spec || !intervalMs) return json({ ok: false, error: "リクエスト形式が不正です", pair, interval }, 400);

  // ---- the history --------------------------------------------------------
  const started = Date.now();
  const nowMs = started;
  const today = jstDayKey(nowMs);
  const keys = dateKeys(nowMs - days * DAY, nowMs, spec.key).filter((k) => spec.key === "year" || k <= today);
  const fetcher = async (url: string): Promise<unknown | null> => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  };
  const bid: Array<{ t: number; c: Candle }> = [];
  const ask: Array<{ t: number; c: Candle }> = [];
  let requests = 0;
  let fetched = 0;
  let empty = 0;
  let cutShort = false;
  let cursor = 0;
  const worker = async () => {
    while (cursor < keys.length) {
      if (Date.now() - started > FETCH_BUDGET_MS) {
        cutShort = true;
        return;
      }
      const key = keys[cursor++];
      const [b, a] = await Promise.all([
        fetcher(klineUrl(symbol, "bid", spec.name, key)),
        fetcher(klineUrl(symbol, "ask", spec.name, key)),
      ]);
      requests += 2;
      const pb = parseKlines(b);
      const pa = parseKlines(a);
      if (pb.length === 0 && pa.length === 0) empty++;
      else fetched++;
      bid.push(...pb);
      ask.push(...pa);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  bid.sort((x, y) => x.t - y.t);
  ask.sort((x, y) => x.t - y.t);
  const merged = usableBars(mergeSides(bid, ask), intervalMs, nowMs);
  // The bar still forming is not a closed bar
  const closed = merged.filter((q) => Date.parse(q.datetime) + intervalMs <= nowMs);
  const candles = closed.map(midCandle);
  if (candles.length === 0) {
    return json({ ok: false, error: "足が取れませんでした", pair, interval, keys: keys.length, requests, empty });
  }

  // ---- the count ----------------------------------------------------------
  const read = computeSignals(candles, horizon);
  const n = candles.length;
  const half = Math.floor(n / 2);
  const older = read.signals.filter((s) => s.index < half);
  const newer = read.signals.filter((s) => s.index >= half);
  // With or against the 200-bar average: a BUY bounce with price above it is
  // "with". The one split a trader would ask for first, so it is answered
  // here rather than guessed at.
  const sma200 = smaSeries(candles.map((c) => c.close), 200);
  const trendOf = (s: Signal): "with" | "against" | "unknown" => {
    const m = sma200[s.index];
    if (m === null) return "unknown";
    const above = s.entry > m;
    return (s.side === "BUY") === above ? "with" : "against";
  };
  const withTrend = read.signals.filter((s) => trendOf(s) === "with");
  const againstTrend = read.signals.filter((s) => trendOf(s) === "against");
  const elapsedMs = Date.now() - started;

  return json({
    ok: true,
    pair,
    interval,
    days,
    horizon,
    rr: RR,
    bars: n,
    from: candles[0].datetime,
    to: candles[n - 1].datetime,
    keys: keys.length,
    requests,
    files_with_bars: fetched,
    files_empty: empty,
    cut_short: cutShort,
    elapsed_ms: elapsedMs,
    read_ok: read.ok,
    read_reason: read.reason,
    atr_now: read.atr,
    signals: read.signals.length,
    all: tally(read.signals),
    untradable: Object.fromEntries(read.stats.filter((st) => st.untradable > 0).map((st) => [`${st.rule}:${st.side}`, st.untradable])),
    by_trend: [
      { part: "with_sma200", signals: withTrend.length, stats: tally(withTrend) },
      { part: "against_sma200", signals: againstTrend.length, stats: tally(againstTrend) },
    ],
    halves: [
      { part: "older", from: candles[0].datetime, to: candles[Math.max(0, half - 1)].datetime, bars: half, stats: tally(older) },
      { part: "newer", from: candles[half].datetime, to: candles[n - 1].datetime, bars: n - half, stats: tally(newer) },
    ],
    // A handful of the newest signals, so a reader can check one by hand
    sample: read.signals.slice(-8).map((s) => ({
      datetime: s.datetime,
      side: s.side,
      rule: s.rule,
      level: round(s.level, 3),
      entry: round(s.entry, 3),
      stop: round(s.stop, 3),
      target: round(s.target, 3),
      stop_atr: s.stopAtr,
      outcome: s.outcome,
      bars: s.bars,
      mfe_r: s.mfeR,
    })),
  });
});
