// #391 (docs §8.134): the MACD email on shares — the 1-hour MACD email's rule (v8: _shared/macd-level.ts
// decideZoneOnWindow, the 600 closed bars ending at the bar, the newest 120 bars' pane, 95%) on the hourly bars of
// the 22 US and Japanese shares measured in docs §8.133, read from Yahoo as the live chart reads them
// (live-chart/stocks.ts parseYahooChart, rounded as its history is). The owner (2026-10-31), shown §8.133's numbers:
// 「出す、利確幅はいらない、自分で決める」 — so the email names no stop and no target.
//
// #397 (docs §8.150): from signal-alerts v39 to v40 the email was the ride of the pairs' MACD email
// (_shared/macd-ride.ts; research/macdride-spec.md section 6), the owner's 「5ペア・金・株を全部変える」 and, for the
// shares, 「1時間足の確定ごとに見る」 (2026-11-12): email 1 at the close of the 1-hour bar at which the MACD line came
// into the 90% band of the pane's top (a BUY) or bottom (a SELL), a notice where it was already at 96%, email 2 at the
// first later close at 96%, its rides kept in public.macd_rides.
//
// v40 (docs §8.155; research/macdfade1h-prod-spec.md 2, 3.3, 3.4 and 4.4): the email is the fade, the pairs' MACD
// email on the share's 1-hour bars, in place of the ride, which is stopped (the owner, 2026-11-17:
// 「もうシンプル96%の足できたら逆張りのメールちょうだい」, then 「やっぱりメールの判断1時間足で」; the shares fade too, a
// SELL being a short sale). One email at the close of the bar at which the MACD line (blue) is at 96% or more of the
// top (a SELL) or bottom (a BUY) of the pane of the newest 120 bars, the bar before not at 96%
// (_shared/macd-fade.ts fadeCloseEntryAt, on the 600 closed bars ending at the bar: the one function of the pairs,
// gold and the shares), with the bar's close as the price in; no take-profit and no stop price, nothing sent after it,
// and nothing kept: the decision is the closed bars', worked out again at each read (index.ts stockSweep, stockFade;
// public.macd_rides is neither read nor written). What is here is pure: whether the newest closed bar is fresh and
// its entry (stockFadeClose), and the mail's text. Nothing of the fade is measured on shares, and the mail says so
// with no number (the study's numbers are the five pairs'; docs §8.133's are the 95% rule's and are written nowhere
// here).
//
// v41 (research/macdfade15min-prod-spec.md 2.4 and 3.3): the same fade on the shares' 15-minute bars (Yahoo's `15m`
// over `60d`, STOCKMACD_INTERVALS), the owner's 「メールの判断15分に変更して」 (2026-11-19; the shares too, knowing
// that Yahoo's Tokyo prices come late), kept so by the owner's per-pair decision of the same day (the shares:
// 「15分足のまま（おすすめ）」; the pairs each on their own chart, indicators.ts MACDH_INTERVAL_OF). The regular session's bars open every 15 minutes: in Tokyo 9:00 … 11:15 JST
// (the one opening 11:15 ends at the lunch break, 11:30) and 12:30 … 15:15 (the last ends at the closing auction,
// 15:30); in New York 9:30 … 15:45 local (the last ends at 16:00). Seen in Yahoo's answer of 2026-11-19 (the
// yahoo-probe15 run 44535921376): New York's rows 9:30 to 15:45 and, on the latest finished session, a 16:00 point of
// volume 0; Tokyo's rows 9:00 to 11:15, then an 11:30 row of one price with volume (the morning's closing auction),
// null rows 11:45 to 12:15, and rows 12:30 to 15:15. A bar is closed once Yahoo has priced the share at or after its
// end (meta.regularMarketTime) or a later bar is in its answer, so a feed that lags is waited for. Yahoo is read for a
// share only in the half hour after one of those closes (stockCloseDue), at most once in 50 seconds, until the bar
// is in. How the closing points join the bar before them is parseYahooChart's (live-chart/stocks.ts), unchanged here;
// it is not yet fitted to 15-minute bars (the spec's 3.3 item 6), so no text here says that a session's last bar is
// judged on its closing price.
//
// v42 (research/allstocks-prod-spec.md 2, 3, 4.1 and 7): any share the app's chart search would offer may be followed,
// not only the 22 (the owner, 2026-11-21: 「1で」, 「50銘柄まで（おすすめ）」). The rule's chart is told by the symbol's
// shape (isStockmacdChart: live-chart/stocks.ts isStockSymbol, on the 15-minute chart); which shares may be added, and
// the cap of 50 distinct shares for all users together (STOCKMACD_CAP), are index.ts's `set` (Yahoo's search at the
// time a share is first added) and the database's public.stockmacd_follow. A share outside the 22 is named in its mail
// by the name Yahoo's search gave when it was added (stored in public.signal_alert_stocks, cleaned by stockNameClean),
// or by its code alone; the judgment is unchanged.
//
// v43: one share on another chart. The owner (2026-11-27): 「信越化学工業 のメールは1時間足で判断して」. Shin-Etsu
// Chemical (4063.T) is judged on its 1-hour bars; every other share stays on its 15-minute bars, as in v42. One map
// says it (STOCKMACD_CHART_OF; stockmacdChartOf gives a share's chart, "15min" for a share not in it), and it drives
// what is read (Yahoo's `60m` over `1y` for a 1-hour share, v40's read and the live chart's own of that chart: a
// year of Tokyo's seven 1-hour bars a day, counted, not read here, is well past the 600 closed bars a judgment needs;
// `15m` over `60d` for the others, unchanged), the closes and when a share is due
// (stockCloseDue: a 1-hour share only in the half hour after one of its own 1-hour closes), the bars' ends and breaks
// (stockBarEnd, stockBarBreak), the signal's interval and its rule id (one version a chart: v5 on '15min', unchanged;
// v6 on '1h', stockmacd_12_26_9_w600_1h_fade96of120_in_v6, since v40 wrote v4 on '1h' for every share from 2026-11-18
// to 11-20 and each change of the chart raises the number), and the mail's words. The 1-hour bars, closes, ends and
// breaks are v40's (Tokyo's bars stamped 9:00 … 15:00, the 11:00 bar ending at the lunch break, 11:30, the bar
// stamped 12:00 running 12:30-13:00 and the 15:00 bar ending at the closing auction, 15:30), and on them Yahoo's
// Tokyo prices were measured some 15 minutes late (docs §8.141: the 1-hour reads of 2026-11-06, each bar judged 901 to
// 904 seconds after its close). The subscriptions do not change: a share is followed by its 'stockmacd' '15min' row
// as before (isStockmacdChart, STOCKMACD_INTERVALS: public.stockmacd_follow inserts '15min' rows,
// stockmacd_followed_count and the cap of 50 count them, the screen ticks and unticks them). That row is the follow;
// the chart the share is judged on comes from the map, so the run hands 4063.T's '15min' followers its '1h' signal,
// and their rows of public.signal_alerts carry '1h' and the v6 id. The rule itself is unchanged (the 600 closed bars
// ending at the bar, 96%, the bar before not at 96%, the pane of the newest 120 bars of the chart, the bar's close as
// the price in, no take-profit, no stop, one email). Nothing of the fade is measured on shares, on either chart.
// stockBarsOf takes the chart of the answer it parses (the run passes the share's own, the chart it read); its default
// is the `15m` answer, so a caller that reads every share's `15m` bars (research/allstocks-scan/scan.ts) still gets
// 15-minute bars for 4063.T, not its 15-minute bars ended on the 1-hour grid.

