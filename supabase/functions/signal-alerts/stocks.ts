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

import type { Candle } from "../analyze/indicators.ts";
import { barOpenMs } from "../analyze/state.ts";
import { MACD_DEFAULTS } from "../_shared/macd.ts";
import { decideZoneOnWindow, LEVEL_WINDOW, ZONE_BARS, ZONE_PCT } from "../_shared/macd-level.ts";
import { parseYahooChart, stockDecimals, stockMarketOf } from "../live-chart/stocks.ts";
import type { IndicatorSignal } from "./indicators.ts";
import { APP_URL, assemble, clock, type Lang, type Mail } from "./logic.ts";

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
// The rule's id: v8's numbers, on shares (its own id, so the FX record and the morning check's never take them in)
export const STOCKMACD_RULE_ID = `stockmacd_${MACD_DEFAULTS.fast}_${MACD_DEFAULTS.slow}_${MACD_DEFAULTS.signal}_w${LEVEL_WINDOW}_1h_z${ZONE_PCT}of${ZONE_BARS}_v1`;

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
  const bars: StockBar[] = got.bars.map((c, k) => {
    const open = barOpenMs(c.datetime);
    const end = stockBarEnd(sym, open, session && open >= session.start && open < session.end ? session.end : null);
    const closed = k < got.bars.length - 1 || (marketMs !== null && marketMs >= end);
    return { datetime: c.datetime, open: r(c.open), high: r(c.high), low: r(c.low), close: r(c.close), open_ms: open, end, closed };
  });
  return { bars, marketMs };
};

// The MACD email on the newest of a share's closed bars (oldest first): a SELL or BUY as v8 decides on the 600 ending
// at it, while it closed at most STOCK_FRESH_MS ago; nothing on fewer bars or another chart
export const stockmacdSignals = (sym: string, closed: ReadonlyArray<StockBar>, nowMs: number): IndicatorSignal[] => {
  if (!isStockmacdChart(sym, "1h") || closed.length < LEVEL_WINDOW) return [];
  const i = closed.length - 1;
  const b = closed[i];
  const age = nowMs - b.end;
  if (age < 0 || age > STOCK_FRESH_MS) return [];
  const z = decideZoneOnWindow(closed, i);
  if (z === null || !z.fire) return [];
  return [{
    rule: "stockmacd",
    pair: sym,
    interval: "1h",
    side: z.side,
    strong: false,
    barTime: new Date(b.open_ms).toISOString(),
    closedAt: new Date(b.end).toISOString(),
    close: b.close,
    line: null,
    eps: null,
    rsi: null,
    rsiPrev: null,
    sl: null,
    tps: null,
    macdh: { m: z.m, top: z.top, bottom: z.bottom, mark: z.mark },
  }];
};

// What a run does for one share this minute, from its bars as Yahoo answered: the newest closed bar (judged unless
// it was), and whether the close due is done (its bar is in, or the share did not trade today: no bar in the six
// hours before it)
export const stockSweepOf = (
  sym: string,
  bars: ReadonlyArray<StockBar>,
  due: number,
  judgedOpen: number | undefined,
  nowMs: number,
): { signals: IndicatorSignal[]; newest: StockBar | null; judge: boolean; done: boolean; noSession: boolean } => {
  const last = bars.length > 0 ? bars[bars.length - 1] : null;
  if (!last || last.open_ms < due - 6 * HOUR) return { signals: [], newest: null, judge: false, done: true, noSession: true };
  const closed = bars.filter((b) => b.closed);
  const newest = closed.length > 0 ? closed[closed.length - 1] : null;
  const judge = newest !== null && newest.open_ms !== judgedOpen;
  return {
    signals: judge ? stockmacdSignals(sym, closed, nowMs) : [],
    newest,
    judge,
    done: newest !== null && newest.end >= due,
    noSession: false,
  };
};

// The MACD numbers as the email writes them: the price's decimals, or more where the pane's edge on the signal's side
// would come out with fewer than two significant digits; the minus as the chart's (U+2212)
const macdText = (s: IndicatorSignal): ((v: number) => string) => {
  const d = stockDecimals(s.pair);
  const f = s.macdh;
  const end = f ? (s.side === "BUY" ? f.bottom : f.top) : NaN;
  const md = Number.isFinite(end) && end !== 0 ? Math.min(20, Math.max(d, 1 - Math.floor(Math.log10(Math.abs(end))))) : d;
  return (v: number) => (Number.isFinite(v) ? v.toFixed(md).replace(/^-/, "−") : "—");
};

