// #391 (docs §8.134): the MACD email on shares (signal-alerts v35) — the 22 shares' hourly bars from Yahoo, each
// session's bar closes (Tokyo's lunch break and closing auction, New York's 16:00, daylight saving), when a bar is in,
// the run's steps, the email with no stop or target — and its tab in the settings.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import SignalAlertSettings from "../components/SignalAlertSettings";
import { normalizeAlertSettings } from "../lib/signalAlerts";
import {
  STOCKMACD_INTERVALS,
  STOCKMACD_PAIRS,
  STOCKMACD_RULE_ID,
  type StockBar,
  renderStockMail,
  stockBarEnd,
  stockBarsOf,
  stockCloseDue,
  stockmacdSignals,
  stockSweepOf,
} from "../../supabase/functions/signal-alerts/stocks";
import {
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  INDICATOR_RULES,
  indicatorRuleId,
  isIndicatorChartFor,
  isIndicatorRule,
  renderIndicatorMail,
} from "../../supabase/functions/signal-alerts/indicators";
import { renderTestMail } from "../../supabase/functions/signal-alerts/logic";
import { decideZoneOnWindow } from "../../supabase/functions/_shared/macd-level";
import { JP_STOCKS, US_STOCKS } from "../lib/stocks";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);
const MIN = 60_000;
const H = 60 * MIN;
const at = (iso: string) => Date.parse(iso);

