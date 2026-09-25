// #105: an email when the RSI + Parabolic SAR rule fires.
//
// The owner's request (2026-09-25): 「buyかsellのタイミングがきたらメールで
// 知らせてほしいです。」 The rule is the one the app publishes on since #104
// (analyze/rsisar.ts), read the same way — closed bars only, the newest
// closed bar decides — and the plan in the email is the one the app would
// publish at that close (stop 0.8 ATR, target 1.5 times the stop).
//
// Where the bars come from. GMO Coin's public bid/ask klines, the mid of the
// two: no key, no quota, and the feed the tracker settles every plan on. The
// in-app analysis reads 15min, 4h and 1day from Twelve Data (price-source.ts
// GMO_ANALYSIS_TIMEFRAMES), whose shared key allows eight requests a minute —
// a sweep over every subscribed pair every fifteen minutes would starve the
// analyses people are waiting on. So on those three timeframes the email and
// the app can, rarely, read a bar differently; the email says so.
//
// Everything here is Deno-free: src/test/signal-alerts.test.ts imports it.

import type { Candle } from "../analyze/indicators.ts";
import {
  BUY_LEVEL,
  REWARD_RATIO,
  RSI_SAR_EVIDENCE,
  RULE_ID,
  SELL_LEVEL,
  STOP_ATR,
  planFor,
  readRsiSar,
  type RsiSarRead,
  type Side,
} from "../analyze/rsisar.ts";
import { barOpenMs } from "../analyze/state.ts";
import { costlyHourAt } from "../analyze/timing.ts";
import { fetchRecentQuotes, midCandle } from "../analyze/price-source.ts";
import {
  GMO_INTERVALS,
  GMO_SYMBOLS,
  jstYearKey,
  klineUrl,
  mergeSides,
  parseKlines,
  usableBars,
  type Fetcher,
  type QuoteCandle,
} from "../track-outcomes/quotes.ts";

// The pairs the app analyses (analyze/index.ts ALLOWED_PAIRS)
export const ALERT_PAIRS = ["USD/JPY", "EUR/USD", "GBP/USD", "EUR/JPY", "GBP/JPY", "AUD/USD", "AUD/JPY"] as const;

// 1min is left out: the study never measured it, and a rule that fires a few
// times a day per pair on 15min would fire every hour or so on 1min — an inbox
// nobody reads is not a notification.
export const ALERT_INTERVALS = ["15min", "1h", "4h", "1day"] as const;

const MIN = 60_000;
const HOUR = 60 * MIN;
export const STEP_MS: Record<string, number> = {
  "15min": 15 * MIN,
  "1h": HOUR,
  "4h": 4 * HOUR,
  "1day": 24 * HOUR,
};

// A signal is only mailed while its bar closed at most this long ago. The
// sweep runs at 2, 17, 32 and 47 minutes past the hour, so every close is
// looked at two minutes after it and again fifteen minutes later, which covers
// one failed run. Past that the price has moved on and the email would be a
// report, not a notification.
export const FRESH_MS = 20 * MIN;

// Closed bars read per timeframe. The in-app read gets ~250; RSI's seed has
// decayed to nothing long before 200 ((13/14)^200 ≈ 4e-7) and the SAR
// restarts at every reversal, so the two reads agree on the same prices.
export const ALERT_BARS = 200;

// Who may subscribe. The pricing page lists alerts under Pro; admins get
// everything (the same allowlist analyze uses).
export const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com", "munekan2989@gmail.com"];
export const alertsAllowed = (plan: string | null | undefined, email: string | null | undefined): boolean =>
  (!!email && ADMIN_EMAILS.includes(email.toLowerCase())) || (plan ?? "").toLowerCase() === "pro";

export const isAlertPair = (v: unknown): v is string => typeof v === "string" && (ALERT_PAIRS as readonly string[]).includes(v);
export const isAlertInterval = (v: unknown): v is string =>
  typeof v === "string" && (ALERT_INTERVALS as readonly string[]).includes(v);

// Can a bar of this timeframe have closed inside the freshness window? 1h and
// coarser bars all close on the hour (GMO's trading day rolls on the hour in
// both seasons), so outside the first FRESH_MS of an hour there is nothing to
// look at and the fetch is skipped. 15min always qualifies.
export const mayHaveFreshClose = (interval: string, nowMs: number): boolean => {
  const step = STEP_MS[interval];
  if (step === undefined) return false;
  const grid = Math.min(step, HOUR);
  return nowMs % grid < FRESH_MS;
};

