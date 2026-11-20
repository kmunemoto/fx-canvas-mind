// #391 (docs §8.134): the MACD email on shares (signal-alerts v35) — the 22 shares' hourly bars from Yahoo, each
// session's bar closes (Tokyo's lunch break and closing auction, New York's 16:00, daylight saving), when a bar is in,
// the run's steps — and its tab in the settings.
// #397 (docs §8.150): from v39 to v40 that email was the ride of the pairs' MACD email (its tests went with it).
// v40 (docs §8.155; research/macdfade1h-prod-spec.md): the email is the fade, judged at the share's 1-hour closes.
// v41 (research/macdfade15min-prod-spec.md sections 2.4, 3.3, 3.4, 3.6, 3.7, 4.1, 4.2, 4.4 and 7.1): the same fade on
// the shares' 15-minute bars, the owner's 「メールの判断15分に変更して」 (2026-11-19). Here: the closes every 15 minutes
// of each session (CLOSES, stockCloseDue, stockBarEnd, stockBarBreak: New York's 15:45 bar the session's last, Tokyo's
// 11:15 bar before the lunch break and its 15:15 bar the last), the rule id, what a read of a share's bars gives
// (stockFadeClose: fresh for 45 minutes, the entry at the newest closed bar's close), the signal and its row, the
// share's mail word for word (a US BUY, a US SELL — a short sale — at a session's last bar, Tokyo shares', ja and en),
// the closing-price condition of spec 3.3 item 6, and the "stocks" run of the REAL
// supabase/functions/signal-alerts/index.ts replayed over fake tables (Yahoo's `15m` answers, Supabase's REST, the auth
// lookup and Resend faked, the clock and the sleeps too: nothing waits and nothing reaches the network), each import of
// the module one fresh instance, with the run's time budget (spec 3.3 item 10). Yahoo's real 15-minute answer (the
// yahoo-probe15 run 44535921376, 2026-11-19) is not in the repository: the answers here are made, shaped as that run's
// rows were reported (New York 9:30 … 15:45 and a 16:00 point of volume 0; Tokyo 9:00 … 11:15, an 11:30 row of one price
// with volume, null rows 11:45 … 12:15, 12:30 … 15:15). The rule itself (fadeCloseEntryAt) is checked in
// src/test/macd-fade.test.ts and against the study by research/macdfade-prod-check.ts; the pairs' and gold's fade in
// src/test/macd-fade-alerts.test.ts.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import SignalAlertSettings from "../components/SignalAlertSettings";
import { normalizeAlertSettings } from "../lib/signalAlerts";
import {
  CLOSES,
  STOCK_POLL_MS,
  STOCK_RUN_BUDGET_MS,
  STOCKMACD_FADE_VERSION,
  STOCKMACD_INTERVALS,
  STOCKMACD_PAIRS,
  STOCKMACD_RULE_ID,
  STOCK_FRESH_MS,
  type StockBar,
  localOf,
  renderStockMail,
  stockBarBreak,
  stockBarEnd,
  stockBarFresh,
  stockBarsOf,
  stockCloseDue,
  stockFadeClose,
  stockSweepOf,
} from "../../supabase/functions/signal-alerts/stocks";
import {
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  INDICATOR_RULES,
  fadeSignal,
  indicatorRuleId,
  isIndicatorChartFor,
  isIndicatorRule,
  renderIndicatorMail,
  rideSignalTag,
  signalRow,
  type IndicatorSignal,
} from "../../supabase/functions/signal-alerts/indicators";
import { renderTestMail } from "../../supabase/functions/signal-alerts/logic";
import { FADE_SHARE, fadeCloseEntryAt, fadeRuleId, type FadeEntry } from "../../supabase/functions/_shared/macd-fade";
import { JP_STOCKS, US_STOCKS } from "../lib/stocks";
import { ja as JA } from "../lib/i18n/ja";
import { en as EN } from "../lib/i18n/en";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);
const MIN = 60_000;
const H = 60 * MIN;
// v41: a bar's length, the 15-minute chart's
const STEP = 15 * MIN;
const at = (iso: string) => Date.parse(iso);

// the app's regexes: RIDE_ID as src/lib/signalAlerts.ts has it (v9's rows), FADE_ID as research/macdfade1h-prod-spec.md
// section 5 writes it (unchanged in research/macdfade15min-prod-spec.md section 5; src/test/macd-fade.test.ts holds both
// against their files)
const RIDE_ID = /^(?:macdx|stockmacd)_.*_(?:touch|ride)(\d+)to(\d+)of120_(in|at|out)_/;
const FADE_ID = /^(?:macdx|stockmacd)_.*_fade(\d+)(?:tp[0-9a-z]+)?of120_in_/;

describe("#391 when a share's bar closes (signal-alerts/stocks.ts; v41: its 15-minute bars)", () => {
  it("is the chart's list of shares, on the 15-minute chart, under its own id: the fade's one, built from its constants", () => {
    expect([...STOCKMACD_PAIRS]).toEqual([...US_STOCKS, ...JP_STOCKS].map((s) => s.symbol));
    expect([...STOCKMACD_INTERVALS]).toEqual(["15min"]);
    // v41 (research/macdfade15min-prod-spec.md 3.7): the fade's one id, every part from a constant, v5 (v40 writes v4).
    // It starts as the app reads the rule back from it, the app reads it as a fade at 96% (FADE_ID), not as v9's ride
    // (RIDE_ID), and it is none of the earlier ids
    expect(STOCKMACD_FADE_VERSION).toBe(5);
    expect(STOCKMACD_RULE_ID).toBe("stockmacd_12_26_9_w600_15min_fade96of120_in_v5");
    expect(STOCKMACD_RULE_ID).toBe(fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], STOCKMACD_FADE_VERSION));
    expect(STOCKMACD_RULE_ID.startsWith("stockmacd")).toBe(true);
    expect(FADE_ID.exec(STOCKMACD_RULE_ID)?.[1]).toBe("96");
    expect(RIDE_ID.test(STOCKMACD_RULE_ID)).toBe(false);
    for (const old of [
      "stockmacd_12_26_9_w600_1h_z95of120_v1",
      "stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2",
      "stockmacd_12_26_9_w600_1h_ride90to96of120_at_v2",
      "stockmacd_12_26_9_w600_1h_ride90to96of120_out_v2",
      "stockmacd_12_26_9_w600_1h_ride90to95of120_in_v3",
      "stockmacd_12_26_9_w600_15min_fade96of120_in_v4",
      // v40's, written from 2026-11-18
      "stockmacd_12_26_9_w600_1h_fade96of120_in_v4",
    ]) {
      expect(STOCKMACD_RULE_ID).not.toBe(old);
    }
    expect(INDICATOR_RULES).toContain("stockmacd");
    expect(isIndicatorRule("stockmacd")).toBe(true);
    // indicatorRuleId gives it, and a share's row is written under it (signalRow, below)
    expect(indicatorRuleId("stockmacd")).toBe(STOCKMACD_RULE_ID);
    expect(isIndicatorChartFor("stockmacd", "AAPL", "15min")).toBe(true);
    expect(isIndicatorChartFor("stockmacd", "7203.T", "15min")).toBe(true);
    expect(isIndicatorChartFor("stockmacd", "IBM", "15min")).toBe(false);
    // the 1-hour chart is not offered any more (a '1h' row gets a '15min' twin by hand, spec 3.6)
    expect(isIndicatorChartFor("stockmacd", "AAPL", "1h")).toBe(false);
    expect(isIndicatorChartFor("stockmacd", "USD/JPY", "15min")).toBe(false);
    // the FX rules do not take a share
    expect(isIndicatorChartFor("macdx", "AAPL", "15min")).toBe(false);
    expect(isIndicatorChartFor("ultra", "AAPL", "15min")).toBe(false);
  });

  it("closes every 15 minutes of the regular session (spec 3.3 item 3): New York 9:45 to 16:00 (26), Tokyo 9:15 to 11:30 and 12:45 to 15:30 (22)", () => {
    const hm = (v: number) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
    expect(CLOSES.us.map(hm)).toEqual([
      "9:45", "10:00", "10:15", "10:30", "10:45", "11:00", "11:15", "11:30", "11:45", "12:00", "12:15", "12:30", "12:45",
      "13:00", "13:15", "13:30", "13:45", "14:00", "14:15", "14:30", "14:45", "15:00", "15:15", "15:30", "15:45", "16:00",
    ]);
    expect(CLOSES.jp.map(hm)).toEqual([
      "9:15", "9:30", "9:45", "10:00", "10:15", "10:30", "10:45", "11:00", "11:15", "11:30",
      "12:45", "13:00", "13:15", "13:30", "13:45", "14:00", "14:15", "14:30", "14:45", "15:00", "15:15", "15:30",
    ]);
    expect([CLOSES.us.length, CLOSES.jp.length]).toEqual([26, 22]);
    // unchanged (spec 3.3 item 9): read in the half hour after a close, mailed up to 45 minutes after it
    expect(STOCK_POLL_MS).toBe(30 * MIN);
    expect(STOCK_FRESH_MS).toBe(45 * MIN);
    expect(STOCK_RUN_BUDGET_MS).toBe(30_000);
  });

  it("is due in the half hour after a close, New York's with daylight saving, Tokyo's with the lunch break", () => {
    // Friday 2026-10-30 (New York on daylight time, UTC−4): 9:45 local = 13:45 UTC, the first close
    expect(stockCloseDue("AAPL", at("2026-10-30T13:45:20Z"))).toBe(at("2026-10-30T13:45:00Z"));
    expect(stockCloseDue("AAPL", at("2026-10-30T13:59:00Z"))).toBe(at("2026-10-30T13:45:00Z"));
    // 10:01 local: the 10:00 close, the newest
    expect(stockCloseDue("AAPL", at("2026-10-30T14:01:00Z"))).toBe(at("2026-10-30T14:00:00Z"));
    // 16:00 local, the last, and half an hour on; then nothing
    expect(stockCloseDue("AAPL", at("2026-10-30T20:05:00Z"))).toBe(at("2026-10-30T20:00:00Z"));
    expect(stockCloseDue("AAPL", at("2026-10-30T20:30:00Z"))).toBe(at("2026-10-30T20:00:00Z"));
    expect(stockCloseDue("AAPL", at("2026-10-30T20:31:00Z"))).toBeNull();
    // 9:44 local: nothing has closed yet today
    expect(stockCloseDue("AAPL", at("2026-10-30T13:44:00Z"))).toBeNull();
    // Monday 2026-11-02 (standard time, UTC−5): 9:45 local = 14:45 UTC, not 13:45
    expect(stockCloseDue("AAPL", at("2026-11-02T13:50:00Z"))).toBeNull();
    expect(stockCloseDue("AAPL", at("2026-11-02T14:35:00Z"))).toBeNull();
    expect(stockCloseDue("AAPL", at("2026-11-02T14:46:00Z"))).toBe(at("2026-11-02T14:45:00Z"));
    // Saturday
    expect(stockCloseDue("AAPL", at("2026-10-31T14:31:00Z"))).toBeNull();
    // Tokyo, Monday 2026-11-02: 9:15 JST the first close (00:15 UTC)
    expect(stockCloseDue("7203.T", at("2026-11-02T00:14:00Z"))).toBeNull();
    expect(stockCloseDue("7203.T", at("2026-11-02T00:15:30Z"))).toBe(at("2026-11-02T00:15:00Z"));
    // 11:30 JST, the morning's end, and 11:45 (no close: still the 11:30 one's half hour)
    expect(stockCloseDue("7203.T", at("2026-11-02T02:35:00Z"))).toBe(at("2026-11-02T02:30:00Z"));
    expect(stockCloseDue("7203.T", at("2026-11-02T02:45:00Z"))).toBe(at("2026-11-02T02:30:00Z"));
    // 12:05 JST: 35 minutes after the morning's end, nothing due; 12:30 neither (the afternoon's first close is 12:45)
    expect(stockCloseDue("7203.T", at("2026-11-02T03:05:00Z"))).toBeNull();
    expect(stockCloseDue("7203.T", at("2026-11-02T03:30:30Z"))).toBeNull();
    expect(stockCloseDue("7203.T", at("2026-11-02T03:45:10Z"))).toBe(at("2026-11-02T03:45:00Z"));
    // 15:30 JST, the last
    expect(stockCloseDue("7203.T", at("2026-11-02T06:45:00Z"))).toBe(at("2026-11-02T06:30:00Z"));
    expect(stockCloseDue("7203.T", at("2026-11-02T07:01:00Z"))).toBeNull();
  });

  it("ends each bar 15 minutes after it opens, or at the session's end when that is earlier (spec 3.3 item 4); no half bar", () => {
    // New York's last bar, 15:45 local (daylight time), ends at the close, 16:00
    expect(stockBarEnd("AAPL", at("2026-10-30T19:45:00Z"))).toBe(at("2026-10-30T20:00:00Z"));
    expect(stockBarEnd("AAPL", at("2026-10-30T18:30:00Z"))).toBe(at("2026-10-30T18:45:00Z"));
    // standard time: 15:45 local = 20:45 UTC
    expect(stockBarEnd("AAPL", at("2026-11-02T20:45:00Z"))).toBe(at("2026-11-02T21:00:00Z"));
    // Tokyo: the 11:15 bar ends at the lunch break (11:30), the 15:15 bar at the closing auction (15:30), the
    // afternoon's first bar is stamped 12:30 (Yahoo's answer of 2026-11-19) and ends 12:45
    expect(stockBarEnd("7203.T", at("2026-11-02T02:15:00Z"))).toBe(at("2026-11-02T02:30:00Z"));
    expect(stockBarEnd("7203.T", at("2026-11-02T06:15:00Z"))).toBe(at("2026-11-02T06:30:00Z"));
    expect(stockBarEnd("7203.T", at("2026-11-02T03:30:00Z"))).toBe(at("2026-11-02T03:45:00Z"));
    expect(stockBarEnd("7203.T", at("2026-11-02T00:00:00Z"))).toBe(at("2026-11-02T00:15:00Z"));
    // a session that ends at 13:00 local (a US half day): its 12:45 bar ends then; a session's end that is earlier than
    // a bar's 15 minutes cuts it; one later, or a bar opened at or past it, does not
    expect(stockBarEnd("AAPL", at("2026-11-27T17:45:00Z"), at("2026-11-27T18:00:00Z"))).toBe(at("2026-11-27T18:00:00Z"));
    expect(stockBarEnd("AAPL", at("2026-11-27T17:45:00Z"), at("2026-11-27T17:50:00Z"))).toBe(at("2026-11-27T17:50:00Z"));
    expect(stockBarEnd("AAPL", at("2026-11-27T17:30:00Z"), at("2026-11-27T18:00:00Z"))).toBe(at("2026-11-27T17:45:00Z"));
    expect(stockBarEnd("AAPL", at("2026-11-27T18:00:00Z"), at("2026-11-27T18:00:00Z"))).toBe(at("2026-11-27T18:15:00Z"));
  });

  it("says where trading stops (spec 3.3 item 5): New York's 15:45 bar \"close\", Tokyo's 11:15 bar \"lunch\" and its 15:15 bar \"close\"; no other", () => {
    expect(stockBarBreak("AAPL", at("2026-10-30T19:45:00Z"))).toBe("close");
    expect(stockBarBreak("AAPL", at("2026-11-02T20:45:00Z"))).toBe("close");
    for (const t of ["2026-10-30T19:30:00Z", "2026-10-30T19:15:00Z", "2026-10-30T13:30:00Z", "2026-11-02T19:45:00Z"]) expect(stockBarBreak("AAPL", at(t)), t).toBeNull();
    expect(stockBarBreak("7203.T", at("2026-11-02T02:15:00Z"))).toBe("lunch");
    expect(stockBarBreak("7203.T", at("2026-11-02T06:15:00Z"))).toBe("close");
    // (v40's hourly breaks, Tokyo's 11:00 and 15:00 bars and New York's 15:30, are inside the session now)
    for (const t of ["2026-11-02T02:00:00Z", "2026-11-02T06:00:00Z", "2026-11-02T03:30:00Z", "2026-11-02T02:30:00Z"]) expect(stockBarBreak("7203.T", at(t)), t).toBeNull();
    expect(stockBarBreak("AAPL", at("2026-10-30T19:30:00Z"))).toBeNull();
  });

  it("a US half day (research/macdfade15min-prod-spec.md 7.1, review finding (2)): the bar opening 12:45 New York gives no break (stockBarBreak reads the regular hours), and it ends at the session's 13:00 end, so its mail says nothing of a session's end", () => {
    // 2026-11-27, the Friday after Thanksgiving, taken as a half day from NYSE's usual calendar (not checked here); the
    // pin needs only a 12:45 bar (17:45 UTC in New York's winter time)
    expect(stockBarBreak("AAPL", at("2026-11-27T17:45:00Z"))).toBeNull();
    expect(stockBarEnd("AAPL", at("2026-11-27T17:45:00Z"), at("2026-11-27T18:00:00Z"))).toBe(at("2026-11-27T18:00:00Z"));
    // 13:00 New York is one of CLOSES (a regular quarter-hour close), read as any other
    expect(CLOSES.us).toContain(13 * 60);
  });

  // Intel's last hour of Friday 2026-10-30 on 15-minute bars, made in the shape of Yahoo's `15m` answer (rows 15:00 …
  // 15:45 New York, then a 16:00 point of volume 0 once the session has ended), Yahoo naming that day's session; and the
  // same hour while it was trading (the last bar forming, no 16:00 point)
  const intc = (marketTime: number, n = 5, end = 1793390400) => ({
    chart: {
      result: [{
        meta: { symbol: "INTC", gmtoffset: -14400, regularMarketPrice: 65.76, regularMarketTime: marketTime, currentTradingPeriod: { regular: { start: 1793367000, end } } },
        timestamp: [1793386800, 1793387700, 1793388600, 1793389500, 1793390400].slice(0, n),
        indicators: {
          quote: [{
            open: [63.875, 64.2, 64.95, 65.5, 65.76].slice(0, n),
            high: [64.3, 65.0, 65.6, 65.88, 65.76].slice(0, n),
            low: [63.58, 64.1, 64.9, 65.4, 65.76].slice(0, n),
            close: [64.2, 64.95, 65.5, 65.88, 65.76].slice(0, n),
            volume: [810000, 920000, 1040000, 2310000, 0].slice(0, n),
          }],
        },
      }],
    },
  });

  it("takes a bar as closed once Yahoo has priced past its end; while Yahoo names the session just ended, its 16:00 point (volume 0) is joined to the 15:45 bar", () => {
    // 16:01 local: the closing point is in and joined to the 15:45 bar; every bar closed
    const after = stockBarsOf("INTC", intc(1793390401), at("2026-10-30T20:01:00Z"))!;
    expect(after.bars).toHaveLength(4);
    expect(after.bars.every((b) => b.closed)).toBe(true);
    expect(after.bars[3]).toMatchObject({ datetime: "2026-10-30 19:45:00", close: 65.76, end: at("2026-10-30T20:00:00Z") });
    // 16:00:30 local, Yahoo's last trade 15:59:58 and no closing point yet: the 15:45 bar is not in
    const before = stockBarsOf("INTC", intc(1793390398, 4), at("2026-10-30T20:00:30Z"))!;
    expect(before.bars).toHaveLength(4);
    expect(before.bars[3].closed).toBe(false);
    expect(before.bars[2].closed).toBe(true);
    expect(before.bars[3].close).toBe(65.88);
    // rounded as the chart's history (2 decimals), each bar 15 minutes
    expect(after.bars[0].open).toBe(63.88);
    expect(after.bars.map((b) => b.end - b.open_ms)).toEqual([STEP, STEP, STEP, STEP]);
    expect(stockBarsOf("INTC", null, at("2026-10-30T20:01:00Z"))).toBeNull();
  });

  it("judges the newest closed bar once, is done when the bar due is in, and skips a day with no bars", () => {
    const bars = stockBarsOf("INTC", intc(1793390401), at("2026-10-30T20:01:00Z"))!.bars;
    const due = at("2026-10-30T20:00:00Z");
    const first = stockSweepOf("INTC", bars, due, undefined, at("2026-10-30T20:01:00Z"));
    expect(first).toMatchObject({ judge: true, done: true, noSession: false });
    expect(first.newest!.datetime).toBe("2026-10-30 19:45:00");
    // the closed bars are handed on; with fewer than 600 of them there is no entry to mail
    expect(first.closed).toHaveLength(4);
    expect(first.fresh).toBe(true);
    expect(stockFadeClose("INTC", first.closed, at("2026-10-30T20:01:00Z"))).toEqual({ fresh: true, entry: null });
    const again = stockSweepOf("INTC", bars, due, first.newest!.open_ms, at("2026-10-30T20:02:00Z"));
    expect(again.judge).toBe(false);
    // the bar due (16:00) not in yet: judged what is, not done
    const early = stockBarsOf("INTC", intc(1793390398, 4), at("2026-10-30T20:00:30Z"))!.bars;
    const wait = stockSweepOf("INTC", early, due, undefined, at("2026-10-30T20:00:30Z"));
    expect(wait.done).toBe(false);
    expect(wait.newest!.datetime).toBe("2026-10-30 19:30:00");
    // Monday 9:45 New York with the newest bar Friday's (a holiday): nothing to do that close
    const holiday = stockSweepOf("INTC", bars, at("2026-11-02T14:45:00Z"), undefined, at("2026-11-02T14:46:00Z"));
    expect(holiday).toMatchObject({ noSession: true, done: true, judge: false, closed: [], newest: null });
  });
});

