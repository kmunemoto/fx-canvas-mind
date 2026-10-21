import { describe, it, expect } from "vitest";
import { eventId, type EconEvent, type Impact } from "../../supabase/functions/econ-calendar/events.ts";
import {
  DIGEST_SPAN_MS,
  buildDigest,
  digestCurrencies,
  digestDayOf,
  isSpeech,
  pickBig,
  reasonOf,
  renderDigestMail,
  titleJa,
  type DigestReason,
} from "../../supabase/functions/econ-calendar/digest.ts";

// #370: the mail of big scheduled events (docs §8.123)

const ev = (country: string, at: string, title: string, impact: Impact = "Low", extra: Partial<EconEvent> = {}): EconEvent => ({
  id: eventId(country, at, title),
  event_at: at,
  country,
  title,
  impact,
  forecast: null,
  previous: null,
  all_day: false,
  source: "forexfactory",
  ...extra,
});

const OWNER_PAIRS = ["AUD/JPY", "AUD/USD", "EUR/JPY", "EUR/USD", "USD/JPY", "XAU/USD"];

describe("reasonOf: what makes an event big", () => {
  // Forex Factory's own label in the week of 2026-10-19 beside each
  const cases: Array<[string, string, Impact, DigestReason | null]> = [
    // the ones Forex Factory calls Low that moved the owner's pairs
    ["AUD", "RBA Deputy Gov Hauser Speaks", "Low", "central_bank"],
    ["AUD", "RBA Assist Gov Kent Speaks", "Low", "central_bank"],
    ["CNY", "GDP q/y", "Low", "gdp"],
    ["CNY", "1-y Loan Prime Rate", "Low", "central_bank"],
    ["CNY", "5-y Loan Prime Rate", "Low", "central_bank"],
    ["JPY", "National Core CPI y/y", "Low", "prices"],
    // prices
    ["USD", "CPI y/y", "High", "prices"],
    ["USD", "Core PCE Price Index m/m", "High", "prices"],
    ["AUD", "Trimmed Mean CPI m/m", "High", "prices"],
    ["EUR", "CPI Flash Estimate y/y", "Medium", "prices"],
    ["EUR", "Core CPI Flash Estimate y/y", "Medium", "prices"],
    ["EUR", "German Prelim CPI m/m", "Medium", "prices"],
    ["JPY", "Tokyo Core CPI y/y", "Medium", "prices"],
    ["JPY", "BOJ Core CPI y/y", "Low", "prices"],
    ["EUR", "Final CPI y/y", "Low", null],
    ["EUR", "Final Core CPI y/y", "Low", null],
    ["EUR", "French Final CPI m/m", "Low", null],
    // central banks
    ["USD", "Federal Funds Rate", "High", "central_bank"],
    ["USD", "FOMC Statement", "High", "central_bank"],
    ["USD", "FOMC Meeting Minutes", "High", "central_bank"],
    ["USD", "Fed Chairman Warsh Speaks", "High", "central_bank"],
    ["USD", "FOMC Member Barkin Speaks", "Low", "central_bank"],
    ["USD", "Beige Book", "Low", "central_bank"],
    ["USD", "Fed Monetary Policy Report", "Low", "central_bank"],
    ["JPY", "BOJ Policy Rate", "High", "central_bank"],
    ["JPY", "Monetary Policy Statement", "High", "central_bank"],
    ["JPY", "Monetary Policy Meeting Minutes", "Low", "central_bank"],
    ["JPY", "BOJ Summary of Opinions", "Low", "central_bank"],
    ["EUR", "Main Refinancing Rate", "High", "central_bank"],
    ["EUR", "ECB President Lagarde Speaks", "Medium", "central_bank"],
    ["EUR", "German Buba President Nagel Speaks", "Low", "central_bank"],
    ["EUR", "ECB Monetary Policy Meeting Accounts", "Low", "central_bank"],
    ["AUD", "Cash Rate", "High", "central_bank"],
    ["AUD", "RBA Rate Statement", "High", "central_bank"],
    ["AUD", "Monetary Policy Meeting Minutes", "Low", "central_bank"],
    // their reports that do not move a price
    ["EUR", "ECB Economic Bulletin", "Low", null],
    ["EUR", "German Buba Monthly Report", "Low", null],
    ["AUD", "RBA Annual Report", "Low", null],
    ["AUD", "RBA Financial Stability Review", "Low", null],
    // "Federal" is not "Fed"
    ["USD", "Federal Budget Balance", "Low", null],
    // GDP
    ["USD", "Advance GDP q/q", "High", "gdp"],
    ["EUR", "Prelim Flash GDP q/q", "Medium", "gdp"],
    ["USD", "Final GDP Price Index q/q", "Medium", null],
    ["EUR", "Revised GDP q/q", "Low", null],
    // a final print Forex Factory calls High is still listed, as high impact
    ["USD", "Final GDP q/q", "High", "high"],
    // China's activity numbers, China's only
    ["CNY", "Manufacturing PMI", "Low", "china"],
    ["CNY", "Industrial Production y/y", "Low", "china"],
    ["CNY", "Retail Sales y/y", "Low", "china"],
    ["CNY", "RatingDog Manufacturing PMI", "Low", null],
    ["CNY", "Trade Balance", "Low", null],
    ["CNY", "New Home Prices m/m", "Low", null],
    ["JPY", "Retail Sales y/y", "Low", null],
    // High otherwise
    ["USD", "Non-Farm Employment Change", "High", "high"],
    ["AUD", "Employment Change", "High", "high"],
    ["USD", "Retail Sales m/m", "High", "high"],
    // not big
    ["USD", "Unemployment Claims", "Medium", null],
    ["USD", "President Trump Speaks", "Medium", null],
    ["USD", "Treasury Sec Bessent Speaks", "Medium", null],
    ["USD", "Crude Oil Inventories", "Low", null],
    ["AUD", "Flash Manufacturing PMI", "Low", null],
    ["JPY", "Bank Holiday", "Holiday", null],
    ["EUR", "Daylight Saving Time Shift", "Holiday", null],
  ];
  for (const [country, title, impact, want] of cases) {
    it(`${country} ${title} (${impact}) → ${want}`, () => {
      expect(reasonOf({ country, title, impact })).toBe(want);
    });
  }

  it("reads a title with doubled or trailing spaces the same", () => {
    expect(reasonOf({ country: "AUD", title: "  RBA  Deputy Gov Hauser Speaks ", impact: "Low" })).toBe("central_bank");
  });
});