// GMO serves the bar still forming; the rule reads closed bars only.
export const closedMidBars = (quotes: QuoteCandle[], interval: string, nowMs: number): Candle[] => {
  const step = STEP_MS[interval];
  if (step === undefined) return [];
  return quotes
    .filter((q) => {
      const t = Date.parse(q.datetime);
      return Number.isFinite(t) && t + step <= nowMs;
    })
    .map(midCandle);
};

export interface FiredSignal {
  pair: string;
  interval: string;
  side: Side;
  // the open of the bar the rule fired on, ISO
  barTime: string;
  // when that bar closed, ISO
  closedAt: string;
  entry: number;
  stop: number;
  target: number;
  rsi: number;
  rsiPrev: number;
  sar: number;
  atr: number;
  // the close falls in the hours the app will not publish in (timing.ts)
  costly: boolean;
}

// Every signal whose bar closed inside the freshness window. Usually that is
// the newest closed bar or nothing; on 15min the window also reaches the bar
// before it, so a close the previous run missed (a failed fetch, a late cron
// tick) is still mailed by the next one — the unique key on signal_alerts
// keeps it to one email.
export const freshSignals = (pair: string, interval: string, read: RsiSarRead, nowMs: number): FiredSignal[] => {
  const step = STEP_MS[interval];
  if (step === undefined || !read.ok) return [];
  const out: FiredSignal[] = [];
  for (const s of read.signals) {
    const openMs = barOpenMs(s.datetime);
    if (!Number.isFinite(openMs)) continue;
    const closeMs = openMs + step;
    const age = nowMs - closeMs;
    if (age < 0 || age > FRESH_MS) continue;
    const plan = planFor(s.side, s.entry, s.atr);
    out.push({
      pair,
      interval,
      side: s.side,
      barTime: new Date(openMs).toISOString(),
      closedAt: new Date(closeMs).toISOString(),
      entry: plan.entry,
      stop: plan.stop,
      target: plan.target,
      rsi: s.rsi,
      rsiPrev: s.rsiPrev,
      sar: s.sar,
      atr: s.atr,
      costly: costlyHourAt(interval, closeMs),
    });
  }
  return out;
};

// Year-keyed intervals (4h, 1day): this JST year's file, and last year's too
// while this year's is still too short to hold the read.
export const fetchYearQuotes = async (
  pair: string,
  interval: string,
  minBars: number,
  nowMs: number,
  fetcher: Fetcher,
): Promise<QuoteCandle[] | null> => {
  const symbol = GMO_SYMBOLS[pair];
  const spec = GMO_INTERVALS[interval];
  if (!symbol || !spec || spec.key !== "year") return null;
  const year = Number(jstYearKey(nowMs));
  let bid: Array<{ t: number; c: Candle }> = [];
  let ask: Array<{ t: number; c: Candle }> = [];
  for (const key of [String(year), String(year - 1)]) {
    const [b, a] = await Promise.all([
      fetcher(klineUrl(symbol, "bid", spec.name, key)),
      fetcher(klineUrl(symbol, "ask", spec.name, key)),
    ]);
    bid = [...parseKlines(b), ...bid];
    ask = [...parseKlines(a), ...ask];
    const merged = usableBars(mergeSides(bid, ask), STEP_MS[interval], nowMs);
    if (merged.length >= minBars) return merged.slice(-minBars);
  }
  const merged = usableBars(mergeSides(bid, ask), STEP_MS[interval], nowMs);
  return merged.length > 0 ? merged : null;
};

// ALERT_BARS closed bars and the one forming, oldest first
export const fetchAlertQuotes = async (
  pair: string,
  interval: string,
  nowMs: number,
  deadlineMs: number,
  fetcher: Fetcher,
): Promise<QuoteCandle[] | null> => {
  const spec = GMO_INTERVALS[interval];
  if (!spec || !isAlertInterval(interval)) return null;
  if (spec.key === "day") {
    const got = await fetchRecentQuotes(pair, interval, ALERT_BARS + 1, nowMs, deadlineMs, fetcher);
    return got ? got.bars : null;
  }
  return fetchYearQuotes(pair, interval, ALERT_BARS + 1, nowMs, fetcher);
};

// One pair and timeframe, from the feed to the rule
export const checkPair = async (
  pair: string,
  interval: string,
  nowMs: number,
  deadlineMs: number,
  fetcher: Fetcher,
): Promise<{ read: RsiSarRead | null; signals: FiredSignal[]; bars: number }> => {
  const quotes = await fetchAlertQuotes(pair, interval, nowMs, deadlineMs, fetcher);
  if (!quotes) return { read: null, signals: [], bars: 0 };
  const closed = closedMidBars(quotes, interval, nowMs);
  const read = readRsiSar(closed);
  return { read, signals: freshSignals(pair, interval, read, nowMs), bars: closed.length };
};

