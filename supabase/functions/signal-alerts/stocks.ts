// #391 (docs §8.134): the MACD email on shares — the 1-hour MACD email's rule (v8: _shared/macd-level.ts
// decideZoneOnWindow, the 600 closed bars ending at the bar, the newest 120 bars' pane, 95%) on the hourly bars of
// the 22 US and Japanese shares measured in docs §8.133, read from Yahoo as the live chart reads them
// (live-chart/stocks.ts parseYahooChart, rounded as its history is). The owner (2026-10-31), shown §8.133's numbers:
// 「出す、利確幅はいらない、自分で決める」 — so the email names no stop and no target.
//
// When a share's hourly bar has closed: the regular session's bars open on the hour in Tokyo (9:00 … 15:00 JST; the
// one opening 11:00 ends at the lunch break, 11:30, and the one stamped 12:00 runs 12:30-13:00; the last ends at the
// closing auction, 15:30) and on the half hour in New York (9:30 … 15:30 local; the last ends at 16:00). A bar is
// closed once Yahoo has priced the share at or after its end (meta.regularMarketTime) or a later bar is in its
// answer: so a session's last bar is judged on the closing auction's price (Yahoo's point at the close, joined to it
// by parseYahooChart), and a feed that lags is waited for. Yahoo is read for a share only in the half hour after one
// of those closes (stockCloseDue), once a minute at most, until the bar is in.
//
// #397 (docs §8.150): from signal-alerts v39 the email is the ride of the pairs' MACD email (_shared/macd-ride.ts;
// research/macdride-spec.md section 6), the owner's 「5ペア・金・株を全部変える」 and, for the shares,
// 「1時間足の確定ごとに見る」 (2026-11-12), in place of the 95% email, which is stopped. Email 1 at the close of the
// 1-hour bar at which the MACD line (blue) came into the 90% band of the pane's top (a BUY) or bottom (a SELL, on a
// share a short sale) with the bar before outside it; a notice in its place where the line is already at 96% at that
// close; email 2 at the first later closed bar whose line, on its own 600 closed bars, is at 96% of the same edge —
// looked at at closes only: no minute is read, and no state is kept (every read brings the bars). A ride is a row of
// public.macd_rides, read and written by the run (index.ts stockSweep); what is here is pure: from a share's closed
// bars, the chart's ride rows and the clock, the rides reached (stockRidesReached) and what the newest closed bar's
// close does (stockRideClose), and the three mails' texts. Nothing of the ride is measured on shares (docs §8.149 is
// the five pairs'; docs §8.133's numbers are the 95% rule's and are written nowhere here).

import type { Candle } from "../analyze/indicators.ts";
import { barOpenMs } from "../analyze/state.ts";
import { ZONE_BARS } from "../_shared/macd-level.ts";
import {
  RIDE_IN_PCT,
  RIDE_IN_SHARE,
  RIDE_OUT_PCT,
  RIDE_OUT_SHARE,
  rideCatchUpByClose,
  rideCloseStep,
  rideEntryAt,
  rideRuleId,
  rideZoneSideOf,
  type RideCloseStep,
  type RideEntry,
  type RideMail,
  type RideRow,
  type RideSide,
} from "../_shared/macd-ride.ts";
import { parseYahooChart, stockDecimals, stockMarketOf } from "../live-chart/stocks.ts";
// (indicators.ts imports this file too: nothing of it is used here while the module is loaded, only inside the mails)
import type { IndicatorSignal } from "./indicators.ts";
import { APP_URL, assemble, clock, rideHeldText, type Lang, type Mail } from "./logic.ts";

// The shares measured in docs §8.133 (the live chart's list, src/lib/stocks.ts), in its order
export const STOCKMACD_PAIRS: readonly string[] = [
  "NVDA", "INTC", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA",
  "7203.T", "6758.T", "9984.T", "8306.T", "6861.T", "9983.T", "8035.T", "7974.T", "9432.T", "6501.T", "7267.T",
  "6920.T", "4063.T", "8058.T",
];
export const STOCKMACD_INTERVALS = ["1h"] as const;
export const isStockmacdChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && STOCKMACD_PAIRS.includes(pair) &&
  (STOCKMACD_INTERVALS as readonly string[]).includes(interval);