describe("docs §8.140: a bar forming while the session trades is not closed (v41: on 15-minute bars)", () => {
  const t = (iso: string) => Date.parse(iso) / 1000;
  // Apple's 15-minute answer in the shape Yahoo gave its hourly one on 2026-11-05 (.github/workflows/yahoo-probe.yml):
  // yesterday's last two bars (15:30 and 15:45 New York), today's 9:30, 9:45 and 10:00 bars, the 10:15 bar forming, and
  // one point at the last price, volume 0
  const apple = (last: string, lastVolume = 0, rows = 7) => ({
    chart: {
      result: [{
        meta: { symbol: "AAPL", gmtoffset: -18000, regularMarketPrice: 346.48, regularMarketTime: t(last), currentTradingPeriod: { regular: { start: t("2026-11-05T14:30:00Z"), end: t("2026-11-05T21:00:00Z") } } },
        timestamp: [t("2026-11-04T20:30:00Z"), t("2026-11-04T20:45:00Z"), t("2026-11-05T14:30:00Z"), t("2026-11-05T14:45:00Z"), t("2026-11-05T15:00:00Z"), t("2026-11-05T15:15:00Z"), t(last)].slice(0, rows),
        indicators: {
          quote: [{
            open: [352.17, 350.9, 353.9, 351.2, 349.82, 347.1, 346.48].slice(0, rows),
            high: [352.83, 351.0, 355.38, 351.9, 350.33, 347.5, 346.48].slice(0, rows),
            low: [350.5, 349.4, 350.6, 349.6, 346.9, 345.5, 346.48].slice(0, rows),
            close: [350.9, 349.62, 351.2, 349.82, 347.1, 346.05, 346.48].slice(0, rows),
            volume: [5090501, 11375216, 35192996, 20333617, 18333617, 9333617, lastVolume].slice(0, rows),
          }],
        },
      }],
    },
  });

  it("at 15:20 UTC judges the 15:00 bar, not the 15:15 one still forming (its last point inside it is joined to it)", () => {
    const now = at("2026-11-05T15:20:41Z");
    const got = stockBarsOf("AAPL", apple("2026-11-05T15:20:39Z"), now)!;
    expect(got.bars.map((b) => [b.datetime, b.closed])).toEqual([
      ["2026-11-04 20:30:00", true],
      ["2026-11-04 20:45:00", true],
      ["2026-11-05 14:30:00", true],
      ["2026-11-05 14:45:00", true],
      ["2026-11-05 15:00:00", true],
      ["2026-11-05 15:15:00", false],
    ]);
    const step = stockSweepOf("AAPL", got.bars, at("2026-11-05T15:15:00Z"), undefined, now);
    expect(step.newest!.datetime).toBe("2026-11-05 15:00:00");
    expect(step.done).toBe(true);
    // a later point that traded (not joined to the bar) does not close the bar either: its end has not come
    const traded = stockBarsOf("AAPL", apple("2026-11-05T15:20:39Z", 5), now)!;
    expect(traded.bars).toHaveLength(7);
    expect(traded.bars[5].closed).toBe(false);
    expect(traded.bars[6].closed).toBe(false);
  });

  it("at 15:30 UTC, once Yahoo has priced past it, judges the 15:15 bar (it was not marked judged while it formed)", () => {
    const now = at("2026-11-05T15:30:05Z");
    const got = stockBarsOf("AAPL", apple("2026-11-05T15:30:03Z"), now)!;
    // the point at 15:30:03 opens the next bar
    expect(got.bars.map((b) => [b.datetime, b.closed]).slice(-2)).toEqual([["2026-11-05 15:15:00", true], ["2026-11-05 15:30:03", false]]);
    const before = stockSweepOf("AAPL", stockBarsOf("AAPL", apple("2026-11-05T15:20:39Z"), at("2026-11-05T15:20:41Z"))!.bars, at("2026-11-05T15:15:00Z"), undefined, at("2026-11-05T15:20:41Z"));
    const step = stockSweepOf("AAPL", got.bars, at("2026-11-05T15:30:00Z"), before.newest!.open_ms, now);
    expect(step).toMatchObject({ judge: true, done: true, noSession: false });
    expect(step.newest!.datetime).toBe("2026-11-05 15:15:00");
    // before Yahoo has priced past 15:30 (its last trade 15:29:58, no later point): not in yet, not done
    const early = stockBarsOf("AAPL", apple("2026-11-05T15:29:58Z", 0, 6), at("2026-11-05T15:30:01Z"))!;
    expect(early.bars[5].closed).toBe(false);
    expect(stockSweepOf("AAPL", early.bars, at("2026-11-05T15:30:00Z"), before.newest!.open_ms, at("2026-11-05T15:30:01Z")).done).toBe(false);
    // a later point inside the bar that traded (not joined) does not close it once its end has come either: only a bar
    // that opens at or after its end does
    const inside = stockBarsOf("AAPL", apple("2026-11-05T15:29:58Z", 5), at("2026-11-05T15:30:05Z"))!;
    expect(inside.bars.map((b) => [b.datetime, b.closed]).slice(-2)).toEqual([["2026-11-05 15:15:00", false], ["2026-11-05 15:29:58", false]]);
  });
});

// ---- research/macdfade15min-prod-spec.md 3.3 item 6: the closing-price condition --------------------------------------
//
// A session's last bar (Tokyo's 11:15 and 15:15, New York's 15:45) is judged on its closing point only if
// live-chart/stocks.ts parseYahooChart joins that point to it. That join is not fitted to 15-minute bars yet (item 6,
// left to a later build, a probe at the market closes being run for it). On Yahoo's answer as the first probe (run
// 44535921376, 2026-11-19) reported it, Tokyo's morning ends with an 11:30 row of one price WITH volume (the closing
// auction), then null rows to 12:15: today's parser keeps that row as a bar of its own, so the 11:15 bar is judged on its
// close before the auction. So the condition does not hold today, and the sentences that say a session's last bar is
// judged on its closing price are left out of the mail (4.4 item 11) and of the notes (stockmacdNotes [2]'s 〔closing〕),
// ja and en. (The answer here is made in that shape; the real one is not in the repository.)
describe("spec 3.3 item 6, the closing-price condition: not held by today's parser on Yahoo's reported 15-minute shape, so its sentences are absent", () => {
  const t = (iso: string) => Date.parse(iso) / 1000;
  // Toyota's morning of Monday 2026-11-16 as the probe reported Tokyo's rows: 9:00 … 11:15 JST (00:00 … 02:15 UTC), an
  // 11:30 row of one price with volume, null rows 11:45 … 12:15, then 12:30 and 12:45 (the afternoon, still trading)
  const toyota = () => {
    const ts: number[] = [];
    const q = { open: [] as Array<number | null>, high: [] as Array<number | null>, low: [] as Array<number | null>, close: [] as Array<number | null>, volume: [] as Array<number | null> };
    const row = (iso: string, o: number | null, c: number | null, v: number | null) => {
      ts.push(t(iso));
      q.open.push(o);
      q.high.push(o === null || c === null ? null : Math.max(o, c) + 1);
      q.low.push(o === null || c === null ? null : Math.min(o, c) - 1);
      q.close.push(c);
      q.volume.push(v);
    };
    for (let k = 0; k < 10; k++) row(new Date(Date.UTC(2026, 10, 16, 0, 15 * k)).toISOString(), 2900 + k, 2901 + k, 50_000);
    // the morning's closing auction: one price, with volume
    ts.push(t("2026-11-16T02:30:00Z"));
    q.open.push(2925);
    q.high.push(2925);
    q.low.push(2925);
    q.close.push(2925);
    q.volume.push(410_000);
    for (const iso of ["2026-11-16T02:45:00Z", "2026-11-16T03:00:00Z", "2026-11-16T03:15:00Z"]) row(iso, null, null, null);
    row("2026-11-16T03:30:00Z", 2924, 2926, 60_000);
    row("2026-11-16T03:45:00Z", 2926, 2927, 40_000);
    return {
      chart: {
        result: [{
          meta: { symbol: "7203.T", gmtoffset: 32400, regularMarketPrice: 2927, regularMarketTime: t("2026-11-16T03:46:00Z"), currentTradingPeriod: { regular: { start: t("2026-11-16T00:00:00Z"), end: t("2026-11-16T06:30:00Z") } } },
          timestamp: ts,
          indicators: { quote: [q] },
        }],
      },
    };
  };

  it("the 11:15 bar is not judged on the 11:30 closing auction's price: that row stays a bar of its own (so the condition does not hold today)", () => {
    const got = stockBarsOf("7203.T", toyota(), at("2026-11-16T04:01:00Z"))!;
    const lunch = got.bars.find((b) => b.datetime === "2026-11-16 02:15:00")!;
    expect(stockBarBreak("7203.T", lunch.open_ms)).toBe("lunch");
    expect(lunch.close).toBe(2910);
    // the auction's row, 2925, is a bar of its own stamped 11:30 JST, and the null rows are left out
    expect(got.bars.map((b) => b.datetime)).toContain("2026-11-16 02:30:00");
    expect(got.bars.find((b) => b.datetime === "2026-11-16 02:30:00")!.close).toBe(2925);
    expect(got.bars.map((b) => b.datetime)).not.toContain("2026-11-16 02:45:00");
    // the afternoon's first bar is stamped 12:30 JST
    expect(got.bars.map((b) => b.datetime)).toContain("2026-11-16 03:30:00");
  });

  // research/macdfade15min-prod-spec.md 2.4 "Never judged" and 7.1 "A share" (added at its fourth review): Tokyo's 11:30
  // bar (the morning's closing-auction row, a one-price bar of its own from 11:30 to 11:45 JST) is never mailed. The
  // answers below are made in the probe's shapes (the 11:30 row of one price with volume, null rows 11:45 to 12:15,
  // then the afternoon's rows), with made-up prices; Yahoo's real answer in the lunch break is not yet seen (3.3)
  const tokyoAt = (o: { until: string; market: string }) => {
    const body = toyota();
    const r = body.chart.result[0];
    const keep = r.timestamp.map((x) => x <= t(o.until));
    const q = r.indicators.quote[0];
    const cut = <T,>(xs: T[]) => xs.filter((_, k) => keep[k]);
    r.timestamp = cut(r.timestamp);
    r.indicators.quote[0] = { open: cut(q.open), high: cut(q.high), low: cut(q.low), close: cut(q.close), volume: cut(q.volume) };
    r.meta.regularMarketTime = t(o.market);
    return body;
  };

  it("Tokyo's 11:30 bar is never mailed: a read of the 11:30 close up to 12:00 JST with Yahoo's last trade at the auction does not take it as closed; a read of the 12:45 close once the 12:30 row is in takes it as the newest closed bar, not fresh: no entry, no mail", () => {
    const auction = at("2026-11-16T02:30:00Z");
    // 11:50 JST, in the 11:30 close's half hour: the answer holds the auction row and the null rows to 11:45, Yahoo's
    // last trade the auction's (11:30)
    const now1 = at("2026-11-16T02:50:00Z");
    expect(stockCloseDue("7203.T", now1)).toBe(auction);
    const got1 = stockBarsOf("7203.T", tokyoAt({ until: "2026-11-16T02:45:00Z", market: "2026-11-16T02:30:00Z" }), now1)!;
    const bar1130 = got1.bars.find((b) => b.open_ms === auction)!;
    expect(bar1130.end).toBe(at("2026-11-16T02:45:00Z"));
    expect(bar1130.closed).toBe(false);
    const s1 = stockSweepOf("7203.T", got1.bars, auction, undefined, now1);
    // the newest closed bar is the 11:15 one (it ends at the lunch break, 11:30), and that close is done
    expect(s1.newest!.open_ms).toBe(at("2026-11-16T02:15:00Z"));
    expect(s1.done).toBe(true);
    // up to 12:00 JST the same (the 11:30 close's reads end there)
    const now2 = at("2026-11-16T03:00:00Z");
    expect(stockCloseDue("7203.T", now2)).toBe(auction);
    const s2 = stockSweepOf("7203.T", stockBarsOf("7203.T", tokyoAt({ until: "2026-11-16T03:00:00Z", market: "2026-11-16T02:30:00Z" }), now2)!.bars, auction, undefined, now2);
    expect(s2.newest!.open_ms).toBe(at("2026-11-16T02:15:00Z"));
    // 12:46 JST, the 12:45 close's read: the 12:30 row is in (Yahoo about 15 minutes behind, its last trade 12:31), so
    // the 11:30 bar is closed and the newest closed one, an hour past its end: not fresh, no entry, no mail
    const due = at("2026-11-16T03:45:00Z");
    const now3 = at("2026-11-16T03:46:00Z");
    expect(stockCloseDue("7203.T", now3)).toBe(due);
    const got3 = stockBarsOf("7203.T", tokyoAt({ until: "2026-11-16T03:30:00Z", market: "2026-11-16T03:31:00Z" }), now3)!;
    const s3 = stockSweepOf("7203.T", got3.bars, due, at("2026-11-16T02:15:00Z"), now3);
    expect(s3.newest!.open_ms).toBe(auction);
    expect(s3.judge).toBe(true);
    expect(s3.fresh).toBe(false);
    expect(s3.done).toBe(false);
    expect(stockFadeClose("7203.T", s3.closed, now3)).toEqual({ fresh: false, entry: null });
    // the run mails only a fresh entry (index.ts stockFade: not fresh, it returns before the price and the mail)
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    expect(fn).toMatch(/const close = stockFadeClose\(sym, closed, nowMs\);[\s\S]{0,400}if \(!close\.fresh\) return true;/);
  });

  it("so the mail says nothing of a session's last bar being judged on its closing price (4.4 item 11), ja and en", () => {
    for (const sig of [usSig(I_LAST), usSig(I_BUY), tokyoSig(T_LUNCH), tokyoSig(T_LAST)]) {
      const ja = renderStockMail(sig, "ja").text;
      const en = renderStockMail(sig, "en").text;
      expect(ja).not.toContain("引けの値段");
      expect(ja).not.toContain("取引時間の最後の足は、引けの値段で判定します");
      expect(en).not.toContain("closing price");
      expect(en).not.toContain("judged on its closing price");
    }
  });

  it("and the notes' 〔closing〕 (stockmacdNotes [2]) is empty, ja and en", () => {
    expect(JA.alerts.stockmacdNotes[2]).toContain("Yahoo の最後の約定の時刻がそれを過ぎたら判定します。確定から45分を過ぎた足は送りません。");
    expect(EN.alerts.stockmacdNotes[2]).toContain("a bar is judged once Yahoo's last trade is past its close. A bar that closed more than 45 minutes ago is not mailed.");
    for (const n of JA.alerts.stockmacdNotes) expect(n).not.toContain("引けの値段が出てから判定します");
    for (const n of EN.alerts.stockmacdNotes) expect(n).not.toContain("once the closing price is out");
  });
});