// ---- the email --------------------------------------------------------------------

export type Lang = "ja" | "en";
export const isLang = (v: unknown): v is Lang => v === "ja" || v === "en";

export const APP_URL = "https://fx-tactical.jp/";

const decimalsOf = (pair: string) => (pair.toUpperCase().includes("JPY") ? 3 : 5);
const pipOf = (pair: string) => (pair.toUpperCase().includes("JPY") ? 0.01 : 0.0001);
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}`);

const TF_LABEL: Record<Lang, Record<string, string>> = {
  ja: { "15min": "15分足", "1h": "1時間足", "4h": "4時間足", "1day": "日足" },
  en: { "15min": "15-minute", "1h": "1-hour", "4h": "4-hour", "1day": "daily" },
};
export const tfLabel = (lang: Lang, interval: string) => TF_LABEL[lang][interval] ?? interval;

// "2026-09-25 19:15"
const clock = (ms: number, offsetHours: number) =>
  new Date(ms + offsetHours * HOUR).toISOString().slice(0, 16).replace("T", " ");

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Paragraphs, rendered twice from the same source so the text and the HTML
// part can never say different things
const assemble = (subject: string, paragraphs: string[]): Mail => ({
  subject,
  text: paragraphs.join("\n\n"),
  html: [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;font-size:14px;line-height:1.6;color:#111">',
    ...paragraphs.map((p) => {
      const body = escapeHtml(p).replace(/\n/g, "<br>").replace(escapeHtml(APP_URL), `<a href="${APP_URL}">${APP_URL}</a>`);
      return `<p style="margin:0 0 14px">${body}</p>`;
    }),
    "</div>",
  ].join(""),
});

export const renderSignalMail = (s: FiredSignal, lang: Lang): Mail => {
  const d = decimalsOf(s.pair);
  const px = (v: number) => v.toFixed(d);
  const pips = (v: number) => (Math.abs(v - s.entry) / pipOf(s.pair)).toFixed(1);
  const closeMs = Date.parse(s.closedAt);
  const ev = RSI_SAR_EVIDENCE.byTf[s.interval];
  const all = RSI_SAR_EVIDENCE.all;
  const be = pct(RSI_SAR_EVIDENCE.breakeven.win);
  const tf = tfLabel(lang, s.interval);
  if (lang === "en") {
    const side = s.side === "BUY" ? "BUY" : "SELL";
    const cross = s.side === "BUY" ? `back above ${BUY_LEVEL}` : `back below ${SELL_LEVEL}`;
    const sarSide = s.side === "BUY" ? "below price" : "above price";
    const evidence = ev?.measured
      ? `Tested on past charts (${RSI_SAR_EVIDENCE.period}, ${RSI_SAR_EVIDENCE.pairs} pairs): ${pct(ev.win)}% of ${s.interval} signals won (${ev.winN} signals). Breaking even takes ${be}%, which this rule alone has not reached.`
      : `The ${tf} timeframe was not part of the test. Across the tested timeframes (${RSI_SAR_EVIDENCE.period}, ${RSI_SAR_EVIDENCE.pairs} pairs) ${pct(all.win)}% of signals won (${all.winN} signals); breaking even takes ${be}%, which this rule alone has not reached.`;
    return assemble(`[Sextant] ${s.pair} ${tf} ${side} signal (RSI + Parabolic SAR)`, [
      `A ${side} signal fired on ${s.pair}, ${tf} chart.`,
      [
        `Bar: closed ${clock(closeMs, 0)} UTC (${clock(closeMs, 9)} JST)`,
        `RSI(14): ${s.rsiPrev.toFixed(1)} → ${s.rsi.toFixed(1)} (${cross})`,
        `Parabolic SAR: ${px(s.sar)} (${sarSide})`,
      ].join("\n"),
      [
        "The plan the app would publish at that close:",
        `  Entry ≈ ${px(s.entry)}`,
        `  Stop ${px(s.stop)} (${pips(s.stop)} pips)`,
        `  Target ${px(s.target)} (${pips(s.target)} pips)`,
        `  The stop is ${STOP_ATR} ATR away; the target is ${REWARD_RATIO} times the stop.`,
      ].join("\n"),
      evidence,
      `Prices are the mid of GMO Coin's public bid and ask. The app reads some timeframes from a different feed, so its numbers can differ slightly. Check the latest state in the app before you place an order:\n${APP_URL}`,
      "To stop these emails, open Settings → Email alerts in the app and untick the chart.\nThis is reference information, not investment advice. Every trading decision is your own.",
    ]);
  }
  const side = s.side === "BUY" ? "買い（BUY）" : "売り（SELL）";
  const cross = s.side === "BUY" ? `${BUY_LEVEL} を下から上に抜けました` : `${SELL_LEVEL} を上から下に抜けました`;
  const sarSide = s.side === "BUY" ? "価格の下" : "価格の上";
  const evidence = ev?.measured
    ? `過去のチャートでの検証（${RSI_SAR_EVIDENCE.period}・${RSI_SAR_EVIDENCE.pairs}通貨ペア）: この時間足のサインの勝率は ${pct(ev.win)}%（${ev.winN}回）。損益ゼロに必要な勝率は ${be}% で、このルールだけでは届いていません。`
    : `${tf}は検証していません。検証した時間足の合計（${RSI_SAR_EVIDENCE.period}・${RSI_SAR_EVIDENCE.pairs}通貨ペア）では勝率 ${pct(all.win)}%（${all.winN}回）で、損益ゼロに必要な ${be}% に届いていません。`;
  return assemble(`【Sextant】${s.pair} ${tf} ${side}のサイン（RSI＋パラボリックSAR）`, [
    `${s.pair} の${tf}で${side}のサインが出ました。`,
    [
      `判定した足: ${clock(closeMs, 9)}（日本時間）に確定した足`,
      `RSI(14): ${s.rsiPrev.toFixed(1)} → ${s.rsi.toFixed(1)}（${cross}）`,
      `パラボリックSAR: ${px(s.sar)}（${sarSide}）`,
    ].join("\n"),
    [
      "この終値でアプリが出す注文の目安:",
      `  エントリー ≈ ${px(s.entry)}`,
      `  損切り ${px(s.stop)}（${pips(s.stop)}pips）`,
      `  利確 ${px(s.target)}（${pips(s.target)}pips）`,
      `  損切りは ATR の ${STOP_ATR} 倍、利確は損切り幅の ${REWARD_RATIO} 倍です。`,
    ].join("\n"),
    evidence,
    `価格は GMOコインの公開レート（買値と売値の中間）で判定しています。アプリの分析は時間足によって別の価格配信を使うため、数値が少しずれることがあります。注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
    "この通知を止めるには、アプリの「設定」→「メール通知」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
  ]);
};

export const renderTestMail = (subs: Array<{ pair: string; interval: string }>, lang: Lang): Mail => {
  if (lang === "en") {
    const list = subs.length === 0 ? "none yet" : subs.map((s) => `${s.pair} ${tfLabel("en", s.interval)}`).join(", ");
    return assemble("[Sextant] Test email alert", [
      "This is a test. When the RSI + Parabolic SAR rule fires a BUY or SELL on a chart you follow, the alert arrives at this address.",
      `Charts you follow: ${list}`,
      `Settings → Email alerts in the app:\n${APP_URL}`,
    ]);
  }
  const list = subs.length === 0 ? "まだありません" : subs.map((s) => `${s.pair} ${tfLabel("ja", s.interval)}`).join("、");
  return assemble("【Sextant】メール通知のテスト", [
    "これはテストです。登録したチャートで RSI＋パラボリックSAR の買い（BUY）・売り（SELL）のサインが出ると、このアドレスに届きます。",
    `登録中のチャート: ${list}`,
    `アプリの「設定」→「メール通知」:\n${APP_URL}`,
  ]);
};

// ---- sending ----------------------------------------------------------------------

export const RESEND_URL = "https://api.resend.com/emails";
// Resend's shared sender. It delivers only to the address the Resend account
// was opened with until a domain is verified there; ALERT_FROM overrides it.
export const DEFAULT_FROM = "Sextant <onboarding@resend.dev>";

// Provider errors can quote an address — Resend's "you can only send testing
// emails to your own email address (…)" names the ACCOUNT OWNER's. The row is
// shown to the subscriber, so no address survives into it.
export const redactEmails = (s: string): string => s.replace(/[^\s()<>"',;:]+@[^\s()<>"',;:]+/g, "[email]");

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

export const sendMail = async (
  apiKey: string,
  from: string,
  to: string,
  mail: Mail,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> => {
  try {
    const res = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
      // (absent in the test DOM, always there in Deno)
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(15_000) : undefined,
    });
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (res.ok && body && typeof body.id === "string") return { ok: true, id: body.id };
    const msg = body && typeof body.message === "string" ? body.message : body && typeof body.name === "string" ? body.name : "";
    return { ok: false, error: redactEmails(`${res.status} ${msg}`.trim()).slice(0, 300) };
  } catch (err) {
    return { ok: false, error: redactEmails(err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
};

export { RULE_ID };
