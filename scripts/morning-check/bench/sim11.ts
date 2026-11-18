// Local test bench of morning-check v11 (README.md v11.4): plays production's MACD fade on the 1-hour chart (signal-alerts v40) over the synthetic 1-hour bars of the v9
// bench's generators (gen.py: the five pairs' GMO day files; gen_gold.py: gold's stored Twelve Data row) with the function's OWN code (fadeCloseEntryAt from
// supabase/functions/_shared/macd-fade.ts, ridePaidAt from signal-alerts/indicators.ts, isPossiblyClosed from _shared/market-hours.ts), and writes
// (1) the rows production would have left (signal_alerts, one per follower, entry = the price in, stop and target null; the subscriptions) as SQL, and (2) the lines the
// morning check should answer: every entry with its verdict (ok where mailed, not_mailable where production could not mail it), its price in, its close and near_edge.
//   deno run -A sim11.ts OUTDIR [LIVE_PAIRS_MS LIVE_GOLD_MS]
import { fadeCloseEntryAt } from "../../../supabase/functions/_shared/macd-fade.ts";
import { isPossiblyClosed } from "../../../supabase/functions/_shared/market-hours.ts";
import { ridePaidAt } from "../../../supabase/functions/signal-alerts/indicators.ts";
import type { QuoteCandle } from "../../../supabase/functions/track-outcomes/quotes.ts";

const dir = Deno.args[0];
const MIN = 60_000;
const HOUR = 60 * MIN;
// the go-live instants of the bench (README v11.4): bars opened before them are judged by v39, not v40 (before_go_live). Gold's is one bar earlier than the pairs': what
// happens when v40 first answers between minute 5 and minute 29 of an hour (gold's close is looked at to minute 29, the pairs' at minutes 0, 3 and 5)
const LIVE_PAIRS = Number(Deno.args[1] ?? Date.UTC(2026, 10, 18, 10));
const LIVE_GOLD = Number(Deno.args[2] ?? Date.UTC(2026, 10, 18, 9));
const RULE = "macdx_12_26_9_w600_1h_fade96of120_in_v11";
// followers (the user column is a stand-in): two on USD/JPY, one on each other chart, all on '1h' (no subscription moves, spec 3.6)
const FOLLOWERS: Record<string, string[]> = { "USD/JPY": ["u1", "u2"], "EUR/JPY": ["u1"], "AUD/JPY": ["u1"], "EUR/USD": ["u1"], "AUD/USD": ["u1"], "XAU/USD": ["u1"] };
const src = JSON.parse(Deno.readTextFileSync(`${dir}/bars.json`)) as Record<string, { pair: string; d: number; gold?: boolean; bars: (string | number)[][] }>;

const iso = (ms: number) => new Date(ms).toISOString();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: number | null) => (v === null ? "null" : `'${JSON.stringify(v)}'::float8`);
const sql: string[] = [];
const expect: Record<string, unknown>[] = [];
let entriesAll = 0;
let mailed = 0;

for (const [, { pair, d, gold, bars: raw }] of Object.entries(src)) {
  for (const w of FOLLOWERS[pair]) sql.push(`insert into public.signal_alert_subscriptions (who, pair, interval, rule) values (${q(w)}, ${q(pair)}, '1h', 'macdx');`);
  const r = (v: number) => Number(v.toFixed(d));
  const tick = 10 ** -d;
  // a bar as production reads it: the close as the chart draws it (a pair: GMO's mid rounded; gold: Twelve Data's close rounded) and its quote (a pair: GMO's bid and ask
  // bars as given, as hourQuotes keeps them)
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
    // judged: some read of the bar's close falls outside the weekend gate (pairs: minutes 0, 3 and 5 after the close; gold: minutes 1 to 29), a second into the minute;
    // every one of them is fresh (at most 30 minutes after the close, freshFor("1h"))
    const closeMs = b.t + HOUR;
    const reads = gold ? Array.from({ length: 29 }, (_, i) => closeMs + (i + 1) * MIN + 1000) : [0, 3, 5].map((m) => closeMs + m * MIN + 1000);
    const at = reads.find((ms) => !isPossiblyClosed(ms)) ?? null;
    const why: string[] = [];
    if (at === null) why.push("weekend_window");
    if (b.t < live) why.push("before_go_live");
    const mail = why.length === 0;
    if (mail) {
      mailed++;
      for (const w of FOLLOWERS[pair]) {
        sql.push(
          `insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, stop, target, rule, status, created_at, sent_at, who) values ('signal', ${q(pair)}, '1h', ` +
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
  `entries ${entriesAll} (mailed ${mailed}, not mailable ${nm.length}: weekend ${nm.filter((x) => String(x.why).includes("weekend")).length}, before go-live ${nm.filter((x) => String(x.why).includes("before")).length}); near_edge true ${expect.filter((x) => x.near).length}; rows ${sql.length}`,
);