// ---- v41: the bars the fade's tests stand on -------------------------------------------------------------------------
//
// 2,200 15-minute bars of a US share on New York's sessions (9:30 … 15:45 local, 26 a weekday, daylight saving kept:
// the first opens 13:30 UTC in summer and 14:30 in winter), a slow wave, quicker ones and a drift, rounded to the cent
// as the chart draws a US share. A bar opens at the close before it and has no wick. A Tokyo share's bars are the same
// wave in yen (a tenth of a yen, as the chart draws a Tokyo share), 22 a weekday stamped 9:00 … 11:15 and 12:30 … 15:15
// JST (00:00 … 02:15 and 03:30 … 06:15 UTC; the 11:15 bar ends at the lunch break, the 15:15 one at 15:30). Under the
// fade's rule each holds 24 entries, found below with the shared code
const SYM = "AAPL";
const N = 2200;
const times: number[] = [];
for (let day = Date.UTC(2025, 5, 2); times.length < N; day += 24 * H) {
  const wd = new Date(day).getUTCDay();
  if (wd === 0 || wd === 6) continue;
  const first = localOf(SYM, day + 13.5 * H).min === 9 * 60 + 30 ? day + 13.5 * H : day + 14.5 * H;
  for (let k = 0; k < 26 && times.length < N; k++) times.push(first + k * STEP);
}
const ends = times.map((t) => stockBarEnd(SYM, t));
const wave = (i: number) => 0.9 * Math.sin(i / 90) + 0.35 * Math.sin(i / 23) + 0.12 * Math.sin(i / 7) + 0.03 * Math.sin(i * 1.9) + 0.0004 * i;
const closes = Array.from({ length: N }, (_, i) => Number((200 + 10 * wave(i)).toFixed(2)));
const openOf = (k: number) => (k > 0 ? closes[k - 1] : closes[k]);
const iso = (ms: number) => new Date(ms).toISOString();
const dt = (ms: number) => iso(ms).slice(0, 19).replace("T", " ");
const closeOf = (k: number) => ends[k];
const shareBar = (k: number, over: Partial<StockBar> = {}): StockBar => ({
  datetime: dt(times[k]), open: openOf(k), high: Math.max(openOf(k), closes[k]), low: Math.min(openOf(k), closes[k]), close: closes[k],
  open_ms: times[k], end: ends[k], closed: true, ...over,
});
// the closed bars up to bar n, as a read brings them
const closedTo = (n: number): StockBar[] => Array.from({ length: n + 1 }, (_, k) => shareBar(k));
const entryAt = (i: number): FadeEntry | null => fadeCloseEntryAt(closes.slice(i - 599, i + 1));
const TOKYO = (() => {
  const sym = "7203.T";
  const t: number[] = [];
  for (let day = Date.UTC(2025, 5, 2); t.length < N; day += 24 * H) {
    const wd = new Date(day).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (let k = 0; k < 10 && t.length < N; k++) t.push(day + k * STEP);
    for (let k = 0; k < 12 && t.length < N; k++) t.push(day + 3.5 * H + k * STEP);
  }
  return { sym, times: t, ends: t.map((x) => stockBarEnd(sym, x)), closes: Array.from({ length: N }, (_, i) => Number((3000 + 100 * wave(i)).toFixed(1))) };
})();
const tEntryAt = (i: number): FadeEntry | null => fadeCloseEntryAt(TOKYO.closes.slice(i - 599, i + 1));

// the bars the scenarios stand on (each checked below)
const I_BUY = 952; // a BUY (the pane's bottom) inside New York's session: the bar of 2025-07-22 13:30 New York
const I_SELL = 1149; // a SELL (the top) inside the session: 2025-08-01 10:45 New York
const I_LAST = 1585; // a SELL at a session's last bar: 2025-08-25 15:45 New York, ending at 16:00
const T_LUNCH = 1527; // Tokyo: a BUY at the 11:15 JST bar (the lunch break follows), 2025-09-05
const T_LAST = 1253; // Tokyo: a BUY at the 15:15 JST bar (the session's last, ending at 15:30), 2025-08-19
const T_MID = 1459; // Tokyo: a SELL at the 10:45 JST bar (ending 11:00), 2025-09-02

describe("v41 the share bars the fade's tests stand on (found with the shared code)", () => {
  it("are New York's 26 bars a weekday and Tokyo's 22, and hold SELLs and BUYs inside a session, at a session's last bar and before Tokyo's lunch", () => {
    expect(times.every((t) => {
      const l = localOf(SYM, t);
      return l.wd >= 1 && l.wd <= 5 && l.min >= 9 * 60 + 30 && l.min <= 15 * 60 + 45 && l.min % 15 === 0;
    })).toBe(true);
    expect(TOKYO.times.every((t) => {
      const l = localOf(TOKYO.sym, t);
      return l.wd >= 1 && l.wd <= 5 && l.min % 15 === 0 && ((l.min >= 9 * 60 && l.min <= 11 * 60 + 15) || (l.min >= 12 * 60 + 30 && l.min <= 15 * 60 + 15));
    })).toBe(true);
    // every bar 15 minutes long
    expect(ends.every((e, k) => e - times[k] === STEP)).toBe(true);
    expect(TOKYO.ends.every((e, k) => e - TOKYO.times[k] === STEP)).toBe(true);
    const found = (cl: number[]) => {
      const out: string[] = [];
      for (let i = 599; i < N; i++) {
        const e = fadeCloseEntryAt(cl.slice(i - 599, i + 1));
        if (e) out.push(`${i}:${e.side}`);
      }
      return out;
    };
    const us = found(closes);
    expect(us).toHaveLength(24);
    expect(us.filter((x) => x.endsWith(":SELL"))).toHaveLength(11);
    // the yen wave is the dollar wave scaled: the same entries
    expect(found(TOKYO.closes)).toEqual(us);
    for (const [i, side, zside] of [[I_BUY, "BUY", "bottom"], [I_SELL, "SELL", "top"], [I_LAST, "SELL", "top"]] as const) {
      expect(entryAt(i), `bar ${i}`).toMatchObject({ side, zside });
      // the bar before is not at 96% on that side, the bar after no entry (no entry while the line stays at 96%)
      expect(entryAt(i - 1), `bar ${i - 1}`).toBeNull();
      expect(entryAt(i + 1), `bar ${i + 1}`).toBeNull();
    }
    for (const [i, side] of [[T_LUNCH, "BUY"], [T_LAST, "BUY"], [T_MID, "SELL"]] as const) {
      expect(tEntryAt(i), `Tokyo bar ${i}`).toMatchObject({ side });
      expect(tEntryAt(i - 1), `Tokyo bar ${i - 1}`).toBeNull();
    }
    // where they are in the session: inside it, a session's last bar, Tokyo's
    expect([I_BUY, I_SELL, I_LAST].map((k) => dt(times[k]))).toEqual(["2025-07-22 17:30:00", "2025-08-01 14:45:00", "2025-08-25 19:45:00"]);
    expect([I_BUY, I_SELL, I_LAST].map((k) => stockBarBreak(SYM, times[k]))).toEqual([null, null, "close"]);
    expect([T_LUNCH, T_LAST, T_MID].map((k) => dt(TOKYO.times[k]))).toEqual(["2025-09-05 02:15:00", "2025-08-19 06:15:00", "2025-09-02 01:45:00"]);
    expect([T_LUNCH, T_LAST, T_MID].map((k) => stockBarBreak(TOKYO.sym, TOKYO.times[k]))).toEqual(["lunch", "close", null]);
  });
});

describe("v41 the fade on a share, judged at closes (stocks.ts stockFadeClose; spec 3.3)", () => {
  it("the entry at the newest closed bar's close while the bar ended at most 45 minutes ago; an older bar, or one not ended, is not judged", () => {
    expect(STOCK_FRESH_MS).toBe(45 * MIN);
    const closed = closedTo(I_BUY);
    const e = entryAt(I_BUY)!;
    expect(e).toMatchObject({ side: "BUY", zside: "bottom" });
    // a minute after it ended: the shared code's entry on the 600 closed bars ending at the bar (older bars not read)
    expect(stockFadeClose(SYM, closed, closeOf(I_BUY) + MIN)).toEqual({ fresh: true, entry: e });
    expect(stockFadeClose(SYM, closed.slice(-600), closeOf(I_BUY) + MIN)).toEqual({ fresh: true, entry: e });
    // 45 minutes after it ended still; a millisecond later not, and not before it ended
    expect(stockFadeClose(SYM, closed, closeOf(I_BUY) + 45 * MIN)).toEqual({ fresh: true, entry: e });
    expect(stockFadeClose(SYM, closed, closeOf(I_BUY) + 45 * MIN + 1)).toEqual({ fresh: false, entry: null });
    expect(stockFadeClose(SYM, closed, closeOf(I_BUY) - 1)).toEqual({ fresh: false, entry: null });
    expect(stockBarFresh(shareBar(I_BUY), closeOf(I_BUY))).toBe(true);
    expect(stockBarFresh(shareBar(I_BUY), closeOf(I_BUY) + 45 * MIN + 1)).toBe(false);
    // a close with no entry; a SELL at the top
    expect(stockFadeClose(SYM, closedTo(I_BUY + 1), closeOf(I_BUY + 1) + MIN)).toEqual({ fresh: true, entry: null });
    expect(stockFadeClose(SYM, closedTo(I_SELL), closeOf(I_SELL) + MIN)).toEqual({ fresh: true, entry: entryAt(I_SELL) });
    // fewer than 600 closed bars: no entry
    expect(stockFadeClose(SYM, closed.slice(-599), closeOf(I_BUY) + MIN)).toEqual({ fresh: true, entry: null });
    // a share the rule is not offered on, or no closed bar: nothing
    expect(stockFadeClose("IBM", closed, closeOf(I_BUY) + MIN)).toEqual({ fresh: false, entry: null });
    expect(stockFadeClose(SYM, [], closeOf(I_BUY) + MIN)).toEqual({ fresh: false, entry: null });
    // a session's last bar is judged by its own end (16:00 New York), 15 minutes after it opened
    expect(stockFadeClose(SYM, closedTo(I_LAST), times[I_LAST] + STEP + MIN)).toEqual({ fresh: true, entry: entryAt(I_LAST) });
    expect(stockFadeClose(SYM, closedTo(I_LAST), times[I_LAST] + STEP + 45 * MIN + 1).fresh).toBe(false);
  });
});

// ---- v41: the signal, its row, the mail (spec 3.4, 4.1, 4.2 and 4.4) ------------------------------------------------

// a share's fade signal as the run makes it (index.ts stockFade): the bar's open and end, its close, the price in its
// close, on the rule's chart (STOCKMACD_INTERVALS: the 15-minute one)
const usSig = (i: number): IndicatorSignal =>
  fadeSignal("stockmacd", SYM, STOCKMACD_INTERVALS[0], entryAt(i)!, { openMs: times[i], closeMs: closeOf(i), close: closes[i], price: closes[i] });
const tokyoSig = (i: number): IndicatorSignal =>
  fadeSignal("stockmacd", TOKYO.sym, STOCKMACD_INTERVALS[0], tEntryAt(i)!, { openMs: TOKYO.times[i], closeMs: TOKYO.ends[i], close: TOKYO.closes[i], price: TOKYO.closes[i] });