describe("digestCurrencies", () => {
  it("the owner's six: the dollar, the yen, the euro, the Australian dollar, and China for it", () => {
    expect(digestCurrencies(OWNER_PAIRS)).toEqual(["USD", "JPY", "EUR", "AUD", "CNY"]);
  });
  it("gold is its dollar", () => {
    expect(digestCurrencies(["XAU/USD"])).toEqual(["USD"]);
  });
  it("China only beside the Australian or New Zealand dollar", () => {
    expect(digestCurrencies(["GBP/JPY"])).toEqual(["JPY", "GBP"]);
    expect(digestCurrencies(["NZD/USD"])).toEqual(["USD", "NZD", "CNY"]);
    expect(digestCurrencies([])).toEqual([]);
  });
});

describe("pickBig", () => {
  const events = [
    ev("GBP", "2026-10-21T06:00:00Z", "CPI y/y", "High"),
    ev("All", "2026-10-22T09:00:00Z", "G20 Meetings", "High"),
    ev("All", "2026-10-21T09:00:00Z", "IMF Meetings", "Low"),
    ev("USD", "2026-10-22T12:30:00Z", "CPI y/y", "High"),
    ev("AUD", "2026-10-21T23:00:00Z", "RBA Gov Bullock Speaks", "Low"),
    ev("JPY", "2026-10-21T23:00:00Z", "BOJ Gov Ueda Speaks", "Medium"),
  ];
  it("keeps the person's currencies, and Forex Factory's High of everyone's, soonest first", () => {
    const got = pickBig(events, digestCurrencies(OWNER_PAIRS));
    expect(got.map((i) => `${i.event.country} ${i.event.title} ${i.reason}`)).toEqual([
      "AUD RBA Gov Bullock Speaks central_bank",
      "JPY BOJ Gov Ueda Speaks central_bank",
      "All G20 Meetings high",
      "USD CPI y/y prices",
    ]);
  });
  it("leaves out another person's currency", () => {
    expect(pickBig(events, ["GBP"]).map((i) => i.event.title)).toEqual(["CPI y/y", "G20 Meetings"]);
  });
});

