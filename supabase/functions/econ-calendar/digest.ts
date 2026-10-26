// #370: the big scheduled events, mailed on their own (docs §8.123).
//
// The owner, 2026-10-21: 「別々で送ってください。大きな予定だけのメールを
// ください。」 — not written into the MACD mails, a mail of its own, once each
// weekday morning in Japan.
//
// Forex Factory's impact label alone does not pick the events that moved the
// owner's pairs: in the week of 2026-10-19 it called the RBA deputy and
// assistant governors' speeches, China's GDP and loan prime rates and Japan's
// national core CPI all "Low". So an event is big when it is a consumer-price
// print, central-bank business, a GDP print, one of China's activity numbers,
// or anything Forex Factory itself calls "High" (reasonOf).
//
// Deno-free on purpose: src/test/econ-digest.test.ts imports this file.

import { currenciesOf, type EconEvent } from "./events.ts";
import { APP_URL, assemble, type Lang, type Mail } from "../signal-alerts/logic.ts";
import { pairJa } from "../_shared/pair-names.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const JST_MS = 9 * HOUR;

// Sent on the first econ-calendar run (minute 13 of every hour) inside these
// Japanese hours of a weekday morning: 6:13 normally, 7:13 or 8:13 when the
// earlier runs did not happen
export const DIGEST_FIRST_HOUR_JST = 6;
export const DIGEST_END_HOUR_JST = 9;
// The first section: from the send, this long
export const DIGEST_SPAN_MS = 24 * HOUR;
// A feed older than this is said to be old in the mail
export const DIGEST_STALE_MS = 2 * HOUR;

export type DigestReason = "prices" | "central_bank" | "gdp" | "china" | "high";

export interface DigestItem {
  event: EconEvent;
  reason: DigestReason;
}

const PRICES = /\bCPI\b|\bPCE Price Index\b/;
const FINAL = /\bFinal\b/;
const CENTRAL_BANK_PREFIX = /^(?:Fed|FOMC|BOJ|ECB|RBA|BOE|MPC|BOC|RBNZ|SNB|PBOC|German Buba)\b/;
const CENTRAL_BANK_TITLES: readonly string[] = [
  "Federal Funds Rate",
  "Main Refinancing Rate",
  "Cash Rate",
  "Official Bank Rate",
  "Official Cash Rate",
  "Overnight Rate",
  "1-y Loan Prime Rate",
  "5-y Loan Prime Rate",
  "Monetary Policy Statement",
  "Monetary Policy Summary",
  "Monetary Policy Meeting Minutes",
  "Beige Book",
];
// The central banks' reports that do not move a price: left out
const CENTRAL_BANK_MINOR = /(?:Annual Report|Financial Stability Review|Economic Bulletin|Monthly Report)$/;
const GDP = /\bGDP\b/;
const GDP_LEFT_OUT = /\bGDP Price Index\b|\bFinal\b|\bRevised\b/;
const CHINA_ACTIVITY: readonly string[] = ["Manufacturing PMI", "Industrial Production y/y", "Retail Sales y/y"];
const SPEECH = /\bSpeaks$/;

const tidy = (title: string) => title.trim().replace(/\s+/g, " ");

// Why an event is big, the first of the five that fits (§8.123), or null
export const reasonOf = (e: Pick<EconEvent, "country" | "title" | "impact">): DigestReason | null => {
  if (e.impact === "Holiday") return null;
  const t = tidy(e.title);
  if (PRICES.test(t) && !FINAL.test(t)) return "prices";
  if ((CENTRAL_BANK_PREFIX.test(t) || CENTRAL_BANK_TITLES.includes(t)) && !CENTRAL_BANK_MINOR.test(t)) return "central_bank";
  if (GDP.test(t) && !GDP_LEFT_OUT.test(t)) return "gdp";
  if (e.country.toUpperCase() === "CNY" && CHINA_ACTIVITY.includes(t)) return "china";
  if (e.impact === "High") return "high";
  return null;
};

export const isSpeech = (e: Pick<EconEvent, "title">): boolean => SPEECH.test(tidy(e.title));

