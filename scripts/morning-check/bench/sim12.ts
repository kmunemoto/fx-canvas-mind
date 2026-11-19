// Local test bench of morning-check v12 (README.md v12.4): plays production's MACD fade on the 15-minute chart (signal-alerts v41,
// research/macdfade15min-prod-spec.md) over the synthetic 15-minute bars of gen12.py (the five pairs' GMO day files, of which the pairs' run uses USD/JPY and AUD/USD only,
// below) and gen_gold12.py (gold's stored Twelve Data row) with
// the function's OWN code: fadeCloseEntryAt from supabase/functions/_shared/macd-fade.ts; ridePaidAt, gmoIntervalsDue, twelveCloseDue, latestCloseMs and freshFor from
// signal-alerts/indicators.ts; isPossiblyClosed from _shared/market-hours.ts. It writes (1) the rows production would have left (signal_alerts, one per follower, interval
// '15min', entry = the price in, stop and target null; the '15min' subscriptions) as SQL, and (2) the lines the morning check should answer: every entry with its verdict
// (ok where mailed, not_mailable where production could not mail it), its price in, its close and near_edge.
//   deno run -A sim12.ts OUTDIR [LIVE_PAIRS_MS LIVE_GOLD_MS]
import { fadeCloseEntryAt } from "../../../supabase/functions/_shared/macd-fade.ts";
import { isPossiblyClosed } from "../../../supabase/functions/_shared/market-hours.ts";
import { freshFor, gmoIntervalsDue, latestCloseMs, ridePaidAt, twelveCloseDue } from "../../../supabase/functions/signal-alerts/indicators.ts";
import type { QuoteCandle } from "../../../supabase/functions/track-outcomes/quotes.ts";

const dir = Deno.args[0];
const MIN = 60_000;
const STEP = 15 * MIN;
const TF = "15min";
// the go-live instants of the bench (README v12.4): bars opened before them were judged by v40 on the 1-hour chart, not by v41 (before_go_live). The pairs' first bar is the
// one that closes at 10:15 (v41 first answering at 10:15 to 10:18 UTC: spec 6.2's aim); gold's is one bar earlier, 09:45 (what happens when v41 first answers from H:04 to
// H:14: gold's newest close is looked at from a minute after it until the next close, the pairs' only at minutes 0, 1 and 3)
const LIVE_PAIRS = Number(Deno.args[1] ?? Date.UTC(2026, 10, 25, 10));
const LIVE_GOLD = Number(Deno.args[2] ?? Date.UTC(2026, 10, 25, 9, 45));
const RULE = "macdx_12_26_9_w600_15min_fade96of120_in_v12";
// the pairs v41 judges on the 15-minute chart (research/macdfade15min-prod-spec.md 7.3, the per-pair form): USD/JPY and AUD/USD only. EUR/JPY, AUD/JPY and EUR/USD stay on
// v40's 1-hour form (pairs1h-v11), so in the pairs' run the followers and the rows written narrow to these two: gen12.py's other three pairs get no '15min' subscription and no
// '15min' row (so a clean bench day shows pairs-v12's RUN macdx_15min_rows_other_pairs 0) and no expected line. The gold run is as it was (gold-v12 is kept as a record).
const PAIRS_15MIN = new Set(["USD/JPY", "AUD/USD"]);
// followers (the user column is a stand-in): two on USD/JPY, one on AUD/USD and one on gold, all on '15min' (the twins, spec 3.6)
const FOLLOWERS: Record<string, string[]> = { "USD/JPY": ["u1", "u2"], "AUD/USD": ["u1"], "XAU/USD": ["u1"] };
const src = JSON.parse(Deno.readTextFileSync(`${dir}/bars.json`)) as Record<string, { pair: string; d: number; gold?: boolean; bars: (string | number)[][] }>;

const iso = (ms: number) => new Date(ms).toISOString();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: number | null) => (v === null ? "null" : `'${JSON.stringify(v)}'::float8`);
const sql: string[] = [];
const expect: Record<string, unknown>[] = [];
let entriesAll = 0;
let mailed = 0;

// the moments production reads a bar's close, a second into the minute (startWaitMs), within the close's own quarter hour: a pair's when gmoIntervalsDue has the 15-minute
// chart (minutes 0, 1 and 3 after the close) and the close a read is for (latestCloseMs) is this one; gold's when twelveCloseDue gives this close (from a minute after it
// until the next close). Only reads within freshFor("15min") of the close mail (all of them here: 20 minutes). The sweep does nothing while isPossiblyClosed.
const readsOf = (closeMs: number, gold: boolean): number[] => {
  const out: number[] = [];
  for (let m = 0; m < 15; m++) {
    const t = closeMs + m * MIN + 1000;
    const due = gold ? twelveCloseDue(TF, t) === closeMs : gmoIntervalsDue(t).includes(TF) && latestCloseMs(TF, t) === closeMs;
    if (due && t - closeMs <= freshFor(TF)) out.push(t);
  }
  return out;
};