import type { Candle } from "../analyze/indicators.ts";
import { barOpenMs } from "../analyze/state.ts";
import { ZONE_BARS } from "../_shared/macd-level.ts";
import { FADE_PCT, FADE_SHARE, fadeCloseEntryAt, fadeRuleId, type FadeEntry } from "../_shared/macd-fade.ts";
import { isStockSymbol, parseYahooChart, stockDecimals, stockMarketOf } from "../live-chart/stocks.ts";
// (indicators.ts imports this file too: nothing of it is used here while the module is loaded, only inside the mails)
import type { IndicatorSignal } from "./indicators.ts";
import { APP_URL, assemble, clock, tfLabel, type Lang, type Mail } from "./logic.ts";

// The 22 listed from the start: the screen's rows before any search (the shares docs §8.133 measured); v42: any share
// of the search may be followed too (the live chart's list, src/lib/stocks.ts, in its order)
export const STOCKMACD_PAIRS: readonly string[] = [
  "NVDA", "INTC", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA",
  "7203.T", "6758.T", "9984.T", "8306.T", "6861.T", "9983.T", "8035.T", "7974.T", "9432.T", "6501.T", "7267.T",
  "6920.T", "4063.T", "8058.T",
];
// v42 (research/allstocks-prod-spec.md 3.1): at most this many distinct shares are followed on the 15-minute chart,
// all users together (enforced by public.stockmacd_follow, not here)
export const STOCKMACD_CAP = 50;
export const isListedStock = (p: string) => STOCKMACD_PAIRS.includes(p);
// v41 (research/macdfade15min-prod-spec.md 3.3 item 1): the shares' 15-minute chart (v40's was the 1-hour one). This
// one constant drives isStockmacdChart, the run's subscriptions, the bars read (Yahoo's `15m`), the status call, set /
// set_many and the rule id. v43: it is the follow's chart only — the interval of every share's 'stockmacd' row (the
// run's subscriptions, the status call's column, set / set_many, public.stockmacd_follow and the cap's count) — and the
// chart of every share STOCKMACD_CHART_OF does not name; the chart a share is judged on is stockmacdChartOf's
export const STOCKMACD_INTERVALS = ["15min"] as const;
// v42 (research/allstocks-prod-spec.md 4.1): the symbol's shape (a US ticker or a Tokyo code on ".T"), not the list;
// the cap is the database call's. v43: whether a row is a share's follow (its '15min' row, whatever chart the share is
// judged on); not whether a signal's chart is the share's (isStockmacdJudged)
export const isStockmacdChart = (pair: unknown, interval: unknown): boolean =>
  isStockSymbol(pair) && typeof interval === "string" && (STOCKMACD_INTERVALS as readonly string[]).includes(interval);
// v43: the charts a share's email may be judged on
export type StockmacdChart = "15min" | "1h";
// v43 (the owner, 2026-11-27: 「信越化学工業 のメールは1時間足で判断して」): the shares judged on a chart other than the
// 15-minute one. The one place that says it: stockmacdChartOf reads it for the run (the bars read, the closes, the
// signal's interval and its id), the mail and the status call (stockmacd.charts, which the screen shows beside the share)
export const STOCKMACD_CHART_OF: Readonly<Record<string, StockmacdChart>> = { "4063.T": "1h" };
// A share's chart: its entry in STOCKMACD_CHART_OF, else the 15-minute one (the map's own entries only, so no name
// of Object.prototype reads as a share's)
export const stockmacdChartOf = (sym: string): StockmacdChart =>
  Object.prototype.hasOwnProperty.call(STOCKMACD_CHART_OF, sym) ? STOCKMACD_CHART_OF[sym] : STOCKMACD_INTERVALS[0];