describe("digestDayOf: a weekday morning in Japan, 6:00–8:59", () => {
  const cases: Array<[string, string | null]> = [
    ["2026-10-21T21:13:00Z", "2026-10-22"], // Thu 06:13 JST
    ["2026-10-21T21:00:00Z", "2026-10-22"], // Thu 06:00 JST
    ["2026-10-21T20:59:59Z", null], // Thu 05:59 JST
    ["2026-10-21T23:59:59Z", "2026-10-22"], // Thu 08:59 JST
    ["2026-10-22T00:00:00Z", null], // Thu 09:00 JST
    ["2026-10-22T21:13:00Z", "2026-10-23"], // Fri 06:13 JST
    ["2026-10-23T21:13:00Z", null], // Sat 06:13 JST
    ["2026-10-24T21:13:00Z", null], // Sun 06:13 JST
    ["2026-10-25T21:13:00Z", "2026-10-26"], // Mon 06:13 JST
  ];
  for (const [at, want] of cases) {
    it(`${at} → ${want}`, () => {
      expect(digestDayOf(Date.parse(at))).toBe(want);
    });
  }
});

// The week of 2026-10-19 as the feed had it, trimmed, with made-up forecasts
const WEEK = [
  ev("AUD", "2026-10-20T22:30:00Z", "RBA Deputy Gov Hauser Speaks"),
  ev("AUD", "2026-10-21T23:00:00Z", "RBA Gov Bullock Speaks"),
  ev("USD", "2026-10-21T14:30:00Z", "Crude Oil Inventories"),
  ev("All", "2026-10-22T09:00:00Z", "G20 Meetings", "High"),
  ev("USD", "2026-10-22T12:30:00Z", "CPI y/y", "High", { forecast: "3.1%", previous: "3.0%" }),
  ev("USD", "2026-10-22T12:30:00Z", "Unemployment Claims", "Medium", { forecast: "231K", previous: "228K" }),
  ev("AUD", "2026-10-22T22:00:00Z", "Flash Manufacturing PMI"),
  ev("JPY", "2026-10-22T23:30:00Z", "National Core CPI y/y", "Low", { previous: "2.9%" }),
  ev("USD", "2026-10-23T15:00:00Z", "FOMC Member Waller Speaks"),
  ev("USD", "2026-10-23T12:30:00Z", "Core PCE Price Index m/m", "High", { forecast: "0.2%" }),
  ev("EUR", "2026-10-25T01:00:00Z", "Daylight Saving Time Shift", "Holiday", { all_day: true }),
];
const NOW = Date.parse("2026-10-21T21:13:00Z"); // Thu 22 Oct 06:13 JST
const FETCHED = Date.parse("2026-10-21T21:13:00.400Z");

describe("buildDigest", () => {
  const d = buildDigest({ events: WEEK, pairs: OWNER_PAIRS, nowMs: NOW, day: "2026-10-22", fetchedAt: FETCHED });
  it("the next 24 hours from the send", () => {
    expect(d.from).toBe(NOW);
    expect(d.to).toBe(NOW + DIGEST_SPAN_MS);
    expect(d.soon.map((i) => i.event.title)).toEqual(["RBA Gov Bullock Speaks", "G20 Meetings", "CPI y/y"]);
  });
  it("after them the rest of the week, without the speeches", () => {
    expect(d.later.map((i) => i.event.title)).toEqual(["National Core CPI y/y", "Core PCE Price Index m/m"]);
    expect(isSpeech(WEEK[8])).toBe(true);
  });
  it("an event at the window's end goes to the later part, one at its start to the first", () => {
    const edge = buildDigest({
      events: [
        ev("USD", new Date(NOW).toISOString(), "CPI m/m", "High"),
        ev("USD", new Date(NOW + DIGEST_SPAN_MS).toISOString(), "CPI y/y", "High"),
      ],
      pairs: ["USD/JPY"],
      nowMs: NOW,
      day: "2026-10-22",
      fetchedAt: FETCHED,
    });
    expect(edge.soon.map((i) => i.event.title)).toEqual(["CPI m/m"]);
    expect(edge.later.map((i) => i.event.title)).toEqual(["CPI y/y"]);
  });
  it("the feed's last event, big or not, is where the calendar ends", () => {
    expect(d.lastEventAt).toBe(Date.parse("2026-10-25T01:00:00Z"));
  });
});