const skipped: string[] = [];
for (const [, { pair, d, gold, bars: raw }] of Object.entries(src)) {
  if (!gold && !PAIRS_15MIN.has(pair)) {
    skipped.push(pair);
    continue;
  }
  for (const w of FOLLOWERS[pair]) sql.push(`insert into public.signal_alert_subscriptions (who, pair, interval, rule) values (${q(w)}, ${q(pair)}, '15min', 'macdx');`);
  const r = (v: number) => Number(v.toFixed(d));
  const tick = 10 ** -d;
  // a bar as production reads it: the close as the chart draws it (a pair: GMO's mid rounded; gold: Twelve Data's close rounded) and its quote (a pair: GMO's bid and ask
  // bars as given, as fadeQuotes keeps the 15-minute read's quotes)
  const bars = raw.map((b) => {
    if (gold) {
      const [t, , , , c] = b.map(Number);
      return { t, close: r(c), quote: null };
    }
    const [t, bo, bh, bl, bc, ao, ah, al, ac] = b.map(Number);
    const dt = iso(t);
    const quote = { datetime: dt, bid: { datetime: dt, open: bo, high: bh, low: bl, close: bc }, ask: { datetime: dt, open: ao, high: ah, low: al, close: ac } };
    return { t, close: r((bc + ac) / 2), quote };
  });
  const closes = bars.map((b) => b.close);
  const live = gold ? LIVE_GOLD : LIVE_PAIRS;
  for (let j = 599; j < bars.length; j++) {
    const b = bars[j];
    const upTo = closes.slice(j - 599, j + 1);
    const entry = fadeCloseEntryAt(upTo);
    if (!entry) continue;
    entriesAll++;
    // near_edge, worked out here on its own: the decision with the bar's own close two ticks lower and higher (the 599 closes before it as they are)
    const moved = (k: number) => {
      const w = upTo.slice();
      w[599] = Number((b.close + k * tick).toFixed(d));
      return fadeCloseEntryAt(w)?.side ?? null;
    };
    const near = moved(-2) !== entry.side || moved(2) !== entry.side;
    // the price in: a pair's ask close (BUY) or bid close (SELL) of the bar's own quote, through production's ridePaidAt; gold's the bar's close
    const price = gold ? b.close : ridePaidAt(entry.side, b.quote as QuoteCandle);
    const closeMs = b.t + STEP;
    const reads = readsOf(closeMs, Boolean(gold));
    if (reads.length !== (gold ? 14 : 3)) throw new Error(`reads of ${iso(closeMs)}: ${reads.length}`);
    const at = reads.find((ms) => !isPossiblyClosed(ms)) ?? null;
    const why: string[] = [];
    if (at === null) why.push("weekend_window");
    if (b.t < live) why.push("before_go_live");
    const mail = why.length === 0;
    if (mail) {
      mailed++;
      for (const w of FOLLOWERS[pair]) {
        sql.push(
          `insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, stop, target, rule, status, created_at, sent_at, who) values ('signal', ${q(pair)}, '15min', ` +
            `'${iso(b.t)}', '${iso(closeMs)}', '${entry.side}', ${num(price)}, null, null, '${RULE}', 'sent', '${iso((at as number) + 1500)}', '${iso((at as number) + 2500)}', ${q(w)});`,
        );
      }
    }
    expect.push({ pair, bar: b.t, side: entry.side, zside: entry.zside, verdict: mail ? "ok" : "not_mailable", why: why.join(";"), near, price, close: b.close, share0: entry.share0 });
  }
}

Deno.writeTextFileSync(`${dir}/rows.sql`, sql.join("\n") + "\n");
Deno.writeTextFileSync(`${dir}/expect.json`, JSON.stringify(expect));
const nm = expect.filter((x) => x.verdict === "not_mailable");
console.log(
  `${skipped.length ? `pairs not judged on 15 minutes (no rows, no lines): ${skipped.join(", ")}; ` : ""}entries ${entriesAll} (mailed ${mailed}, not mailable ${nm.length}: weekend ${nm.filter((x) => String(x.why).includes("weekend")).length}, before go-live ${nm.filter((x) => String(x.why).includes("before")).length}); near_edge true ${expect.filter((x) => x.near).length}; rows ${sql.length}`,
);