describe("#391 when a share's hourly bar closes (signal-alerts/stocks.ts)", () => {
  it("is the chart's list of shares, on the 1-hour chart, under its own id", () => {
    expect([...STOCKMACD_PAIRS]).toEqual([...US_STOCKS, ...JP_STOCKS].map((s) => s.symbol));
    expect([...STOCKMACD_INTERVALS]).toEqual(["1h"]);
    expect(STOCKMACD_RULE_ID).toBe("stockmacd_12_26_9_w600_1h_z95of120_v1");
    expect(INDICATOR_RULES).toContain("stockmacd");
    expect(isIndicatorRule("stockmacd")).toBe(true);
    expect(indicatorRuleId("stockmacd")).toBe(STOCKMACD_RULE_ID);
    expect(isIndicatorChartFor("stockmacd", "AAPL", "1h")).toBe(true);
    expect(isIndicatorChartFor("stockmacd", "7203.T", "1h")).toBe(true);
    expect(isIndicatorChartFor("stockmacd", "IBM", "1h")).toBe(false);
    expect(isIndicatorChartFor("stockmacd", "AAPL", "15min")).toBe(false);
    expect(isIndicatorChartFor("stockmacd", "USD/JPY", "1h")).toBe(false);
    // the FX rules do not take a share
    expect(isIndicatorChartFor("macdx", "AAPL", "1h")).toBe(false);
    expect(isIndicatorChartFor("ultra", "AAPL", "1h")).toBe(false);
  });

  it("is due in the half hour after a session's close, New York's with daylight saving, Tokyo's with the lunch break", () => {
    // Friday 2026-10-30 (New York on daylight time, UTC−4): 10:30 local = 14:30 UTC
    expect(stockCloseDue("AAPL", at("2026-10-30T14:31:20Z"))).toBe(at("2026-10-30T14:30:00Z"));
    expect(stockCloseDue("AAPL", at("2026-10-30T15:00:00Z"))).toBe(at("2026-10-30T14:30:00Z"));
    // 16:00 local, the last
    expect(stockCloseDue("AAPL", at("2026-10-30T20:05:00Z"))).toBe(at("2026-10-30T20:00:00Z"));
    // 9:45 local: nothing has closed yet today
    expect(stockCloseDue("AAPL", at("2026-10-30T13:45:00Z"))).toBeNull();
    // Monday 2026-11-02 (standard time, UTC−5): 10:30 local = 15:30 UTC, not 14:30
    expect(stockCloseDue("AAPL", at("2026-11-02T14:35:00Z"))).toBeNull();
    expect(stockCloseDue("AAPL", at("2026-11-02T15:31:00Z"))).toBe(at("2026-11-02T15:30:00Z"));
    // Saturday
    expect(stockCloseDue("AAPL", at("2026-10-31T14:31:00Z"))).toBeNull();
    // Tokyo, Monday 2026-11-02: 10:00, 11:30 (the morning's end), 13:00, 15:30 JST
    expect(stockCloseDue("7203.T", at("2026-11-02T01:00:30Z"))).toBe(at("2026-11-02T01:00:00Z"));
    expect(stockCloseDue("7203.T", at("2026-11-02T02:35:00Z"))).toBe(at("2026-11-02T02:30:00Z"));
    // 12:05 JST: 35 minutes after the morning's end, nothing due
    expect(stockCloseDue("7203.T", at("2026-11-02T03:05:00Z"))).toBeNull();
    expect(stockCloseDue("7203.T", at("2026-11-02T04:00:00Z"))).toBe(at("2026-11-02T04:00:00Z"));
    expect(stockCloseDue("7203.T", at("2026-11-02T06:45:00Z"))).toBe(at("2026-11-02T06:30:00Z"));
    expect(stockCloseDue("7203.T", at("2026-11-02T07:01:00Z"))).toBeNull();
  });

  it("ends each bar where the session does: Tokyo's 11:00 and 15:00 bars, New York's 15:30, an early close", () => {
    expect(stockBarEnd("AAPL", at("2026-10-30T19:30:00Z"))).toBe(at("2026-10-30T20:00:00Z"));
    expect(stockBarEnd("AAPL", at("2026-10-30T18:30:00Z"))).toBe(at("2026-10-30T19:30:00Z"));
    expect(stockBarEnd("AAPL", at("2026-11-02T20:30:00Z"))).toBe(at("2026-11-02T21:00:00Z"));
    expect(stockBarEnd("7203.T", at("2026-11-02T02:00:00Z"))).toBe(at("2026-11-02T02:30:00Z"));
    expect(stockBarEnd("7203.T", at("2026-11-02T06:00:00Z"))).toBe(at("2026-11-02T06:30:00Z"));
    // the bar stamped 12:00 JST runs 12:30-13:00
    expect(stockBarEnd("7203.T", at("2026-11-02T03:00:00Z"))).toBe(at("2026-11-02T04:00:00Z"));
    // a session that ends at 13:00 local (a half day): its 12:30 bar ends then
    expect(stockBarEnd("AAPL", at("2026-11-27T17:30:00Z"), at("2026-11-27T18:00:00Z"))).toBe(at("2026-11-27T18:00:00Z"));
  });

  // Intel's hourly bars of Friday 2026-10-30 as Yahoo answered (live-chart's stocks.test.tsx), and the same day while
  // it was trading (the last bar forming)
  const intc = (marketTime: number, n = 8, end = 1793390400) => ({
    chart: {
      result: [{
        meta: { symbol: "INTC", gmtoffset: -14400, regularMarketPrice: 65.76, regularMarketTime: marketTime, currentTradingPeriod: { regular: { start: 1793367000, end } } },
        timestamp: [1793367000, 1793370600, 1793374200, 1793377800, 1793381400, 1793385000, 1793388600, 1793390400].slice(0, n),
        indicators: {
          quote: [{
            open: [68.35, 65.94, 65.9796, 64.755, 64.38, 63.7839, 63.875, 65.76].slice(0, n),
            high: [68.76, 67.41, 66.0974, 65.0, 64.3995, 64.2, 65.88, 65.76].slice(0, n),
            low: [64.12, 65.6301, 64.26, 64.105, 63.5, 63.2001, 63.58, 65.76].slice(0, n),
            close: [65.94, 65.9725, 64.7599, 64.385, 63.785, 63.875, 65.88, 65.76].slice(0, n),
          }],
        },
      }],
    },
  });

  it("takes a bar as closed once Yahoo has priced past its end, the last of the session on the closing auction's price", () => {
    // 16:01 local: the closing point is in and joined to the 15:30 bar; every bar closed
    const after = stockBarsOf("INTC", intc(1793390401), at("2026-10-30T20:01:00Z"))!;
    expect(after.bars).toHaveLength(7);
    expect(after.bars.every((b) => b.closed)).toBe(true);
    expect(after.bars[6]).toMatchObject({ datetime: "2026-10-30 19:30:00", close: 65.76, end: at("2026-10-30T20:00:00Z") });
    // 16:00:30 local, Yahoo's last trade 15:59:58 and no closing point yet: the 15:30 bar is not in
    const before = stockBarsOf("INTC", intc(1793390398, 7), at("2026-10-30T20:00:30Z"))!;
    expect(before.bars).toHaveLength(7);
    expect(before.bars[6].closed).toBe(false);
    expect(before.bars[5].closed).toBe(true);
    expect(before.bars[6].close).toBe(65.88);
    // rounded as the chart's history (2 decimals)
    expect(after.bars[2].open).toBe(65.98);
    expect(stockBarsOf("INTC", null, at("2026-10-30T20:01:00Z"))).toBeNull();
  });

  it("judges the newest closed bar once, is done when the bar due is in, and skips a day with no bars", () => {
    const bars = stockBarsOf("INTC", intc(1793390401), at("2026-10-30T20:01:00Z"))!.bars;
    const due = at("2026-10-30T20:00:00Z");
    const first = stockSweepOf("INTC", bars, due, undefined, at("2026-10-30T20:01:00Z"));
    expect(first).toMatchObject({ judge: true, done: true, noSession: false });
    expect(first.newest!.datetime).toBe("2026-10-30 19:30:00");
    // fewer than 600 bars: no email
    expect(first.signals).toEqual([]);
    const again = stockSweepOf("INTC", bars, due, first.newest!.open_ms, at("2026-10-30T20:02:00Z"));
    expect(again.judge).toBe(false);
    // the bar due (16:00) not in yet: judged what is, not done
    const early = stockBarsOf("INTC", intc(1793390398, 7), at("2026-10-30T20:00:30Z"))!.bars;
    const wait = stockSweepOf("INTC", early, due, undefined, at("2026-10-30T20:00:30Z"));
    expect(wait.done).toBe(false);
    expect(wait.newest!.datetime).toBe("2026-10-30 18:30:00");
    // Monday 10:30 New York with the newest bar Friday's (a holiday): nothing to do that close
    const holiday = stockSweepOf("INTC", bars, at("2026-11-02T15:30:00Z"), undefined, at("2026-11-02T15:31:00Z"));
    expect(holiday).toMatchObject({ noSession: true, done: true, judge: false, signals: [] });
  });
});

