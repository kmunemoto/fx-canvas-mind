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

import type { Candle } from "../analyze/indicators.ts";
import { barOpenMs } from "../analyze/state.ts";
import { ZONE_BARS } from "../_shared/macd-level.ts";
import { FADE_PCT, FADE_SHARE, fadeCloseEntryAt, fadeRuleId, type FadeEntry } from "../_shared/macd-fade.ts";
import { parseYahooChart, stockDecimals, stockMarketOf } from "../live-chart/stocks.ts";
// (indicators.ts imports this file too: nothing of it is used here while the module is loaded, only inside the mails)
import type { IndicatorSignal } from "./indicators.ts";
import { APP_URL, assemble, clock, tfLabel, type Lang, type Mail } from "./logic.ts";

// The shares measured in docs §8.133 (the live chart's list, src/lib/stocks.ts), in its order
export const STOCKMACD_PAIRS: readonly string[] = [
  "NVDA", "INTC", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA",
  "7203.T", "6758.T", "9984.T", "8306.T", "6861.T", "9983.T", "8035.T", "7974.T", "9432.T", "6501.T", "7267.T",
  "6920.T", "4063.T", "8058.T",
];
// v41 (research/macdfade15min-prod-spec.md 3.3 item 1): the shares' 15-minute chart (v40's was the 1-hour one). This
// one constant drives isStockmacdChart, the run's subscriptions, the bars read (Yahoo's `15m`), the status call, set /
// set_many and the rule id
export const STOCKMACD_INTERVALS = ["15min"] as const;
export const isStockmacdChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && STOCKMACD_PAIRS.includes(pair) &&
  (STOCKMACD_INTERVALS as readonly string[]).includes(interval);
// The rule's id (its own, so the FX record and the morning check's never take it in; it starts with "stockmacd", as
// the app reads the rule back from it). #391: the 95% email's was stockmacd_12_26_9_w600_1h_z95of120_v1, never written
// again; #397: the ride's three, stockmacd_12_26_9_w600_1h_ride90to96of120_{in,at,out}_v2, written no more from v40.
// v40 (research/macdfade1h-prod-spec.md 3.7): the fade's one id, every part from a constant (fadeRuleId):
// stockmacd_12_26_9_w600_1h_fade96of120_in_v4, written from 2026-11-18. v41 (research/macdfade15min-prod-spec.md 3.7):
// on the 15-minute bars, stockmacd_12_26_9_w600_15min_fade96of120_in_v5 (what indicatorRuleId gives for 'stockmacd'):
// 5, not 4, since v40 writes 4 (each change of the chart raises the number; the never-built
// stockmacd_..._15min_fade96of120_in_v4 of research/macdfade15-prod-spec.md stays that spec's record). The
// subscriptions keep rule = 'stockmacd'.
export const STOCKMACD_FADE_VERSION = 5;
export const STOCKMACD_RULE_ID = fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], STOCKMACD_FADE_VERSION);

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
export const stockNameOf = (sym: string, lang: Lang): string => NAMES[sym]?.[lang] ?? sym;

const MIN = 60_000;
const HOUR = 60 * MIN;
// v41: a bar's length (the 15-minute chart's; spec 3.3 items 3-5)
const BAR_MS = 15 * MIN;

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
// how long after a close Yahoo is read for its bar
export const STOCK_POLL_MS = 30 * MIN;
// how long after its close a bar is still mailed (a lagging feed, a missed run). v41: kept at 45 minutes, which holds
// a Tokyo bar judged some 16 minutes after its close (Yahoo's Tokyo prices about 15 minutes late, docs §8.141; counted
// from the code, not measured on 15-minute reads) inside it
export const STOCK_FRESH_MS = 45 * MIN;
// v41 (spec 3.3 item 10): how long a "stocks" run may go on starting Yahoo reads. The stocks run and the pairs' and
// gold's run share pg_net's one queue (docs §8.112), and on 15-minute bars a Tokyo share is read about once a minute
// through the session; so once a run has spent this long, no more reads are started, and the shares left are read
// first by the next run (index.ts stockSweep)
export const STOCK_RUN_BUDGET_MS = 30_000;

