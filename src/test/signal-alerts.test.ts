import { describe, it, expect } from "vitest";
import {
  ALERT_BARS,
  DEFAULT_FROM,
  FRESH_MS,
  STEP_MS,
  alertsAllowed,
  checkPair,
  closedMidBars,
  fetchAlertQuotes,
  fetchYearQuotes,
  freshSignals,
  mayHaveFreshClose,
  redactEmails,
  renderSignalMail,
  renderTestMail,
  sendMail,
  type FiredSignal,
} from "../../supabase/functions/signal-alerts/logic";
import { readRsiSar, REWARD_RATIO, STOP_ATR } from "../../supabase/functions/analyze/rsisar";
import { costlyHourAt } from "../../supabase/functions/analyze/timing";
import type { Candle } from "../../supabase/functions/analyze/indicators";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import { isPossiblyClosed } from "../../supabase/functions/_shared/market-hours";

const MIN = 60_000;

const rng = (seed: number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
// Closed bars of `stepMs`, the newest opening at `lastOpenMs`
const walk = (n: number, seed: number, stepMs: number, lastOpenMs: number): Candle[] => {
  const r = rng(seed);
  const out: Candle[] = [];
  let px = 150;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = o + (r() - 0.5) * 0.2;
    out.push({
      datetime: stamp(lastOpenMs - (n - 1 - i) * stepMs),
      open: o,
      high: Math.max(o, px) + r() * 0.05,
      low: Math.min(o, px) - r() * 0.05,
      close: px,
    });
  }
  return out;
};

// The first prefix of a walk on which the rule fires on the newest bar
const firingPrefix = (bars: Candle[]): Candle[] => {
  for (let cut = 120; cut < bars.length; cut++) {
    const part = bars.slice(0, cut + 1);
    if (readRsiSar(part).now?.signal) return part;
  }
  throw new Error("the rule never fired");
};

describe("which charts a run looks at", () => {
  it("15min every run; 1h and coarser only in the first minutes of the hour", () => {
    const base = Date.parse("2026-09-24T10:00:00Z");
    for (const m of [2, 17, 32, 47]) expect(mayHaveFreshClose("15min", base + m * MIN)).toBe(true);
    for (const tf of ["1h", "4h", "1day"]) {
      expect(mayHaveFreshClose(tf, base + 2 * MIN)).toBe(true);
      expect(mayHaveFreshClose(tf, base + 17 * MIN)).toBe(true);
      expect(mayHaveFreshClose(tf, base + 32 * MIN)).toBe(false);
      expect(mayHaveFreshClose(tf, base + 47 * MIN)).toBe(false);
    }
    expect(mayHaveFreshClose("1min", base)).toBe(false);
  });
});

describe("the bars the rule reads", () => {
  it("are the closed ones, at the mid of bid and ask", () => {
    const now = Date.parse("2026-09-24T10:02:00Z");
    const q = (openMs: number, bid: number): QuoteCandle => ({
      datetime: new Date(openMs).toISOString(),
      bid: { datetime: "", open: bid, high: bid + 0.1, low: bid - 0.1, close: bid },
      ask: { datetime: "", open: bid + 0.02, high: bid + 0.12, low: bid - 0.08, close: bid + 0.02 },
    });
    const quotes = [q(now - 32 * MIN, 150), q(now - 17 * MIN, 151), q(now - 2 * MIN, 152)];
    const closed = closedMidBars(quotes, "15min", now);
    // the bar that opened two minutes ago is still forming
    expect(closed).toHaveLength(2);
    expect(closed[1].close).toBeCloseTo(151.01, 10);
    expect(closed[1].datetime).toBe("2026-09-24 09:45:00");
  });
});