describe("titleJa", () => {
  const cases: Array<[string, string, string | null]> = [
    ["AUD", "RBA Deputy Gov Hauser Speaks", "RBA の Hauser 副総裁の発言"],
    ["AUD", "RBA Assist Gov Kent Speaks", "RBA の Kent 総裁補佐の発言"],
    ["AUD", "RBA Gov Bullock Speaks", "RBA の Bullock 総裁の発言"],
    ["USD", "Fed Chairman Warsh Speaks", "FRB の Warsh 議長の発言"],
    ["USD", "Fed Chair Warsh Speaks", "FRB の Warsh 議長の発言"],
    ["USD", "FOMC Member Waller Speaks", "FOMC メンバーの Waller 氏の発言"],
    ["EUR", "ECB President Lagarde Speaks", "ECB の Lagarde 総裁の発言"],
    ["EUR", "German Buba President Nagel Speaks", "ドイツ連銀の Nagel 総裁の発言"],
    ["JPY", "BOJ Gov Ueda Speaks", "日銀の Ueda 総裁の発言"],
    ["USD", "President Trump Speaks", null],
    ["USD", "CPI y/y", "消費者物価指数（前年比）"],
    ["USD", "Core CPI m/m", "コア消費者物価指数（前月比）"],
    ["JPY", "National Core CPI y/y", "全国のコア消費者物価指数（前年比）"],
    ["JPY", "Tokyo Core CPI y/y", "東京都区部のコア消費者物価指数（前年比）"],
    ["JPY", "BOJ Core CPI y/y", "日銀のコア消費者物価指数（前年比）"],
    ["AUD", "Trimmed Mean CPI m/m", "トリム平均の消費者物価指数（前月比）"],
    ["AUD", "Monthly CPI Indicator y/y", "月次の消費者物価指数（前年比）"],
    ["EUR", "CPI Flash Estimate y/y", "消費者物価指数の速報（前年比）"],
    ["EUR", "Core CPI Flash Estimate y/y", "コア消費者物価指数の速報（前年比）"],
    ["EUR", "German Prelim CPI m/m", "ドイツの消費者物価指数の速報（前月比）"],
    ["EUR", "Spanish Flash CPI y/y", "スペインの消費者物価指数の速報（前年比）"],
    ["USD", "Core PCE Price Index m/m", "コアPCE物価指数（前月比）"],
    ["USD", "Core PPI m/m", "コア生産者物価指数（前月比）"],
    ["CNY", "GDP q/y", "GDP（前年同期比）"],
    ["USD", "Advance GDP q/q", "GDP の速報（前期比）"],
    ["EUR", "Prelim Flash GDP q/q", "GDP の速報（前期比）"],
    ["EUR", "German Prelim GDP q/q", "ドイツの GDP の速報（前期比）"],
    ["CNY", "Manufacturing PMI", "製造業PMI"],
    ["CNY", "Industrial Production y/y", "鉱工業生産（前年比）"],
    ["CNY", "Retail Sales y/y", "小売売上高（前年比）"],
    ["USD", "Core Retail Sales m/m", "コア小売売上高（前月比）"],
    ["CNY", "1-y Loan Prime Rate", "中国の1年物ローンプライムレート（LPR）"],
    ["JPY", "Monetary Policy Meeting Minutes", "日銀の議事要旨"],
    ["AUD", "Monetary Policy Meeting Minutes", "RBA の議事要旨"],
    ["EUR", "Monetary Policy Statement", "ECB の声明"],
    ["JPY", "Monetary Policy Statement", "日銀の声明"],
    ["USD", "Federal Funds Rate", "FRB の政策金利の発表（FOMC）"],
    ["USD", "Non-Farm Employment Change", "米国の雇用統計（非農業部門雇用者数）"],
    ["All", "G20 Meetings", null],
    ["USD", "Some Event Nobody Named", null],
  ];
  for (const [country, title, want] of cases) {
    it(`${country} ${title}`, () => {
      expect(titleJa({ country, title })).toBe(want);
    });
  }
});