// v43: whether `chart` is the chart the share's email is judged on (a share's shape, and its chart)
export const isStockmacdJudged = (pair: unknown, chart: unknown): boolean => isStockSymbol(pair) && chart === stockmacdChartOf(pair);
// The rule's id (its own, so the FX record and the morning check's never take it in; it starts with "stockmacd", as
// the app reads the rule back from it). #391: the 95% email's was stockmacd_12_26_9_w600_1h_z95of120_v1, never written
// again; #397: the ride's three, stockmacd_12_26_9_w600_1h_ride90to96of120_{in,at,out}_v2, written no more from v40.
// v40 (research/macdfade1h-prod-spec.md 3.7): the fade's one id, every part from a constant (fadeRuleId):
// stockmacd_12_26_9_w600_1h_fade96of120_in_v4, written from 2026-11-18. v41 (research/macdfade15min-prod-spec.md 3.7):
// on the 15-minute bars, stockmacd_12_26_9_w600_15min_fade96of120_in_v5 (what indicatorRuleId gives for 'stockmacd'):
// 5, not 4, since v40 writes 4 (each change of the chart raises the number; the never-built
// stockmacd_..._15min_fade96of120_in_v4 of research/macdfade15-prod-spec.md stays that spec's record). The
// subscriptions keep rule = 'stockmacd'.
// v43: one version a chart, as the pairs' MACD fade has (indicators.ts MACDH_FADE_VERSION_OF): 5 on the 15-minute
// chart, unchanged; 6 on the 1-hour chart (4063.T's), stockmacd_12_26_9_w600_1h_fade96of120_in_v6 — 6, not v40's 4,
// which v40 wrote on '1h' for every share from 2026-11-18 to 11-20 and which is not used again. No single id stands
// beside them (v41's STOCKMACD_FADE_VERSION and STOCKMACD_RULE_ID are gone): one would read as the one in force, so
// indicatorRuleId has no 'stockmacd' answer and signalRuleId takes the signal's chart's (stockmacdRuleId)
export const STOCKMACD_FADE_VERSION_OF: Readonly<Record<StockmacdChart, number>> = { "15min": 5, "1h": 6 };
export const stockmacdRuleId = (chart: string): string => {
  if (!Object.prototype.hasOwnProperty.call(STOCKMACD_FADE_VERSION_OF, chart)) {
    throw new Error(`stockmacdRuleId: the stock MACD fade has no version on the chart "${chart}"`);
  }
  return fadeRuleId("stockmacd", chart, STOCKMACD_FADE_VERSION_OF[chart as StockmacdChart]);
};

// The shares' names in the emails (the live chart's, src/lib/stocks.ts)
const NAMES: Record<string, { ja: string; en: string }> = {
  NVDA: { ja: "エヌビディア", en: "NVIDIA" },
  INTC: { ja: "インテル", en: "Intel" },
  AAPL: { ja: "アップル", en: "Apple" },
  MSFT: { ja: "マイクロソフト", en: "Microsoft" },
  GOOGL: { ja: "アルファベット（グーグル）", en: "Alphabet (Google)" },
  AMZN: { ja: "アマゾン", en: "Amazon" },
  META: { ja: "メタ", en: "Meta" },
  TSLA: { ja: "テスラ", en: "Tesla" },
  "7203.T": { ja: "トヨタ自動車", en: "Toyota Motor" },
  "6758.T": { ja: "ソニーグループ", en: "Sony Group" },
  "9984.T": { ja: "ソフトバンクグループ", en: "SoftBank Group" },
  "8306.T": { ja: "三菱UFJフィナンシャル・グループ", en: "Mitsubishi UFJ Financial Group" },
  "6861.T": { ja: "キーエンス", en: "Keyence" },
  "9983.T": { ja: "ファーストリテイリング", en: "Fast Retailing" },
  "8035.T": { ja: "東京エレクトロン", en: "Tokyo Electron" },
  "7974.T": { ja: "任天堂", en: "Nintendo" },
  "9432.T": { ja: "NTT", en: "NTT" },
  "6501.T": { ja: "日立製作所", en: "Hitachi" },
  "7267.T": { ja: "ホンダ", en: "Honda Motor" },
  "6920.T": { ja: "レーザーテック", en: "Lasertec" },
  "4063.T": { ja: "信越化学工業", en: "Shin-Etsu Chemical" },
  "8058.T": { ja: "三菱商事", en: "Mitsubishi Corporation" },
};
// v42 (research/allstocks-prod-spec.md 4.1 and 7): the 22's own names; another share's stored one (Yahoo's search's,
// cleaned by stockNameClean); else null (the mail writes the code alone, not "XYZ（XYZ）")
export const stockNameOf = (sym: string, lang: Lang, stored: string | null = null): string | null =>
  NAMES[sym]?.[lang] ?? (stored === sym ? null : stored);
// v42: a name as it is stored or mailed: the control characters (U+0000-U+001F, U+007F) made spaces, runs of spaces
// made one, trimmed, cut to 100 code points (so no half of a surrogate pair is left); null when empty, not a string,
// or the symbol itself (a Yahoo hit with no longname or shortname has its symbol as its name)
export const stockNameClean = (v: unknown, sym: string): string | null => {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = [...v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/ {2,}/g, " ").trim()].slice(0, 100).join("");
  return s === "" || s === sym ? null : s;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