// The order the currencies are listed in; any other after them, alphabetically
const CURRENCY_ORDER: readonly string[] = ["USD", "JPY", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "CNY"];
const rank = (c: string) => {
  const i = CURRENCY_ORDER.indexOf(c);
  return i < 0 ? CURRENCY_ORDER.length : i;
};

// The currencies of the pairs someone follows. Gold is its dollar; China joins
// the Australian or New Zealand dollar, which its numbers move.
export const digestCurrencies = (pairs: readonly string[]): string[] => {
  const set = new Set<string>();
  for (const pair of pairs) for (const c of currenciesOf(pair)) if (!c.startsWith("X")) set.add(c);
  if (set.has("AUD") || set.has("NZD")) set.add("CNY");
  return [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
};

// The big events of these currencies, soonest first. "All" (everyone's)
// only when Forex Factory calls it High.
export const pickBig = (events: readonly EconEvent[], currencies: readonly string[]): DigestItem[] => {
  const out: DigestItem[] = [];
  for (const event of events) {
    const country = event.country.toUpperCase();
    if (country === "ALL") {
      if (event.impact === "High") out.push({ event, reason: "high" });
      continue;
    }
    if (!currencies.includes(country)) continue;
    const reason = reasonOf(event);
    if (reason !== null) out.push({ event, reason });
  }
  return out.sort(
    (a, b) =>
      Date.parse(a.event.event_at) - Date.parse(b.event.event_at) ||
      a.event.country.localeCompare(b.event.country) ||
      a.event.title.localeCompare(b.event.title),
  );
};

// The Japanese date (YYYY-MM-DD) whose morning mail is due at this moment, or
// null outside a weekday's 6:00–8:59 in Japan
export const digestDayOf = (nowMs: number): string | null => {
  const jst = new Date(nowMs + JST_MS);
  const dow = jst.getUTCDay();
  const hour = jst.getUTCHours();
  if (dow === 0 || dow === 6) return null;
  if (hour < DIGEST_FIRST_HOUR_JST || hour >= DIGEST_END_HOUR_JST) return null;
  return jst.toISOString().slice(0, 10);
};

export interface Digest {
  // the Japanese date of the morning
  day: string;
  // the first section's window: [from, to)
  from: number;
  to: number;
  soon: DigestItem[];
  // from `to` on, speeches left out
  later: DigestItem[];
  currencies: string[];
  pairs: string[];
  // when the feed the events came from was fetched, and its last event
  fetchedAt: number | null;
  lastEventAt: number | null;
}

export const buildDigest = (args: {
  events: readonly EconEvent[];
  pairs: readonly string[];
  nowMs: number;
  day: string;
  fetchedAt: number | null;
}): Digest => {
  const currencies = digestCurrencies(args.pairs);
  const from = args.nowMs;
  const to = from + DIGEST_SPAN_MS;
  const big = pickBig(args.events, currencies);
  const at = (i: DigestItem) => Date.parse(i.event.event_at);
  const times = args.events.map((e) => Date.parse(e.event_at)).filter(Number.isFinite);
  return {
    day: args.day,
    from,
    to,
    soon: big.filter((i) => at(i) >= from && at(i) < to),
    later: big.filter((i) => at(i) >= to && !isSpeech(i.event)),
    currencies,
    pairs: [...args.pairs],
    fetchedAt: args.fetchedAt,
    lastEventAt: times.length > 0 ? Math.max(...times) : null,
  };
};

// ---- names ---------------------------------------------------------------

const CURRENCY_JA: Readonly<Record<string, string>> = {
  USD: "米ドル", JPY: "円", EUR: "ユーロ", AUD: "豪ドル", CNY: "中国", GBP: "ポンド", NZD: "NZドル",
  CAD: "カナダドル", CHF: "スイスフラン", ALL: "全体",
};
const currencyJa = (c: string) => CURRENCY_JA[c.toUpperCase()] ?? c;

const REASON_JA: Readonly<Record<DigestReason, string>> = {
  prices: "物価", central_bank: "中央銀行", gdp: "GDP", china: "中国の景気", high: "重要",
};
const REASON_EN: Readonly<Record<DigestReason, string>> = {
  prices: "Prices", central_bank: "Central bank", gdp: "GDP", china: "China activity", high: "High impact",
};

// with its particle, so a Latin name keeps a space before it and a Japanese one does not
const BANK_JA: Readonly<Record<string, string>> = {
  USD: "FRB の", JPY: "日銀の", EUR: "ECB の", AUD: "RBA の", GBP: "英中銀の", CNY: "中国人民銀行の",
  CAD: "カナダ中銀の", NZD: "RBNZ の", CHF: "スイス中銀の",
};

// Who speaks, as Forex Factory writes it before "Speaks"
const SPEAKERS: ReadonlyArray<[RegExp, (name: string) => string]> = [
  [/^Fed Chair(?:man)? (.+)$/, (n) => `FRB の ${n} 議長`],
  [/^Fed Vice Chair for Supervision (.+)$/, (n) => `FRB の ${n} 副議長（金融監督）`],
  [/^Fed Vice Chair (.+)$/, (n) => `FRB の ${n} 副議長`],
  [/^FOMC Member (.+)$/, (n) => `FOMC メンバーの ${n} 氏`],
  [/^BOJ Gov (.+)$/, (n) => `日銀の ${n} 総裁`],
  [/^BOJ Deputy Gov (.+)$/, (n) => `日銀の ${n} 副総裁`],
  [/^ECB President (.+)$/, (n) => `ECB の ${n} 総裁`],
  [/^ECB Vice President (.+)$/, (n) => `ECB の ${n} 副総裁`],
  [/^ECB Chief Economist (.+)$/, (n) => `ECB の ${n} チーフエコノミスト`],
  [/^RBA Gov (.+)$/, (n) => `RBA の ${n} 総裁`],
  [/^RBA Deputy Gov (.+)$/, (n) => `RBA の ${n} 副総裁`],
  [/^RBA Assist Gov (.+)$/, (n) => `RBA の ${n} 総裁補佐`],
  [/^German Buba President (.+)$/, (n) => `ドイツ連銀の ${n} 総裁`],
  [/^BOE Gov (.+)$/, (n) => `英中銀の ${n} 総裁`],
  [/^MPC Member (.+)$/, (n) => `英中銀の金融政策委員 ${n} 氏`],
  [/^PBOC Gov (.+)$/, (n) => `中国人民銀行の ${n} 総裁`],
];

// Whole names, some read with the country's central bank (BANK_JA)
const TITLES_JA: Readonly<Record<string, (country: string) => string>> = {
  "Federal Funds Rate": () => "FRB の政策金利の発表（FOMC）",
  "FOMC Statement": () => "FOMC の声明",
  "FOMC Press Conference": () => "FRB 議長の記者会見（FOMC のあと）",
  "FOMC Economic Projections": () => "FOMC の経済見通し",
  "FOMC Meeting Minutes": () => "FOMC の議事要旨",
  "Beige Book": () => "ベージュブック（FRB の地区ごとの景気報告）",
  "BOJ Policy Rate": () => "日銀の政策金利の発表",
  "BOJ Press Conference": () => "日銀総裁の記者会見",
  "BOJ Outlook Report": () => "日銀の展望レポート",
  "BOJ Summary of Opinions": () => "日銀の「主な意見」",
  "Main Refinancing Rate": () => "ECB の政策金利の発表",
  "ECB Press Conference": () => "ECB 総裁の記者会見",
  "ECB Monetary Policy Meeting Accounts": () => "ECB の議事要旨",
  "Cash Rate": () => "RBA の政策金利の発表",
  "RBA Rate Statement": () => "RBA の声明",
  "RBA Press Conference": () => "RBA 総裁の記者会見",
  "RBA Monetary Policy Statement": () => "RBA の金融政策報告",
  "Official Bank Rate": () => "英中銀の政策金利の発表",
  "1-y Loan Prime Rate": () => "中国の1年物ローンプライムレート（LPR）",
  "5-y Loan Prime Rate": () => "中国の5年物ローンプライムレート（LPR）",
  "Monetary Policy Statement": (c) => `${BANK_JA[c] ?? "中央銀行の"}声明`,
  "Monetary Policy Summary": (c) => `${BANK_JA[c] ?? "中央銀行の"}声明`,
  "Monetary Policy Meeting Minutes": (c) => `${BANK_JA[c] ?? "中央銀行の"}議事要旨`,
  "Non-Farm Employment Change": () => "米国の雇用統計（非農業部門雇用者数）",
  "Unemployment Rate": () => "失業率",
  "Employment Change": () => "雇用者数の増減",
  "Average Hourly Earnings m/m": () => "平均時給（前月比）",
  "Unemployment Claims": () => "新規失業保険申請件数",
  "ISM Manufacturing PMI": () => "ISM 製造業景況指数",
  "ISM Services PMI": () => "ISM 非製造業景況指数",
};

// Numbers: [country] [kind...] main [period], e.g. "German Prelim CPI m/m"
const PLACE_JA: ReadonlyArray<[string, string]> = [
  ["German ", "ドイツの"], ["French ", "フランスの"], ["Italian ", "イタリアの"], ["Spanish ", "スペインの"],
  ["Tokyo ", "東京都区部の"], ["National ", "全国の"], ["BOJ ", "日銀の"],
];
const EARLY: readonly string[] = ["Prelim Flash ", "Prelim ", "Flash ", "Advance "];
const MAIN_JA: ReadonlyArray<[string, string, boolean]> = [
  // [name, Japanese, is itself the early print]
  ["CPI Flash Estimate", "消費者物価指数", true],
  ["Monthly CPI Indicator", "月次の消費者物価指数", false],
  ["PCE Price Index", "PCE物価指数", false],
  ["CPI", "消費者物価指数", false],
  ["PPI", "生産者物価指数", false],
  ["GDP", "GDP", false],
  ["Manufacturing PMI", "製造業PMI", false],
  ["Industrial Production", "鉱工業生産", false],
  ["Retail Sales", "小売売上高", false],
];
const PERIOD_JA: Readonly<Record<string, string>> = {
  "m/m": "前月比", "y/y": "前年比", "q/q": "前期比", "q/y": "前年同期比",
};

const numberJa = (title: string): string | null => {
  let rest = title;
  let place = "";
  for (const [en, ja] of PLACE_JA) {
    if (rest.startsWith(en)) {
      place = ja;
      rest = rest.slice(en.length);
      break;
    }
  }
  let early = false;
  for (const en of EARLY) {
    if (rest.startsWith(en)) {
      early = true;
      rest = rest.slice(en.length);
      break;
    }
  }
  let kind = "";
  if (rest.startsWith("Core ")) {
    kind = "コア";
    rest = rest.slice("Core ".length);
  } else if (rest.startsWith("Trimmed Mean ")) {
    kind = "トリム平均の";
    rest = rest.slice("Trimmed Mean ".length);
  }
  let period = "";
  const m = /^(.*) (m\/m|y\/y|q\/q|q\/y)$/.exec(rest);
  if (m) {
    rest = m[1];
    period = PERIOD_JA[m[2]];
  }
  const main = MAIN_JA.find(([en]) => en === rest);
  if (!main) return null;
  // a Latin name keeps a space from the Japanese before it (ドイツの GDP)
  const gap = place !== "" && kind === "" && /^[A-Z]/.test(main[1]) ? " " : "";
  const name = `${place}${gap}${kind}${main[1]}${early || main[2] ? (main[1] === "GDP" ? " の速報" : "の速報") : ""}`;
  return period ? `${name}（${period}）` : name;
};

// The Japanese for a Forex Factory name, or null when there is none (the
// mail then shows the name as it is)
export const titleJa = (e: Pick<EconEvent, "country" | "title">): string | null => {
  const t = tidy(e.title);
  const country = e.country.toUpperCase();
  const whole = TITLES_JA[t];
  if (whole) return whole(country);
  const speech = /^(.+) Speaks$/.exec(t);
  if (speech) {
    for (const [re, say] of SPEAKERS) {
      const m = re.exec(speech[1]);
      if (m) return `${say(m[1])}の発言`;
    }
    return null;
  }
  return numberJa(t);
};

// ---- the mail -------------------------------------------------------------

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 10/22（木）
const dayJa = (ms: number) => {
  const d = new Date(ms + JST_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY_JA[d.getUTCDay()]}）`;
};
// Thu 22 Oct
const dayEn = (ms: number) => {
  const d = new Date(ms);
  return `${WEEKDAY_EN[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_EN[d.getUTCMonth()]}`;
};
const hm = (ms: number, offsetMs: number) => new Date(ms + offsetMs).toISOString().slice(11, 16);

const consensusJa = (e: EconEvent) =>
  [e.forecast ? `予想 ${e.forecast}` : "", e.previous ? `前回 ${e.previous}` : ""].filter(Boolean).join("・");
const consensusEn = (e: EconEvent) =>
  [e.forecast ? `forecast ${e.forecast}` : "", e.previous ? `previous ${e.previous}` : ""].filter(Boolean).join(", ");

// Forex Factory stamps an event without a set time at midnight in its own zone (events.ts all_day); a release
// really at that midnight looks the same, so the time is shown and called uncertain
const lineJa = (i: DigestItem): string => {
  const e = i.event;
  const at = Date.parse(e.event_at);
  const when = e.all_day ? `${hm(at, JST_MS)}（時刻未定かも）` : hm(at, JST_MS);
  const star = e.impact === "High" ? "★ " : "";
  const ja = titleJa(e);
  const consensus = consensusJa(e);
  const tail = consensus ? `\u3000${consensus}` : "";
  // the Japanese name, the forecast, then Forex Factory's own name to look it up by
  const name = ja === null ? `${tidy(e.title)}${tail}` : `${ja}${tail}（${tidy(e.title)}）`;
  return `・${when} ${currencyJa(e.country)}【${REASON_JA[i.reason]}】${star}${name}`;
};

const lineEn = (i: DigestItem): string => {
  const e = i.event;
  const at = Date.parse(e.event_at);
  const when = `${hm(at, 0)} UTC (${hm(at, JST_MS)} JST${e.all_day ? ", maybe no set time" : ""})`;
  const star = e.impact === "High" ? " ★" : "";
  const consensus = consensusEn(e);
  return `- ${when} ${e.country.toUpperCase()} [${REASON_EN[i.reason]}]${star} ${tidy(e.title)}${consensus ? ` (${consensus})` : ""}`;
};

// Lines under a heading for each day (the Japanese day in Japanese, the UTC
// day in English)
const byDay = (items: readonly DigestItem[], lang: Lang): string[] => {
  const out: string[] = [];
  let last = "";
  for (const i of items) {
    const at = Date.parse(i.event.event_at);
    const day = lang === "ja" ? dayJa(at) : dayEn(at);
    if (day !== last) {
      out.push(day);
      last = day;
    }
    out.push(lang === "ja" ? lineJa(i) : lineEn(i));
  }
  return out;
};

const hoursAgo = (fromMs: number, toMs: number) => Math.floor((toMs - fromMs) / HOUR);

export const renderDigestMail = (d: Digest, lang: Lang, nowMs: number): Mail => {
  const stale = d.fetchedAt === null || nowMs - d.fetchedAt > DIGEST_STALE_MS;
  const noFuture = d.lastEventAt === null || d.lastEventAt < d.from;
  const chinaForAud = d.currencies.includes("CNY") && !d.pairs.some((p) => currenciesOf(p).includes("CNY"));
  if (lang === "ja") {
    const n = d.soon.length;
    const subject = noFuture
      ? `【Sextant】大きな予定 ${dayJa(d.from)}: 予定表に先の予定が入っていません`
      : `【Sextant】大きな予定 ${dayJa(d.from)}: 今日〜明日の朝${n > 0 ? ` ${n}件` : "はなし"}${stale ? "（予定表が古い）" : ""}`;
    const soonHead = `■ 今日〜明日の朝（${dayJa(d.from)} ${hm(d.from, JST_MS)} から24時間）`;
    const laterHead = "■ その先（今週の残り。発言は除く）";
    const notes = [
      "【】は選んだ理由、★ は Forex Factory の重要度が「高」のものです。最後の（）は Forex Factory の名前です。予想・前回は Forex Factory の値で、取り込んだ時点のものです。時刻や予想は変わることがあります。結果の数字は、このメールには載りません。",
      d.lastEventAt === null
        ? "予定表は今週の分しか出ていません。"
        : `予定表は今週の分しか出ていません（入っている最後の予定は ${dayJa(d.lastEventAt)}）。その先の予定は、次の週のメールに載ります。`,
      ...(stale
        ? [
          d.fetchedAt === null
            ? "※ 予定表を読めませんでした。大きな予定が載っていないかもしれません。"
            : `※ 予定表の最後の取り込みは${hoursAgo(d.fetchedAt, nowMs)}時間前です。新しく入った予定や、時刻の変更が抜けているかもしれません。`,
        ]
        : []),
      ...(noFuture ? ["※ 予定表に、これから先の予定が入っていません。週の切り替わりの前か、取り込みの不具合です。"] : []),
    ].join("\n");
    return assemble(subject, [
      `今日〜明日の朝と、今週の残りの、大きな予定です（中央銀行・物価・GDP など）。時刻は日本時間です。\n対象の通貨: ${d.currencies.map(currencyJa).join("・")}（売買のメールのペア: ${d.pairs.map(pairJa).join("・")}${chinaForAud ? "。中国は、その数字で豪ドルや NZドルが動くことがあるため" : ""}）`,
      n > 0 ? [soonHead, ...byDay(d.soon, "ja")].join("\n") : `${soonHead}\n大きな予定はありません。`,
      d.later.length > 0 ? [laterHead, ...byDay(d.later, "ja")].join("\n") : `${laterHead}\nありません。`,
      notes,
      `このメールは、売買のメール（MACD の山・谷）を受け取っている方に、日本時間の平日の朝に1通送っています。選び方: 物価（CPI など）・中央銀行（政策金利・声明・会見・議事要旨・発言）・GDP・中国の景気の数字・Forex Factory の重要度が「高」のもの。このメールだけを止める画面のスイッチはまだありません。止めるには、アプリの「設定」→「メール通知」で「MACD の山・谷」のチェックを外してください（売買のメールも止まります）。\n${APP_URL}`,
      "本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
    ]);
  }
  const n = d.soon.length;
  const subject = noFuture
    ? `[Sextant] Big scheduled events, ${dayEn(d.from)}: the calendar holds nothing ahead`
    : `[Sextant] Big scheduled events, ${dayEn(d.from)}: ${n > 0 ? n : "none"} in the next 24 hours${stale ? " (old calendar)" : ""}`;
  const soonHead = `■ Next 24 hours (from ${dayEn(d.from)} ${hm(d.from, 0)} UTC)`;
  const laterHead = "■ Later this week (speeches left out)";
  const notes = [
    "[ ] is why it is listed; ★ marks what Forex Factory calls high impact. Forecasts and previous figures are Forex Factory's, as fetched; times and forecasts can change. The results are not in this email.",
    d.lastEventAt === null
      ? "The calendar only covers this week."
      : `The calendar only covers this week (its last event is on ${dayEn(d.lastEventAt)}, UTC). Later events come in the next week's emails.`,
    ...(stale
      ? [
        d.fetchedAt === null
          ? "Note: the calendar could not be read. Events may be missing."
          : `Note: the calendar was last fetched ${hoursAgo(d.fetchedAt, nowMs)} hours ago. New events or changed times may be missing.`,
      ]
      : []),
    ...(noFuture ? ["Note: the calendar holds no events from now on: the week has not turned yet, or the fetch is failing."] : []),
  ].join("\n");
  return assemble(subject, [
    `The big scheduled events (central banks, prices, GDP and the like) for the next 24 hours and the rest of the week. Times are UTC, with Japan time in brackets.\nCurrencies: ${d.currencies.join(", ")} (from your trade emails' pairs: ${d.pairs.join(", ")}${chinaForAud ? "; CNY because China's numbers can move AUD and NZD" : ""})`,
    n > 0 ? [soonHead, ...byDay(d.soon, "en")].join("\n") : `${soonHead}\nNo big events.`,
    d.later.length > 0 ? [laterHead, ...byDay(d.later, "en")].join("\n") : `${laterHead}\nNone.`,
    notes,
    `This email goes to those who receive the trade emails (MACD peak/valley), once each weekday morning in Japan. Listed: prices (CPI and the like), central banks (rates, statements, press conferences, minutes, speeches), GDP, China's activity numbers, and what Forex Factory calls high impact. There is no switch for this email alone yet: unticking "MACD peak/valley" under Settings → Email alerts stops it, and the trade emails too.\n${APP_URL}`,
    "This email is for information only and is not investment advice. Every trading decision is your own.",
  ]);
};