describe("v41 the share's signal and its row (spec 3.4)", () => {
  it("the signal: the bar's open and end, its close, the line and the pane's edges unrounded, the price in its close, no stop, no target", () => {
    const e = entryAt(I_BUY)!;
    const s = usSig(I_BUY);
    expect(s).toMatchObject({
      rule: "stockmacd", pair: SYM, interval: "15min", side: "BUY", barTime: iso(times[I_BUY]), closedAt: iso(times[I_BUY] + STEP), close: closes[I_BUY], sl: null, tps: null,
    });
    expect(s.fade).toEqual({ zside: "bottom", m: e.z.m, top: e.z.top, bottom: e.z.bottom, share0: e.share0, price: closes[I_BUY] });
    expect(s.fade!.share0).toBeGreaterThanOrEqual(FADE_SHARE);
    expect(usSig(I_SELL).fade).toMatchObject({ zside: "top", price: closes[I_SELL] });
  });

  it("the row: the bar's open, its end, the side, the price in (the bar's close), no stop and no target, the fade's id; the record's tag", () => {
    expect(signalRow(usSig(I_BUY))).toEqual({
      bar_time: iso(times[I_BUY]), closed_at: iso(closeOf(I_BUY)), side: "BUY", entry: closes[I_BUY], stop: null, target: null, rule: STOCKMACD_RULE_ID,
    });
    // a session's last bar and Tokyo's bar before lunch close 15 minutes after they open, as every bar: the row's
    // closed_at is the bar's own end (stockBarEnd)
    expect(signalRow(usSig(I_LAST))).toEqual({
      bar_time: iso(times[I_LAST]), closed_at: iso(times[I_LAST] + STEP), side: "SELL", entry: closes[I_LAST], stop: null, target: null, rule: STOCKMACD_RULE_ID,
    });
    expect(signalRow(tokyoSig(T_LUNCH))).toEqual({
      bar_time: iso(TOKYO.times[T_LUNCH]), closed_at: iso(TOKYO.times[T_LUNCH] + STEP), side: "BUY", entry: TOKYO.closes[T_LUNCH], stop: null, target: null, rule: STOCKMACD_RULE_ID,
    });
    expect([usSig(I_BUY), usSig(I_SELL)].map(rideSignalTag)).toEqual(["stockmacd:BUY", "stockmacd:SELL"]);
  });
});

// The spec's sentences (research/macdfade15min-prod-spec.md 4.4; those it keeps from research/macdfade1h-prod-spec.md
// 4.4), as written there
const ITEM6_JA = "利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。";
const ITEM6_EN = "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a stop.";
const ITEM7_JA = "メールはこの1通だけです。このあと、この合図について知らせは送りません。同じチャート・同じ向きに前の合図があっても、次の合図は送ります。";
const ITEM7_EN = "This is the only email: nothing more is sent about this signal. A later signal on the same chart and side is sent too, whatever came before it.";
const ITEM8_US_JA = "このメールは、足の確定の後の読み込みで判定して送ります（読み込みで判定するのは、その時に確定している一番新しい足だけです。確定から45分を過ぎた足は送りません。実際に何分で届くかは測っていません）。";
const ITEM8_US_EN = "This email is judged and sent at a read after the bar closes (a read judges only the newest bar closed by then; a bar more than 45 minutes past its close is not sent; how long it takes to arrive has not been measured).";
const ITEM8_TOKYO_JA = "東証の値段は Yahoo では約15分遅れて届きます（2026-11-06 に、1時間足の読み込みで測りました）。そのため、このメールは足が確定してから15分ほど後に判定して送ります（15分足で実際に何分後になるかは、まだ測っていません）。";
const ITEM8_TOKYO_EN = "Yahoo's Tokyo prices come about 15 minutes late (measured on 2026-11-06, on the 1-hour reads), so this email is judged and sent some 15 minutes after the bar closed (how many minutes on 15-minute bars has not been measured yet).";
const ITEM8_ARRIVE_JA = "届いた時の値段は、上の終値と違うことがあります（その差は測っていません）。";
const ITEM8_ARRIVE_EN = "The price when it arrives may differ from the close above (the difference has not been measured).";
const ITEM9_JA = "株では測っていません。";
const ITEM9_EN = "Not measured on shares.";
const ITEM10_JA =
  "この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・株を15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。";
const ITEM10_EN =
  "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging shares on 15-minute bars, the MACD pane of the newest 120 15-minute bars, the fade side (shares included) and stating no take-profit or stop price are the app owner's choices. That pane is the same as the app's 15-minute chart's.";
const BREAK_JA = "この足の終値では、次に市場が開くまで売買できません。";
const BREAK_EN = "At this bar's close nothing can be traded until the market opens again.";
// item 11 (stocks.ts's Yahoo source line, the app link, how to stop, the disclaimer), without the closing-price
// sentence (「取引時間の最後の足は、引けの値段で判定します。」 / "; a session's last bar is judged on its closing price"):
// spec 3.3 item 6's closing-price condition does not hold today (its describe above)
const ITEM11_JA = "足と値段は Yahoo Finance の公開データ（公式の配信ではないため、止まることがあります）で、アプリの株のチャートと同じです。注文の前にアプリで最新の状態を確認してください。\nhttps://fx-tactical.jp/";
const ITEM11_EN = "The bars and the price are Yahoo Finance's public data (not an official feed; it may stop), the same as the app's stock chart. Check the latest state in the app before you place an order:\nhttps://fx-tactical.jp/";
const STOP_JA = "この通知を止めるには、アプリの「設定」→「メール通知」の「株の MACD」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。";
const STOP_EN = "To stop these emails, open Settings → Email alerts in the app and untick the share under Stock MACD.\nThis is reference information, not investment advice. Every trading decision is your own.";
// research/macdfade96-spec.md 6.1's two patterns: no text asserts that a price recovers (spec 4.1)
const COME_BACK_JA = /(必ず|いずれ|きっと|そのうち|やがて)[^。]{0,8}戻|戻ってく|戻ってき|戻るはず|戻ります/;
const COME_BACK_EN =
  /\b(always|will|surely|certainly|eventually)\s+(come|comes|go|goes)\s+back\b|\b(always|will|surely|certainly|eventually)\s+(return|returns|recover|recovers)\b|\bcomes?\s+back\s+(eventually|in\s+the\s+end)\b/i;

// how the mail writes the MACD numbers: `md` decimals, the chart's minus (U+2212)
const num = (v: number, md: number) => v.toFixed(md).replace(/^-/, "−");
const jstOf = (ms: number) => iso(ms + 9 * H).slice(0, 16).replace("T", " ");
const utcOf = (ms: number) => iso(ms).slice(0, 16).replace("T", " ");