export const renderStockMail = (s: IndicatorSignal, lang: Lang): Mail => {
  const jp = stockMarketOf(s.pair) === "jp";
  const d = stockDecimals(s.pair);
  const px = (v: number) => (jp ? `${v.toFixed(d)}${lang === "en" ? " yen" : "円"}` : lang === "en" ? `$${v.toFixed(d)}` : `${v.toFixed(d)}ドル`);
  const closeMs = Date.parse(s.closedAt);
  const f = s.macdh;
  const buy = s.side === "BUY";
  const mx = macdText(s);
  const name = stockNameOf(s.pair, lang);
  if (lang === "en") {
    const side = buy ? "BUY" : "SELL";
    return assemble(`[Sextant] ${name} (${s.pair}) 1-hour ${side} signal (stock MACD)`, [
      `A MACD peak/valley ${side} signal fired on ${name} (${s.pair}, ${jp ? "Tokyo" : "US"}), 1-hour chart.`,
      [
        `Bar: closed ${clock(closeMs, 0)} UTC (${clock(closeMs, 9)} JST)`,
        `Close ${px(s.close)}`,
        `MACD(12, 26, 9): the MACD line (blue) reached the ${buy ? "bottom" : "top"} band of the MACD pane of the newest ${ZONE_BARS} bars: ${ZONE_PCT}% or more of the way from the zero line to the pane's ${buy ? "bottom" : "top"} (the ${buy ? "lowest" : "highest"} of the MACD line, the signal line and the histogram)`,
        ...(f ? [`  MACD = ${mx(f.m)}; ${buy ? "bottom" : "top"} of the pane = ${mx(buy ? f.bottom : f.top)}; ${ZONE_PCT}% of it = ${mx(f.mark)}`] : []),
      ].join("\n"),
      `This is the rule of the app's 1-hour MACD email on currency pairs (docs §8.119, §8.122, §8.129), on the share's 1-hour bars: a SELL when the MACD line first reaches ${ZONE_PCT}% or more of the way to the top of the newest ${ZONE_BARS} bars' pane, a BUY when it first reaches ${ZONE_PCT}% or more of the way to its bottom; one email per peak or valley. No stop or target is given. Measured on 22 shares' past hourly bars (docs §8.133), holding with no stop left some trades open far below their entry, even with a take-profit of 0.1%.`,
      `The bars and the price are Yahoo Finance's public data (not an official feed; it may stop), the same as the app's stock chart; a session's last bar is judged on its closing price. ${jp ? "How far Yahoo's Tokyo prices lag has not been checked. " : ""}Check the latest state in the app before you place an order:\n${APP_URL}`,
      "To stop these emails, open Settings → Email alerts in the app and untick the share under Stock MACD.\nThis is reference information, not investment advice. Every trading decision is your own.",
    ]);
  }
  const sideM = `${buy ? "買い" : "売り"}（${s.side}）`;
  const end = buy ? "下" : "上";
  return assemble(`【Sextant】${name}（${s.pair}） 1時間足 ${sideM}のサイン（株の MACD）`, [
    `${name}（${s.pair}、${jp ? "東証" : "米国"}）の1時間足で、MACD の山・谷の${sideM}のサインが出ました。`,
    [
      `判定した足: ${clock(closeMs, 9)}（日本時間）に確定した足`,
      `終値 ${px(s.close)}`,
      `MACD(12・26・9): 青い線（MACD）が、新しい${ZONE_BARS}本の MACD の枠の${end}の端（青い線・オレンジの線・棒の${buy ? "一番低い" : "一番高い"}所）の${ZONE_PCT}%以上（0の線から測って）に届きました`,
      ...(f ? [`  MACD = ${mx(f.m)}、枠の${end}の端 = ${mx(buy ? f.bottom : f.top)}（その${ZONE_PCT}% = ${mx(f.mark)}）`] : []),
    ].join("\n"),
    `FX の1時間足 MACD のメールと同じ決まり（docs §8.119・§8.122・§8.129）を、株の1時間足に当てたものです。青い線が新しい${ZONE_BARS}本の枠の上の端の${ZONE_PCT}%以上に届いた足で売り、下の端の${ZONE_PCT}%以上に届いた足で買いを送り、一つの山・谷では1通だけです。損切り・利確の目安は付けていません。22銘柄の過去の1時間足で測ると（docs §8.133）、損切りなしで持った場合、利確を 0.1% にしても、大きな含み損のまま戻らずに残る取引がありました。`,
    `足と値段は Yahoo Finance の公開データ（公式の配信ではないため、止まることがあります）で、アプリの株のチャートと同じです。取引時間の最後の足は、引けの値段で判定します。${jp ? "東証の値段が Yahoo で何分遅れているかは、まだ確かめていません。" : ""}注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
    "この通知を止めるには、アプリの「設定」→「メール通知」の「株の MACD」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
  ]);
};