describe("#391 the MACD email on a share", () => {
  // an hourly walk on New York's sessions (13:30-19:30 UTC bars, weekdays), the first bar where the rule fires
  const session = (n: number, seed: number): StockBar[] => {
    let s = seed;
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const out: StockBar[] = [];
    let p = 200;
    let day = at("2025-01-06T00:00:00Z");
    while (out.length < n) {
      const wd = new Date(day).getUTCDay();
      if (wd !== 0 && wd !== 6) {
        for (let h = 0; h < 7 && out.length < n; h++) {
          const open = day + 13.5 * H + h * H;
          const o = p;
          p = o + (rnd() - 0.5) * 2 + Math.sin(out.length / 40) * 0.4;
          const c = Number(p.toFixed(2));
          out.push({
            datetime: new Date(open).toISOString().slice(0, 19).replace("T", " "),
            open: Number(o.toFixed(2)), high: Number((Math.max(o, p) + 0.3).toFixed(2)), low: Number((Math.min(o, p) - 0.3).toFixed(2)), close: c,
            open_ms: open, end: stockBarEnd("AAPL", open), closed: true,
          });
        }
      }
      day += 24 * H;
    }
    return out;
  };
  const firing = (() => {
    const bars = session(1400, 7);
    for (let i = 599; i < bars.length; i++) if (decideZoneOnWindow(bars, i)) return bars.slice(0, i + 1);
    throw new Error("no entry in the walk");
  })();
  const last = firing[firing.length - 1];

  it("mails the rule's entry on the newest closed bar while fresh, with the MACD numbers and no stop or target", () => {
    const sigs = stockmacdSignals("AAPL", firing, last.end + MIN);
    expect(sigs).toHaveLength(1);
    const z = decideZoneOnWindow(firing, firing.length - 1)!;
    expect(sigs[0]).toMatchObject({
      rule: "stockmacd", pair: "AAPL", interval: "1h", side: z.side, close: last.close, sl: null, tps: null,
      barTime: new Date(last.open_ms).toISOString(), closedAt: new Date(last.end).toISOString(),
    });
    expect(sigs[0].macdh).toEqual({ m: z.m, top: z.top, bottom: z.bottom, mark: z.mark });
    // 46 minutes after the close, another share, too few bars: none
    expect(stockmacdSignals("AAPL", firing, last.end + 46 * MIN)).toEqual([]);
    expect(stockmacdSignals("IBM", firing, last.end + MIN)).toEqual([]);
    expect(stockmacdSignals("AAPL", firing.slice(-599), last.end + MIN)).toEqual([]);
    // the run takes it in
    expect(stockSweepOf("AAPL", firing, last.end, undefined, last.end + MIN).signals).toHaveLength(1);
  });

  it("writes the email in Japanese and English: the share's name, the close, the MACD, Yahoo, and no stop or target", () => {
    const sig = stockmacdSignals("AAPL", firing, last.end + MIN)[0];
    const ja = renderIndicatorMail(sig, "ja");
    expect(ja).toEqual(renderStockMail(sig, "ja"));
    const sideJa = sig.side === "BUY" ? "買い（BUY）" : "売り（SELL）";
    expect(ja.subject).toBe(`【Sextant】アップル（AAPL） 1時間足 ${sideJa}のサイン（株の MACD）`);
    expect(ja.text).toContain(`アップル（AAPL、米国）の1時間足で、MACD の山・谷の${sideJa}のサインが出ました。`);
    expect(ja.text).toContain(`終値 ${last.close.toFixed(2)}ドル`);
    expect(ja.text).toContain("95%以上（0の線から測って）に届きました");
    expect(ja.text).toContain("損切り・利確の目安は付けていません。");
    expect(ja.text).not.toContain("エントリー ≈");
    expect(ja.text).not.toContain("利確1");
    expect(ja.text).toContain("Yahoo Finance");
    expect(ja.text).toContain("「株の MACD」でチェックを外してください");
    expect(ja.text).not.toContain("東証の値段");
    const en = renderIndicatorMail(sig, "en");
    expect(en.subject).toBe(`[Sextant] Apple (AAPL) 1-hour ${sig.side} signal (stock MACD)`);
    expect(en.text).toContain(`Close $${last.close.toFixed(2)}`);
    expect(en.text).toContain("No stop or target is given.");
    expect(en.text).not.toContain("TP1");
    // a Tokyo share: yen, its market, the lag not checked
    const toyota = renderStockMail({ ...sig, pair: "7203.T", close: 3070 }, "ja");
    expect(toyota.subject).toContain("トヨタ自動車（7203.T）");
    expect(toyota.text).toContain("終値 3070.0円");
    expect(toyota.text).toContain("東証の値段が Yahoo で何分遅れているかは、まだ確かめていません。");
    expect(renderStockMail({ ...sig, pair: "7203.T", close: 3070 }, "en").text).toContain("Close 3070.0 yen");
  });

  it("runs every minute as its own mode, reads only its own subscriptions, and the database takes the shares and the rule", () => {
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    expect(fn).toContain('const FUNCTION_VERSION = "signal-alerts-v35-2026-10-31T16:00:00Z";');
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=eq.stockmacd&select=user_id,pair,interval,lang,rule")');
    // the other rules' run does not take them
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3,emarm)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toContain('if (body.mode === "stocks") {');
    expect(fn).toContain("stockmacd: { pairs: STOCKMACD_PAIRS, intervals: STOCKMACD_INTERVALS },");
    expect(renderTestMail([{ pair: "AAPL", interval: "1h", rule: "stockmacd" }], "ja").text).toContain("AAPL 1時間足（株の MACD）");
    const mig = readFileSync("supabase/migrations/20261031160000_signal_alert_stockmacd.sql", "utf8");
    expect(mig).toContain("'emarm', 'stockmacd']));");
    for (const s of STOCKMACD_PAIRS) expect(mig).toContain(`'${s}'`);
    const cron = readFileSync("supabase/migrations/20261031160100_stockmacd_sweep.sql", "utf8");
    expect(cron).toContain("'signal-alerts-stocks',\n  '* * * * *',");
    expect(cron).toContain(`body := '{"mode":"stocks"}'::jsonb,`);
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

  it("has its own tab with the 22 shares named on the 1-hour chart, its notes, and saves a tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      normalizeAlertSettings(body.action === "set" ? payload({ subscriptions: [{ pair: "7203.T", interval: "1h", rule: "stockmacd" }] }) : payload())!
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-rule-stockmacd").textContent).toBe("株の MACD");
    expect(screen.getByTestId("signal-alerts-indicator-intro").textContent).toContain("メールに損切り・利確の目安は入りません");
    const rows = screen.getByTestId("signal-alerts-grid").querySelectorAll("tbody tr");
    // the shares, and the row for all of them
    expect(rows.length).toBe(STOCKMACD_PAIRS.length + 1);
    expect(screen.getByTestId("signal-alerts-grid").textContent).toContain("7203.Tトヨタ自動車");
    expect(screen.getByTestId("signal-alert-stockmacd-AAPL-1h")).toBeTruthy();
    expect(screen.queryByTestId("signal-alert-stockmacd-AAPL-15min")).toBeNull();
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("損切り・利確の目安は付けていません。");
    expect(notes).toContain("1,696回が届き（99.36%）");
    expect(notes).toContain("含み損の合計 −1,837.40%");
    fireEvent.click(screen.getByTestId("signal-alert-stockmacd-7203.T-1h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "7203.T", interval: "1h", on: true, rule: "stockmacd", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-stockmacd-7203.T-1h") as HTMLInputElement).checked).toBe(true));
  });

  it("from a server that does not send its charts: says it is not available yet", async () => {
    const call = vi.fn(async () => normalizeAlertSettings(payload({ indicator: { rules: INDICATOR_RULES, pairs: INDICATOR_PAIRS, intervals: INDICATOR_INTERVALS, limited: {} } }))!);
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-stockmacd-unavailable")).toBeTruthy();
  });
});