// v41: a bar's length (the 15-minute chart's; spec 3.3 items 3-5). v43: and the 1-hour chart's (4063.T's)
const BAR_MS: Readonly<Record<StockmacdChart, number>> = { "15min": 15 * MIN, "1h": HOUR };

// The weekday and the time of day (minutes) at `ms` in the share's market: Tokyo's is UTC+9 all year, New York's
// moves with daylight saving (the runtime's time zones)
const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" });
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const localOf = (sym: string, ms: number): { wd: number; min: number } => {
  if (stockMarketOf(sym) === "jp") {
    const d = new Date(ms + 9 * HOUR);
    return { wd: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  const parts = Object.fromEntries(NY.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { wd: WEEKDAYS.indexOf(parts.weekday), min: Number(parts.hour) * 60 + Number(parts.minute) };
};

// The regular session's bar closes, in the market's time of day (minutes). v41 (spec 3.3 item 3): every 15 minutes,
// New York 9:45 to 16:00 (26 closes: the bars 9:30 to 15:45), Tokyo 9:15 to 11:30 (10) and 12:45 to 15:30 (12), 22
// closes (the bars 9:00 to 11:15 and 12:30 to 15:15; Yahoo's answer of 2026-11-19 stamps the afternoon's first bar
// 12:30). (v40's were the hourly bars' closes: New York 10:30 … 15:30 and 16:00; Tokyo 10:00, 11:00, 11:30, 13:00 …
// 15:00 and 15:30.)
const hm = (h: number, m: number) => h * 60 + m;
const every15 = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let t = from; t <= to; t += 15) out.push(t);
  return out;
};
export const CLOSES: Record<"us" | "jp", readonly number[]> = {
  us: every15(hm(9, 45), hm(16, 0)),
  jp: [...every15(hm(9, 15), hm(11, 30)), ...every15(hm(12, 45), hm(15, 30))],
};
// v43: the 1-hour bars' closes, v40's (a share on the 1-hour chart: 4063.T): New York 10:30 … 15:30 and 16:00 (7: the
// bars 9:30 … 14:30 and the 15:30 bar ending at the close), Tokyo 10:00, 11:00, 11:30 (the 11:00 bar ending at the lunch
// break), 13:00 (the bar stamped 12:00, 12:30-13:00), 14:00, 15:00 and 15:30 (the 15:00 bar ending at the closing
// auction): 7 a day (docs §8.141: Yahoo's 1-hour answer of 2026-11-06 stamps the afternoon's first bar 12:00, and
// every one of them was judged some 15 minutes after its close)
export const CLOSES_1H: Record<"us" | "jp", readonly number[]> = {
  us: [hm(10, 30), hm(11, 30), hm(12, 30), hm(13, 30), hm(14, 30), hm(15, 30), hm(16, 0)],
  jp: [hm(10, 0), hm(11, 0), hm(11, 30), hm(13, 0), hm(14, 0), hm(15, 0), hm(15, 30)],
};
// a share's closes, by the chart it is judged on
const closesOf = (sym: string): readonly number[] => (stockmacdChartOf(sym) === "1h" ? CLOSES_1H : CLOSES)[stockMarketOf(sym)];
// how long after a close Yahoo is read for its bar
export const STOCK_POLL_MS = 30 * MIN;
// how long after its close a bar is still mailed (a lagging feed, a missed run). v41: kept at 45 minutes, which holds
// a Tokyo bar judged some 16 minutes after its close (Yahoo's Tokyo prices about 15 minutes late, docs §8.141; counted
// from the code, not measured on 15-minute reads) inside it. v43: the same on the 1-hour chart (v40's, where the Tokyo
// bars were judged 901 to 904 seconds after their close, docs §8.141)
export const STOCK_FRESH_MS = 45 * MIN;
// v41 (spec 3.3 item 10): how long a "stocks" run may go on starting Yahoo reads. The stocks run and the pairs' and
// gold's run share pg_net's one queue (docs §8.112), and on 15-minute bars a Tokyo share is read about once a minute
// through the session; so once a run has spent this long, no more reads are started, and the shares left are read
// first by the next run (index.ts stockSweep). v43: unchanged; a share on the 1-hour chart is due only in the half hour
// after one of its own 1-hour closes (stockCloseDue), so it adds no read outside those
export const STOCK_RUN_BUDGET_MS = 30_000;

// The newest regular close (ms, on the minute) at or before `nowMs` and within STOCK_POLL_MS of it, on a weekday;
// null when there is none (outside the session, the weekend). A holiday is told by the bars (stockSweepOf). v43: the
// closes of the share's own chart (CLOSES, or CLOSES_1H for a share on the 1-hour chart)
export const stockCloseDue = (sym: string, nowMs: number): number | null => {
  const closes = closesOf(sym);
  const minute = Math.floor(nowMs / MIN) * MIN;
  for (let k = 0; k * MIN <= STOCK_POLL_MS; k++) {
    const t = minute - k * MIN;
    const l = localOf(sym, t);
    if (l.wd >= 1 && l.wd <= 5 && closes.includes(l.min)) return t;
  }
  return null;
};

// When a bar that opens at `openMs` ends: 15 minutes after it opens (v41, spec 3.3 item 4: no 15-minute bar is a half
// bar; Tokyo's 11:15 bar ends at the lunch break, its 15:15 bar at the closing auction, New York's 15:45 bar at its
// close, each 15 minutes after it opens). On a day that ends early, at the session's end when Yahoo gives it and it is
// earlier (`sessionEndMs`, the session the bar is in). (v40's hourly bars had two half bars in Tokyo and one in New
// York.) v43: by the share's own chart; on the 1-hour chart v40's ends again: Tokyo's 11:00 bar at the lunch break
// (11:30) and its 15:00 bar at the closing auction (15:30), New York's 15:30 bar at its close (16:00), each half an hour
// after it opens; every other an hour after it opens (the bar stamped 12:00 in Tokyo, trading 12:30-13:00, at 13:00).
// `chart` is the chart the bar is of: by default the share's own (stockmacdChartOf); stockBarsOf passes the chart of
// the answer it parses
export const stockBarEnd = (
  sym: string,
  openMs: number,
  sessionEndMs: number | null = null,
  chart: StockmacdChart = stockmacdChartOf(sym),
): number => {
  let len = BAR_MS[chart];
  if (chart === "1h") {
    const l = localOf(sym, openMs);
    const half = stockMarketOf(sym) === "jp" ? l.min === hm(11, 0) || l.min === hm(15, 0) : l.min === hm(15, 30);
    if (half) len = 30 * MIN;
  }
  const end = openMs + len;
  return sessionEndMs !== null && openMs < sessionEndMs && sessionEndMs < end ? sessionEndMs : end;
};

export interface StockBar extends Candle {
  open_ms: number;
  end: number;
  closed: boolean;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// Yahoo's answer on the rule's chart (v41: its `15m` bars, STOCKMACD_INTERVALS) -> the chart's bars (rounded as its
// history is: Number(v.toFixed(d))), each with its end and whether it has closed by Yahoo's last price (`marketMs`,
// its regularMarketTime) — or a later bar is there. v43: `chart` is the chart of the answer `body` is, and the bars
// are parsed and ended on it (on "1h" as the live chart parses its 1-hour bars, Yahoo's closing point joined to the
// session's last bar as v40's were). The run reads each share on its own chart and passes it (stockmacdChartOf: `60m`
// for 4063.T); the default is the `15m` answer (yahooChartUrl(sym, "15min")), so a caller that reads every share's
// `15m` bars, as research/allstocks-scan/scan.ts does, gets them as 15-minute bars for 4063.T too, not as 1-hour ones
export const stockBarsOf = (
  sym: string,
  body: unknown,
  nowMs: number,
  chart: StockmacdChart = STOCKMACD_INTERVALS[0],
): { bars: StockBar[]; marketMs: number | null } | null => {
  const got = parseYahooChart(sym, body, chart, nowMs);
  if (!got) return null;
  const result = rec(rec(body)?.chart)?.result;
  const meta = rec(Array.isArray(result) ? rec(result[0])?.meta : null);
  const at = num(meta?.regularMarketTime);
  const marketMs = at === null ? null : at * 1000;
  const regular = rec(rec(meta?.currentTradingPeriod)?.regular);
  const sEnd = num(regular?.end);
  const sStart = num(regular?.start);
  const session = sStart !== null && sEnd !== null && sEnd > sStart ? { start: sStart * 1000, end: sEnd * 1000 } : null;
  const d = stockDecimals(sym);
  const r = (v: number) => Number(v.toFixed(d));
  const opens = got.bars.map((c) => barOpenMs(c.datetime));
  const bars: StockBar[] = got.bars.map((c, k) => {
    const open = opens[k];
    const sessionEnd = session && open >= session.start && open < session.end ? session.end : null;
    const end = stockBarEnd(sym, open, sessionEnd, chart);
    // docs §8.140: closed once its end has passed and Yahoo has priced at or past it, or a bar that opens at or after
    // its end is there. A later point inside the bar is not one: while a session trades, Yahoo's answer goes on past
    // the forming bar (2026-11-05: the bar opened 15:30 UTC was judged as closed from 15:32 on)
    const next = k < opens.length - 1 ? opens[k + 1] : null;
    const closed = end <= nowMs && ((marketMs !== null && marketMs >= end) || (next !== null && next >= end));
    return { datetime: c.datetime, open: r(c.open), high: r(c.high), low: r(c.low), close: r(c.close), open_ms: open, end, closed };
  });
  return { bars, marketMs };
};

// ---- v40 (docs §8.155): the fade on a share, judged at closes (research/macdfade1h-prod-spec.md 3.3; v41 on the ----
// ---- 15-minute bars, research/macdfade15min-prod-spec.md 3.3) ----------------------------------------------------
//
// #391's stockmacdSignals (the 95% email's decision, decideZoneOnWindow) went with that email; #397's
// stockRidesReached and stockRideClose (the ride's) went with the ride. What a read of a share's bars does now is told
// by two pure functions, in the order the run uses them: stockSweepOf (is the close due done, is the newest closed bar
// to be judged) and stockFadeClose (is that bar still fresh, and the entry at its close). The run (index.ts stockSweep,
// stockFade) prices it (the bar's close) and mails it; nothing of it is kept between reads.

// Whether an entry at a closed bar is still mailed: the bar ended at most STOCK_FRESH_MS ago
export const stockBarFresh = (bar: Pick<StockBar, "end">, nowMs: number): boolean => {
  const age = nowMs - bar.end;
  return age >= 0 && age <= STOCK_FRESH_MS;
};

// What the close of a share's newest closed bar gives (spec 3.3): `fresh`, whether it ended at most STOCK_FRESH_MS ago
// (an older bar is not judged: no entry), and the entry at it — fadeCloseEntryAt on the 600 closed bars ending at it
// (null with fewer, with a close that is not a number, or with none). None on a chart the rule is not offered on, or
// with no closed bar. `closed`: the share's closed bars, oldest first, the newest the one judged.
export interface StockFadeClose {
  fresh: boolean;
  entry: FadeEntry | null;
}
// v43: `closed` are the bars of the share's own chart (the run reads stockmacdChartOf's chart and passes it to
// stockBarsOf); on either chart an entry is mailed up to STOCK_FRESH_MS after its bar's end
export const stockFadeClose = (sym: string, closed: ReadonlyArray<StockBar>, nowMs: number): StockFadeClose => {
  const newest = isStockmacdJudged(sym, stockmacdChartOf(sym)) && closed.length > 0 ? closed[closed.length - 1] : null;
  if (newest === null || !stockBarFresh(newest, nowMs)) return { fresh: false, entry: null };
  return { fresh: true, entry: fadeCloseEntryAt(closed.map((b) => b.close)) };
};

// What a run does for one share this minute, from its bars as Yahoo answered: the closed ones, the newest of them
// (judged unless this instance has), whether an entry at it would still be mailed (`fresh`), and whether the close
// due is done (its bar is in, or the share did not trade today: no bar in the six hours before it)
export const stockSweepOf = (
  sym: string,
  bars: ReadonlyArray<StockBar>,
  due: number,
  judgedOpen: number | undefined,
  nowMs: number,
): { closed: StockBar[]; newest: StockBar | null; judge: boolean; fresh: boolean; done: boolean; noSession: boolean } => {
  const last = bars.length > 0 ? bars[bars.length - 1] : null;
  if (!last || last.open_ms < due - 6 * HOUR) return { closed: [], newest: null, judge: false, fresh: false, done: true, noSession: true };
  const closed = bars.filter((b) => b.closed);
  const newest = closed.length > 0 ? closed[closed.length - 1] : null;
  return {
    closed,
    newest,
    judge: newest !== null && isStockmacdJudged(sym, stockmacdChartOf(sym)) && newest.open_ms !== judgedOpen,
    fresh: newest !== null && stockBarFresh(newest, nowMs),
    done: newest !== null && newest.end >= due,
    noSession: false,
  };
};

// Whether trading stops at the end of the bar that opens at `openMs`, by the regular hours: "close" for a session's
// last bar (v41, spec 3.3 item 5: New York's 15:45, Tokyo's 15:15), "lunch" for Tokyo's 11:15 bar (the lunch break
// follows), null for the others. A day that ends early is not told from here: its last bar reads as any other. v43: by
// the share's own chart; on the 1-hour chart v40's: Tokyo's 15:00 bar "close" and its 11:00 bar "lunch", New York's
// 15:30 bar "close"
export const stockBarBreak = (sym: string, openMs: number): "close" | "lunch" | null => {
  const l = localOf(sym, openMs);
  const hour = stockmacdChartOf(sym) === "1h";
  if (stockMarketOf(sym) === "jp") {
    const [close, lunch] = hour ? [hm(15, 0), hm(11, 0)] : [hm(15, 15), hm(11, 15)];
    return l.min === close ? "close" : l.min === lunch ? "lunch" : null;
  }
  return l.min === (hour ? hm(15, 30) : hm(15, 45)) ? "close" : null;
};

// The MACD numbers as the email writes them: the price's decimals, or more where the pane's edge the mail is about
// (`end`) would come out with fewer than two significant digits; the minus as the chart's (U+2212). v40: the edge is
// the pane's on the fade's side, the top for a SELL and the bottom for a BUY (#397: the ride's was the top for a BUY)
const macdText = (sym: string, end: number | null): ((v: number | null) => string) => {
  const d = stockDecimals(sym);
  const md = end !== null && Number.isFinite(end) && end !== 0 ? Math.min(20, Math.max(d, 1 - Math.floor(Math.log10(Math.abs(end))))) : d;
  return (v: number | null) => (v !== null && Number.isFinite(v) ? v.toFixed(md).replace(/^-/, "−") : "—");
};

// v40 (docs §8.155; research/macdfade1h-prod-spec.md 4.1, 4.2 and 4.4): the MACD fade's one email on a share, the
// spec's words, ja and en, in its order: (1) the share, its market and the side (a SELL is a short sale); (2) the bar
// judged, by its end (stockBarEnd: the signal's closedAt); (3, 4) that the blue line closed at 96% or more of the
// pane's top (bottom) with the bar before not at 96% — a fade SELL (BUY) — and its numbers; (5) the bar's close, and,
// on a session's last bar or Tokyo's bar before lunch (stockBarBreak), that nothing can be traded at it until the
// market opens again; (6) that there is no take-profit and no stop price (how the rule is built, not advice); (7) that
// it is the only email; (8) when it is judged and sent, a US share's and a Tokyo share's own (not the pairs' reads);
// (9) not measured on shares, no number; (10) whose choices these are; (11) Yahoo's source line, the app link, how to
// stop under 「株の MACD」 / "Stock MACD" and the disclaimer, as before. The pane's edge is the side's: the top for a
// SELL, the bottom for a BUY. No price is labelled a take-profit or a stop, and no text asserts that a price recovers
// (spec 4.1). (#397: the ride's three mails — email 1, the notice, email 2 with its result — went with the ride.)
// v41 (research/macdfade15min-prod-spec.md 3.3 item 7, 4.2 and 4.4): the bar's word from the signal's interval
// (tfLabel: 「15分足」 / "15-minute"); (8) rewritten: a US share's read judges only the newest bar closed by then, a
// Tokyo share's is judged some 15 minutes after its close (Yahoo's delay, measured on the 1-hour reads of 2026-11-06;
// not yet measured on 15-minute bars); (10) rewritten: the shares' 15-minute bars and the pane of the newest 120
// 15-minute bars are the owner's choices too (2026-11-17 and 11-19), written 「株を15分足で判定すること」 / "judging
// shares on 15-minute bars" with no 「も」 / "too" (spec 4.4 item 10: under per pair four of the fade's six charts
// are 1-hour, so "too" would say the fade's mails are on 15-minute bars as well). The source line no longer says that a session's
// last bar is judged on its closing price: that holds only once parseYahooChart is fitted to Yahoo's 15-minute closing
// points (spec 3.3 item 6, its "closing-price condition"), and on Yahoo's answer of 2026-11-19 it does not (Tokyo's
// 11:30 closing-auction row has volume, so it stays a bar of its own).
// v43: a share on the 1-hour chart (4063.T, STOCKMACD_CHART_OF) has the bar's word 「1時間足」 / "1-hour" from the
// signal's interval, as every share's, and two items of its own: (8) a Tokyo share's, judged and sent some 15 minutes
// after the close with no "not measured yet" clause (Yahoo's delay was measured on the 1-hour reads, docs §8.141);
// (10) the owner's choices without "judging shares on 15-minute bars" and the 15-minute pane, then that judging this
// share on 1-hour bars, the other shares being judged on 15-minute bars, is the owner's choice too (2026-11-27), and
// that the MACD pane is the newest 120 bars of the 1-hour chart, the same as the app's 1-hour chart's (stated as a
// fact of the rule: the live chart draws the newest CHART_BARS, 120, closed bars of a share's chart on every
// timeframe, and ZONE_BARS is CHART_BARS). A share's mail on the 15-minute chart is word for word as in v42. A signal
// off its share's chart is refused (the 1-hour text says the share is judged on 1-hour bars, and the run would have
// read and judged it otherwise)
export const renderStockMail = (s: IndicatorSignal, lang: Lang): Mail => {
  if (!isStockmacdJudged(s.pair, s.interval)) {
    throw new Error(`the stock MACD email: ${s.pair} is not judged on "${s.interval}" (its chart is ${stockmacdChartOf(s.pair)})`);
  }
  // v43: on the 1-hour chart (spec above), and the word of the other shares' chart
  const hour = s.interval === "1h";
  const others = tfLabel(lang, STOCKMACD_INTERVALS[0]);
  const f = s.fade ?? null;
  const jp = stockMarketOf(s.pair) === "jp";
  const d = stockDecimals(s.pair);
  const money = (v: number) => (jp ? `${v.toFixed(d)}${lang === "en" ? " yen" : "円"}` : lang === "en" ? `$${v.toFixed(d)}` : `${v.toFixed(d)}ドル`);
  const px = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : money(v));
  const buy = s.side === "BUY";
  const top = (f?.zside ?? (buy ? "bottom" : "top")) === "top";
  const edge = f ? (top ? f.top : f.bottom) : null;
  const mx = macdText(s.pair, edge);
  const mark = edge === null ? null : FADE_SHARE * edge;
  // v42 (research/allstocks-prod-spec.md 7): the 22's own name, another share's stored one (Yahoo's search's), else
  // none: then the code alone. A stored name is named Yahoo's in the source line
  const name = stockNameOf(s.pair, lang, s.stockName ?? null);
  const yahooName = name !== null && NAMES[s.pair] === undefined;
  const open = Date.parse(s.barTime);
  // the bar's end (stockBarEnd), as the run gives it
  const close = Date.parse(s.closedAt);
  // the price in: the bar's close (spec 2.3)
  const price = f ? f.price : s.close;
  // trading stops at the end of this bar: a session's last bar, Tokyo's bar before the lunch break
  const brk = Number.isFinite(open) ? stockBarBreak(s.pair, open) !== null : false;
  // the minutes after its close a bar is still mailed (45)
  const freshMin = STOCK_FRESH_MS / MIN;
  // the bar's word: 「15分足」 / "15-minute" on the rule's chart (spec 3.3 item 7); v43: 「1時間足」 / "1-hour" on 4063.T's
  const tf = tfLabel(lang, s.interval);
  if (lang === "en") {
    const side = buy ? "BUY" : "SELL";
    const end = top ? "top" : "bottom";
    const market = jp ? "Tokyo" : "US";
    const label = name === null ? `${s.pair} ` : `${name} (${s.pair}) `;
    const on = name === null ? `${s.pair} (${market})` : `${name} (${s.pair}, ${market})`;
    return assemble(`[Sextant] ${label}${tf} ${buy ? "BUY" : "SELL (short sale)"}: the MACD line closed at ${FADE_PCT}% of the ${end} (Stock MACD)`, [
      `A MACD fade ${side} signal on ${on}, ${tf} chart.${buy ? "" : " A SELL on a share is a short sale."}`,
      [
        `Bar judged: the ${tf} bar that closed at ${clock(close, 0)} UTC (${clock(close, 9)} JST)`,
        `At this bar's close the MACD line (blue) was at ${FADE_PCT}% or more of the ${end} of the MACD pane of the newest ${ZONE_BARS} bars (${tf}) (the ${top ? "highest" : "lowest"} of the blue line, the orange line and the bars), measured from the zero line. At the close of the bar before, it was below ${FADE_PCT}%. It is the ${end}, so this is a fade ${side} signal.`,
        `MACD = ${mx(f?.m ?? null)}, the pane's ${end} = ${mx(edge)} (${FADE_PCT}% of it = ${mx(mark)})`,
        `This bar's close: ${px(price)}`,
        ...(brk ? ["At this bar's close nothing can be traded until the market opens again."] : []),
      ].join("\n"),
      "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a stop.",
      "This is the only email: nothing more is sent about this signal. A later signal on the same chart and side is sent too, whatever came before it.",
      (jp
        ? hour
          ? "Yahoo's Tokyo prices come about 15 minutes late (measured on 2026-11-06, on the 1-hour reads), so this email is judged and sent some 15 minutes after the bar closed."
          : `Yahoo's Tokyo prices come about 15 minutes late (measured on 2026-11-06, on the 1-hour reads), so this email is judged and sent some 15 minutes after the bar closed (how many minutes on ${tf} bars has not been measured yet).`
        : `This email is judged and sent at a read after the bar closes (a read judges only the newest bar closed by then; a bar more than ${freshMin} minutes past its close is not sent; how long it takes to arrive has not been measured).`) +
        " The price when it arrives may differ from the close above (the difference has not been measured).",
      "Not measured on shares.",
      hour
        ? `This rule is Sextant's own, not a published indicator. ${FADE_PCT}%, judging at the bar's close, the fade side (shares included) and stating no take-profit or stop price are the app owner's choices. Judging this share on ${tf} bars, while the other shares are judged on ${others} bars, is the app owner's choice too (2026-11-27). The MACD pane is the newest ${ZONE_BARS} bars of the ${tf} chart, the same as the app's ${tf} chart's pane.`
        : `This rule is Sextant's own, not a published indicator. ${FADE_PCT}%, judging at the bar's close, judging shares on ${tf} bars, the MACD pane of the newest ${ZONE_BARS} ${tf} bars, the fade side (shares included) and stating no take-profit or stop price are the app owner's choices. That pane is the same as the app's ${tf} chart's.`,
      `${yahooName ? "The bars, the price and the stock's name are" : "The bars and the price are"} Yahoo Finance's public data (not an official feed; it may stop), the same as the app's stock chart. Check the latest state in the app before you place an order:\n${APP_URL}`,
      "To stop these emails, open Settings → Email alerts in the app and untick the share under Stock MACD.\nThis is reference information, not investment advice. Every trading decision is your own.",
    ]);
  }
  const sideJ = `${buy ? "買い" : "売り"}（${s.side}）`;
  const end = top ? "上" : "下";
  const market = jp ? "東証" : "米国";
  const labelJ = name === null ? `${s.pair} ` : `${name}（${s.pair}）`;
  const onJ = name === null ? `${s.pair}（${market}）` : `${name}（${s.pair}、${market}）`;
  return assemble(`【Sextant】${labelJ}${tf} ${buy ? "買い（BUY）" : "売り（SELL・空売り）"}: 青い線が${end}の端の${FADE_PCT}%で確定（株の MACD）`, [
    `${onJ}の${tf}で、MACD の逆張りの${sideJ}の合図が出ました。${buy ? "" : "株の売りは空売りです。"}`,
    [
      `判定した足: ${clock(close, 9)}（日本時間）に確定した${tf}`,
      `この足の終わりで、青い線（MACD）が、新しい${ZONE_BARS}本（${tf}）の MACD の枠の${end}の端（青い線・オレンジの線・棒の${top ? "一番高い" : "一番低い"}所）の${FADE_PCT}%以上（0の線から測って）でした。一つ前の足の終わりでは、${FADE_PCT}%に届いていませんでした。${end}の端なので、逆張りの${sideJ}の合図です。`,
      `MACD = ${mx(f?.m ?? null)}、枠の${end}の端 = ${mx(edge)}（その${FADE_PCT}% = ${mx(mark)}）`,
      `この足の終値: ${px(price)}`,
      ...(brk ? ["この足の終値では、次に市場が開くまで売買できません。"] : []),
    ].join("\n"),
    "利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。",
    "メールはこの1通だけです。このあと、この合図について知らせは送りません。同じチャート・同じ向きに前の合図があっても、次の合図は送ります。",
    (jp
      ? hour
        ? "東証の値段は Yahoo では約15分遅れて届きます（2026-11-06 に、1時間足の読み込みで測りました）。そのため、このメールは足が確定してから15分ほど後に判定して送ります。"
        : `東証の値段は Yahoo では約15分遅れて届きます（2026-11-06 に、1時間足の読み込みで測りました）。そのため、このメールは足が確定してから15分ほど後に判定して送ります（${tf}で実際に何分後になるかは、まだ測っていません）。`
      : `このメールは、足の確定の後の読み込みで判定して送ります（読み込みで判定するのは、その時に確定している一番新しい足だけです。確定から${freshMin}分を過ぎた足は送りません。実際に何分で届くかは測っていません）。`) +
      "届いた時の値段は、上の終値と違うことがあります（その差は測っていません）。",
    "株では測っていません。",
    hour
      ? `この決まりは Sextant 独自のもので、公開されているインジケーターではありません。${FADE_PCT}%・足の確定で判定すること・逆張りの向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この銘柄を${tf}で判定すること（ほかの株は${others}で判定します）も、アプリのオーナーが決めたものです（2026-11-27）。MACD の枠は${tf}の新しい${ZONE_BARS}本で、アプリの${tf}のチャートの枠と同じです。`
      : `この決まりは Sextant 独自のもので、公開されているインジケーターではありません。${FADE_PCT}%・足の確定で判定すること・株を${tf}で判定すること・MACD の枠を${tf}の新しい${ZONE_BARS}本にすること・逆張りの向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの${tf}のチャートの枠と同じです。`,
    `${yahooName ? "足と値段と銘柄の名前は" : "足と値段は"} Yahoo Finance の公開データ（公式の配信ではないため、止まることがあります）で、アプリの株のチャートと同じです。注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
    "この通知を止めるには、アプリの「設定」→「メール通知」の「株の MACD」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
  ]);
};