describe("v41 the share's email, word for word (spec 4.2 and 4.4)", () => {
  it("a US share's BUY in Japanese: the share and its market, the bar by its end, the line at 96% of the BOTTOM with the bar before not, the numbers, the close, no take-profit and no stop price, one email, its own timing, not measured, whose choices, the source, how to stop", () => {
    const s = usSig(I_BUY);
    const f = s.fade!;
    const mail = renderIndicatorMail(s, "ja");
    expect(mail).toEqual(renderStockMail(s, "ja"));
    expect(mail.subject).toBe("【Sextant】アップル（AAPL）15分足 買い（BUY）: 青い線が下の端の96%で確定（株の MACD）");
    // the bar opened 2025-07-22 17:30 UTC and closed 17:45 UTC, 02:45 the next day in Japan
    expect(jstOf(closeOf(I_BUY))).toBe("2025-07-23 02:45");
    expect(mail.text).toBe([
      "アップル（AAPL、米国）の15分足で、MACD の逆張りの買い（BUY）の合図が出ました。",
      [
        "判定した足: 2025-07-23 02:45（日本時間）に確定した15分足",
        "この足の終わりで、青い線（MACD）が、新しい120本（15分足）の MACD の枠の下の端（青い線・オレンジの線・棒の一番低い所）の96%以上（0の線から測って）でした。一つ前の足の終わりでは、96%に届いていませんでした。下の端なので、逆張りの買い（BUY）の合図です。",
        `MACD = ${num(f.m, 2)}、枠の下の端 = ${num(f.bottom, 2)}（その96% = ${num(0.96 * f.bottom, 2)}）`,
        `この足の終値: ${closes[I_BUY].toFixed(2)}ドル`,
      ].join("\n"),
      ITEM6_JA,
      ITEM7_JA,
      ITEM8_US_JA + ITEM8_ARRIVE_JA,
      ITEM9_JA,
      ITEM10_JA,
      ITEM11_JA,
      STOP_JA,
    ].join("\n\n"));
    // below zero the minus is the chart's
    expect(f.bottom).toBeLessThan(0);
    expect(mail.text).toMatch(/\nMACD = −\d/);
    expect(mail.text).not.toContain("= -");
    // a BUY on a share is no short sale, and a bar inside the session says nothing of the market shutting
    for (const no of ["空売り", "東証", "市場が開くまで"]) expect(mail.text, no).not.toContain(no);
    expect(mail.html).toContain("株の MACD");
    expect(mail.html).toContain('<a href="https://fx-tactical.jp/">https://fx-tactical.jp/</a>');
  });

  it("a US share's BUY in English", () => {
    const s = usSig(I_BUY);
    const f = s.fade!;
    const mail = renderIndicatorMail(s, "en");
    expect(mail.subject).toBe("[Sextant] Apple (AAPL) 15-minute BUY: the MACD line closed at 96% of the bottom (Stock MACD)");
    expect(utcOf(closeOf(I_BUY))).toBe("2025-07-22 17:45");
    expect(mail.text).toBe([
      "A MACD fade BUY signal on Apple (AAPL, US), 15-minute chart.",
      [
        "Bar judged: the 15-minute bar that closed at 2025-07-22 17:45 UTC (2025-07-23 02:45 JST)",
        "At this bar's close the MACD line (blue) was at 96% or more of the bottom of the MACD pane of the newest 120 bars (15-minute) (the lowest of the blue line, the orange line and the bars), measured from the zero line. At the close of the bar before, it was below 96%. It is the bottom, so this is a fade BUY signal.",
        `MACD = ${num(f.m, 2)}, the pane's bottom = ${num(f.bottom, 2)} (96% of it = ${num(0.96 * f.bottom, 2)})`,
        `This bar's close: $${closes[I_BUY].toFixed(2)}`,
      ].join("\n"),
      ITEM6_EN,
      ITEM7_EN,
      `${ITEM8_US_EN} ${ITEM8_ARRIVE_EN}`,
      ITEM9_EN,
      ITEM10_EN,
      ITEM11_EN,
      STOP_EN,
    ].join("\n\n"));
    for (const no of ["short sale", "Tokyo", "opens again"]) expect(mail.text, no).not.toContain(no);
  });

  it("a US share's SELL at a session's last bar, Japanese and English: the TOP, a short sale (subject and first line), the close, and that nothing can be traded at it until the market opens again", () => {
    const s = usSig(I_LAST);
    const f = s.fade!;
    expect(f.top).toBeGreaterThan(0);
    // the bar opened 2025-08-25 15:45 New York and closed at 16:00 (20:00 UTC, 05:00 the next day in Japan)
    expect(utcOf(closeOf(I_LAST))).toBe("2025-08-25 20:00");
    const ja = renderIndicatorMail(s, "ja");
    expect(ja.subject).toBe("【Sextant】アップル（AAPL）15分足 売り（SELL・空売り）: 青い線が上の端の96%で確定（株の MACD）");
    expect(ja.text).toBe([
      "アップル（AAPL、米国）の15分足で、MACD の逆張りの売り（SELL）の合図が出ました。株の売りは空売りです。",
      [
        "判定した足: 2025-08-26 05:00（日本時間）に確定した15分足",
        "この足の終わりで、青い線（MACD）が、新しい120本（15分足）の MACD の枠の上の端（青い線・オレンジの線・棒の一番高い所）の96%以上（0の線から測って）でした。一つ前の足の終わりでは、96%に届いていませんでした。上の端なので、逆張りの売り（SELL）の合図です。",
        `MACD = ${num(f.m, 2)}、枠の上の端 = ${num(f.top, 2)}（その96% = ${num(0.96 * f.top, 2)}）`,
        `この足の終値: ${closes[I_LAST].toFixed(2)}ドル`,
        BREAK_JA,
      ].join("\n"),
      ITEM6_JA,
      ITEM7_JA,
      ITEM8_US_JA + ITEM8_ARRIVE_JA,
      ITEM9_JA,
      ITEM10_JA,
      ITEM11_JA,
      STOP_JA,
    ].join("\n\n"));
    const en = renderIndicatorMail(s, "en");
    expect(en.subject).toBe("[Sextant] Apple (AAPL) 15-minute SELL (short sale): the MACD line closed at 96% of the top (Stock MACD)");
    expect(en.text).toBe([
      "A MACD fade SELL signal on Apple (AAPL, US), 15-minute chart. A SELL on a share is a short sale.",
      [
        "Bar judged: the 15-minute bar that closed at 2025-08-25 20:00 UTC (2025-08-26 05:00 JST)",
        "At this bar's close the MACD line (blue) was at 96% or more of the top of the MACD pane of the newest 120 bars (15-minute) (the highest of the blue line, the orange line and the bars), measured from the zero line. At the close of the bar before, it was below 96%. It is the top, so this is a fade SELL signal.",
        `MACD = ${num(f.m, 2)}, the pane's top = ${num(f.top, 2)} (96% of it = ${num(0.96 * f.top, 2)})`,
        `This bar's close: $${closes[I_LAST].toFixed(2)}`,
        BREAK_EN,
      ].join("\n"),
      ITEM6_EN,
      ITEM7_EN,
      `${ITEM8_US_EN} ${ITEM8_ARRIVE_EN}`,
      ITEM9_EN,
      ITEM10_EN,
      ITEM11_EN,
      STOP_EN,
    ].join("\n\n"));
    // a SELL inside the session: the short sale, and no line of the market shutting
    const mid = usSig(I_SELL);
    const midJa = renderIndicatorMail(mid, "ja");
    expect(midJa.subject).toBe("【Sextant】アップル（AAPL）15分足 売り（SELL・空売り）: 青い線が上の端の96%で確定（株の MACD）");
    expect(midJa.text).toContain("MACD の逆張りの売り（SELL）の合図が出ました。株の売りは空売りです。\n\n");
    expect(midJa.text).toContain(`\nこの足の終値: ${closes[I_SELL].toFixed(2)}ドル\n\n${ITEM6_JA}`);
    expect(midJa.text).not.toContain(BREAK_JA);
    expect(renderIndicatorMail(mid, "en").text).not.toContain(BREAK_EN);
  });

  it("a Tokyo share's BUY at the 11:15 bar, before the lunch break, Japanese and English: yen, its market, the bar by its end (11:30), the lunch break as a break, Yahoo's measured delay (judged some 15 minutes after the close) in place of the US sentence", () => {
    const s = tokyoSig(T_LUNCH);
    const f = s.fade!;
    // a Tokyo share in a tenth of a yen: the edge has more than two significant digits in one decimal
    expect(Math.abs(f.bottom)).toBeGreaterThan(1);
    expect(jstOf(TOKYO.ends[T_LUNCH])).toBe("2025-09-05 11:30");
    const ja = renderIndicatorMail(s, "ja");
    expect(ja.subject).toBe("【Sextant】トヨタ自動車（7203.T）15分足 買い（BUY）: 青い線が下の端の96%で確定（株の MACD）");
    expect(ja.text).toBe([
      "トヨタ自動車（7203.T、東証）の15分足で、MACD の逆張りの買い（BUY）の合図が出ました。",
      [
        "判定した足: 2025-09-05 11:30（日本時間）に確定した15分足",
        "この足の終わりで、青い線（MACD）が、新しい120本（15分足）の MACD の枠の下の端（青い線・オレンジの線・棒の一番低い所）の96%以上（0の線から測って）でした。一つ前の足の終わりでは、96%に届いていませんでした。下の端なので、逆張りの買い（BUY）の合図です。",
        `MACD = ${num(f.m, 1)}、枠の下の端 = ${num(f.bottom, 1)}（その96% = ${num(0.96 * f.bottom, 1)}）`,
        `この足の終値: ${TOKYO.closes[T_LUNCH].toFixed(1)}円`,
        BREAK_JA,
      ].join("\n"),
      ITEM6_JA,
      ITEM7_JA,
      ITEM8_TOKYO_JA + ITEM8_ARRIVE_JA,
      ITEM9_JA,
      ITEM10_JA,
      ITEM11_JA,
      STOP_JA,
    ].join("\n\n"));
    const en = renderIndicatorMail(s, "en");
    expect(en.subject).toBe("[Sextant] Toyota Motor (7203.T) 15-minute BUY: the MACD line closed at 96% of the bottom (Stock MACD)");
    expect(en.text).toBe([
      "A MACD fade BUY signal on Toyota Motor (7203.T, Tokyo), 15-minute chart.",
      [
        "Bar judged: the 15-minute bar that closed at 2025-09-05 02:30 UTC (2025-09-05 11:30 JST)",
        "At this bar's close the MACD line (blue) was at 96% or more of the bottom of the MACD pane of the newest 120 bars (15-minute) (the lowest of the blue line, the orange line and the bars), measured from the zero line. At the close of the bar before, it was below 96%. It is the bottom, so this is a fade BUY signal.",
        `MACD = ${num(f.m, 1)}, the pane's bottom = ${num(f.bottom, 1)} (96% of it = ${num(0.96 * f.bottom, 1)})`,
        `This bar's close: ${TOKYO.closes[T_LUNCH].toFixed(1)} yen`,
        BREAK_EN,
      ].join("\n"),
      ITEM6_EN,
      ITEM7_EN,
      `${ITEM8_TOKYO_EN} ${ITEM8_ARRIVE_EN}`,
      ITEM9_EN,
      ITEM10_EN,
      ITEM11_EN,
      STOP_EN,
    ].join("\n\n"));
  });

  it("a Tokyo share's BUY at the session's last bar (15:15, ending 15:30) and a SELL at a bar inside the session (10:45, ending 11:00): the break only where trading stops; a SELL a short sale", () => {
    const last = renderIndicatorMail(tokyoSig(T_LAST), "ja");
    expect(last.subject).toBe("【Sextant】トヨタ自動車（7203.T）15分足 買い（BUY）: 青い線が下の端の96%で確定（株の MACD）");
    expect(last.text.startsWith("トヨタ自動車（7203.T、東証）の15分足で、MACD の逆張りの買い（BUY）の合図が出ました。\n\n判定した足: 2025-08-19 15:30（日本時間）に確定した15分足\n")).toBe(true);
    expect(last.text).toContain(`\nこの足の終値: ${TOKYO.closes[T_LAST].toFixed(1)}円\n${BREAK_JA}\n\n${ITEM6_JA}\n\n${ITEM7_JA}\n\n${ITEM8_TOKYO_JA}${ITEM8_ARRIVE_JA}\n\n`);
    const lastEn = renderIndicatorMail(tokyoSig(T_LAST), "en");
    expect(lastEn.subject).toBe("[Sextant] Toyota Motor (7203.T) 15-minute BUY: the MACD line closed at 96% of the bottom (Stock MACD)");
    expect(lastEn.text).toContain(`\nThis bar's close: ${TOKYO.closes[T_LAST].toFixed(1)} yen\n${BREAK_EN}\n\n${ITEM6_EN}`);
    // the 10:45 bar ends at 11:00: trading goes on; a SELL is a short sale
    const mid = renderIndicatorMail(tokyoSig(T_MID), "ja");
    expect(mid.subject).toBe("【Sextant】トヨタ自動車（7203.T）15分足 売り（SELL・空売り）: 青い線が上の端の96%で確定（株の MACD）");
    expect(mid.text).toContain("MACD の逆張りの売り（SELL）の合図が出ました。株の売りは空売りです。\n\n判定した足: 2025-09-02 11:00（日本時間）に確定した15分足\n");
    expect(mid.text).toContain(`\nこの足の終値: ${TOKYO.closes[T_MID].toFixed(1)}円\n\n${ITEM6_JA}`);
    expect(mid.text).not.toContain(BREAK_JA);
    expect(renderIndicatorMail(tokyoSig(T_MID), "en").text).not.toContain(BREAK_EN);
  });

  it("item 8, each kind's timing: a US share's read judging only the newest closed bar, 45 minutes, how long the mail takes not measured; a Tokyo share's delay measured on the 1-hour reads, its minutes on 15-minute bars not measured; the arrival price in both; none says 「数分後」 / \"a few minutes\" or a pair's reads; item 10 names the owner for what 4.4 lists", () => {
    const us = [usSig(I_BUY), usSig(I_SELL), usSig(I_LAST)];
    const jp = [tokyoSig(T_LUNCH), tokyoSig(T_LAST), tokyoSig(T_MID)];
    for (const s of us) {
      const ja = renderIndicatorMail(s, "ja").text;
      const en = renderIndicatorMail(s, "en").text;
      expect(ja).toContain(`\n\n${ITEM8_US_JA}${ITEM8_ARRIVE_JA}\n\n`);
      expect(en).toContain(`\n\n${ITEM8_US_EN} ${ITEM8_ARRIVE_EN}\n\n`);
      expect(ja).toContain("実際に何分で届くかは測っていません");
      expect(en).toContain("how long it takes to arrive has not been measured");
      expect(ja).not.toContain(ITEM8_TOKYO_JA);
      expect(en).not.toContain(ITEM8_TOKYO_EN);
    }
    for (const s of jp) {
      const ja = renderIndicatorMail(s, "ja").text;
      const en = renderIndicatorMail(s, "en").text;
      expect(ja).toContain(`\n\n${ITEM8_TOKYO_JA}${ITEM8_ARRIVE_JA}\n\n`);
      expect(en).toContain(`\n\n${ITEM8_TOKYO_EN} ${ITEM8_ARRIVE_EN}\n\n`);
      expect(ja).not.toContain(ITEM8_US_JA);
      expect(en).not.toContain(ITEM8_US_EN);
    }
    for (const s of [...us, ...jp]) {
      const ja = renderIndicatorMail(s, "ja").text;
      const en = renderIndicatorMail(s, "en").text;
      for (const no of ["数分後", "3分後", "直後・1分後・3分後", "週末の止まっている時間", "約15分後に送っています"]) expect(ja, no).not.toContain(no);
      for (const no of ["a few minutes", "1 and 3 minutes", "weekend pause", "sent about 15 minutes after"]) expect(en, no).not.toContain(no);
      // item 9: not measured, and no number of any study
      expect(ja).toContain(`\n\n${ITEM9_JA}\n\n`);
      expect(en).toContain(`\n\n${ITEM9_EN}\n\n`);
      // item 10 (rewritten, spec 4.4): the owner is named for 96%, judging at the close, the shares' 15-minute bars, the
      // pane of the newest 120 15-minute bars, the fade side (shares included) and no take-profit or stop price
      expect(ja).toContain(`\n\n${ITEM10_JA}\n\n`);
      expect(en).toContain(`\n\n${ITEM10_EN}\n\n`);
      // item 11: Yahoo's source line, the app link, how to stop under 「株の MACD」 / "Stock MACD", the disclaimer
      expect(ja.endsWith(`\n\n${ITEM11_JA}\n\n${STOP_JA}`)).toBe(true);
      expect(en.endsWith(`\n\n${ITEM11_EN}\n\n${STOP_EN}`)).toBe(true);
    }
    // research/macdfade15min-prod-spec.md 4.4 item 10 (corrected at its third review): no 「も」 / "too" (under per pair
    // four of the fade's six charts are 1-hour); the item as the spec writes it, its lines joined
    expect(ITEM10_JA.split("アプリのオーナーが決めたものです。")[0]).toContain("・株を15分足で判定すること・MACD の枠を15分足の新しい120本にすること・");
    expect(ITEM10_JA).not.toContain("株も");
    expect(ITEM10_EN).not.toContain(" too,");
    const spec44 = readFileSync("research/macdfade15min-prod-spec.md", "utf8").split("\n");
    const i10 = spec44.findIndex((l) => l.startsWith("10. (rewritten; :326 / en :302) 「"));
    expect(i10).toBeGreaterThan(0);
    const item10 = spec44.slice(i10, i10 + 6).map((l) => l.trim());
    expect(item10.join("")).toContain(`「${ITEM10_JA}」`);
    expect(item10.join(" ")).toContain(`"${ITEM10_EN}"`);
    expect(ITEM10_JA.split("アプリのオーナーが決めたものです。")[1]).toBe("この枠は、アプリの15分足のチャートの枠と同じです。");
    expect(ITEM10_EN.split("are the app owner's choices.")[0]).toContain(", judging shares on 15-minute bars, the MACD pane of the newest 120 15-minute bars,");
    expect(ITEM10_EN.split("are the app owner's choices.")[1]).toBe(" That pane is the same as the app's 15-minute chart's.");
    // not the pairs' and gold's item 10 (which names judging the email on 15-minute bars as the owner's)
    expect(ITEM10_JA).not.toContain("メールを15分足で判定すること");
    expect(ITEM10_EN).not.toContain("judging the email on 15-minute bars");
    // no 「1時間足」 / "1-hour" left in a share's mail but where it names the delay's measurement (on the 1-hour reads)
    for (const sig of [...us, ...jp]) {
      expect(renderIndicatorMail(sig, "ja").text.split("2026-11-06 に、1時間足の読み込みで測りました").join("")).not.toContain("1時間足");
      expect(renderIndicatorMail(sig, "en").text.split("measured on 2026-11-06, on the 1-hour reads").join("")).not.toContain("1-hour");
    }
  });

  it("4.1's guards: 「利確」 / \"take profit\" only in item 6 and item 10; 「利確の目安」, \"take-profit level\" never; no price labelled a target or a stop; no text asserts that a price recovers; no number but 96% and the bar's own", () => {
    // (the patterns are the spec's, character for character; that they catch such a sentence in a share's mail was
    // checked by planting one in stocks.ts: this test failed)
    const spec96 = readFileSync("research/macdfade96-spec.md", "utf8");
    expect(spec96).toContain(`\`/${COME_BACK_JA.source}/\``);
    expect(spec96).toContain(`\`/${COME_BACK_EN.source}/i\``);
    const strip = (t: string, allowed: string[]) =>
      allowed.reduce((x, a) => {
        expect(x, a.slice(0, 30)).toContain(a);
        return x.split(a).join("");
      }, t);
    for (const s of [usSig(I_BUY), usSig(I_SELL), usSig(I_LAST), tokyoSig(T_LUNCH), tokyoSig(T_LAST), tokyoSig(T_MID)]) {
      const ja = renderIndicatorMail(s, "ja");
      const en = renderIndicatorMail(s, "en");
      for (const t of [ja.subject, ja.text, ja.html]) {
        expect(t).not.toContain("利確の目安");
        expect(t).not.toMatch(COME_BACK_JA);
        expect(t).not.toContain("必ず");
        expect(t).not.toContain("戻");
        expect(t).not.toMatch(/(利確|損切り|目標)[^。\n]{0,6}[0-9]/);
      }
      for (const t of [en.subject, en.text, en.html]) {
        expect(t.toLowerCase()).not.toContain("take-profit level");
        expect(t).not.toMatch(COME_BACK_EN);
        expect(t).not.toMatch(/\b(take profit|take-profit|stop|target|TP\d)\s*(price)?\s*[:=]?\s*[0-9]/i);
      }
      expect(strip(ja.text, [ITEM6_JA, ITEM10_JA])).not.toContain("利確");
      const enLeft = strip(en.text, [ITEM6_EN, ITEM10_EN]).toLowerCase();
      expect(enLeft).not.toContain("take profit");
      expect(enLeft).not.toContain("take-profit");
      // no study's numbers (the pairs' measured paragraph is not in a share's mail): every percent is the rule's 96%
      for (const t of [ja.text, en.text]) {
        expect(t.match(/[0-9.,]+%/g)!.every((p) => p === "96%"), t.match(/[0-9.,]+%/g)!.join(" ")).toBe(true);
        for (const no of ["pips", "1,490", "§8.133", "§8.150", "§8.155", "1,696", "99.36", "1,837.40", "22銘柄", "22 shares", "z95of120", "95%", "90%", "2通目", "email 2", "MACD の流れ", "MACD ride"]) {
          expect(t, no).not.toContain(no);
        }
      }
    }
  });

  it("a tiny edge is written to two significant digits, the numbers of a mail alike, from the edge on the fade's side; a signal with no facts is written with dashes", () => {
    const e = entryAt(I_BUY)!;
    const withZ = (zside: "top" | "bottom", z: { m: number; top: number; bottom: number }) =>
      fadeSignal("stockmacd", SYM, STOCKMACD_INTERVALS[0], { ...e, zside, side: zside === "top" ? "SELL" : "BUY", z }, { openMs: times[I_BUY], closeMs: closeOf(I_BUY), close: closes[I_BUY], price: closes[I_BUY] });
    // a top of 0.0126: in a US share's 2 decimals it would read 0.01 three times
    expect(renderStockMail(withZ("top", { m: 0.0126, top: 0.0126, bottom: -2.2 }), "ja").text).toContain("\nMACD = 0.013、枠の上の端 = 0.013（その96% = 0.012）\n");
    // the decimals follow the edge on the fade's side: a SELL's tiny BOTTOM changes nothing, a BUY's does
    expect(renderStockMail(withZ("top", { m: 0.19, top: 0.2, bottom: -1e-9 }), "en").text).toContain("\nMACD = 0.19, the pane's top = 0.20 (96% of it = 0.19)\n");
    expect(renderStockMail(withZ("bottom", { m: -0.0095, top: 0.2, bottom: -0.0097 }), "en").text).toContain("\nMACD = −0.0095, the pane's bottom = −0.0097 (96% of it = −0.0093)\n");
    const bare: IndicatorSignal = { ...usSig(I_SELL), fade: undefined };
    expect(renderStockMail(bare, "ja").text).toContain("\nMACD = —、枠の上の端 = —（その96% = —）\n");
    expect(renderStockMail(bare, "ja").text).toContain(`\nこの足の終値: ${closes[I_SELL].toFixed(2)}ドル\n`);
  });
});