describe("a fresh signal", () => {
  const step = STEP_MS["15min"];
  // the newest bar opens 09:45 and closes 10:00 UTC
  const bars = firingPrefix(walk(3000, 5, step, Date.parse("2026-09-24T09:45:00Z")));
  // relabel so the newest bar still closes at 10:00
  const relabel = (b: Candle[], lastOpenMs: number) => b.map((c, i) => ({ ...c, datetime: stamp(lastOpenMs - (b.length - 1 - i) * step) }));
  const read = readRsiSar(relabel(bars, Date.parse("2026-09-24T09:45:00Z")));
  const closeMs = Date.parse("2026-09-24T10:00:00Z");

  it("is mailed from the close until FRESH_MS after it, and not outside that", () => {
    expect(freshSignals("USD/JPY", "15min", read, closeMs + 2 * MIN)).toHaveLength(1);
    expect(freshSignals("USD/JPY", "15min", read, closeMs + FRESH_MS)).toHaveLength(1);
    expect(freshSignals("USD/JPY", "15min", read, closeMs + FRESH_MS + 1)).toHaveLength(0);
    expect(freshSignals("USD/JPY", "15min", read, closeMs - 1)).toHaveLength(0);
  });

  it("carries the plan the app would publish at that close", () => {
    const [s] = freshSignals("USD/JPY", "15min", read, closeMs + 2 * MIN);
    const now = read.now!;
    expect(s.side).toBe(now.signal);
    expect(s.barTime).toBe("2026-09-24T09:45:00.000Z");
    expect(s.closedAt).toBe("2026-09-24T10:00:00.000Z");
    expect(s.entry).toBe(now.close);
    const dir = s.side === "BUY" ? 1 : -1;
    expect((s.entry - s.stop) * dir).toBeCloseTo(STOP_ATR * now.atr, 10);
    expect((s.target - s.entry) * dir).toBeCloseTo(STOP_ATR * now.atr * REWARD_RATIO, 10);
    expect(s.rsi).toBe(now.rsi);
    expect(s.rsiPrev).toBe(now.rsiPrev);
  });

  it("a run that missed the close still mails it once the next bar has closed", () => {
    // one more bar on top that does not fire
    const withNext = relabel([...bars, { ...bars[bars.length - 1], datetime: "" }], Date.parse("2026-09-24T10:00:00Z"));
    const later = readRsiSar(withNext);
    const got = freshSignals("USD/JPY", "15min", later, closeMs + 17 * MIN);
    expect(got.some((s) => s.closedAt === "2026-09-24T10:00:00.000Z")).toBe(true);
  });

  it("is flagged when it closes in the hours the app will not publish in", () => {
    const evening = readRsiSar(relabel(bars, Date.parse("2026-09-24T18:45:00Z")));
    const [late] = freshSignals("USD/JPY", "15min", evening, Date.parse("2026-09-24T19:02:00Z"));
    expect(late.costly).toBe(true);
    expect(costlyHourAt("15min", Date.parse(late.closedAt))).toBe(true);
    const [day] = freshSignals("USD/JPY", "15min", read, closeMs + 2 * MIN);
    expect(day.costly).toBe(false);
  });
});

describe("who may follow a chart", () => {
  it("Pro and the admins, nobody else", () => {
    expect(alertsAllowed("pro", "someone@example.com")).toBe(true);
    expect(alertsAllowed("PRO", null)).toBe(true);
    expect(alertsAllowed("standard", "someone@example.com")).toBe(false);
    expect(alertsAllowed("light", "someone@example.com")).toBe(false);
    expect(alertsAllowed(null, null)).toBe(false);
    expect(alertsAllowed("free", "K.Munemoto@kyoto-salute.com")).toBe(true);
    expect(alertsAllowed(undefined, "munekan2989@gmail.com")).toBe(true);
  });
});

// ---- the feed -------------------------------------------------------------------------

type Row = { openTime: string; open: string; high: string; low: string; close: string };
const klines = (bars: Array<{ t: number; c: number }>, spread: number): { status: number; data: Row[] } => ({
  status: 0,
  data: bars.map((b) => ({
    openTime: String(b.t),
    open: String(b.c + spread),
    high: String(b.c + spread + 0.05),
    low: String(b.c + spread - 0.05),
    close: String(b.c + spread),
  })),
});

