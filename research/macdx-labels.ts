// #272 (docs §8.109): the owner's marks on the MACD of three 5-minute charts
// (2026-10-10, the second set of screenshots, 10/09 20:00 .. 10/10 05:55 JST):
// green where the cross is near the top or the bottom of the MACD pane — the
// crosses to judge on — and purple where it is near 0 — not to judge on. The
// owner: 「macdの緑丸ぐらい一番上、一番下に近いところでのクロスで判断して。
// 逆に紫丸は0に近いから0に近いクラスでは判断いらない。」
//
// This reads GMO's 5-minute bars of the three pairs for those days and writes
// the chart's MACD (12, 26, 9) on its own bars (mid, rounded: historyRead),
// in pips, with each cross on the screen and the mark it was given, so that
// the rule's numbers can be set from the marks before any of the measured
// period is read. It reads only these days (the measured period ends before
// them). No price is printed: MACD and the bars' ranges are differences of
// prices, in pips.
//
// Runs on GitHub's runners because they can reach GMO's public price API and
// the development container cannot. Read-only: it fetches public prices and
// writes research/out/macdx-labels (uploaded as an artifact).

import { GMO_SYMBOLS, dateKeys, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import { macd } from "../supabase/functions/_shared/macd.ts";
import { ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { getJson } from "./ownerhold-data.ts";

const OUT = "research/out/macdx-labels";
const JST = 9 * 3600_000;
// the screen: 10/09 20:00 .. 10/10 05:55 JST (bars opening then)
const SCREEN_FROM = Date.UTC(2026, 9, 9, 11, 0);
const SCREEN_TO = Date.UTC(2026, 9, 9, 20, 55);
// GMO's week closed 10/09 21:00 UTC; the bars before it are all closed
const NOW = Date.UTC(2026, 9, 9, 21, 0);
const READ_FROM = Date.UTC(2026, 9, 1, 0, 0);
const NS = [24, 48, 96, 120, 240, 288];

type Mark = "green" | "purple";
// the marks, at the time read off each screenshot (the circle's centre, to
// about ten minutes: x = 18 + 70.8 px an hour from 20:00 JST), and where the
// owner put them (top, bottom, near 0)
const MARKS: Array<{ pair: string; jst: string; mark: Mark; where: "top" | "bottom" | "zero" }> = [
  { pair: "USD/JPY", jst: "10-09 20:00", mark: "green", where: "top" },
  { pair: "USD/JPY", jst: "10-09 21:40", mark: "purple", where: "zero" },
  { pair: "USD/JPY", jst: "10-10 00:05", mark: "green", where: "top" },
  { pair: "USD/JPY", jst: "10-10 04:10", mark: "green", where: "bottom" },
  { pair: "AUD/USD", jst: "10-09 21:20", mark: "green", where: "top" },
  { pair: "AUD/USD", jst: "10-09 22:45", mark: "green", where: "bottom" },
  { pair: "AUD/USD", jst: "10-10 02:25", mark: "purple", where: "zero" },
  { pair: "AUD/USD", jst: "10-10 05:25", mark: "green", where: "top" },
  { pair: "EUR/USD", jst: "10-10 00:35", mark: "purple", where: "zero" },
  { pair: "EUR/USD", jst: "10-10 01:55", mark: "purple", where: "zero" },
  { pair: "EUR/USD", jst: "10-10 04:20", mark: "green", where: "top" },
];
const jstMs = (s: string): number => {
  const [md, hm] = s.split(" ");
  const [mo, d] = md.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  return Date.UTC(2026, mo - 1, d, h, mi) - JST;
};
const jstOf = (ms: number): string => new Date(ms + JST).toISOString().slice(5, 16).replace("T", " ");

const load = async (pair: string): Promise<QuoteCandle[]> => {
  const symbol = GMO_SYMBOLS[pair];
  const sides: Record<"bid" | "ask", Array<{ t: number; c: { datetime: string; open: number; high: number; low: number; close: number } }>> = { bid: [], ask: [] };
  for (const key of dateKeys(READ_FROM, NOW, "day")) {
    for (const side of ["bid", "ask"] as const) {
      const r = await getJson(klineUrl(symbol, side, "5min", key));
      if (r.status === 404) continue;
      if (r.status === 0) throw new Error(`${pair} ${side} ${key}: ${r.why}`);
      sides[side].push(...parseKlines(r.body));
    }
  }
  sides.bid.sort((a, b) => a.t - b.t);
  sides.ask.sort((a, b) => a.t - b.t);
  return mergeSides(sides.bid, sides.ask);
};

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
await Deno.mkdir(OUT, { recursive: true });
const report: Record<string, unknown> = { now: new Date(NOW).toISOString(), marks: MARKS, pairs: {} };
const lines: string[] = [];
const say = (s: string) => {
  console.log(s);
  lines.push(s);
};
say(`#272 the owner's MACD marks: crosses on 10/09 20:00 .. 10/10 05:55 JST, MACD (12,26,9) in pips on the chart's 5-minute bars (GMO mid, rounded)`);
say(`stats of the N bars up to and including the cross (trailing): maxM / minM of the MACD line, and the pane's top / bottom (MACD, signal and histogram), all in pips`);

for (const pair of ["USD/JPY", "AUD/USD", "EUR/USD"]) {
  const unit = ultraUnit(pair);
  const quotes = await load(pair);
  const candles = historyRead(pair, "5min", quotes, NOW).candles;
  const t = candles.map((c) => Date.parse(c.datetime));
  const m = macd(candles.map((c) => c.close));
  const pip = (v: number | null) => (v === null ? Number.NaN : v / unit);
  const M = m.macd.map(pip);
  const S = m.signal.map(pip);
  const H = m.hist.map(pip);
  const TR = candles.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high, candles[i - 1].close) - Math.min(c.low, candles[i - 1].close)) / unit);
  // the series, for any rule to be tried on them afterwards
  const csv = ["openUtc,jst,macd,signal,hist,tr", ...candles.map((_, i) => `${new Date(t[i]).toISOString()},${jstOf(t[i])},${fmt(M[i], 4)},${fmt(S[i], 4)},${fmt(H[i], 4)},${fmt(TR[i], 2)}`)];
  await Deno.writeTextFile(`${OUT}/${pair.replace("/", "")}.csv`, csv.join("\n") + "\n");
  const trail = (i: number, n: number) => {
    let maxM = -Infinity, minM = Infinity, top = -Infinity, bottom = Infinity, ok = true;
    for (let k = i - n + 1; k <= i; k++) {
      if (k < 0 || !Number.isFinite(M[k]) || !Number.isFinite(S[k]) || !Number.isFinite(H[k])) {
        ok = false;
        break;
      }
      maxM = Math.max(maxM, M[k]);
      minM = Math.min(minM, M[k]);
      top = Math.max(top, M[k], S[k], H[k]);
      bottom = Math.min(bottom, M[k], S[k], H[k]);
    }
    return ok ? { maxM, minM, top, bottom } : null;
  };
  const screen = (() => {
    let top = -Infinity, bottom = Infinity;
    for (let k = 0; k < t.length; k++) if (t[k] >= SCREEN_FROM && t[k] <= SCREEN_TO) {
      top = Math.max(top, M[k], S[k], H[k]);
      bottom = Math.min(bottom, M[k], S[k], H[k]);
    }
    return { top, bottom };
  })();
  const crosses: Array<Record<string, unknown>> = [];
  for (let i = 1; i < t.length; i++) {
    if (t[i] < SCREEN_FROM || t[i] > SCREEN_TO) continue;
    const a = H[i - 1], b = H[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const dir = a <= 0 && b > 0 ? "UP" : a >= 0 && b < 0 ? "DOWN" : null;
    if (!dir) continue;
    crosses.push({ i, jst: jstOf(t[i]), dir, macd: M[i], signal: S[i], atr14: TR.slice(i - 13, i + 1).reduce((x, y) => x + y, 0) / 14, trailing: Object.fromEntries(NS.map((n) => [n, trail(i, n)])) });
  }
  // each mark to the nearest cross within 25 minutes
  const marked = MARKS.filter((x) => x.pair === pair).map((x) => {
    const at = jstMs(x.jst);
    let best: Record<string, unknown> | null = null;
    let gap = Infinity;
    for (const c of crosses) {
      const d = Math.abs(t[c.i as number] - at);
      if (d < gap) {
        gap = d;
        best = c;
      }
    }
    return { ...x, cross: gap <= 25 * 60_000 && best ? best.jst : null, minutesOff: gap / 60_000 };
  });
  (report.pairs as Record<string, unknown>)[pair] = { bars: candles.length, first: jstOf(t[0]), last: jstOf(t[t.length - 1]), screen, crosses, marked };
  say(`\n== ${pair}: ${candles.length} bars ${jstOf(t[0])} .. ${jstOf(t[t.length - 1])} JST; the screen's pane top ${fmt(screen.top)} bottom ${fmt(screen.bottom)}`);
  say(`cross JST    dir   mark    MACD  signal ATR14 | N: maxM minM top bottom ...`);
  for (const c of crosses) {
    const mk = marked.find((x) => x.cross === c.jst);
    const tr = c.trailing as Record<number, { maxM: number; minM: number; top: number; bottom: number } | null>;
    say(
      `${c.jst}  ${String(c.dir).padEnd(4)}  ${(mk ? mk.mark : "-").padEnd(6)} ${fmt(c.macd as number).padStart(6)} ${fmt(c.signal as number).padStart(6)} ${fmt(c.atr14 as number).padStart(5)} | ` +
        NS.map((n) => (tr[n] ? `${n}: ${fmt(tr[n]!.maxM)} ${fmt(tr[n]!.minM)} ${fmt(tr[n]!.top)} ${fmt(tr[n]!.bottom)}` : `${n}: -`)).join(" | "),
    );
  }
  for (const x of marked) say(`mark ${x.jst} ${x.mark} (${x.where}): ${x.cross ? `cross ${x.cross}, ${fmt(x.minutesOff, 0)} min off` : `no cross within 25 min (nearest ${fmt(x.minutesOff, 0)} min)`}`);
}
await Deno.writeTextFile(`${OUT}/report.json`, JSON.stringify(report, null, 1));
await Deno.writeTextFile(`${OUT}/print.txt`, lines.join("\n") + "\n");