describe("#391 the shares' run and the database", () => {
  it("runs every minute as its own mode, reads only its own subscriptions, and the database takes the shares and the rule", () => {
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    // (v40: the MACD email, the shares' too, is the fade; v41 on 15-minute bars)
    expect(fn).toContain('const FUNCTION_VERSION = "signal-alerts-v41-2026-11-20";');
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=eq.stockmacd&select=user_id,pair,interval,lang,rule")');
    // the other rules' run does not take them
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3,emarm,spike)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toContain('if (body.mode === "stocks") {');
    expect(fn).toContain("stockmacd: { pairs: STOCKMACD_PAIRS, intervals: STOCKMACD_INTERVALS },");
    expect(renderTestMail([{ pair: "AAPL", interval: "15min", rule: "stockmacd" }], "ja").text).toContain("AAPL 15分足（株の MACD）");
    const mig = readFileSync("supabase/migrations/20261031160000_signal_alert_stockmacd.sql", "utf8");
    expect(mig).toContain("'emarm', 'stockmacd']));");
    for (const s of STOCKMACD_PAIRS) expect(mig).toContain(`'${s}'`);
    const cron = readFileSync("supabase/migrations/20261031160100_stockmacd_sweep.sql", "utf8");
    expect(cron).toContain("'signal-alerts-stocks',\n  '* * * * *',");
    expect(cron).toContain(`body := '{"mode":"stocks"}'::jsonb,`);
  });

  it("v40/v41: the fade on a share is judged in its own try / catch, priced at the bar's close and mailed by mailRide, on the rule's chart (STOCKMACD_INTERVALS, no \"1h\" written); nothing of v39's ride, no state row, no minute read; the 95% decision is called nowhere", () => {
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    const run = fn.slice(fn.indexOf("const stockSweep = async"), fn.indexOf("const goldTicks = async"));
    // the code without its comment lines (the history in the comments names v39's ride)
    const code = run.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    // spec 3.3: fresh by stockBarFresh (stockFadeClose), the entry fadeCloseEntryAt's, the price the bar's close, the
    // signal, mailRide to the share's followers; settled only with no error and no follower left unsent
    expect(code).toContain("const close = stockFadeClose(sym, closed, nowMs);");
    expect(code).toContain("const price = newest.close;");
    expect(code).toContain('const sig = fadeSignal("stockmacd", sym, STOCKMACD_INTERVALS[0], entry, { openMs: newest.open_ms, closeMs: newest.end, close: newest.close, price });');
    expect(code).toContain("const got = await mailRide(sig, subs, counts);");
    expect(code).toContain("if (got.otherSide) out.fade.other_side = true;");
    expect(code).toContain("return out.unsent.length === 0;");
    expect(code).toMatch(
      /try \{\s+settled = await stockFade\(sym, step\.closed, step\.newest, said\);\s+\} catch \(err\) \{\s+console\.error\("stockmacd failed:", sym, errText\(err\)\);\s+said\.fade\.error = "failed";\s+settled = false;\s+\}/,
    );
    expect(code).toMatch(/if \(settled\) \{\s+if \(step\.done\) stockDone\.set\(sym, due\);\s+if \(step\.judge && step\.newest\) stockJudged\.set\(sym, step\.newest\.open_ms\);\s+\}/);
    // the bars read are the rule's chart's (spec 3.3 item 2: Yahoo's `15m` over `60d`), at the reads as they were
    expect(code).toContain('const r = await fetch(yahooChartUrl(sym, STOCKMACD_INTERVALS[0]), { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(10_000) });');
    expect(code).toContain("const due = stockCloseDue(sym, nowMs);");
    expect(code).toContain("if (nowMs - (stockReadAt.get(sym) ?? 0) < 50_000) continue;");
    expect(code).toContain("const got = stockBarsOf(sym, body, nowMs);");
    expect(code).toContain("const step = stockSweepOf(sym, got.bars, due, stockJudged.get(sym), nowMs);");
    // what is logged of a failure holds no address (a lookup's URL holds a follower's id)
    for (const line of code.split("\n").filter((l) => l.includes("console.error"))) expect(line, line).not.toMatch(/user_id|email|\bid\b/);
    // shares keep no state rows, read no minute and nothing of v39's ride
    for (const gone of ["macd_ride", "select=*", "readRides", "reachRide", "openRide", "rideMailThere", "rideOutSignal", "rideCloseSignal", "rideRowOf", "RIDE_CATCHUP_BARS", "MacdRide", "shareOf", "stockRide", "sendRide", "said.ride"]) {
      expect(code, gone).not.toContain(gone);
    }
    const src = readFileSync("supabase/functions/signal-alerts/stocks.ts", "utf8");
    const srcCode = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    expect(src.split("\n").filter((l) => l.includes("z95of120") && !l.trimStart().startsWith("//"))).toEqual([]);
    for (const gone of ["decideZoneOnWindow(", "ZONE_PCT", "export const stockmacdSignals", "macdh"]) expect(src, gone).not.toContain(gone);
    for (const gone of ["macd-ride", "rideHeldText", "RIDE_", "Ride", "stockRidesReached", "stockRideClose", "stockRidePnl", "STOCKMACD_AT_RULE_ID", "STOCKMACD_OUT_RULE_ID", "s.ride"]) {
      expect(srcCode, gone).not.toContain(gone);
    }
    // the one shared function, and the guard of the chart the rule is offered on (spec 3.3)
    expect(src).toContain('import { FADE_PCT, FADE_SHARE, fadeCloseEntryAt, fadeRuleId, type FadeEntry } from "../_shared/macd-fade.ts";');
    expect(src).toContain("const newest = isStockmacdChart(sym, STOCKMACD_INTERVALS[0]) && closed.length > 0 ? closed[closed.length - 1] : null;");
    expect(src).toContain("return { fresh: true, entry: fadeCloseEntryAt(closed.map((b) => b.close)) };");
    // v41 (spec 3.3 items 1 and 2, 7.1): every "1h" of the share functions takes the constant, which is "15min"
    expect(src).toContain('export const STOCKMACD_INTERVALS = ["15min"] as const;');
    expect(src).toContain("export const STOCKMACD_FADE_VERSION = 5;");
    expect(src).toContain("const got = parseYahooChart(sym, body, STOCKMACD_INTERVALS[0], nowMs);");
    expect(src).toContain("judge: newest !== null && isStockmacdChart(sym, STOCKMACD_INTERVALS[0]) && newest.open_ms !== judgedOpen,");
    const body = (from: string, to: string) => {
      const i = srcCode.indexOf(from);
      return srcCode.slice(i, srcCode.indexOf(to, i));
    };
    for (const [name, part] of [
      ["stockBarsOf", body("export const stockBarsOf = ", "export const stockBarFresh = ")],
      ["stockFadeClose", body("export const stockFadeClose = ", "export const stockSweepOf = ")],
      ["stockSweepOf", body("export const stockSweepOf = ", "export const stockBarBreak = ")],
      ["stockFade", code.slice(code.indexOf("const stockFade = async ("), code.indexOf("const followed = "))],
      ["the share read", code.slice(code.indexOf("const followed = "), code.indexOf("const got = stockBarsOf("))],
    ] as const) {
      expect(part.length, name).toBeGreaterThan(100);
      expect(part, name).not.toContain('"1h"');
    }
    // the mail's bar word is the signal's own (tfLabel), no 1-hour word written in it (spec 3.3 item 7)
    const mail = body("export const renderStockMail = ", "\n};\n");
    expect(mail).toContain("const tf = tfLabel(lang, s.interval);");
    expect(mail.split("2026-11-06 に、1時間足の読み込みで測りました").join("").split("on the 1-hour reads").join("")).not.toMatch(/1時間足|1-hour/);
  });

  // spec 7.1: "nothing read or written each minute, no state row", held as code text over the whole of index.ts (the
  // calls are read, not the comments, which may still name the tables), and no file under supabase/functions imports
  // _shared/macd-ride.ts (it stays as main's v9 file for the v9 bench, v9's replay and a rollback)
  it("no rest( or readRows( call in index.ts names macd_rides or macd_ride_state, and no file under supabase/functions imports _shared/macd-ride.ts", () => {
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    const code = fn.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    // every call of rest( and readRows(, as far as its closing parenthesis (strings taken whole)
    const callsOf = (name: string): string[] => {
      const out: string[] = [];
      const re = new RegExp(`(?<![\\w.])${name}\\(`, "g");
      for (let m = re.exec(code); m; m = re.exec(code)) {
        let depth = 1;
        let quote: string | null = null;
        let i = m.index + m[0].length;
        for (; i < code.length && depth > 0; i++) {
          const c = code[i];
          if (quote) {
            if (c === "\\") i++;
            else if (c === quote) quote = null;
          } else if (c === '"' || c === "'" || c === "`") quote = c;
          else if (c === "(") depth++;
          else if (c === ")") depth--;
        }
        out.push(code.slice(m.index, i));
      }
      return out;
    };
    const calls = [...callsOf("rest"), ...callsOf("readRows")];
    expect(calls.length).toBeGreaterThan(20);
    expect(calls).toContain('readRows("signal_alert_subscriptions?rule=eq.stockmacd&select=user_id,pair,interval,lang,rule")');
    for (const c of calls) expect(c, c).not.toMatch(/macd_ride/);
    // stricter still: no code line of index.ts names either table
    expect(code).not.toContain("macd_ride");
    // no file under supabase/functions imports macd-ride.ts (the shares' stocks.ts included)
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = `${dir}/${f}`;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(p) && /(from|import)\s*\(?\s*["'][^"']*macd-ride(\.ts)?["']/.test(readFileSync(p, "utf8"))) importers.push(p);
      }
    };
    walk("supabase/functions");
    expect(importers).toEqual([]);
    // (the file itself is still there, and the check can fail: an import of it is found)
    expect(statSync("supabase/functions/_shared/macd-ride.ts").isFile()).toBe(true);
    expect(/(from|import)\s*\(?\s*["'][^"']*macd-ride(\.ts)?["']/.test('import { rideEntryAt } from "../_shared/macd-ride.ts";')).toBe(true);
  });
});

describe("#391 the MACD email on shares in the settings", () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    ok: true,
    allowed: true,
    email_configured: true,
    email: "me@example.com",
    pairs: ["USD/JPY"],
    intervals: ["15min", "1h", "4h", "1day"],
    subscriptions: [],
    alerts: [],
    indicator: {
      rules: INDICATOR_RULES,
      pairs: INDICATOR_PAIRS,
      intervals: INDICATOR_INTERVALS,
      limited: {},
      stockmacd: { pairs: STOCKMACD_PAIRS, intervals: STOCKMACD_INTERVALS },
    },
    ...over,
  });

  it("has its own tab with the 22 shares named on the 15-minute chart, its notes, and saves a tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      normalizeAlertSettings(body.action === "set" ? payload({ subscriptions: [{ pair: "7203.T", interval: "15min", rule: "stockmacd" }] }) : payload())!
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-rule-stockmacd").textContent).toBe("株の MACD");
    // v41: the tab describes the fade on 15-minute bars (the screen's text is src/lib/i18n's; spec section 5)
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toContain("米国株と日本株の15分足で、FX と同じ「MACD の逆張り」のメールを送ります（1つの足で1通だけ）。15分足が確定した時に、");
    expect(intro).not.toContain("1時間足");
    expect(intro).toContain("株の売りは空売りです");
    expect(intro).toContain("株では測っていません。");
    const rows = screen.getByTestId("signal-alerts-grid").querySelectorAll("tbody tr");
    // the shares, and the row for all of them
    expect(rows.length).toBe(STOCKMACD_PAIRS.length + 1);
    expect(screen.getByTestId("signal-alerts-grid").textContent).toContain("7203.Tトヨタ自動車");
    expect(screen.getByTestId("signal-alert-stockmacd-AAPL-15min")).toBeTruthy();
    expect(screen.queryByTestId("signal-alert-stockmacd-AAPL-1h")).toBeNull();
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。");
    // 4.4 item 10 (section 5's stockmacdNotes [3]): the owner named for 96%, judging at the close, the shares' 15-minute
    // bars, the pane of the newest 120 15-minute bars, the fade side (shares included) and no take-profit or stop price
    expect(notes).toContain(ITEM10_JA);
    expect(notes).toContain("決まりは FX の「MACD の逆張り」と同じで、見るのは15分足の確定ごとです。");
    expect(notes).toContain("株では測っていません。5ペアで測った数字は、株には当てはまりません。");
    // none of docs §8.133's numbers (the 95% rule's), nor that a price always comes back
    for (const no of ["1,696回", "99.36%", "−1,837.40%", "95%", "必ず戻"]) expect(`${intro}\n${notes}`, no).not.toContain(no);
    fireEvent.click(screen.getByTestId("signal-alert-stockmacd-7203.T-15min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "7203.T", interval: "15min", on: true, rule: "stockmacd", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-stockmacd-7203.T-15min") as HTMLInputElement).checked).toBe(true));
  });

  it("from a server that does not send its charts: says it is not available yet", async () => {
    const call = vi.fn(async () => normalizeAlertSettings(payload({ indicator: { rules: INDICATOR_RULES, pairs: INDICATOR_PAIRS, intervals: INDICATOR_INTERVALS, limited: {} } }))!);
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-stockmacd-unavailable")).toBeTruthy();
  });
});

// ---- v41: the "stocks" run of the real index.ts over fake tables (spec 2.4, 2.5, 3.3, 3.4 and 7.1) -------------------
//
// (Last in this file: it stubs the clock, the timers and fetch, and puts them back when it is done.)

type Row = Record<string, unknown>;
const SB = "https://sb.test";
const TIME_COLS = new Set(["bar_time", "closed_at", "created_at"]);
const world = {
  subs: [] as Row[],
  alerts: [] as Row[],
  sent: [] as Array<{ to: string; subject: string; text: string }>,
  // how far behind the clock Yahoo's answer is (its newest bar and its last trade)
  yahooLag: 0,
  yahooStatus: 200,
  // Yahoo's reads, as "symbol interval range"
  yahoo: [] as string[],
  // v41: how long each Yahoo read takes (the clock moved on by it), for the run's time budget
  yahooDelayMs: 0,
  // followers whose plan lookup fails (a 503)
  failPlanFor: new Set<string>(),
  // followers whose address lookup answers this status (503: the lookup failed)
  failAuthFor: new Map<string, number>(),
  // shares whose read of signal_alerts cannot be sent at all (fetch throws): the fade's work on them fails
  alertsThrowFor: new Set<string>(),
  // shares whose read of signal_alerts is answered with a 503 (its inserts still work)
  alertsFailFor: new Set<string>(),
  // every REST read as "table select", every request that no route took, every request to v39's ride tables
  reads: [] as string[],
  unrouted: [] as string[],
  rideTables: [] as string[],
  ids: 0,
};
const resetWorld = () => {
  Object.assign(world, { subs: [], alerts: [], sent: [], yahooLag: 0, yahooStatus: 200, yahoo: [], yahooDelayMs: 0, reads: [], unrouted: [], rideTables: [], ids: 0 });
  world.failPlanFor.clear();
  world.failAuthFor.clear();
  world.alertsThrowFor.clear();
  world.alertsFailFor.clear();
};
let clock = 0;

// Yahoo's 15-minute answer at the clock (less its lag): the bars of the 60 days before it (`range=60d`), each bar opened
// by then, the one still forming 0.7 above its open (so that a price taken from the forming bar, or from Yahoo's last
// trade, is not the judged bar's close and the price tests catch it), and Yahoo's last trade then. Every US share is
// given the same bars, a Tokyo share TOKYO's.
const yahooAnswer = (sym: string) => {
  const seen = clock - world.yahooLag;
  const S = sym.endsWith(".T") ? TOKYO : { times, ends, closes };
  let last = -1;
  let from = 0;
  for (let k = 0; k < N && S.times[k] <= seen; k++) {
    last = k;
    if (S.times[k] < seen - 60 * 24 * H) from = k + 1;
  }
  const ts: number[] = [];
  const q = { open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], volume: [] as number[] };
  for (let k = from; k <= last; k++) {
    const open = k > 0 ? S.closes[k - 1] : S.closes[k];
    const close = S.ends[k] <= seen ? S.closes[k] : Number((open + 0.7).toFixed(2));
    ts.push(S.times[k] / 1000);
    q.open.push(open);
    q.high.push(Math.max(open, close));
    q.low.push(Math.min(open, close));
    q.close.push(close);
    q.volume.push(1000);
  }
  return { chart: { result: [{ meta: { symbol: sym, gmtoffset: -14400, regularMarketPrice: q.close[q.close.length - 1], regularMarketTime: Math.floor(seen / 1000) }, timestamp: ts, indicators: { quote: [q] } }] } };
};

// PostgREST's filters, as far as the run uses them
const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
const same = (col: string, a: unknown, b: string) => (TIME_COLS.has(col) ? Date.parse(String(a)) === Date.parse(b) : String(a) === b);
const condOf = (col: string, expr: string): ((r: Row) => boolean) => {
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const val = unquote(expr.slice(dot + 1));
  if (op === "eq") return (r) => r[col] !== null && r[col] !== undefined && same(col, r[col], val);
  throw new Error(`a filter the fake does not know: ${col}=${expr}`);
};
const META = new Set(["select", "order", "limit", "on_conflict"]);
const whereOf = (u: URL): ((r: Row) => boolean) => {
  const conds: Array<(r: Row) => boolean> = [];
  for (const [k, v] of u.searchParams) if (!META.has(k)) conds.push(condOf(k, v));
  return (r) => conds.every((c) => c(r));
};
const pick = (r: Row, select: string | null): Row => (select === null || select === "*" ? { ...r } : Object.fromEntries(select.split(",").map((c) => [c, r[c] ?? null])));
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const empty = (status: number) => new Response(null, { status });