describe("the year-keyed feed (4h, 1day)", () => {
  it("reaches into last year's file while this year's is too short", async () => {
    const now = Date.parse("2026-01-20T12:00:00Z");
    const step = STEP_MS["1day"];
    const days = (from: number, to: number) => {
      const out: Array<{ t: number; c: number }> = [];
      for (let t = from; t < to; t += step) {
        const d = new Date(t).getUTCDay();
        if (d !== 6 && d !== 0) out.push({ t, c: 150 + (t % 7) / 100 });
      }
      return out;
    };
    const y2026 = days(Date.parse("2025-12-31T21:00:00Z"), now);
    const y2025 = days(Date.parse("2024-12-31T21:00:00Z"), Date.parse("2025-12-31T21:00:00Z"));
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      const year = url.match(/date=(\d+)/)![1];
      const rows = year === "2026" ? y2026 : year === "2025" ? y2025 : [];
      return klines(rows, url.includes("priceType=ASK") ? 0.01 : 0);
    };
    const got = await fetchYearQuotes("USD/JPY", "1day", ALERT_BARS + 1, now, fetcher);
    expect(got).not.toBeNull();
    expect(got!.length).toBe(ALERT_BARS + 1);
    expect(urls.some((u) => u.includes("date=2025"))).toBe(true);
    expect(urls.every((u) => u.includes("interval=1day"))).toBe(true);
    // one year was enough later in the year
    urls.length = 0;
    const lateNow = Date.parse("2025-12-20T12:00:00Z");
    await fetchYearQuotes("USD/JPY", "1day", 100, lateNow, async (url) => {
      urls.push(url);
      return klines(url.includes("date=2025") ? y2025.filter((b) => b.t < lateNow) : [], url.includes("ASK") ? 0.01 : 0);
    });
    expect(urls.every((u) => u.includes("date=2025"))).toBe(true);
  });

  it("1min is not a chart anyone can follow", async () => {
    expect(await fetchAlertQuotes("USD/JPY", "1min", Date.now(), Date.now() + 1000, async () => null)).toBeNull();
  });
});

describe("one chart, from the feed to the rule", () => {
  it("reads the closed bars and reports the signal on the bar that just closed", async () => {
    const step = STEP_MS["1h"];
    const lastOpen = Date.parse("2026-09-24T09:00:00Z");
    const prefix = firingPrefix(walk(3000, 9, step, lastOpen));
    // Open-market hours only, newest first back from 09:00: the feed drops
    // bars inside the weekend, and the rule must read the same bars here
    const hours: number[] = [];
    for (let t = lastOpen; hours.length < prefix.length; t -= step) if (!isPossiblyClosed(t)) hours.unshift(t);
    const closed = prefix.map((c, i) => ({ ...c, datetime: stamp(hours[i]) }));
    // the firing bar is the one that opened 09:00; the forming 10:00 bar is added on top
    const bars = closed.map((c, i) => ({ ...c, t: hours[i] }));
    const forming = { ...bars[bars.length - 1], t: lastOpen + step };
    const all = [...bars, forming];
    const now = lastOpen + step + 2 * MIN;
    const fetcher = async (url: string) => {
      const key = url.match(/date=(\d{8})/)![1];
      const ask = url.includes("priceType=ASK");
      const inDay = all.filter((b) => new Date(b.t + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "") === key);
      return {
        status: 0,
        data: inDay.map((b) => ({
          openTime: String(b.t),
          open: String(b.open + (ask ? 0.01 : 0)),
          high: String(b.high + (ask ? 0.01 : 0)),
          low: String(b.low + (ask ? 0.01 : 0)),
          close: String(b.close + (ask ? 0.01 : 0)),
        })),
      };
    };
    const r = await checkPair("USD/JPY", "1h", now, Date.now() + 60_000, fetcher);
    expect(r.bars).toBeGreaterThanOrEqual(60);
    // the forming bar was left out, so the newest read bar is the one that fired
    expect(r.read!.now!.datetime).toBe("2026-09-24 09:00:00");
    expect(r.signals.map((s) => s.closedAt)).toContain("2026-09-24T10:00:00.000Z");
    expect(r.signals[r.signals.length - 1].side).toBe(readRsiSar(closed).now!.signal);
  });
});

// ---- the email -----------------------------------------------------------------------------