// The rule's ids (their own, so the FX record and the morning check's never take them in; they start with
// "stockmacd", as the app reads the rule back from them). #391: the 95% email's was
// stockmacd_12_26_9_w600_1h_z95of120_v1, never written again. #397: the ride's three, one a mail, built from the
// ride's constants (rideRuleId): stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2 (email 1; what indicatorRuleId gives
// for 'stockmacd'), ..._at_v2 (the notice) and ..._out_v2 (email 2). The subscriptions keep rule = 'stockmacd'.
export const STOCKMACD_RIDE_VERSION = 2;
export const STOCKMACD_RULE_ID = rideRuleId("stockmacd", "in", STOCKMACD_RIDE_VERSION);
export const STOCKMACD_AT_RULE_ID = rideRuleId("stockmacd", "at", STOCKMACD_RIDE_VERSION);
export const STOCKMACD_OUT_RULE_ID = rideRuleId("stockmacd", "out", STOCKMACD_RIDE_VERSION);

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

// The regular session's bar closes, in the market's time of day (minutes)
const hm = (h: number, m: number) => h * 60 + m;
const CLOSES: Record<"us" | "jp", number[]> = {
  us: [hm(10, 30), hm(11, 30), hm(12, 30), hm(13, 30), hm(14, 30), hm(15, 30), hm(16, 0)],
  jp: [hm(10, 0), hm(11, 0), hm(11, 30), hm(13, 0), hm(14, 0), hm(15, 0), hm(15, 30)],
};
// how long after a close Yahoo is read for its bar
export const STOCK_POLL_MS = 30 * MIN;
// how long after its close a bar is still mailed (a lagging feed, a missed run)
export const STOCK_FRESH_MS = 45 * MIN;

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