const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  if (url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/")) {
    const u = new URL(url);
    const sym = decodeURIComponent(u.pathname.split("/").pop()!);
    world.yahoo.push(`${sym} ${u.searchParams.get("interval")} ${u.searchParams.get("range")}`);
    // (a slow read: the clock moves on by it before the answer comes)
    clock += world.yahooDelayMs;
    return world.yahooStatus === 200 ? reply(yahooAnswer(sym)) : reply({}, world.yahooStatus);
  }
  if (url === "https://api.resend.com/emails") {
    world.sent.push({ to: body.to[0], subject: body.subject, text: body.text });
    return reply({ id: `re_${world.sent.length}` });
  }
  if (url.startsWith(`${SB}/auth/v1/admin/users/`)) {
    const uid = decodeURIComponent(url.split("/").pop()!);
    const failed = world.failAuthFor.get(uid);
    if (failed !== undefined) return reply({ message: "boom" }, failed);
    return reply({ id: uid, email: `${uid}@example.test` });
  }
  if (!url.startsWith(`${SB}/rest/v1/`)) {
    world.unrouted.push(`${method} ${url.slice(0, 90)}`);
    return new Response("not found", { status: 404 });
  }
  const u = new URL(url);
  const table = u.pathname.slice("/rest/v1/".length);
  const select = u.searchParams.get("select");
  // v39's ride tables: any request to them is noted (spec 7.1: a shares run makes none), and answered as a table
  // that is not there
  if (table.startsWith("macd_ride")) {
    world.rideTables.push(`${method} ${table}`);
    return reply({ message: `relation "public.${table}" does not exist` }, 404);
  }
  if (method === "GET") world.reads.push(`${table} ${select ?? "*"}`);
  if (table === "rpc/track_outcomes_sweep_token") return reply("tok");
  const where = whereOf(u);
  if (table === "signal_alert_subscriptions" && method === "GET") return reply(world.subs.filter(where).map((r) => pick(r, select)));
  if (table === "profiles" && method === "GET") {
    const uid = u.searchParams.get("id")!.slice(3);
    return world.failPlanFor.has(uid) ? reply({ message: "boom" }, 503) : reply([{ plan: "light" }]);
  }
  if (table === "signal_alerts") {
    if (method === "GET") {
      // (as Deno says a request it could not send: its URL in the message)
      if (world.alertsThrowFor.has((u.searchParams.get("pair") ?? "").slice(3))) throw new TypeError(`error sending request for url (${url})`);
      if (world.alertsFailFor.has((u.searchParams.get("pair") ?? "").slice(3))) return reply({ message: "boom" }, 503);
      return reply(world.alerts.filter(where).map((r) => pick(r, select)));
    }
    if (method === "POST") {
      const key = (r: Row) => [r.user_id, r.kind, r.pair, r.interval, Date.parse(String(r.bar_time)), r.side, r.rule].join("|");
      if (world.alerts.some((r) => key(r) === key(body))) return reply([], 201);
      const row = { ...body, id: `alert-${++world.ids}` };
      world.alerts.push(row);
      return reply([{ id: row.id }], 201);
    }
    if (method === "PATCH") {
      for (const r of world.alerts.filter(where)) Object.assign(r, body);
      return empty(204);
    }
  }
  world.unrouted.push(`${method} ${table}?${u.searchParams.toString().slice(0, 90)}`);
  return reply([], 200);
};

type Handler = (req: Request) => Promise<Response>;
type Read = Record<string, unknown> & { pair?: string; signals?: string[]; fade?: Record<string, unknown> };
type Summary = Record<string, unknown> & { reads?: Read[] };