describe("renderDigestMail", () => {
  const d = buildDigest({ events: WEEK, pairs: OWNER_PAIRS, nowMs: NOW, day: "2026-10-22", fetchedAt: FETCHED });

  it("Japanese: the subject, both parts by Japanese day, the notes", () => {
    const m = renderDigestMail(d, "ja", NOW);
    expect(m.subject).toBe("【Sextant】大きな予定 10/22（木）: 今日〜明日の朝 3件");
    const lines = m.text.split("\n");
    expect(lines[0]).toBe("今日〜明日の朝と、今週の残りの、大きな予定です（中央銀行・物価・GDP など）。時刻は日本時間です。");
    expect(lines).toContain("対象の通貨: 米ドル・円・ユーロ・豪ドル・中国（売買のメールのペア: 豪ドル/円・豪ドル/ドル・ユーロ/円・ユーロ/ドル・ドル/円・金。中国は、その数字で豪ドルや NZドルが動くことがあるため）");
    expect(m.text).toContain("止めるには、アプリの「設定」→「メール通知」で1時間足の「MACD の山・谷」のチェックを外してください（売買のメールも止まります）。");
    const soon = lines.indexOf("■ 今日〜明日の朝（10/22（木） 06:13 から24時間）");
    const later = lines.indexOf("■ その先（今週の残り。発言は除く）");
    expect(soon).toBeGreaterThan(-1);
    expect(later).toBeGreaterThan(soon);
    expect(lines.slice(soon + 1, soon + 5)).toEqual([
      "10/22（木）",
      "・08:00 豪ドル【中央銀行】RBA の Bullock 総裁の発言（RBA Gov Bullock Speaks）",
      "・18:00 全体【重要】★ G20 Meetings",
      "・21:30 米ドル【物価】★ 消費者物価指数（前年比）　予想 3.1%・前回 3.0%（CPI y/y）",
    ]);
    expect(lines.slice(later + 1, later + 4)).toEqual([
      "10/23（金）",
      "・08:30 円【物価】全国のコア消費者物価指数（前年比）　前回 2.9%（National Core CPI y/y）",
      "・21:30 米ドル【物価】★ コアPCE物価指数（前月比）　予想 0.2%（Core PCE Price Index m/m）",
    ]);
    expect(m.text).toContain("予定表は今週の分しか出ていません（入っている最後の予定は 10/25（日））。");
    expect(m.text).not.toMatch(/undefined|null|NaN/);
    expect(m.text).not.toContain("※");
    // the HTML part says the same, escaped
    expect(m.html).toContain("・08:00 豪ドル【中央銀行】RBA の Bullock 総裁の発言（RBA Gov Bullock Speaks）<br>");
    expect(m.html).not.toContain("<script");
  });

  it("English: UTC with Japan time, the UTC day", () => {
    const m = renderDigestMail(d, "en", NOW);
    expect(m.subject).toBe("[Sextant] Big scheduled events, Wed 21 Oct: 3 in the next 24 hours");
    const lines = m.text.split("\n");
    const soon = lines.indexOf("■ Next 24 hours (from Wed 21 Oct 21:13 UTC)");
    expect(lines.slice(soon + 1, soon + 6)).toEqual([
      "Wed 21 Oct",
      "- 23:00 UTC (08:00 JST) AUD [Central bank] RBA Gov Bullock Speaks",
      "Thu 22 Oct",
      "- 09:00 UTC (18:00 JST) ALL [High impact] ★ G20 Meetings",
      "- 12:30 UTC (21:30 JST) USD [Prices] ★ CPI y/y (forecast 3.1%, previous 3.0%)",
    ]);
    expect(m.text).toContain("The calendar only covers this week (its last event is on Sun 25 Oct, UTC).");
    expect(m.text).not.toMatch(/undefined|null|NaN/);
  });

  it("a morning with nothing big says so, and is still sent", () => {
    const quiet = buildDigest({ events: [WEEK[2], WEEK[10]], pairs: OWNER_PAIRS, nowMs: NOW, day: "2026-10-22", fetchedAt: FETCHED });
    const m = renderDigestMail(quiet, "ja", NOW);
    expect(m.subject).toBe("【Sextant】大きな予定 10/22（木）: 今日〜明日の朝はなし");
    expect(m.text).toContain("■ 今日〜明日の朝（10/22（木） 06:13 から24時間）\n大きな予定はありません。");
    expect(m.text).toContain("■ その先（今週の残り。発言は除く）\nありません。");
  });

  it("an old feed, and a feed with nothing ahead, are said, in the subject too", () => {
    const old = buildDigest({ events: WEEK, pairs: OWNER_PAIRS, nowMs: NOW, day: "2026-10-22", fetchedAt: NOW - 3 * 3_600_000 - 1 });
    expect(renderDigestMail(old, "ja", NOW).text).toContain("※ 予定表の最後の取り込みは3時間前です。");
    expect(renderDigestMail(old, "ja", NOW).subject).toBe("【Sextant】大きな予定 10/22（木）: 今日〜明日の朝 3件（予定表が古い）");
    expect(renderDigestMail(old, "en", NOW).subject).toBe("[Sextant] Big scheduled events, Wed 21 Oct: 3 in the next 24 hours (old calendar)");
    // two hours old exactly is not old
    const edge = buildDigest({ events: WEEK, pairs: OWNER_PAIRS, nowMs: NOW, day: "2026-10-22", fetchedAt: NOW - 2 * 3_600_000 });
    expect(renderDigestMail(edge, "ja", NOW).subject).toBe("【Sextant】大きな予定 10/22（木）: 今日〜明日の朝 3件");
    const none = buildDigest({ events: [], pairs: OWNER_PAIRS, nowMs: NOW, day: "2026-10-22", fetchedAt: null });
    const t = renderDigestMail(none, "ja", NOW).text;
    expect(t).toContain("※ 予定表を読めませんでした。");
    expect(t).toContain("※ 予定表に、これから先の予定が入っていません。");
    const past = buildDigest({ events: [WEEK[0]], pairs: OWNER_PAIRS, nowMs: NOW, day: "2026-10-22", fetchedAt: FETCHED });
    expect(renderDigestMail(past, "ja", NOW).text).toContain("※ 予定表に、これから先の予定が入っていません。");
    expect(renderDigestMail(past, "ja", NOW).subject).toBe("【Sextant】大きな予定 10/22（木）: 予定表に先の予定が入っていません");
    expect(renderDigestMail(past, "en", NOW).subject).toBe("[Sextant] Big scheduled events, Wed 21 Oct: the calendar holds nothing ahead");
    expect(renderDigestMail(past, "en", NOW).text).toContain("Note: the calendar holds no events from now on");
  });

  it("a time Forex Factory may not have set (its midnight): shown, and called uncertain", () => {
    const tbd = buildDigest({
      events: [ev("USD", "2026-10-22T04:00:00Z", "FOMC Member Waller Speaks", "Low", { all_day: true })],
      pairs: ["USD/JPY"],
      nowMs: NOW,
      day: "2026-10-22",
      fetchedAt: FETCHED,
    });
    expect(renderDigestMail(tbd, "ja", NOW).text).toContain("・13:00（時刻未定かも） 米ドル【中央銀行】FOMC メンバーの Waller 氏の発言（FOMC Member Waller Speaks）");
    expect(renderDigestMail(tbd, "en", NOW).text).toContain("- 04:00 UTC (13:00 JST, maybe no set time) USD [Central bank] FOMC Member Waller Speaks");
  });

  it("China is explained only when it was added for the Australian dollar", () => {
    const usd = buildDigest({ events: WEEK, pairs: ["USD/JPY"], nowMs: NOW, day: "2026-10-22", fetchedAt: FETCHED });
    const t = renderDigestMail(usd, "ja", NOW).text;
    expect(t).toContain("対象の通貨: 米ドル・円（売買のメールのペア: ドル/円）");
    expect(t).not.toContain("中国は");
  });
});
