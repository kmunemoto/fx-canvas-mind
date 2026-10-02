// #181: the live chart's added timeframes on GMO's own files (docs §8.92).
//
// Read-only: GMO's public klines, nothing written anywhere. Run on GitHub's
// runners (the development container cannot reach GMO). For three pairs and
// each timeframe added, the chart's own read (live-chart/logic.ts
// fetchChartQuotes, liveRead) is made as the function makes it, and what it
// gives is printed: how many bars, the first and last, the gaps between them,
// the forming bar and the next close. Then the bars the chart makes of
// shorter ones are checked against GMO's own longer bars: five 2-minute bars
// against GMO's 10-minute one, ten 3-minute against its 30-minute, fifteen
// 4-minute against its hourly, two 2-hour against its 4-hour (the bid side,
// open, high, low and close; every bar the two have in common).
//
//   deno run --allow-net=forex-api.coin.z.com research/chart-timeframes.ts

import { LIVE_STEP_MS, NO_KLINE_FILE, buildQuotes, fetchChartQuotes, liveRead } from "../supabase/functions/live-chart/logic.ts";
import { GMO_SYMBOLS, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";

const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
let failed = 0;
// as the function's deep reader: GMO's 404 is a file with no bars; 100 ms apart
const fetcher = async (url: string): Promise<unknown> => {
  await sleep(100);
  requests++;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) {
      await r.body?.cancel();
      return NO_KLINE_FILE;
    }
    if (!r.ok) {
      failed++;
      await r.body?.cancel();
      return null;
    }
    return await r.json();
  } catch {
    failed++;
    return null;
  }
};

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const gapsOf = (bars: QuoteCandle[]) => {
  const count = new Map<number, number>();
  for (let i = 1; i < bars.length; i++) {
    const g = Date.parse(bars[i].datetime) - Date.parse(bars[i - 1].datetime);
    count.set(g, (count.get(g) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, n]) => `${(g / HOUR).toFixed(2)}h×${n}`).join(" ");
};

const NOW = Date.now();
const ADDED = ["2min", "3min", "4min", "10min", "30min", "2h", "8h", "1week", "1month"];
console.log(`now ${iso(NOW)}`);
console.log("pair     tf      n    complete first                 last                  forming_open          next_close            ok    gaps");
for (const pair of ["USD/JPY", "EUR/USD", "HUF/JPY"]) {
  for (const tf of ADDED) {
    const got = await fetchChartQuotes(pair, tf, 201, NOW, Date.now() + 120_000, fetcher);
    if (!got) {
      console.log(`${pair.padEnd(8)} ${tf.padEnd(7)} none`);
      continue;
    }
    const r = liveRead(pair, tf, got.bars, NOW);
    const t = got.bars.map((b) => Date.parse(b.datetime));
    const bad = got.bars.filter((b) => ![b.bid.open, b.bid.high, b.bid.low, b.bid.close, b.ask.close].every(Number.isFinite) || b.bid.high < b.bid.low).length;
    const weekend = t.filter((x) => new Date(x).getUTCDay() === 6).length;
    console.log(
      `${pair.padEnd(8)} ${tf.padEnd(7)} ${String(got.bars.length).padEnd(4)} ${String(got.complete).padEnd(8)} ` +
        `${iso(t[0]).padEnd(21)} ${iso(t[t.length - 1]).padEnd(21)} ${String(r.forming_open).padEnd(21)} ${String(r.next_close).padEnd(21)} ` +
        `${String(r.ok).padEnd(5)} ${gapsOf(got.bars)}${bad ? ` BAD ${bad}` : ""}${weekend && tf !== "1week" && tf !== "1month" ? ` SATURDAY ${weekend}` : ""}`,
    );
  }
}

// GMO's own longer bars against those made of the chart's shorter ones
const sideFile = async (pair: string, name: string, key: string): Promise<QuoteCandle[]> => {
  const sym = GMO_SYMBOLS[pair];
  const [b, a] = await Promise.all([fetcher(klineUrl(sym, "bid", name, key)), fetcher(klineUrl(sym, "ask", name, key))]);
  return mergeSides(parseKlines(b), parseKlines(a));
};
const yesterday = new Date(NOW + 9 * HOUR - 24 * HOUR).toISOString().slice(0, 10).replaceAll("-", "");
const today = new Date(NOW + 9 * HOUR).toISOString().slice(0, 10).replaceAll("-", "");
const year = new Date(NOW + 9 * HOUR).toISOString().slice(0, 4);
const compare = (label: string, made: QuoteCandle[], theirs: QuoteCandle[], stepMs: number) => {
  const own = new Map(theirs.map((q) => [Date.parse(q.datetime), q]));
  let same = 0;
  const differ: string[] = [];
  // only bars closed by now: a forming one is not the same
  for (const m of made.filter((q) => Date.parse(q.datetime) + stepMs <= NOW)) {
    const g = own.get(Date.parse(m.datetime));
    if (!g) continue;
    const ok = [["open", m.bid.open, g.bid.open], ["high", m.bid.high, g.bid.high], ["low", m.bid.low, g.bid.low], ["close", m.bid.close, g.bid.close]]
      .every(([, x, y]) => Math.abs((x as number) - (y as number)) < 1e-9);
    if (ok) same++;
    else differ.push(`${iso(Date.parse(m.datetime))} made ${m.bid.open}/${m.bid.high}/${m.bid.low}/${m.bid.close} gmo ${g.bid.open}/${g.bid.high}/${g.bid.low}/${g.bid.close}`);
  }
  console.log(`${label}: ${same} the same, ${differ.length} not`);
  for (const d of differ.slice(0, 5)) console.log(`  ${d}`);
};
console.log("");
console.log(`checks against GMO's own (USD/JPY bid; day files ${yesterday} and ${today}, year ${year})`);
for (const [tf, n, gmoName, gmoTf] of [["2min", 5, "10min", "10min"], ["3min", 10, "30min", "30min"], ["4min", 15, "1hour", "1h"]] as const) {
  const mine = await fetchChartQuotes("USD/JPY", tf, 201, NOW, Date.now() + 120_000, fetcher);
  const theirs = [...(await sideFile("USD/JPY", gmoName, yesterday)), ...(await sideFile("USD/JPY", gmoName, today))];
  compare(`${n} × ${tf} vs GMO ${gmoName}`, buildQuotes(mine?.bars ?? [], LIVE_STEP_MS[gmoTf], 0), theirs, LIVE_STEP_MS[gmoTf]);
}
{
  const mine = await fetchChartQuotes("USD/JPY", "2h", 201, NOW, Date.now() + 120_000, fetcher);
  const theirs = await sideFile("USD/JPY", "4hour", year);
  compare("2 × 2h vs GMO 4hour", buildQuotes(mine?.bars ?? [], LIVE_STEP_MS["4h"], 0), theirs, LIVE_STEP_MS["4h"]);
}
console.log("");
console.log(`requests ${requests}, failed ${failed}`);