// When a bar that opens at `openMs` ends: Tokyo's 11:00 bar at the lunch break and its 15:00 bar at the closing
// auction, New York's 15:30 bar at its close; every other an hour after it opens. On a day that ends early, at the
// session's end when Yahoo gives it (`sessionEndMs`, the session the bar is in)
export const stockBarEnd = (sym: string, openMs: number, sessionEndMs: number | null = null): number => {
  const l = localOf(sym, openMs);
  const half = stockMarketOf(sym) === "jp" ? l.min === hm(11, 0) || l.min === hm(15, 0) : l.min === hm(15, 30);
  const end = openMs + (half ? 30 * MIN : HOUR);
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

// Yahoo's hourly answer -> the chart's bars (rounded as its history is: Number(v.toFixed(d))), each with its end and
// whether it has closed by Yahoo's last price (`marketMs`, its regularMarketTime) — or a later bar is there
export const stockBarsOf = (sym: string, body: unknown, nowMs: number): { bars: StockBar[]; marketMs: number | null } | null => {
  const got = parseYahooChart(sym, body, "1h", nowMs);
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

// ---- #397 (docs §8.150): the ride on a share, judged at closes (research/macdride-spec.md section 6) --------------
//
// #391's stockmacdSignals (the 95% email's decision at the newest closed bar, decideZoneOnWindow) is gone with that
// email. What a read of a share's bars does now is told by three pure functions, in the order the run uses them:
// stockSweepOf (is the close due done, is the newest closed bar to be judged), stockRidesReached (the open rides
// whose line is at 96% at a closed bar after their entry) and stockRideClose (what the newest closed bar's close
// does: email 1, the notice, or nothing). The run (index.ts stockSweep) reads and writes public.macd_rides between
// them, so the rows stockRideClose is given are those as they stand after the reached ones were written.

// Whether an entry at a closed bar is still mailed: the bar ended at most STOCK_FRESH_MS ago
export const stockBarFresh = (bar: Pick<StockBar, "end">, nowMs: number): boolean => {
  const age = nowMs - bar.end;
  return age >= 0 && age <= STOCK_FRESH_MS;
};

// A ride of a share found reached: the ride as it was given, the open of the bar it was reached in (its row's
// reached_bar), the price when seen (the newest closed bar's close), whether it was seen late (that bar is not the
// newest closed one, or the newest closed one ended more than STOCK_FRESH_MS ago) and the line's share of the way to
// its edge at that bar's close (its row's share1)
export interface StockReach<R extends RideRow = RideRow> {
  ride: R;
  bar: number;
  price: number;
  late: boolean;
  share: number;
}

// The rides of a share reached by now, from its closed bars (oldest first; every closed bar of the read, a bar being
// judged on its own 600) and the chart's ride rows (public.macd_rides, both sides; those not open are passed over):
// for each open ride the first closed bar after its entry bar, among the newest RIDE_CATCHUP_BARS, whose line on the
// 600 closed bars ending at it is at 96% on the ride's side (rideCatchUpByClose) — by the bar's close, not by its
// high or low: a share is looked at at closes only. A bar that has left the newest RIDE_CATCHUP_BARS is never seen
// (spec section 10). None on another chart, or with no closed bar.
export const stockRidesReached = <R extends RideRow>(
  sym: string,
  closed: ReadonlyArray<StockBar>,
  rides: ReadonlyArray<R>,
  nowMs: number,
): Array<StockReach<R>> => {
  if (!isStockmacdChart(sym, "1h") || closed.length === 0) return [];
  const newest = closed[closed.length - 1];
  const bars = closed.map((b) => ({ t: b.open_ms, close: b.close }));
  const stale = nowMs - newest.end > STOCK_FRESH_MS;
  const out: Array<StockReach<R>> = [];
  for (const ride of rides) {
    if (ride.status !== "open") continue;
    const c = rideCatchUpByClose(bars, rideZoneSideOf(ride.side), ride.entryBar);
    if (c !== null) out.push({ ride, bar: c.bar, price: newest.close, late: !c.newest || stale, share: c.share });
  }
  return out;
};

// What the close of a share's newest closed bar does: `fresh`, whether it ended at most STOCK_FRESH_MS ago (an older
// bar is no entry: nothing is judged); the entry at it (rideEntryAt on the 600 closed bars ending at it: null with
// fewer, or with none), and the step (rideCloseStep: "in" email 1, "at" the notice, "skip" while an older ride of the
// side is held, "quiet" when a ride of the side was reached in this very bar, null with no entry). `rows`: the
// chart's ride rows, both sides, as they stand after this read's reached rides were written — every open one, every
// one reached in this bar or later, and this bar's own (rideCloseStep's needs).
export interface StockRideClose {
  fresh: boolean;
  entry: RideEntry | null;
  step: RideCloseStep;
}
export const stockRideClose = (
  sym: string,
  closed: ReadonlyArray<StockBar>,
  rows: ReadonlyArray<RideRow>,
  nowMs: number,
): StockRideClose => {
  const newest = isStockmacdChart(sym, "1h") && closed.length > 0 ? closed[closed.length - 1] : null;
  if (newest === null || !stockBarFresh(newest, nowMs)) return { fresh: false, entry: null, step: rideCloseStep(null, 0, []) };
  const entry = rideEntryAt(closed.map((b) => b.close));
  return { fresh: true, entry, step: rideCloseStep(entry, newest.open_ms, rows) };
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
    judge: newest !== null && isStockmacdChart(sym, "1h") && newest.open_ms !== judgedOpen,
    fresh: newest !== null && stockBarFresh(newest, nowMs),
    done: newest !== null && newest.end >= due,
    noSession: false,
  };
};

// Whether trading stops at the end of the bar that opens at `openMs`, by the regular hours: "close" for a session's
// last bar (New York's 15:30, Tokyo's 15:00), "lunch" for Tokyo's 11:00 bar (the lunch break follows), null for the
// others. A day that ends early is not told from here: its last bar reads as any other
export const stockBarBreak = (sym: string, openMs: number): "close" | "lunch" | null => {
  const l = localOf(sym, openMs);
  if (stockMarketOf(sym) === "jp") return l.min === hm(15, 0) ? "close" : l.min === hm(11, 0) ? "lunch" : null;
  return l.min === hm(15, 30) ? "close" : null;
};

// Profit or loss against email 1's price on a share (research/macdride-spec.md section 2): the price when seen less the entry
// for a BUY, the entry less it for a SELL (a short sale), in the share's currency and in percent of the entry. Both
// prices are closes of Yahoo's bars (close to close). Worked in whole steps of the price's decimals, so that a
// difference of prices comes out as written
export const stockRidePnl = (sym: string, side: RideSide, entry: number, seen: number): { value: number; pct: number } => {
  const k = 10 ** stockDecimals(sym);
  const p = (x: number) => Math.round(x * k);
  const points = side === "BUY" ? p(seen) - p(entry) : p(entry) - p(seen);
  return { value: points / k, pct: (points / p(entry)) * 100 };
};

// The MACD numbers as the email writes them: the price's decimals, or more where the pane's edge the mail is about
// (`end`) would come out with fewer than two significant digits; the minus as the chart's (U+2212). #397: the edge
// is the pane's on the ride's side, the top for a BUY and the bottom for a SELL (the 95% email took the bottom for a
// BUY)
const macdText = (sym: string, end: number | null): ((v: number | null) => string) => {
  const d = stockDecimals(sym);
  const md = end !== null && Number.isFinite(end) && end !== 0 ? Math.min(20, Math.max(d, 1 - Math.floor(Math.log10(Math.abs(end))))) : d;
  return (v: number | null) => (v !== null && Number.isFinite(v) ? v.toFixed(md).replace(/^-/, "−") : "—");
};

// #397 (docs §8.150; research/macdride-spec.md section 8): the three mails of the ride on a share (s.ride says which).
// Email 1: the bar, that the blue line came into the 90% band of the pane's top (bottom) with the bar before outside
// it — an entry with the flow, a BUY (a SELL, on a share a short sale) — its numbers, the bar's close, what follows.
// The notice: the line came in already at 96%, no entry. Email 2: the first email, that the line was at 96% at a
// 1-hour close (or was found to have been, late), the price now (the newest closed bar's close), the profit or loss
// since the first email in the share's currency and in percent of the entry, close to close, and how long it was
// held; it reports the line, not a profit. The pane's edge is the ride's side's: the top for a BUY, the bottom for a
// SELL. Nothing of the ride is measured on shares, and the mails say so with no numbers (docs §8.133's are the 95%
// rule's). A close after which trading stops (a session's last bar, Tokyo's bar before the lunch break) cannot be
// traded until the market opens again: said of the bar where the regular hours tell it, and in general.
export const renderStockMail = (s: IndicatorSignal, lang: Lang): Mail => {
  const f = s.ride ?? null;
  const mail: RideMail = f?.mail ?? "in";
  const jp = stockMarketOf(s.pair) === "jp";
  const d = stockDecimals(s.pair);
  const money = (v: number) => (jp ? `${v.toFixed(d)}${lang === "en" ? " yen" : "円"}` : lang === "en" ? `$${v.toFixed(d)}` : `${v.toFixed(d)}ドル`);
  const px = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : money(v));
  const buy = s.side === "BUY";
  const top = (f?.zside ?? rideZoneSideOf(s.side)) === "top";
  const edge = f ? (top ? f.top : f.bottom) : null;
  const mx = macdText(s.pair, edge);
  const mark = (share: number) => (edge === null ? null : share * edge);
  const name = stockNameOf(s.pair, lang);
  const entryOpen = Date.parse(f ? f.entryBar : s.barTime);
  const entryClose = Date.parse(f ? f.entryClosedAt : s.closedAt);
  const entryPrice = f ? f.entryPrice : s.close;
  const seen = Date.parse(f?.seenAt ?? s.closedAt);
  const late = f?.late === true;
  const reachedBar = f?.reachedBar ? Date.parse(f.reachedBar) : Number.NaN;
  // (a late email 2 names the bar it was reached in by its OPEN, which the row keeps: the bar's end would have to be
  // worked out by the regular hours, and the last bar of a day that ends early would then read half an hour late)
  const seenPrice = f?.seenPrice ?? null;
  // the result with its sign (the minus as the chart's, U+2212; ± at exactly zero), in the share's currency and in
  // percent of the entry
  const pnl = mail === "out" && seenPrice !== null && Number.isFinite(seenPrice) ? stockRidePnl(s.pair, s.side, entryPrice, seenPrice) : null;
  const sign = pnl === null ? "" : pnl.value > 0 ? "+" : pnl.value < 0 ? "−" : "±";
  const result = pnl === null
    ? "—"
    : `${sign}${money(Math.abs(pnl.value))}${Number.isFinite(pnl.pct) ? `${lang === "en" ? " (" : "（"}${sign}${Math.abs(pnl.pct).toFixed(2)}%${lang === "en" ? ")" : "）"}` : ""}`;
  // trading stops at the end of the bar the mail's price is of (email 1: the entry bar; email 2 seen on time: the
  // bar it was reached in, the newest closed one then)
  const brk = mail === "in" && Number.isFinite(entryOpen)
    ? stockBarBreak(s.pair, entryOpen)
    : mail === "out" && !late && Number.isFinite(reachedBar)
    ? stockBarBreak(s.pair, reachedBar)
    : null;
  if (lang === "en") {
    const side = buy ? "BUY" : "SELL";
    const end = top ? "top" : "bottom";
    const market = jp ? "Tokyo" : "US";
    const same = "This is the rule of the app's MACD ride email on currency pairs (Sextant's own rule, docs §8.150), on the share's 1-hour bars.";
    const unmeasured = "This rule has not been measured on shares.";
    const yahoo = "The bars and the price are Yahoo Finance's public data (not an official feed; it may stop), the same as the app's stock chart; a session's last bar is judged on its closing price.";
    const shut = `The close of a session's last bar${jp ? " (and of the last bar before Tokyo's lunch break)" : ""} cannot be traded until the market opens again, and the price then may differ.`;
    const delay = !jp
      ? ""
      : mail === "out" && late
      ? "Yahoo's Tokyo prices come about 15 minutes late (measured on 2026-11-06). "
      : "Yahoo's Tokyo prices come about 15 minutes late, so this email is sent about 15 minutes after the bar closed (measured on 2026-11-06). ";
    const what = mail === "out" ? "price" : "close";
    const brkLine = brk === "lunch"
      ? `This is the last bar before Tokyo's lunch break (11:30–12:30 JST): this ${what} cannot be traded until the afternoon session opens, and the price then may differ`
      : `This is the session's last bar: this ${what} cannot be traded until the next session opens, and the price then may differ`;
    const stop = "To stop these emails, open Settings → Email alerts in the app and untick the share under Stock MACD.\nThis is reference information, not investment advice. Every trading decision is your own.";
    if (mail === "out") {
      return assemble(`[Sextant] ${name} (${s.pair}) 1-hour reached ${RIDE_OUT_PCT}% (Stock MACD, email 2, the ${side})`, [
        `On ${name} (${s.pair}, ${market}), 1-hour chart, the MACD line (blue) reached ${RIDE_OUT_PCT}% of the way to the ${end} of the MACD pane (Stock MACD, email 2, for the ${side}).`,
        [
          `Email 1: a ${side}${buy ? "" : " (a short sale)"} at the bar closed ${clock(entryClose, 0)} UTC (${clock(entryClose, 9)} JST), that bar's close ${px(entryPrice)}`,
          late && Number.isFinite(reachedBar)
            ? `The line was already at ${RIDE_OUT_PCT}% or more at the close of the bar that opened ${clock(reachedBar, 0)} UTC (${clock(reachedBar, 9)} JST). It could not be read then and was found now (${clock(seen, 0)} UTC, ${clock(seen, 9)} JST)`
            : `Seen at ${clock(seen, 0)} UTC (${clock(seen, 9)} JST), on the close of the newest closed 1-hour bar`,
          `Price now: ${px(seenPrice)} (the newest closed 1-hour bar's close)`,
          ...(brk ? [brkLine] : []),
          `Profit or loss against email 1's price: ${result}, close to close`,
          `Time since the entry bar closed: ${rideHeldText(seen - entryClose, "en")} (the hours the market was shut are in it)`,
        ].join("\n"),
        `This email reports that the line reached ${RIDE_OUT_PCT}%. It does not say the trade is at a profit: the result can be a loss. The result compares the close of email 1's bar with the newest closed bar's close; it holds no commission or other cost${buy ? "" : " (a short sale has its own)"}, and the prices you can trade at may differ. ${unmeasured}`,
        `${yahoo} Whether the line is at ${RIDE_OUT_PCT}% is looked at when each 1-hour bar closes, on that bar's close, not while a bar forms. ${shut} ${delay}Check the latest state in the app:\n${APP_URL}`,
        stop,
      ]);
    }
    if (mail === "at") {
      return assemble(`[Sextant] ${name} (${s.pair}) 1-hour notice: already at ${RIDE_OUT_PCT}% (Stock MACD, no entry signal)`, [
        `On ${name} (${s.pair}, ${market}), 1-hour chart, the MACD line (blue) came into the ${RIDE_IN_PCT}% band of the MACD pane's ${end}, and at the bar's close it was already at ${RIDE_OUT_PCT}% or more. No entry signal (it would have been a ${side}${buy ? "" : ", on a share a short sale"}) is sent: this is a notice only.`,
        [
          `Bar: closed ${clock(entryClose, 0)} UTC (${clock(entryClose, 9)} JST)`,
          `Close ${px(s.close)}`,
          `  MACD = ${mx(f?.m ?? null)}; ${end} of the pane = ${mx(edge)}; ${RIDE_OUT_PCT}% of it = ${mx(mark(RIDE_OUT_SHARE))}`,
        ].join("\n"),
        `${same} The next entry signal for this share and side is judged at the bar where the line, having left the ${RIDE_IN_PCT}% band, comes back into it. ${unmeasured}`,
        `${yahoo} ${delay}Check the latest state in the app:\n${APP_URL}`,
        stop,
      ]);
    }
    return assemble(`[Sextant] ${name} (${s.pair}) 1-hour ${side} entry signal (Stock MACD, email 1)`, [
      `A Stock MACD ${side} entry signal fired on ${name} (${s.pair}, ${market}), 1-hour chart (email 1).${buy ? "" : " A SELL on a share is a short sale."}`,
      [
        `Bar: closed ${clock(entryClose, 0)} UTC (${clock(entryClose, 9)} JST)`,
        `MACD(12, 26, 9): the MACD line (blue) came into the ${end} band of the MACD pane of the newest ${ZONE_BARS} bars: ${RIDE_IN_PCT}% or more of the way from the zero line to the pane's ${end} (the ${top ? "highest" : "lowest"} of the MACD line, the signal line and the histogram). The bar before was outside it, so this is an entry with the flow: a ${side}`,
        `  MACD = ${mx(f?.m ?? null)}; ${end} of the pane = ${mx(edge)}; ${RIDE_IN_PCT}% of it = ${mx(mark(RIDE_IN_SHARE))}; ${RIDE_OUT_PCT}% of it = ${mx(mark(RIDE_OUT_SHARE))}`,
        `This bar's close: ${px(entryPrice)}`,
        ...(brk ? [brkLine] : []),
      ].join("\n"),
      `${same} Email 2 is sent at the first later 1-hour close at which the blue line is at ${RIDE_OUT_PCT}% or more of the same edge (the pane's ${end}). Unlike the pairs' email it is looked for at closes only: a touch of ${RIDE_OUT_PCT}% inside a bar that is gone by its close is not seen. There is no stop and no target. Nothing is sent if the line leaves the ${RIDE_IN_PCT}% band, and no new email 1 for this share and side (${side}) is sent until email 2 has been. The pane's edges are taken without the margin the chart adds as it draws them.`,
      `${unmeasured} The numbers measured on the five currency pairs (docs §8.150) do not apply to shares. With no stop, a trade can stay at a loss until the line reaches ${RIDE_OUT_PCT}%.`,
      `${yahoo} ${shut} ${delay}Check the latest state in the app before you place an order:\n${APP_URL}`,
      stop,
    ]);
  }
  const sideJ = `${buy ? "買い" : "売り"}（${s.side}）`;
  const end = top ? "上" : "下";
  const market = jp ? "東証" : "米国";
  const same = "FX の「MACD の流れ」のメールと同じ決まり（Sextant 独自のもの。docs §8.150）を、株の1時間足に当てたものです。";
  const unmeasured = "この決まりは、株では測っていません。";
  const yahoo = "足と値段は Yahoo Finance の公開データ（公式の配信ではないため、止まることがあります）で、アプリの株のチャートと同じです。取引時間の最後の足は、引けの値段で判定します。";
  const shut = `取引時間の最後の足${jp ? "（と、昼休みの前の足）" : ""}の終値では、次に取引が始まるまで売買できず、その時の値段は違うことがあります。`;
  const delay = !jp
    ? ""
    : mail === "out" && late
    ? "東証の値段は Yahoo では約15分遅れて届きます（2026-11-06 に測りました）。"
    : "東証の値段は Yahoo では約15分遅れて届くため、このメールは足が確定してから約15分後に送っています（2026-11-06 に測りました）。";
  const what = mail === "out" ? "値段" : "終値";
  const brkLine = brk === "lunch"
    ? `この足は、東証の昼休み（11:30〜12:30）の前の最後の足です。この${what}では、午後の取引が始まるまで売買できず、その時の値段は違うことがあります`
    : `この足は、取引時間の最後の足です。この${what}では、次の取引時間が始まるまで売買できず、その時の値段は違うことがあります`;
  const stop = "この通知を止めるには、アプリの「設定」→「メール通知」の「株の MACD」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。";
  if (mail === "out") {
    return assemble(`【Sextant】${name}（${s.pair}） 1時間足 ${RIDE_OUT_PCT}%に届きました（株の MACD・2通目、${buy ? "買い" : "売り"}の分）`, [
      `${name}（${s.pair}、${market}）の1時間足で、MACD の青い線が、枠の${end}の端の${RIDE_OUT_PCT}%に届きました（株の MACD の2通目。${sideJ}の分）。`,
      [
        `1通目: ${clock(entryClose, 9)}（日本時間）に確定した足で${buy ? sideJ : `売り（${s.side}、空売り）`}。その足の終値 ${px(entryPrice)}`,
        late && Number.isFinite(reachedBar)
          ? `${clock(reachedBar, 9)}（日本時間）に始まった足の終わりで、もう${RIDE_OUT_PCT}%以上でした。その時は読めず、今見つけました（${clock(seen, 9)}、日本時間）`
          : `届いたのを見た時刻: ${clock(seen, 9)}（日本時間）。その時の最新の確定足の終値で見ました`,
        `今の値段: ${px(seenPrice)}（最新の確定足の終値）`,
        ...(brk ? [brkLine] : []),
        `1通目の値段からの損益: ${result}。終値と終値の比べです`,
        `1通目の足の確定からの時間: ${rideHeldText(seen - entryClose, "ja")}（取引していない時間も入れています）`,
      ].join("\n"),
      `このメールは、青い線が${RIDE_OUT_PCT}%に届いたことの知らせです。損益はプラスとは限りません。損益は、1通目の足の終値と、最新の確定足の終値を比べたものです。手数料などの費用${buy ? "" : "（空売りにかかる費用も）"}は入れていません。実際に売買できる値段は、違うことがあります。${unmeasured}`,
      `${yahoo}${RIDE_OUT_PCT}%に届いたかは、1時間足が確定するたびに、その足の終値で見ています（足の途中は見ていません）。${shut}${delay}アプリで最新の状態を確認してください。\n${APP_URL}`,
      stop,
    ]);
  }
  if (mail === "at") {
    return assemble(`【Sextant】${name}（${s.pair}） 1時間足 知らせ: もう${RIDE_OUT_PCT}%です（株の MACD・入る合図なし）`, [
      `${name}（${s.pair}、${market}）の1時間足で、MACD の青い線が、枠の${end}の端の${RIDE_IN_PCT}%の帯に入りましたが、足が確定した時にはもう${RIDE_OUT_PCT}%以上でした。入る合図（${sideJ}${buy ? "" : "。株では空売り"}）は送りません。知らせだけです。`,
      [
        `判定した足: ${clock(entryClose, 9)}（日本時間）に確定した足`,
        `終値 ${px(s.close)}`,
        `  MACD = ${mx(f?.m ?? null)}、枠の${end}の端 = ${mx(edge)}（その${RIDE_OUT_PCT}% = ${mx(mark(RIDE_OUT_SHARE))}）`,
      ].join("\n"),
      `${same}この株の同じ向きの次の入る合図は、青い線がいったん${RIDE_IN_PCT}%の帯から出て、入り直した足で判定します。${unmeasured}`,
      `${yahoo}${delay}アプリで最新の状態を確認してください。\n${APP_URL}`,
      stop,
    ]);
  }
  return assemble(`【Sextant】${name}（${s.pair}） 1時間足 ${sideJ}で入る合図（株の MACD・1通目）`, [
    `${name}（${s.pair}、${market}）の1時間足で、株の MACD の${sideJ}で入る合図が出ました（1通目）。${buy ? "" : "株の売りは空売りです。"}`,
    [
      `判定した足: ${clock(entryClose, 9)}（日本時間）に確定した足`,
      `MACD(12・26・9): 青い線（MACD）が、新しい${ZONE_BARS}本の MACD の枠の${end}の端（青い線・オレンジの線・棒の${top ? "一番高い" : "一番低い"}所）の${RIDE_IN_PCT}%以上（0の線から測って）に入りました。一つ前の足では入っていなかったので、流れに乗って${buy ? "買い" : "売り"}で入る合図です`,
      `  MACD = ${mx(f?.m ?? null)}、枠の${end}の端 = ${mx(edge)}（その${RIDE_IN_PCT}% = ${mx(mark(RIDE_IN_SHARE))}、${RIDE_OUT_PCT}% = ${mx(mark(RIDE_OUT_SHARE))}）`,
      `この足の終値: ${px(entryPrice)}`,
      ...(brk ? [brkLine] : []),
    ].join("\n"),
    `${same}2通目は、1時間足が確定するたびに見て、青い線が同じ端（枠の${end}の端）の${RIDE_OUT_PCT}%以上にいた最初の足で送ります。FX のメールと違い、足の途中は見ません（途中で${RIDE_OUT_PCT}%に届いても、確定の時に${RIDE_OUT_PCT}%より内側なら見えません）。損切りも目標もありません。青い線が${RIDE_IN_PCT}%の帯から出ても、何も送りません。2通目を送るまで、この株の同じ向き（${buy ? "買い" : "売り"}）の新しい1通目は送りません。枠の端には、チャートが枠を描く時に足す余白は入れていません。`,
    `${unmeasured}FX の5ペアで測った数字（docs §8.150）は、株には当てはまりません。損切りをしないので、${RIDE_OUT_PCT}%に届くまで、含み損のまま持ち続けることがあります。`,
    `${yahoo}${shut}${delay}注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
    stop,
  ]);
};