// The newest regular close (ms, on the minute) at or before `nowMs` and within STOCK_POLL_MS of it, on a weekday;
// null when there is none (outside the session, the weekend). A holiday is told by the bars (stockSweepOf)
export const stockCloseDue = (sym: string, nowMs: number): number | null => {
  const closes = CLOSES[stockMarketOf(sym)];
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
// York.)
export const stockBarEnd = (sym: string, openMs: number, sessionEndMs: number | null = null): number => {
  const end = openMs + BAR_MS;
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
// its regularMarketTime) — or a later bar is there
export const stockBarsOf = (sym: string, body: unknown, nowMs: number): { bars: StockBar[]; marketMs: number | null } | null => {
  const got = parseYahooChart(sym, body, STOCKMACD_INTERVALS[0], nowMs);
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
    const end = stockBarEnd(sym, open, session && open >= session.start && open < session.end ? session.end : null);
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
export const stockFadeClose = (sym: string, closed: ReadonlyArray<StockBar>, nowMs: number): StockFadeClose => {
  const newest = isStockmacdChart(sym, STOCKMACD_INTERVALS[0]) && closed.length > 0 ? closed[closed.length - 1] : null;
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
    judge: newest !== null && isStockmacdChart(sym, STOCKMACD_INTERVALS[0]) && newest.open_ms !== judgedOpen,
    fresh: newest !== null && stockBarFresh(newest, nowMs),
    done: newest !== null && newest.end >= due,
    noSession: false,
  };
};

// Whether trading stops at the end of the bar that opens at `openMs`, by the regular hours: "close" for a session's
// last bar (v41, spec 3.3 item 5: New York's 15:45, Tokyo's 15:15), "lunch" for Tokyo's 11:15 bar (the lunch break
// follows), null for the others. A day that ends early is not told from here: its last bar reads as any other
export const stockBarBreak = (sym: string, openMs: number): "close" | "lunch" | null => {
  const l = localOf(sym, openMs);
  if (stockMarketOf(sym) === "jp") return l.min === hm(15, 15) ? "close" : l.min === hm(11, 15) ? "lunch" : null;
  return l.min === hm(15, 45) ? "close" : null;
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
export const renderStockMail = (s: IndicatorSignal, lang: Lang): Mail => {
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
  const name = stockNameOf(s.pair, lang);
  const open = Date.parse(s.barTime);
  // the bar's end (stockBarEnd), as the run gives it
  const close = Date.parse(s.closedAt);
  // the price in: the bar's close (spec 2.3)
  const price = f ? f.price : s.close;
  // trading stops at the end of this bar: a session's last bar, Tokyo's bar before the lunch break
  const brk = Number.isFinite(open) ? stockBarBreak(s.pair, open) !== null : false;
  // the minutes after its close a bar is still mailed (45)
  const freshMin = STOCK_FRESH_MS / MIN;
  // the bar's word: 「15分足」 / "15-minute" on the rule's chart (spec 3.3 item 7)
  const tf = tfLabel(lang, s.interval);
  if (lang === "en") {
    const side = buy ? "BUY" : "SELL";
    const end = top ? "top" : "bottom";
    const market = jp ? "Tokyo" : "US";
    return assemble(`[Sextant] ${name} (${s.pair}) ${tf} ${buy ? "BUY" : "SELL (short sale)"}: the MACD line closed at ${FADE_PCT}% of the ${end} (Stock MACD)`, [
      `A MACD fade ${side} signal on ${name} (${s.pair}, ${market}), ${tf} chart.${buy ? "" : " A SELL on a share is a short sale."}`,
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
        ? `Yahoo's Tokyo prices come about 15 minutes late (measured on 2026-11-06, on the 1-hour reads), so this email is judged and sent some 15 minutes after the bar closed (how many minutes on ${tf} bars has not been measured yet).`
        : `This email is judged and sent at a read after the bar closes (a read judges only the newest bar closed by then; a bar more than ${freshMin} minutes past its close is not sent; how long it takes to arrive has not been measured).`) +
        " The price when it arrives may differ from the close above (the difference has not been measured).",
      "Not measured on shares.",
      `This rule is Sextant's own, not a published indicator. ${FADE_PCT}%, judging at the bar's close, judging shares on ${tf} bars, the MACD pane of the newest ${ZONE_BARS} ${tf} bars, the fade side (shares included) and stating no take-profit or stop price are the app owner's choices. That pane is the same as the app's ${tf} chart's.`,
      `The bars and the price are Yahoo Finance's public data (not an official feed; it may stop), the same as the app's stock chart. Check the latest state in the app before you place an order:\n${APP_URL}`,
      "To stop these emails, open Settings → Email alerts in the app and untick the share under Stock MACD.\nThis is reference information, not investment advice. Every trading decision is your own.",
    ]);
  }
  const sideJ = `${buy ? "買い" : "売り"}（${s.side}）`;
  const end = top ? "上" : "下";
  const market = jp ? "東証" : "米国";
  return assemble(`【Sextant】${name}（${s.pair}）${tf} ${buy ? "買い（BUY）" : "売り（SELL・空売り）"}: 青い線が${end}の端の${FADE_PCT}%で確定（株の MACD）`, [
    `${name}（${s.pair}、${market}）の${tf}で、MACD の逆張りの${sideJ}の合図が出ました。${buy ? "" : "株の売りは空売りです。"}`,
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
      ? `東証の値段は Yahoo では約15分遅れて届きます（2026-11-06 に、1時間足の読み込みで測りました）。そのため、このメールは足が確定してから15分ほど後に判定して送ります（${tf}で実際に何分後になるかは、まだ測っていません）。`
      : `このメールは、足の確定の後の読み込みで判定して送ります（読み込みで判定するのは、その時に確定している一番新しい足だけです。確定から${freshMin}分を過ぎた足は送りません。実際に何分で届くかは測っていません）。`) +
      "届いた時の値段は、上の終値と違うことがあります（その差は測っていません）。",
    "株では測っていません。",
    `この決まりは Sextant 独自のもので、公開されているインジケーターではありません。${FADE_PCT}%・足の確定で判定すること・株を${tf}で判定すること・MACD の枠を${tf}の新しい${ZONE_BARS}本にすること・逆張りの向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの${tf}のチャートの枠と同じです。`,
    `足と値段は Yahoo Finance の公開データ（公式の配信ではないため、止まることがあります）で、アプリの株のチャートと同じです。注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
    "この通知を止めるには、アプリの「設定」→「メール通知」の「株の MACD」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
  ]);
};