const sample = (over: Partial<FiredSignal> = {}): FiredSignal => ({
  pair: "USD/JPY",
  interval: "15min",
  side: "BUY",
  barTime: "2026-09-24T09:45:00.000Z",
  closedAt: "2026-09-24T10:00:00.000Z",
  entry: 149.5,
  stop: 149.42,
  target: 149.62,
  rsi: 31.4,
  rsiPrev: 28.9,
  sar: 149.31,
  atr: 0.1,
  costly: false,
  ...over,
});

describe("the email", () => {
  it("says what fired, when, the plan and what the rule was measured at", () => {
    const m = renderSignalMail(sample(), "ja");
    expect(m.subject).toContain("USD/JPY");
    expect(m.subject).toContain("15分足");
    expect(m.subject).toContain("買い（BUY）");
    expect(m.text).toContain("2026-09-24 19:00（日本時間）に確定した足");
    expect(m.text).toContain("RSI(14): 28.9 → 31.4");
    expect(m.text).toContain("エントリー ≈ 149.500");
    // #111: 0.08 yen a unit is 800 yen per 10,000
    expect(m.text).toContain("損切り 149.420（8.0pips・1万通貨で ¥800 の損失）");
    expect(m.text).toContain("利確 149.620（12.0pips）");
    expect(m.text).toContain("勝率は 35%（885回）");
    expect(m.text).toContain("損益ゼロに必要な勝率は 40%");
    expect(m.text).toContain("投資助言ではありません");
    expect(m.text).toContain("https://fx-tactical.jp/");
  });

  it("does not claim a measurement the study did not make", () => {
    const m = renderSignalMail(sample({ interval: "1day" }), "ja");
    expect(m.text).toContain("日足は検証していません");
    expect(m.text).not.toContain("885");
  });

  it("writes a SELL on a dollar pair in five decimals", () => {
    const m = renderSignalMail(sample({ pair: "EUR/USD", side: "SELL", entry: 1.1, stop: 1.1008, target: 1.0988, sar: 1.1012 }), "en");
    expect(m.subject).toBe("[Sextant] EUR/USD 15-minute SELL signal (RSI + Parabolic SAR)");
    expect(m.text).toContain("Entry ≈ 1.10000");
    expect(m.text).toContain("Stop 1.10080 (8.0 pips; $8.00 per 10,000 units)");
    expect(m.text).toContain("back below 70");
    expect(m.text).toContain("not investment advice");
  });

  it("the HTML part says what the text part says, escaped, with the link live", () => {
    const m = renderSignalMail(sample(), "ja");
    expect(m.html.split("<p ").length - 1).toBe(m.text.split("\n\n").length);
    expect(m.html).toContain('<a href="https://fx-tactical.jp/">');
    expect(m.html).not.toContain("<script");
    const t = renderTestMail([{ pair: "USD/JPY", interval: "1h" }], "ja");
    expect(t.text).toContain("USD/JPY 1時間足");
    expect(renderTestMail([], "en").text).toContain("none yet");
  });
});

describe("sending", () => {
  const mail = renderTestMail([], "ja");

  it("comes from the domain verified in Resend, so it reaches any address", () => {
    // onboarding@resend.dev delivered only to the Resend account's owner
    expect(DEFAULT_FROM).toBe("Sextant <alerts@fx-tactical.jp>");
  });

  it("returns the provider's id", async () => {
    let sent: unknown = null;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "abc" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sendMail("key", "Sextant <onboarding@resend.dev>", "u@example.com", mail, fake);
    expect(r).toEqual({ ok: true, id: "abc" });
    expect(sent).toMatchObject({ to: ["u@example.com"], subject: mail.subject });
  });

  it("never stores an address from the provider's error", async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({ name: "validation_error", message: "You can only send testing emails to your own email address (owner@example.com)." }),
        { status: 403 },
      )) as unknown as typeof fetch;
    const r = await sendMail("key", "x", "u@example.com", mail, fake);
    expect(r.ok).toBe(false);
    const error = (r as { error?: string }).error ?? "";
    expect(error).toContain("403");
    expect(error).not.toContain("owner@example.com");
    expect(error).toContain("[email]");
    const thrown = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await sendMail("key", "x", "u@example.com", mail, thrown)).toEqual({ ok: false, error: "network down" });
    expect(redactEmails("to a.b+c@d.co.jp now")).toBe("to [email] now");
  });
});