describe("v41 the shares' run: the real index.ts replayed over fake tables (spec 2.4, 2.5, 3.3, 3.4 and 7.1)", () => {
  let captured: Handler | null = null;
  const realSetTimeout = globalThis.setTimeout;
  beforeAll(() => {
    vi.stubGlobal("Deno", {
      env: { get: (k: string) => ({ SUPABASE_URL: SB, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "svc", RESEND_API_KEY: "re_test" } as Record<string, string>)[k] },
      serve: (h: Handler) => {
        captured = h;
      },
    });
    vi.stubGlobal("fetch", fakeFetch);
    // the function's sleeps (Resend two a second) pass at once, the clock moved on by them
    vi.stubGlobal("setTimeout", (fn: () => void, ms?: number) => {
      clock += Math.max(0, ms ?? 0);
      return realSetTimeout(fn, 0);
    });
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    // (absent in the test DOM, always there in Deno)
    const signal = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
    if (typeof signal.timeout !== "function") signal.timeout = () => new AbortController().signal;
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  beforeEach(() => resetWorld());

  // one import of the module is one instance: nothing of an earlier one's memory is in it
  const INDEX = "../../supabase/functions/signal-alerts/index.ts";
  const instance = async (): Promise<Handler> => {
    vi.resetModules();
    captured = null;
    await import(/* @vite-ignore */ INDEX);
    if (!captured) throw new Error("the function did not start");
    return captured;
  };
  // a run of the "stocks" mode at `when`
  const run = async (h: Handler, when: number): Promise<Summary> => {
    clock = when;
    const res = await h(new Request("https://fn.test/signal-alerts", { method: "POST", headers: { "x-sweep-token": "tok", "Content-Type": "application/json" }, body: JSON.stringify({ mode: "stocks" }) }));
    expect(res.status).toBe(200);
    const text = await res.text();
    // no run's record holds a follower, an address or a row id
    for (const no of ["userA", "userB", "userC", "example.test", "alert-", "user_id"]) expect(text, no).not.toContain(no);
    return JSON.parse(text) as Summary;
  };
  const fresh = async (when: number) => run(await instance(), when);
  // `minute` minutes and a second after bar i closed
  const after = (i: number, minute: number) => closeOf(i) + minute * MIN + 1_000;
  const follow = (user: string, pair = SYM, lang = "ja", interval = "15min") => ({ user_id: user, pair, interval, lang, rule: "stockmacd" });
  const readOf = (s: Summary, pair = SYM): Read | undefined => (s.reads ?? []).find((r) => r.pair === pair);
  const mails = () => world.sent.map((m) => `${m.to.split("@")[0]}: ${m.subject}`);
  const BUY_SUBJECT = "【Sextant】アップル（AAPL）15分足 買い（BUY）: 青い線が下の端の96%で確定（株の MACD）";
  const SELL_SUBJECT = "【Sextant】アップル（AAPL）15分足 売り（SELL・空売り）: 青い線が上の端の96%で確定（株の MACD）";
  // nothing the run asked for went unanswered; no read took every column or an alert's error; the bar's rows are
  // read whatever their side (one side a bar); Yahoo is read for the 15-minute bars (`15m` over `60d`, spec 3.3 item
  // 2); and, spec 7.1, a shares run makes no request to v39's ride tables (public.macd_rides, macd_ride_state)
  const clean = () => {
    expect(world.unrouted).toEqual([]);
    expect(world.rideTables).toEqual([]);
    for (const r of world.reads) {
      expect(r, r).not.toMatch(/ \*$/);
      expect(r, r).not.toContain("error");
      if (r.startsWith("signal_alerts ")) expect(r).toBe("signal_alerts user_id,side");
    }
    for (const y of world.yahoo) expect(y).toMatch(/^[A-Z0-9.]+ 15m 60d$/);
  };

  it("a US share's BUY at a close: one email a follower, the price the bar's close; read again before the next close by fresh instances, nobody is mailed twice and a follower whose plan lookup failed is mailed then; the row; the next close judged; nothing asked of v39's ride tables", async () => {
    world.subs = [follow("userA"), follow("userB")];
    world.failPlanFor.add("userB");
    const s0 = await fresh(after(I_BUY, 0));
    expect(s0).toMatchObject({ ok: true, mode: "stocks", subscriptions: 2, sent: 1, not_allowed: 1 });
    expect(String(s0.version)).toMatch(/^signal-alerts-v41-/);
    // (the follower whose lookup failed got no row: said, with no name)
    expect(readOf(s0)).toMatchObject({
      pair: SYM, due: iso(closeOf(I_BUY)), bars: I_BUY + 1, newest: dt(times[I_BUY]), close: closes[I_BUY], judged: true, signals: ["stockmacd:BUY"],
    });
    // (at least 600 closed bars in the 60 days a read brings)
    expect(Number(readOf(s0)!.bars)).toBeGreaterThanOrEqual(600);
    expect(readOf(s0)!.fade).toEqual({ fresh: true, entry: "BUY", price: closes[I_BUY], unsent: ["not_allowed"] });
    expect(mails()).toEqual([`userA: ${BUY_SUBJECT}`]);
    // the mail is the share's (renderStockMail), on the bar judged
    expect(world.sent[0].text).toBe(renderStockMail(usSig(I_BUY), "ja").text);
    // the row (spec 3.4): interval 15min, the bar's open and end (the open plus 15 minutes), the price in its close, no
    // stop, no target, the fade's id
    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]).toMatchObject({
      user_id: "userA", kind: "signal", pair: SYM, interval: "15min", bar_time: iso(times[I_BUY]), closed_at: iso(times[I_BUY] + STEP), side: "BUY",
      entry: closes[I_BUY], stop: null, target: null, rule: STOCKMACD_RULE_ID, event_id: null, status: "sent",
    });
    // read again before the next close, a fresh instance each time, the lookup working: the same bar judged again
    world.failPlanFor.clear();
    for (const m of [1, 2, 3, 4, 5, 10, 14]) {
      const s = await fresh(after(I_BUY, m));
      expect(readOf(s), `minute ${m}`).toMatchObject({ due: iso(closeOf(I_BUY)), judged: true, newest: dt(times[I_BUY]), signals: ["stockmacd:BUY"], fade: { fresh: true, entry: "BUY", price: closes[I_BUY] } });
      expect(readOf(s)!.fade, `minute ${m}`).not.toHaveProperty("unsent");
      expect(s.sent ?? 0, `minute ${m}`).toBe(m === 1 ? 1 : 0);
    }
    expect(mails()).toEqual([`userA: ${BUY_SUBJECT}`, `userB: ${BUY_SUBJECT}`]);
    expect(world.sent[1].text).toBe(world.sent[0].text);
    expect(world.alerts.map((r) => `${r.user_id} ${r.rule} ${r.entry}`)).toEqual([`userA ${STOCKMACD_RULE_ID} ${closes[I_BUY]}`, `userB ${STOCKMACD_RULE_ID} ${closes[I_BUY]}`]);
    // Yahoo was read once a run, 60 days of 15-minute bars
    expect(world.yahoo).toEqual(Array(8).fill("AAPL 15m 60d"));
    // the next close (15 minutes on): its bar judged, no entry, nothing mailed
    const s9 = await fresh(after(I_BUY + 1, 0));
    expect(readOf(s9)).toMatchObject({ due: iso(closeOf(I_BUY + 1)), judged: true, newest: dt(times[I_BUY + 1]), signals: [], fade: { fresh: true, entry: null, price: null } });
    expect(world.sent).toHaveLength(2);
    expect(typeof s9.took_ms).toBe("number");
    clean();
  });

  it("a US share's SELL at a session's last bar (15:45, ending 16:00 New York), read a second after the close: a short sale, its own text in each follower's language, the row's closed_at the bar's own end; past the last close's half hour nothing is read", async () => {
    world.subs = [follow("userA"), follow("userB", SYM, "en")];
    const s0 = await fresh(after(I_LAST, 0));
    expect(readOf(s0)).toMatchObject({
      due: iso(closeOf(I_LAST)), newest: dt(times[I_LAST]), close: closes[I_LAST], judged: true, signals: ["stockmacd:SELL"], fade: { fresh: true, entry: "SELL", price: closes[I_LAST] },
    });
    expect(mails()).toEqual([`userA: ${SELL_SUBJECT}`, "userB: [Sextant] Apple (AAPL) 15-minute SELL (short sale): the MACD line closed at 96% of the top (Stock MACD)"]);
    expect(world.sent[0].text).toBe(renderStockMail(usSig(I_LAST), "ja").text);
    expect(world.sent[1].text).toBe(renderStockMail(usSig(I_LAST), "en").text);
    expect(world.sent[0].text).toContain(`\nこの足の終値: ${closes[I_LAST].toFixed(2)}ドル\n${BREAK_JA}\n\n`);
    expect(world.sent[1].text).toContain(`\nThis bar's close: $${closes[I_LAST].toFixed(2)}\n${BREAK_EN}\n\n`);
    expect(world.alerts.map((r) => [r.side, r.interval, r.bar_time, r.closed_at, r.entry, r.stop, r.target, r.rule])).toEqual(
      Array(2).fill(["SELL", "15min", iso(times[I_LAST]), iso(times[I_LAST] + STEP), closes[I_LAST], null, null, STOCKMACD_RULE_ID]),
    );
    // 16:30 New York: still the last close's half hour; 16:31: nothing due, nothing read
    expect(readOf(await fresh(after(I_LAST, 29)))).toMatchObject({ due: iso(closeOf(I_LAST)) });
    const n = world.yahoo.length;
    expect((await fresh(after(I_LAST, 31))).reads).toEqual([]);
    expect(world.yahoo).toHaveLength(n);
    clean();
  });

  it("a Tokyo share, Yahoo fifteen minutes behind (docs §8.141): at the close the bar is not in yet; at the next close's read it is judged and mailed, some 15 minutes after its close; a bar that comes in 45 minutes after its close is still mailed, a second later it is not", async () => {
    const T = TOKYO;
    world.subs = [follow("userA", T.sym)];
    world.yahooLag = 15 * MIN;
    // at the close itself Yahoo's newest closed bar is the one before, ended 15 minutes ago: judged (no entry), nothing
    const s0 = await fresh(T.ends[T_MID] + 1_000);
    expect(readOf(s0, T.sym)).toMatchObject({ due: iso(T.ends[T_MID]), newest: dt(T.times[T_MID - 1]), judged: true, signals: [], fade: { fresh: true, entry: null, price: null } });
    expect(world.sent).toEqual([]);
    // fifteen minutes on (the next close's read) Yahoo has priced past the bar's end: the entry, 15 minutes old, mailed
    const s1 = await fresh(T.ends[T_MID] + 15 * MIN + 1_000);
    expect(readOf(s1, T.sym)).toMatchObject({
      due: iso(T.ends[T_MID] + STEP), newest: dt(T.times[T_MID]), close: T.closes[T_MID], judged: true, signals: ["stockmacd:SELL"], fade: { fresh: true, entry: "SELL", price: T.closes[T_MID] },
    });
    expect(readOf(s1, T.sym)!.judged_after_ms).toBeGreaterThanOrEqual(15 * MIN);
    expect(mails()).toEqual(["userA: 【Sextant】トヨタ自動車（7203.T）15分足 売り（SELL・空売り）: 青い線が上の端の96%で確定（株の MACD）"]);
    expect(world.sent[0].text).toBe(renderStockMail(tokyoSig(T_MID), "ja").text);
    expect(world.sent[0].text).toContain(`\n\n${ITEM8_TOKYO_JA}${ITEM8_ARRIVE_JA}\n\n`);
    expect(world.sent[0].text).toContain(`\nこの足の終値: ${T.closes[T_MID].toFixed(1)}円\n\n`);
    expect(world.alerts[0]).toMatchObject({
      pair: T.sym, interval: "15min", bar_time: iso(T.times[T_MID]), closed_at: iso(T.ends[T_MID]), side: "SELL", entry: T.closes[T_MID], stop: null, target: null, rule: STOCKMACD_RULE_ID,
    });
    clean();
    // 45 minutes behind: read at 11:45 JST (in the 11:30 close's half hour) the bar that closed at 11:00 is in, 45
    // minutes old: still mailed (STOCK_FRESH_MS)
    resetWorld();
    world.subs = [follow("userA", T.sym)];
    world.yahooLag = 45 * MIN;
    const s2 = await fresh(T.ends[T_MID] + 45 * MIN);
    expect(readOf(s2, T.sym)).toMatchObject({ due: iso(T.ends[T_MID] + 30 * MIN), newest: dt(T.times[T_MID]), judged: true, signals: ["stockmacd:SELL"], fade: { fresh: true, entry: "SELL" } });
    expect(world.sent).toHaveLength(1);
    // a second more: not mailed
    resetWorld();
    world.subs = [follow("userA", T.sym)];
    world.yahooLag = 45 * MIN + 1_000;
    const s3 = await fresh(T.ends[T_MID] + 45 * MIN + 1_000);
    expect(readOf(s3, T.sym)).toMatchObject({ newest: dt(T.times[T_MID]), judged: true, signals: [], fade: { fresh: false, entry: null, price: null } });
    expect(world.sent).toEqual([]);
    expect(world.alerts).toEqual([]);
    clean();
  });

  it("Tokyo's first close of the day (9:15 JST), Yahoo behind: no bar of the day in yet, so the close is taken as no session (harmless, spec 3.3 item 9) and the 9:00 bar is judged at the 9:30 close's reads", async () => {
    const T = TOKYO;
    // the day of T_MID: its 9:00 JST bar
    const first = T_MID - 7;
    expect(dt(T.times[first])).toBe("2025-09-02 00:00:00");
    world.subs = [follow("userA", T.sym)];
    // (Yahoo seventeen minutes behind, so that at 9:16 its newest bar is the day before's)
    world.yahooLag = 17 * MIN;
    const h = await instance();
    const s0 = await run(h, T.ends[first] + MIN);
    expect(s0.reads).toEqual([{ pair: T.sym, due: iso(T.ends[first]), skipped: "no_session" }]);
    // the 9:15 close is done: not read again in its half hour
    expect((await run(h, T.ends[first] + 5 * MIN)).reads).toEqual([]);
    // the 9:30 close: once the 9:15 bar is in, the 9:00 bar is closed and judged
    const s2 = await run(h, T.ends[first] + STEP + 3 * MIN + 1_000);
    expect(readOf(s2, T.sym)).toMatchObject({ due: iso(T.ends[first] + STEP), newest: dt(T.times[first]), judged: true });
    clean();
  });

  it("not fresh: Yahoo fifty minutes behind, the entry bar is the newest closed one but ended over 45 minutes before — judged, not mailed", async () => {
    world.subs = [follow("userA")];
    world.yahooLag = 50 * MIN;
    const s0 = await fresh(after(I_BUY, 50));
    expect(readOf(s0)).toMatchObject({ due: iso(closeOf(I_BUY) + 45 * MIN), newest: dt(times[I_BUY]), judged: true, signals: [], fade: { fresh: false, entry: null, price: null } });
    expect(world.sent).toEqual([]);
    expect(world.alerts).toEqual([]);
    clean();
  });

  it("a bar overtaken by the next closed bar before any read judged it is not judged (only the newest is), so its entry is never mailed", async () => {
    world.subs = [follow("userA")];
    // no run read the share in the BUY bar's 15 minutes; the first read comes after the next bar closed
    const s0 = await fresh(after(I_BUY + 1, 1));
    expect(readOf(s0)).toMatchObject({ due: iso(closeOf(I_BUY + 1)), newest: dt(times[I_BUY + 1]), judged: true, signals: [], fade: { fresh: true, entry: null, price: null } });
    const s1 = await fresh(after(I_BUY + 1, 2));
    expect(readOf(s1)).toMatchObject({ newest: dt(times[I_BUY + 1]), signals: [] });
    expect(world.sent).toEqual([]);
    expect(world.alerts).toEqual([]);
    clean();
  });

  it("one side a bar (spec 2.5): a row of the other side at the bar under the fade's id — nothing mailed, the record says other_side, the bar stays judged; another rule's row of the other side is no such row", async () => {
    world.subs = [follow("userA"), follow("userB")];
    world.alerts = [{ id: "alert-x", user_id: "userC", kind: "signal", pair: SYM, interval: "15min", bar_time: iso(times[I_BUY]), side: "SELL", rule: STOCKMACD_RULE_ID, status: "sent" }];
    const h = await instance();
    const s0 = await run(h, after(I_BUY, 0));
    expect(readOf(s0)).toMatchObject({ judged: true, signals: [] });
    expect(readOf(s0)!.fade).toEqual({ fresh: true, entry: "BUY", price: closes[I_BUY], other_side: true });
    expect(world.sent).toEqual([]);
    expect(world.alerts).toHaveLength(1);
    // held judged: the same instance leaves Yahoo alone until the next close
    expect((await run(h, after(I_BUY, 1))).reads).toEqual([]);
    expect(world.yahoo).toHaveLength(1);
    clean();
    // v40's 1-hour row of the other side at the same bar (another id) does not stop the fade's mail
    resetWorld();
    world.subs = [follow("userA")];
    world.alerts = [{ id: "alert-y", user_id: "userC", kind: "signal", pair: SYM, interval: "15min", bar_time: iso(times[I_BUY]), side: "SELL", rule: "stockmacd_12_26_9_w600_1h_fade96of120_in_v4", status: "sent" }];
    const s1 = await fresh(after(I_BUY, 0));
    expect(readOf(s1)).toMatchObject({ signals: ["stockmacd:BUY"] });
    expect(readOf(s1)!.fade).not.toHaveProperty("other_side");
    expect(mails()).toEqual([`userA: ${BUY_SUBJECT}`]);
    clean();
  });

  it("one side a bar holds when the bar's rows cannot be read (a 503): nothing mailed, an error, the bar not settled; the next run before the next close reads them, other_side, settled", async () => {
    world.subs = [follow("userA")];
    world.alerts = [{ id: "alert-x", user_id: "userC", kind: "signal", pair: SYM, interval: "15min", bar_time: iso(times[I_BUY]), side: "SELL", rule: STOCKMACD_RULE_ID, status: "sent" }];
    world.alertsFailFor.add(SYM);
    const h = await instance();
    const s0 = await run(h, after(I_BUY, 0));
    // (an unread table is not "no row of either side": the read throws before anything is mailed or claimed)
    expect(readOf(s0)).toMatchObject({ judged: true, signals: [] });
    expect(readOf(s0)!.fade).toEqual({ fresh: true, entry: "BUY", price: closes[I_BUY], error: "failed" });
    expect(world.sent).toEqual([]);
    expect(world.alerts.map((r) => r.side)).toEqual(["SELL"]);
    // the same instance, a minute on, the table read again: the bar was not settled, so it is judged again and the row
    // of the other side is seen; settled then, Yahoo is left alone until the next close
    world.alertsFailFor.clear();
    const s1 = await run(h, after(I_BUY, 1));
    expect(readOf(s1)).toMatchObject({ judged: true, signals: [] });
    expect(readOf(s1)!.fade).toEqual({ fresh: true, entry: "BUY", price: closes[I_BUY], other_side: true });
    expect((await run(h, after(I_BUY, 2))).reads).toEqual([]);
    expect(world.yahoo).toHaveLength(2);
    expect(world.sent).toEqual([]);
    expect(world.alerts.map((r) => r.side)).toEqual(["SELL"]);
    clean();
    // with no row of the other side: the unread table mails nothing; the next run mails the follower once
    resetWorld();
    world.subs = [follow("userA")];
    world.alertsFailFor.add(SYM);
    const g = await instance();
    const t0 = await run(g, after(I_BUY, 0));
    expect(readOf(t0)!.fade).toEqual({ fresh: true, entry: "BUY", price: closes[I_BUY], error: "failed" });
    expect(world.sent).toEqual([]);
    expect(world.alerts).toEqual([]);
    world.alertsFailFor.clear();
    const t1 = await run(g, after(I_BUY, 1));
    expect(readOf(t1)).toMatchObject({ judged: true, signals: ["stockmacd:BUY"], fade: { fresh: true, entry: "BUY", price: closes[I_BUY] } });
    expect(readOf(t1)!.fade).not.toHaveProperty("error");
    expect(mails()).toEqual([`userA: ${BUY_SUBJECT}`]);
    expect(world.alerts.map((r) => [r.user_id, r.side, r.entry])).toEqual([["userA", "BUY", closes[I_BUY]]]);
    clean();
  });

  it("an instance kept warm: a follower whose address lookup failed has no row and the bar stays unsettled, so the next run mails them; settled then, Yahoo is left alone until the next close; the next close is read again", async () => {
    world.subs = [follow("userA"), follow("userB")];
    world.failAuthFor.set("userB", 503);
    const h = await instance();
    const s0 = await run(h, after(I_BUY, 0));
    expect(readOf(s0)).toMatchObject({ judged: true, signals: ["stockmacd:BUY"], fade: { fresh: true, entry: "BUY", unsent: ["lookup_failed"] } });
    expect(s0).toMatchObject({ sent: 1, lookup_failed: 1 });
    expect(mails()).toEqual([`userA: ${BUY_SUBJECT}`]);
    expect(world.alerts.map((r) => `${r.user_id} ${r.status}`)).toEqual(["userA sent"]);
    world.failAuthFor.clear();
    const s1 = await run(h, after(I_BUY, 1));
    expect(readOf(s1)).toMatchObject({ judged: true, signals: ["stockmacd:BUY"], fade: { fresh: true, entry: "BUY" } });
    expect(readOf(s1)!.fade).not.toHaveProperty("unsent");
    expect(mails()).toEqual([`userA: ${BUY_SUBJECT}`, `userB: ${BUY_SUBJECT}`]);
    expect(world.sent[1].text).toBe(world.sent[0].text);
    for (const m of [2, 10, 14]) expect((await run(h, after(I_BUY, m))).reads).toEqual([]);
    expect(world.yahoo).toHaveLength(2);
    const s5 = await run(h, after(I_BUY + 1, 0));
    expect(readOf(s5)).toMatchObject({ judged: true, newest: dt(times[I_BUY + 1]), signals: [], fade: { fresh: true, entry: null, price: null } });
    expect(world.yahoo).toHaveLength(3);
    expect(world.sent).toHaveLength(2);
    clean();
  });

  it("one share's failure does not cost another its judgment: the failed one is not held judged and is mailed by the next run; what is logged holds no address; Yahoo failing is said", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      world.subs = [follow("userA"), follow("userA", "MSFT")];
      world.alertsThrowFor.add(SYM);
      const h = await instance();
      const s0 = await run(h, after(I_BUY, 0));
      expect(readOf(s0, SYM)).toMatchObject({ judged: true, signals: [] });
      expect(readOf(s0, SYM)!.fade).toEqual({ fresh: true, entry: "BUY", price: closes[I_BUY], error: "failed" });
      expect(readOf(s0, "MSFT")).toMatchObject({ judged: true, signals: ["stockmacd:BUY"], fade: { fresh: true, entry: "BUY", price: closes[I_BUY] } });
      expect(mails()).toEqual(["userA: 【Sextant】マイクロソフト（MSFT）15分足 買い（BUY）: 青い線が下の端の96%で確定（株の MACD）"]);
      const failed = logged.filter((l) => l.startsWith("stockmacd failed:"));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain("AAPL");
      expect(failed[0]).toContain("(url)");
      for (const no of ["sb.test", "userA", "example.test"]) expect(failed[0], no).not.toContain(no);
      // the same instance, a minute on: AAPL is read and judged again (MSFT's bar is settled), and mailed
      world.alertsThrowFor.clear();
      const s1 = await run(h, after(I_BUY, 1));
      expect(s1.reads!.map((r) => r.pair)).toEqual([SYM]);
      expect(readOf(s1, SYM)).toMatchObject({ judged: true, signals: ["stockmacd:BUY"], fade: { fresh: true, entry: "BUY" } });
      expect(mails()).toEqual(["userA: 【Sextant】マイクロソフト（MSFT）15分足 買い（BUY）: 青い線が下の端の96%で確定（株の MACD）", `userA: ${BUY_SUBJECT}`]);
      clean();
      // Yahoo failing for a read: said, nothing judged
      resetWorld();
      world.subs = [follow("userA")];
      world.yahooStatus = 429;
      expect((await fresh(after(I_BUY, 0))).reads).toEqual([{ pair: SYM, error: "yahoo_429" }]);
      expect(world.sent).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("nobody follows a share under 'stockmacd': nothing is read; a '1h' row (v40's, left until spec 3.6's later delete) is read as no follower", async () => {
    const s0 = await fresh(after(I_BUY, 0));
    expect(s0).toMatchObject({ ok: true, mode: "stocks", subscriptions: 0 });
    expect(s0.reads).toBeUndefined();
    expect(world.yahoo).toEqual([]);
    expect(world.reads).toEqual(["signal_alert_subscriptions user_id,pair,interval,lang,rule"]);
    world.subs = [follow("userA", SYM, "ja", "1h")];
    const s1 = await fresh(after(I_BUY, 0));
    expect(s1).toMatchObject({ subscriptions: 0 });
    expect(world.yahoo).toEqual([]);
    expect(world.sent).toEqual([]);
    // with a '15min' twin beside it, the share is read and mailed once, under the '15min' row
    world.subs = [follow("userA", SYM, "ja", "1h"), follow("userA")];
    const s2 = await fresh(after(I_BUY, 0));
    expect(s2).toMatchObject({ subscriptions: 1, sent: 1 });
    expect(world.alerts.map((r) => r.interval)).toEqual(["15min"]);
    clean();
  });

  describe("the run's time budget (spec 3.3 item 10)", () => {
    const US = STOCKMACD_PAIRS.filter((p) => !p.endsWith(".T"));

    it("with slow Yahoo reads (10 seconds each) no read is started once 30 seconds have passed; the shares left are said as skipped: \"budget\" and are read first by the next run; took_ms says how long the run took", async () => {
      expect(US).toEqual(["NVDA", "INTC", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA"]);
      world.subs = US.map((p) => follow("userA", p));
      world.yahooDelayMs = 10_000;
      // (Yahoo sixteen minutes behind: the bar due is not in, so no close is done and every share stays to be read)
      world.yahooLag = 16 * MIN;
      const h = await instance();
      const s0 = await run(h, after(I_BUY + 1, 0));
      // reads start at 0, 10 and 20 seconds; at 30 seconds the budget is reached: none started after
      expect(s0.reads!.map((r) => [r.pair, r.skipped ?? "read"])).toEqual([
        ["NVDA", "read"], ["INTC", "read"], ["AAPL", "read"],
        ["MSFT", "budget"], ["GOOGL", "budget"], ["AMZN", "budget"], ["META", "budget"], ["TSLA", "budget"],
      ]);
      expect(s0.reads!.filter((r) => r.skipped === "budget").every((r) => Object.keys(r).sort().join() === "pair,skipped")).toBe(true);
      expect(world.yahoo.map((y) => y.split(" ")[0])).toEqual(["NVDA", "INTC", "AAPL"]);
      expect(s0.took_ms).toBe(30_000);
      // the next run, a minute on: the shares left first (never read), then the ones read a minute ago
      const s1 = await run(h, after(I_BUY + 1, 1));
      expect(s1.reads!.map((r) => [r.pair, r.skipped ?? "read"])).toEqual([
        ["MSFT", "read"], ["GOOGL", "read"], ["AMZN", "read"],
        ["META", "budget"], ["TSLA", "budget"], ["NVDA", "budget"], ["INTC", "budget"], ["AAPL", "budget"],
      ]);
      expect(world.yahoo.map((y) => y.split(" ")[0]).slice(3)).toEqual(["MSFT", "GOOGL", "AMZN"]);
      // and the one after: META and TSLA, never read, first; then the oldest read
      const s2 = await run(h, after(I_BUY + 1, 2));
      expect(s2.reads!.map((r) => [r.pair, r.skipped ?? "read"]).slice(0, 3)).toEqual([["META", "read"], ["TSLA", "read"], ["NVDA", "read"]]);
      clean();
    });

    it("with fast reads every followed share is read as before, none skipped; took_ms is said", async () => {
      world.subs = US.map((p) => follow("userA", p));
      const s0 = await fresh(after(I_BUY + 1, 0));
      expect(s0.reads!.map((r) => r.pair)).toEqual(US);
      expect(s0.reads!.some((r) => r.skipped === "budget")).toBe(false);
      expect(world.yahoo).toHaveLength(US.length);
      expect(s0.took_ms).toBe(0);
      clean();
    });

    it("is written as the spec says: the shares oldest read first, no read started once the budget is spent, the share left with its read time not set, took_ms", () => {
      const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
      const runCode = fn.slice(fn.indexOf("const stockSweep = async"), fn.indexOf("const goldTicks = async"));
      expect(runCode).toContain(".sort((a, b) => a.at - b.at || a.k - b.k)");
      expect(runCode).toContain("at: stockReadAt.get(sym) ?? Number.NEGATIVE_INFINITY");
      expect(runCode).toMatch(/if \(Date\.now\(\) - nowMs >= STOCK_RUN_BUDGET_MS\) \{\s+reads\.push\(\{ pair: sym, skipped: "budget" \}\);\s+continue;\s+\}\s+stockReadAt\.set\(sym, nowMs\);/);
      expect(runCode).toContain("return { ...summary, reads, ...counts, took_ms: Date.now() - nowMs };");
      // the 50-second spacing stays
      expect(runCode).toContain("if (nowMs - (stockReadAt.get(sym) ?? 0) < 50_000) continue;");
    });
  });
});
