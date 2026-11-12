import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, cleanup, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import SignalAlertSettings from "../components/SignalAlertSettings";
import { ja } from "../lib/i18n/ja";
import { en } from "../lib/i18n/en";
import { AlertRequestError, indicatorChartOffered, normalizeAlertSettings, type AlertSettings } from "../lib/signalAlerts";
import {
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  MACDH_INTERVALS,
  MACDH_PAIRS,
  SWEEPX_INTERVALS,
  SWEEPX_PAIRS,
  SWEEPX_RULE_ID,
  indicatorIntervalsFor,
} from "../../supabase/functions/signal-alerts/indicators";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const payload = (over: Record<string, unknown> = {}) => ({
  ok: true,
  allowed: true,
  email_configured: true,
  email: "me@example.com",
  pairs: ["USD/JPY", "EUR/JPY"],
  intervals: ["15min", "1h", "4h", "1day"],
  subscriptions: [{ pair: "USD/JPY", interval: "15min" }],
  alerts: [
    {
      id: "a1",
      kind: "signal",
      pair: "USD/JPY",
      interval: "15min",
      side: "BUY",
      closed_at: "2026-09-25T01:00:00.000Z",
      entry: 149.5,
      stop: 149.42,
      target: 149.62,
      status: "sent",
      skip_reason: null,
      created_at: "2026-09-25T01:02:10.000Z",
    },
    {
      id: "a2",
      kind: "signal",
      pair: "USD/JPY",
      interval: "15min",
      side: "SELL",
      closed_at: "2026-09-24T19:00:00.000Z",
      entry: 149.9,
      stop: 149.98,
      target: 149.78,
      status: "skipped",
      skip_reason: "costly_hours",
      created_at: "2026-09-24T19:02:05.000Z",
    },
    { id: "bad", kind: "signal", status: "sent" },
  ],
  ...over,
});

const settings = (over: Record<string, unknown> = {}): AlertSettings => normalizeAlertSettings(payload(over))!;

beforeEach(() => {
  toast.success.mockReset();
  toast.warning.mockReset();
  toast.error.mockReset();
});

describe("the settings as they arrive", () => {
  it("keep the well-formed rows and drop the rest", () => {
    const s = settings();
    expect(s.alerts.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(s.alerts[1].skipReason).toBe("costly_hours");
    expect(normalizeAlertSettings({ ok: false })).toBeNull();
    expect(normalizeAlertSettings({ ok: true, allowed: true })).toBeNull();
  });
});

describe("the email-alert card", () => {
  it("shows what is followed and saves a tick in the app's language", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? settings({ subscriptions: [{ pair: "USD/JPY", interval: "15min" }, { pair: "EUR/JPY", interval: "1h" }] }) : settings()
    );
    render(<SignalAlertSettings call={call} />);
    const on = await screen.findByTestId("signal-alert-USD/JPY-15min");
    expect((on as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/me@example\.com/)).toBeTruthy();
    const off = screen.getByTestId("signal-alert-EUR/JPY-1h") as HTMLInputElement;
    expect(off.checked).toBe(false);
    fireEvent.click(off);
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "EUR/JPY", interval: "1h", on: true, rule: "rsi_sar", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-EUR/JPY-1h") as HTMLInputElement).checked).toBe(true));
  });

  it("#112: follows the GA-style rule separately, with its own record and what it was measured at", async () => {
    const ga = { rule: "gainz_v2a_050_50_5_atr1_v1" };
    const gaPerf = {
      mine: { n: 0, wins: 0, losses: 0, expired: 0, open: 0, winRate: null, meanR: null, ciR: null, sumR: 0 },
      all: { n: 4, wins: 1, losses: 3, expired: 0, open: 2, winRate: 0.25, meanR: -0.26, ciR: null, sumR: -1.04 },
      costly: { n: 0, wins: 0, losses: 0, expired: 0, open: 0, winRate: null, meanR: null, ciR: null, sumR: 0 },
      byTf: {},
      backtest: { period: "2025-07〜2026-09", n: 10757, winRate: 0.288, meanR: -0.134, breakeven: 1 / 3 },
    };
    const base = {
      mine: gaPerf.mine,
      all: { ...gaPerf.all, n: 7, wins: 3, losses: 4, winRate: 0.43, meanR: 0.1 },
      costly: gaPerf.costly,
      byTf: {},
      backtest: { period: "2025-07〜2026-09", n: 1255, winRate: 0.35, meanR: -0.125, breakeven: 0.4 },
    };
    const withGa = (subs: unknown[]) => settings({
      subscriptions: subs,
      performance: { days: 365, ...base, gainz: gaPerf },
      alerts: [{ id: "g1", kind: "signal", pair: "USD/JPY", interval: "4h", side: "SELL", closed_at: "2026-09-25T04:00:00.000Z", entry: 150, stop: 150.3, target: 149.4, status: "sent", created_at: "2026-09-25T04:02:00.000Z", ...ga }],
    });
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set"
        ? withGa([{ pair: "USD/JPY", interval: "15min", rule: "rsi_sar" }, { pair: "USD/JPY", interval: "4h", rule: "gainz" }])
        : withGa([{ pair: "USD/JPY", interval: "15min", rule: "rsi_sar" }])
    );
    render(<SignalAlertSettings call={call} />);
    await waitFor(() => expect(screen.getByTestId("signal-alerts-grid")).toBeTruthy());
    // RSI + SAR first, as before; its own record
    expect((screen.getByTestId("signal-alert-USD/JPY-15min") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("signal-alerts-record-all").textContent).toContain("7回");
    expect(screen.getAllByTestId("signal-alert-row")[0].textContent).toContain("（GA型）");
    fireEvent.click(screen.getByTestId("signal-alerts-rule-gainz"));
    // the GA grid: the RSI + SAR tick does not carry over
    expect((screen.getByTestId("signal-alert-gainz-USD/JPY-15min") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("signal-alerts-gainz-intro").textContent).toContain("GainzAlgo");
    expect(screen.getByTestId("signal-alerts-notes").textContent).toContain("30.1%");
    expect(screen.getByTestId("signal-alerts-record").textContent).toContain("GA型の通知の成績");
    expect(screen.getByTestId("signal-alerts-record-all").textContent).toContain("4回");
    expect(screen.getByTestId("signal-alerts-record").textContent).toContain("33%");
    fireEvent.click(screen.getByTestId("signal-alert-gainz-USD/JPY-4h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "USD/JPY", interval: "4h", on: true, rule: "gainz", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-gainz-USD/JPY-4h") as HTMLInputElement).checked).toBe(true));
    // and back: RSI + SAR's 4h is still unticked
    fireEvent.click(screen.getByTestId("signal-alerts-rule-rsi_sar"));
    expect((screen.getByTestId("signal-alert-USD/JPY-4h") as HTMLInputElement).checked).toBe(false);
  });

  it("without Pro nothing new can be ticked, but a tick can still be removed", async () => {
    render(<SignalAlertSettings call={async () => settings({ allowed: false })} />);
    expect(await screen.findByTestId("signal-alerts-pro-only")).toBeTruthy();
    expect((screen.getByTestId("signal-alert-EUR/JPY-1h") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("signal-alert-USD/JPY-15min") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId("signal-alerts-test") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says plainly when no email can be sent yet", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "test" ? settings({ email_configured: false, test: "not_configured" }) : settings({ email_configured: false })
    );
    render(<SignalAlertSettings call={call} />);
    expect(await screen.findByTestId("signal-alerts-not-configured")).toBeTruthy();
    fireEvent.click(screen.getByTestId("signal-alerts-test"));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("lists what was sent and what was held back, and why", async () => {
    render(<SignalAlertSettings call={async () => settings()} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("09-25 10:00");
    expect(rows[0].textContent).toContain("買い");
    expect(rows[0].textContent).toContain("送信済み");
    expect(rows[0].textContent).toContain("149.500");
    expect(rows[1].textContent).toContain("損失の大きい時間帯");
  });

  it("a test inside the cooldown is refused with the reason", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) => {
      if (body.action === "test") throw new AlertRequestError("test_cooldown");
      return settings();
    });
    render(<SignalAlertSettings call={call} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-test"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("One test email every 5 minutes"));
  });

  it("shows what the alerts did afterwards, and says when there are too few to read anything into", async () => {
    const perf = {
      days: 365,
      mine: { n: 3, wins: 1, losses: 2, expired: 0, open: 1, winRate: 1 / 3, meanR: -0.18, ciR: null, sumR: -0.54 },
      all: { n: 12, wins: 4, losses: 7, expired: 1, open: 3, winRate: 4 / 12, meanR: -0.11, ciR: 0.62, sumR: -1.32 },
      costly: { n: 2, wins: 0, losses: 2, expired: 0, open: 0, winRate: 0, meanR: -1, ciR: null, sumR: -2 },
      byTf: {},
      backtest: { period: "2025-07〜2026-09", n: 1255, winRate: 0.35, meanR: -0.125, breakeven: 0.4 },
    };
    const alerts = [
      { ...payload().alerts[0], status: "sent", event: { outcome: "win", r: 1.4875, bars: 2, exit_at: null } },
      { ...payload().alerts[1], id: "a3", status: "sent", skip_reason: null, event: { outcome: null, r: null, bars: null, exit_at: null } },
    ];
    render(<SignalAlertSettings call={async () => normalizeAlertSettings(payload({ performance: perf, alerts }))!} />);
    const record = await screen.findByTestId("signal-alerts-record");
    expect(record.textContent).toContain("あなたに届いた通知");
    expect(screen.getByTestId("signal-alerts-record-mine").textContent).toContain("3回：勝ち1・負け2・期限切れ0");
    expect(screen.getByTestId("signal-alerts-record-mine").textContent).toContain("決着待ち 1回");
    const all = screen.getByTestId("signal-alerts-record-all").textContent!;
    expect(all).toContain("勝率 33%");
    expect(all).toContain("−0.11R");
    expect(all).toContain("±0.62R");
    expect(record.textContent).toContain("勝率 35%・平均 −0.13R");
    expect(screen.getByTestId("signal-alerts-record-small")).toBeTruthy();
    const results = screen.getAllByTestId("signal-alert-result").map((e) => e.textContent);
    expect(results).toEqual(["勝ち +1.49R", "決着待ち"]);
  });

  it("the warning about small numbers goes once thirty signals have settled", async () => {
    const big = { n: 40, wins: 14, losses: 24, expired: 2, open: 0, winRate: 0.35, meanR: -0.1, ciR: 0.4, sumR: -4 };
    const perf = { days: 365, mine: big, all: big, costly: big, byTf: {}, backtest: null };
    render(<SignalAlertSettings call={async () => normalizeAlertSettings(payload({ performance: perf }))!} />);
    await screen.findByTestId("signal-alerts-record");
    expect(screen.queryByTestId("signal-alerts-record-small")).toBeNull();
  });

  it("a load that fails says so instead of spinning", async () => {
    render(<SignalAlertSettings call={async () => { throw new Error("down"); }} />);
    expect(await screen.findByTestId("signal-alerts-error")).toBeTruthy();
  });
});

// #155: Q-Trend's and ULTRA's alerts, on every pair of the live chart
describe("#155 Q-Trend and ULTRA in the email-alert card", () => {
  const twelve = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).length < INDICATOR_INTERVALS.length);
  const gmo = INDICATOR_PAIRS.filter((p) => !twelve.includes(p));
  const indicator = {
    rules: ["qtrend", "ultra"],
    pairs: INDICATOR_PAIRS,
    intervals: INDICATOR_INTERVALS,
    limited: Object.fromEntries(twelve.map((p) => [p, indicatorIntervalsFor(p)])),
  };
  const withInd = (over: Record<string, unknown> = {}) => settings({ indicator, ...over });

  it("reads the charts offered, each rule's subscriptions and a STRONG alert as they arrive", () => {
    const s = withInd({
      subscriptions: [{ pair: "USD/JPY", interval: "5min", rule: "qtrend" }, { pair: "HKD/JPY", interval: "1h", rule: "ultra" }],
      alerts: [
        { id: "q1", kind: "signal", rule: "qtrend_200_14_1_v1", strong: true, pair: "USD/JPY", interval: "5min", side: "SELL", closed_at: "2026-09-29T02:50:00.000Z", entry: 157.209, stop: null, target: null, status: "sent", created_at: "2026-09-29T02:51:30.000Z" },
        { id: "u1", kind: "signal", rule: "ultra_rsi14_30_70_sl10_tp5_10_15_v1", pair: "XAU/USD", interval: "1h", side: "BUY", closed_at: "2026-09-29T02:00:00.000Z", entry: 4139.89, stop: 4129.89, target: 4144.89, status: "sent", created_at: "2026-09-29T02:03:00.000Z" },
      ],
    });
    // #175: the yen pairs and gold (#177: and EUR/USD; #178: and AUD/USD;
    // #180: and USD/CAD); 6 of the pairs and gold from Twelve Data
    expect(s.indicator!.pairs).toHaveLength(21);
    expect(twelve).toHaveLength(7);
    expect(s.subscriptions.map((x) => x.rule)).toEqual(["qtrend", "ultra"]);
    expect(s.alerts.map((r) => [r.rule, r.strong])).toEqual([["qtrend", true], ["ultra", false]]);
    expect(indicatorChartOffered(s, "USD/JPY", "5min")).toBe(true);
    expect(indicatorChartOffered(s, "EUR/USD", "5min")).toBe(true);
    expect(indicatorChartOffered(s, "AUD/USD", "5min")).toBe(true);
    expect(indicatorChartOffered(s, "HKD/JPY", "5min")).toBe(false);
    expect(indicatorChartOffered(s, "HKD/JPY", "1h")).toBe(true);
    // a pair taken away (#175) is not offered on any timeframe
    expect(indicatorChartOffered(s, "USD/CHF", "1h")).toBe(false);
    // #180: USD/CAD again, from 1 hour as the others read from Twelve Data
    expect(indicatorChartOffered(s, "USD/CAD", "5min")).toBe(false);
    expect(indicatorChartOffered(s, "USD/CAD", "1h")).toBe(true);
    // #212: gold on 15 minutes too, not on 5
    expect(indicatorChartOffered(s, "XAU/USD", "15min")).toBe(true);
    expect(indicatorChartOffered(s, "XAU/USD", "5min")).toBe(false);
    expect(indicatorChartOffered(s, "HKD/JPY", "15min")).toBe(false);
    expect(indicatorChartOffered(s, "XAU/USD", "1h")).toBe(true);
    // a server that does not send them yet: nothing offered
    expect(indicatorChartOffered(settings(), "USD/JPY", "5min")).toBe(false);
  });

  it("lists every pair on 5 minutes to daily, those read from Twelve Data from 1 hour, and saves a tick as Q-Trend's", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? withInd({ subscriptions: [{ pair: "HKD/JPY", interval: "1h", rule: "qtrend" }] }) : withInd()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-qtrend"));
    expect(screen.getByTestId("signal-alerts-indicator-intro").textContent).toContain("STRONG");
    const rows = screen.getByTestId("signal-alerts-grid").querySelectorAll("tbody tr");
    // the all-symbols row, then the 21 (#175: 18; #177: and EUR/USD; #178: and AUD/USD; #180: and USD/CAD)
    expect(rows).toHaveLength(22);
    expect(screen.getByTestId("signal-alert-qtrend-USD/JPY-5min")).toBeTruthy();
    expect(screen.getByTestId("signal-alert-qtrend-HKD/JPY-5min-none").textContent).toBe("—");
    expect(screen.queryByTestId("signal-alert-qtrend-USD/CHF-1h")).toBeNull();
    // #180: USD/CAD from 1 hour, as the others read from Twelve Data
    expect(screen.getByTestId("signal-alert-qtrend-USD/CAD-1h")).toBeTruthy();
    expect(screen.getByTestId("signal-alert-qtrend-USD/CAD-5min-none").textContent).toBe("—");
    // #212: gold on 15 minutes too, not on 5
    expect(screen.getByTestId("signal-alert-qtrend-XAU/USD-15min")).toBeTruthy();
    expect(screen.getByTestId("signal-alert-qtrend-XAU/USD-5min-none").textContent).toBe("—");
    expect(screen.getByTestId("signal-alert-qtrend-XAU/USD-5min-none").getAttribute("title")).toContain("金は15分足も");
    fireEvent.click(screen.getByTestId("signal-alert-qtrend-HKD/JPY-1h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "HKD/JPY", interval: "1h", on: true, rule: "qtrend", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-qtrend-HKD/JPY-1h") as HTMLInputElement).checked).toBe(true));
    // ULTRA's is its own
    fireEvent.click(screen.getByTestId("signal-alerts-rule-ultra"));
    expect((screen.getByTestId("signal-alert-ultra-HKD/JPY-1h") as HTMLInputElement).checked).toBe(false);
    // no record is kept of these signals, and their own notes are shown
    expect(screen.queryByTestId("signal-alerts-record")).toBeNull();
    expect(screen.getByTestId("signal-alerts-notes").textContent).toContain("1日100通");
  });

  it("the all-symbols row follows a timeframe on every pair offered at once, and shows how much of it is followed", async () => {
    const all5 = gmo.map((pair) => ({ pair, interval: "5min", rule: "ultra" }));
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set_many"
        ? withInd({ subscriptions: body.on ? all5 : [] })
        : withInd({ subscriptions: [{ pair: "USD/JPY", interval: "5min", rule: "ultra" }] })
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-ultra"));
    const five = screen.getByTestId("signal-alert-ultra-all-5min") as HTMLInputElement;
    // one of 14 followed (#175: 12; #177: and EUR/USD; #178: and AUD/USD): neither ticked nor clear
    expect(five.checked).toBe(false);
    expect(five.indeterminate).toBe(true);
    fireEvent.click(five);
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "set_many", rule: "ultra", on: true, lang: "ja" })));
    const sent = call.mock.calls.find((c) => c[0].action === "set_many")![0] as { charts: Array<{ pair: string; interval: string }> };
    // the 14 GMO pairs (#177, #178): the 7 read from Twelve Data (#180) have no 5-minute alerts
    expect(gmo).toHaveLength(14);
    expect(sent.charts.map((c) => c.pair)).toEqual(gmo);
    expect(new Set(sent.charts.map((c) => c.interval))).toEqual(new Set(["5min"]));
    await waitFor(() => expect((screen.getByTestId("signal-alert-ultra-all-5min") as HTMLInputElement).checked).toBe(true));
    expect((screen.getByTestId("signal-alert-ultra-all-5min") as HTMLInputElement).indeterminate).toBe(false);
    // untick: every pair off again
    fireEvent.click(screen.getByTestId("signal-alert-ultra-all-5min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "set_many", rule: "ultra", on: false })));
    // the hourly one takes all 21 (#180: USD/CAD among them)
    fireEvent.click(screen.getByTestId("signal-alert-ultra-all-1h"));
    await waitFor(() => expect(call.mock.calls.filter((c) => c[0].action === "set_many")).toHaveLength(3));
    const hourly = call.mock.calls.filter((c) => c[0].action === "set_many")[2][0] as { charts: Array<{ pair: string }> };
    expect(hourly.charts).toHaveLength(21);
    expect(hourly.charts.map((c) => c.pair)).toContain("USD/CAD");
  });

  it("names a STRONG Q-Trend alert in the recent list, with no stop or target to show", async () => {
    const call = vi.fn(async () =>
      withInd({
        alerts: [
          { id: "q1", kind: "signal", rule: "qtrend_200_14_1_v1", strong: true, pair: "USD/JPY", interval: "5min", side: "SELL", closed_at: "2026-09-29T02:50:00.000Z", entry: 157.209, stop: null, target: null, status: "sent", created_at: "2026-09-29T02:51:30.000Z" },
          { id: "u1", kind: "signal", rule: "ultra_rsi14_30_70_sl10_tp5_10_15_v1", pair: "XAU/USD", interval: "1h", side: "BUY", closed_at: "2026-09-29T02:00:00.000Z", entry: 4139.89, stop: 4129.89, target: 4144.89, status: "sent", created_at: "2026-09-29T02:03:00.000Z" },
        ],
      })
    );
    render(<SignalAlertSettings call={call} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows[0].textContent).toContain("USD/JPY 5分 売り・STRONG（Q-Trend）");
    expect(rows[0].textContent).not.toContain("損切り");
    expect(rows[1].textContent).toContain("XAU/USD 1時間 買い（ULTRA）");
    expect(rows[1].textContent).toContain("目安 4139.89 / 損切り 4129.89 / 利確 4144.89");
  });
});

// #275: the MACD peak-and-valley rule, on its own charts (GMO's currency pairs; #324: on 1 hour,
// the owner's levels, from signal-alerts v25 — what the server sends now)
describe("#275 the MACD ride (once the peak-and-valley rule) in the email-alert card", () => {
  const twelve = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).length < INDICATOR_INTERVALS.length);
  const indicator = {
    rules: ["qtrend", "ultra", "macdx"],
    pairs: INDICATOR_PAIRS,
    intervals: INDICATOR_INTERVALS,
    limited: Object.fromEntries(twelve.map((p) => [p, indicatorIntervalsFor(p)])),
    macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS },
  };
  const withMacdx = (over: Record<string, unknown> = {}) => settings({ indicator, ...over });

  it("reads the charts the rule is offered on, and offers nothing when the server sends none", () => {
    const s = withMacdx({ subscriptions: [{ pair: "USD/JPY", interval: "1h", rule: "macdx" }, { pair: "USD/JPY", interval: "5min", rule: "ultra" }] });
    expect(s.indicator!.macdx).toEqual({ pairs: [...MACDH_PAIRS], intervals: ["1h"] });
    expect(s.subscriptions.map((x) => x.rule)).toEqual(["macdx", "ultra"]);
    // its own charts: the 1-hour chart of the owner's five pairs (#324; the 5-minute one no longer) and gold's (#345, v27)
    expect(indicatorChartOffered(s, "USD/JPY", "1h", "macdx")).toBe(true);
    expect(indicatorChartOffered(s, "EUR/USD", "1h", "macdx")).toBe(true);
    expect(indicatorChartOffered(s, "GBP/JPY", "1h", "macdx")).toBe(false);
    expect(indicatorChartOffered(s, "USD/JPY", "5min", "macdx")).toBe(false);
    expect(indicatorChartOffered(s, "USD/JPY", "15min", "macdx")).toBe(false);
    expect(indicatorChartOffered(s, "XAU/USD", "1h", "macdx")).toBe(true);
    expect(indicatorChartOffered(s, "XAU/USD", "15min", "macdx")).toBe(false);
    expect(indicatorChartOffered(s, "HKD/JPY", "1h", "macdx")).toBe(false);
    // the others' are as they were
    expect(indicatorChartOffered(s, "XAU/USD", "15min", "ultra")).toBe(true);
    expect(indicatorChartOffered(s, "HKD/JPY", "1h")).toBe(true);
    // a server that does not send them yet: nothing offered for the rule, the others still are
    const old = settings({ indicator: { ...indicator, macdx: undefined } });
    expect(old.indicator!.macdx).toBeNull();
    expect(indicatorChartOffered(old, "USD/JPY", "1h", "macdx")).toBe(false);
    expect(indicatorChartOffered(old, "USD/JPY", "5min", "ultra")).toBe(true);
  });

  it("has its own tab, with only the 1-hour column and its six instruments (the owner's five pairs and gold), and saves a tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? withMacdx({ subscriptions: [{ pair: "USD/JPY", interval: "1h", rule: "macdx" }] }) : withMacdx()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-rule-macdx").textContent).toBe("MACD の流れ");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    // #397 (docs §8.150): two emails a ride: in at 90% with the flow (a bar's close, the bar before outside), told at 96%
    expect(intro).toContain(
      "1通目: 1時間足が確定した時に、青い線が、新しい120本（チャートを開いた時に見える範囲）の MACD の枠の上の端の90%以上（0の線から測って）に入っていて、一つ前の足では入っていなかった時は買い（BUY）、下の端の90%以上に入っていて、一つ前の足では入っていなかった時は売り（SELL）です（流れに乗って入る合図）。",
    );
    expect(intro).toContain("その足の終わりですでに96%以上にいた時は、入る合図は送らず、知らせを1通だけ送ります。");
    expect(intro).toContain("2通目: 青い線が同じ端の96%に届いた時に送ります。1通目からの損益（プラスとは限りません）を書きます。損切りも目標もありません。");
    expect(intro).toContain("90%の帯から出ても何も送らず、2通目が届くまでは、同じチャート・同じ向きの1通目は送りません。1通目と2通目が1分以内に続けて届くことがあります。");
    expect(intro).toContain("ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルと金（XAU/USD）の1時間足だけです");
    expect(intro).toContain("5ペアで測った数字は下の注に、金では測っていません。");
    expect(intro).toContain("2通目は「96%に届いた」という知らせで、利確の合図とは言えません。");
    // nothing of the replaced rule: 95%, a SELL at the top, one email per peak or valley, ULTRA's stop and targets
    for (const no of ["95%", "山・谷", "一つの山", "ULTRA", "損切り・利確の目安", "まで上がったら売り", "クロス", "0.085"]) expect(intro, no).not.toContain(no);
    expect(intro.replace(/利確の合図とは言えません/g, "")).not.toContain("利確");
    expect(intro).not.toContain("必ず戻る");
    const grid = screen.getByTestId("signal-alerts-grid");
    // one timeframe, the all-symbols row, the owner's five pairs and gold
    expect(grid.querySelectorAll("thead th")).toHaveLength(2);
    expect(grid.querySelectorAll("thead th")[1].textContent).toBe("1時間");
    expect(grid.querySelectorAll("tbody tr")).toHaveLength(1 + MACDH_PAIRS.length);
    expect(MACDH_PAIRS).toHaveLength(6);
    expect(screen.queryByTestId("signal-alert-macdx-GBP/JPY-1h")).toBeNull();
    expect(screen.getByTestId("signal-alert-macdx-USD/JPY-1h")).toBeTruthy();
    expect(screen.queryByTestId("signal-alert-macdx-USD/JPY-5min")).toBeNull();
    expect(screen.getByTestId("signal-alert-macdx-XAU/USD-1h")).toBeTruthy();
    expect(screen.queryByTestId("signal-alert-macdx-XAU/USD-15min")).toBeNull();
    expect(screen.queryByTestId("signal-alert-macdx-HKD/JPY-1h")).toBeNull();
    expect(grid.querySelector("[data-testid$='-none']")).toBeNull();
    fireEvent.click(screen.getByTestId("signal-alert-macdx-USD/JPY-1h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "USD/JPY", interval: "1h", on: true, rule: "macdx", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-macdx-USD/JPY-1h") as HTMLInputElement).checked).toBe(true));
    // ULTRA's tick on the same chart is its own
    fireEvent.click(screen.getByTestId("signal-alerts-rule-ultra"));
    expect((screen.getByTestId("signal-alert-ultra-USD/JPY-1h") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("signal-alerts-grid").querySelectorAll("thead th")).toHaveLength(1 + INDICATOR_INTERVALS.length);
  });

  it("shows RSI + SAR's record on its own tab only: not under the MACD tab, nor ULTRA's or Q-Trend's (a fixture that has a record, so the check can fail)", async () => {
    const big = { n: 40, wins: 14, losses: 24, expired: 2, open: 0, winRate: 0.35, meanR: -0.1, ciR: 0.4, sumR: -4 };
    const performance = { days: 365, mine: big, all: big, costly: big, byTf: {}, backtest: null, gainz: null };
    render(<SignalAlertSettings call={async () => withMacdx({ performance })} />);
    // RSI + SAR first: its record is there
    expect(await screen.findByTestId("signal-alerts-record")).toBeTruthy();
    for (const k of ["macdx", "ultra", "qtrend"]) {
      fireEvent.click(screen.getByTestId(`signal-alerts-rule-${k}`));
      expect(screen.queryByTestId("signal-alerts-record"), k).toBeNull();
    }
    fireEvent.click(screen.getByTestId("signal-alerts-rule-rsi_sar"));
    expect(screen.getByTestId("signal-alerts-record")).toBeTruthy();
  });

  it("against a server that sends no charts for the rule, says so instead of drawing an empty table (the other tabs still work)", async () => {
    render(<SignalAlertSettings call={async () => settings({ indicator: { ...indicator, macdx: undefined } })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-macdx-unavailable").textContent).toContain("まだ使えません");
    expect(screen.queryByTestId("signal-alerts-grid")).toBeNull();
    // the others are as they were
    fireEvent.click(screen.getByTestId("signal-alerts-rule-ultra"));
    expect(screen.queryByTestId("signal-alerts-macdx-unavailable")).toBeNull();
    expect(screen.getByTestId("signal-alert-ultra-USD/JPY-5min")).toBeTruthy();
    // and a server that sends the rule an empty list is told the same
    cleanup();
    render(<SignalAlertSettings call={async () => settings({ indicator: { ...indicator, macdx: { pairs: [], intervals: ["5min"] } } })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-macdx-unavailable")).toBeTruthy();
  });

  it("the MACD pane's note on the chart no longer says that no signal uses MACD, and the card's intro names all five kinds", async () => {
    expect(ja.chart.macd.note).not.toContain("サインの判定には使っていません");
    expect(ja.chart.macd.note).toContain("メール通知の「MACD の流れ」だけが、この MACD（12・26・9）を使います");
    expect(en.chart.macd.note).not.toContain("no signal uses it");
    expect(en.chart.macd.note).toContain("only the \"MACD ride\" email alert does");
    expect(ja.alerts.intro("a@b.c")).toContain("MACD の流れ");
    expect(ja.alerts.introNoEmail).toContain("MACD の流れ");
    expect(en.alerts.intro("a@b.c")).toContain("MACD ride");
    expect(en.alerts.introNoEmail).toContain("MACD ride");
    // #397: the second email does not arrive at a close
    expect(ja.alerts.intro("a@b.c")).toContain("MACD の流れの2通目だけは、青い線が96%に届いた時に届きます");
    expect(en.alerts.intro("a@b.c")).toContain("the MACD ride's email 2 alone arrives when the blue line reaches 96%");
    // the FAQ: the ride has measured numbers on five pairs only, and email 2 is not at a close
    const faq = (d: typeof ja | typeof en) => d.lp.faqs.map((x: { q: string; a: string }) => `${x.q} ${x.a}`).join("\n");
    expect(faq(ja)).toContain("MACD の流れ（1時間足）は、5ペアで測った数字が別にあります");
    expect(faq(ja)).toContain("金・株と、流動性狩り＋EMAクロスは、まだ測っていません");
    expect(faq(ja)).toContain("MACD の流れの2通目だけは、青い線が決まりの所に届いた時に届きます");
    // the sales page quotes no number (src/test/landing.test.tsx): the ride's numbers are in the app's notes, and the
    // page says only what they cannot hide (more of the reached entries ended at a loss than at a profit: 429 against 360)
    expect(faq(ja)).toContain("届いた取引は、損失で終わったものの方が、利益で終わったものより多くありました");
    expect(faq(en)).toContain("more of those that reached it ended at a loss than at a profit");
    for (const d of [ja, en]) expect(faq(d)).not.toMatch(/801|800|429|96\s?%/);
    expect(faq(en)).toContain("The MACD ride (1-hour) has its own numbers, measured on the five pairs only");
    expect(faq(en)).toContain("Gold, stocks and the liquidity sweep + EMA cross have not been measured.");
    expect(faq(en)).toContain("the MACD ride's email 2 is the exception");
    for (const d of [ja, en]) {
      expect(faq(d)).not.toContain("山・谷");
      expect(faq(d)).not.toContain("peak/valley");
    }
  });

  // #397: the ride's notes: what the two emails are, the numbers as measured (the five pairs; gold not measured), that it
  // comes apart from ULTRA's
  it("says in the notes what the two emails are, the measured numbers (five pairs only), and that it comes apart from ULTRA's", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルと金の1時間足だけで判定します（オーナーが選んだ5ペアと、あとから足した金）。1通目は、足が確定した後、5ペアは毎時0分・3分・5分の読み込みで、金は確定の1分後から判定して送ります");
    expect(notes).toContain("2通目は毎分見ています");
    // #345: gold's bars are Twelve Data's, rounded to 2 decimals, read from a minute after the close (and not checked against a later
    // read); its quiet bars (the daily break, the hour before Sunday's open) are judged, and the weekend's last bar is not
    expect(notes).toContain("金の足は Twelve Data のものです（GMOコインに金がないため。");
    expect(notes).toContain("足は小数2桁に丸めた値で、MACD もその値で計算します");
    expect(notes).toContain("確定の1分後から判定します。足は、すでに保存されている足（チャートや、サーバーの前回までの確認が読んで保存したもの）にその足があればそれを使い");
    expect(notes).toContain("Twelve Data の1日の読み込み回数は、チャートや金のほかの通知と分け合っています。1日の上限に達した日は、足を読めずに、金のメールが出ないことがあります");
    expect(notes).toContain("読めたのに足がまだ無い時は、確定の約4分後にもう1回だけ読み、それでも無ければその足は送りません");
    expect(notes).toContain("読み込みそのものが失敗した時は、確定から30分まで、1〜3分おきに読み直します。確定から30分を過ぎた足は送りません");
    expect(notes).toContain("確定の直後（数秒後〜1分後）に読んだ足が、あとで読み直した足と同じかは、まだ確かめていません");
    expect(notes).toContain("金の1時間足を、本番で確定の何秒後に送るかも、まだ見ていません");
    expect(notes).toContain("金曜 21:00 UTC（日本時間 土曜 6:00）以後、日曜 22:00 UTC（日本時間 月曜 7:00）より前に確定する足は判定しない");
    expect(notes).toContain("週末の前の最後の足は判定されません（米国の夏時間は金曜 20:00〜21:00 UTC の足、冬時間は金曜 20:00〜22:00 UTC の2本）");
    expect(notes).toContain("金は、毎日の休み（1時間）の足と、日曜に市場が開く前の足（日曜 22:00 UTC 以後に確定するもの）にも、Twelve Data がほとんど動かない足を返すので、それらの足は判定します");
    expect(notes).toContain("金曜の引け後の1本と、日曜の市場が開く前の数時間の足（日曜 22:00 UTC より前に確定するもの）は、判定はしませんが、MACD の計算と、新しい120本には入ります");
    // email 1: the 90% band, the bar before outside, the pane's edges (the highest and lowest of the blue line, the orange line and the bars, and 0)
    expect(notes).toContain("1通目は、確定した足で、青い線（MACD）が、その足までの新しい120本の MACD の枠の上の端の90%以上に入っていて、一つ前の足では入っていなかった時は買い、枠の下の端の90%以上に入っていて、一つ前の足では入っていなかった時は売りです（どちらも0の線から測ります）");
    expect(notes).toContain("枠の上の端は、その120本の青い線・オレンジの線（シグナル）・棒（ヒストグラム）のうち一番高い値で、どれも0より上に無い時は0です。下の端は一番低い値で、どれも0より下に無い時は0です（チャートの MACD の枠と同じ決め方です）");
    expect(notes).toContain("MACD は、判定する足で終わる600本の足から計算します。オレンジの線とのクロスは待ちません。ほかのペアは選べません");
    // the notice, email 2, the unwatched time, no new email 1 while held, emails 1 and 2 within a minute
    expect(notes).toContain("その足の終わりで、青い線がもう96%以上にいた時は、入る合図は送らず、知らせを1通だけ送ります");
    expect(notes).toContain("2通目は、1通目のあと、青い線が同じ端の96%");
    expect(notes).toContain("5ペアは、毎分、GMO の1時間足のその時までの高値（買い）・安値（売り）で見ます。金は、毎分記録している値の、その1時間の高値・安値で見ます。");
    expect(notes).toContain("1通目からの損益（買いは今の値段−1通目の値段、売りはその逆。5ペアは pips、金はドル）を書きます。");
    expect(notes).toContain("金のドルは、スプレッドを含まず、足と毎分の値段の出どころが別です");
    expect(notes).toContain("損益はプラスとは限りません。2通目は「96%に届いた」という知らせで、利確の合図とは言えません。");
    expect(notes).toContain("次の足の確定の時に見つけます。その2通目には「〔その足〕の間に届いていました。その時は読めず、今見つけました」と書き、今の値段で損益を出します。");
    expect(notes).toContain("青い線が90%の帯から出ても、何も送りません。96%に届くまで持ち続ける形で、2通目が届くまでは、同じチャート・同じ向きの1通目は送りません");
    expect(notes).toContain("1通目と2通目が1分以内に続けて届くことがあります（測った取引の半分は、入ってから1分以内に届いています）。1通目が先に届きます。");
    expect(notes).toContain("チャートを拡大・縮小すると MACD の枠の高さは変わりますが、メールはいつも新しい120本で決めます");
    expect(notes).toContain("チャートの MACD は、チャートが読んだ足から計算するので、メールの600本で出した値とわずかに違うことがあります");
    expect(notes).toContain("青い線と90%・96%の所は、丸めない値で比べます");
    expect(notes).toContain("チャートは MACD を丸めて見せる（円のペアは小数3桁、金は小数2桁）");
    // the measured numbers, as docs §8.149 has them; gold not measured
    expect(notes).toContain("金では測っていません");
    expect(notes).toContain(
      "測った結果（5ペアの1時間足、2024年1月1日〜2026年11月10日、スプレッドを引いたあと、docs §8.149）: 入る合図は801回で、800回が96%に届きました（損益は、利益 360回・損失 429回・ゼロ 11回）。1回あたり平均 +0.43 pips、最悪 −323.6 pips、途中で一番大きかった含み損 558.8 pips、一番長く持ったのは約28日で、1回はまだ届いていません（含み損 −6.1 pips）。知らせだけの足は750回、前の取引を持っている間の見送りは30回でした。",
    );
    expect(notes).toContain("損切りをしないので、届く割合は作りの上で高く出ます。");
    expect(notes).toContain("測ったのは1分足の値で、本番は GMO の1時間足を毎分読むため、その違いはまだ測っていません。");
    expect(notes).toContain("ULTRA のメールとは別に届きます。両方をオンにすると、同じ時刻に2通届くことがあります");
    expect(notes).toContain("損切りも目標もありません。通知は注文の指示ではありません。届いたサインの勝ち負けの記録は付けていません。");
    // nothing of the replaced rule: 95%, one email per peak or valley, ULTRA's stop and targets, the 0.190 example, its numbers
    for (const no of ["95%", "山・谷", "一つの山", "0.190", "110回", "ULTRA と同じ", "損切り・利確の目安", "巡回", "まだ測っていません（1時間足でも", "売りは、確定した足で", "損切りなしで持った場合は測っていません", "ふだんの動き", "0.8倍"]) {
      expect(notes, no).not.toContain(no);
    }
    expect(notes.replace(/利確の合図とは言えません/g, "")).not.toContain("利確");
    expect(notes).not.toContain("必ず戻る");
  });

  it("the all-symbols row follows the 1-hour chart of every pair offered under the rule (the owner's five and gold), at once", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set_many" ? withMacdx({ subscriptions: body.on ? MACDH_PAIRS.map((pair) => ({ pair, interval: "1h", rule: "macdx" })) : [] }) : withMacdx()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    fireEvent.click(screen.getByTestId("signal-alert-macdx-all-1h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "set_many", rule: "macdx", on: true, lang: "ja" })));
    const sent = call.mock.calls.find((c) => c[0].action === "set_many")![0] as { charts: Array<{ pair: string; interval: string }> };
    expect(sent.charts.map((c) => c.pair)).toEqual([...MACDH_PAIRS]);
    expect(new Set(sent.charts.map((c) => c.interval))).toEqual(new Set(["1h"]));
    await waitFor(() => expect((screen.getByTestId("signal-alert-macdx-all-1h") as HTMLInputElement).checked).toBe(true));
  });

  // #345: the owner already follows the five pairs when gold is added (docs §8.118): the all-symbols row then
  // stands for part of them, and a click on it ticks everything (gold too), it does not take the five off
  it("with the five pairs ticked and gold not, the all-symbols row is part-ticked and a click ticks all six (gold too)", async () => {
    const five = MACDH_PAIRS.filter((p) => p !== "XAU/USD");
    expect(five).toHaveLength(5);
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set_many"
        ? withMacdx({ subscriptions: MACDH_PAIRS.map((pair) => ({ pair, interval: "1h", rule: "macdx" })) })
        : withMacdx({ subscriptions: five.map((pair) => ({ pair, interval: "1h", rule: "macdx" })) })
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    const before = screen.getByTestId("signal-alert-macdx-all-1h") as HTMLInputElement;
    expect(before.checked).toBe(false);
    expect(before.indeterminate).toBe(true);
    expect((screen.getByTestId("signal-alert-macdx-USD/JPY-1h") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("signal-alert-macdx-XAU/USD-1h") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(before);
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "set_many", rule: "macdx", on: true, lang: "ja" })));
    const sent = call.mock.calls.find((c) => c[0].action === "set_many")![0] as { charts: Array<{ pair: string; interval: string }> };
    expect(sent.charts.map((c) => c.pair)).toEqual([...MACDH_PAIRS]);
    expect(sent.charts.map((c) => c.pair)).toContain("XAU/USD");
    expect(new Set(sent.charts.map((c) => c.interval))).toEqual(new Set(["1h"]));
    await waitFor(() => expect((screen.getByTestId("signal-alert-macdx-XAU/USD-1h") as HTMLInputElement).checked).toBe(true));
    const after = screen.getByTestId("signal-alert-macdx-all-1h") as HTMLInputElement;
    expect(after.checked).toBe(true);
    expect(after.indeterminate).toBe(false);
  });

  it("gold's own tick saves under the MACD rule on 1 hour, and ULTRA's gold ticks are another rule's", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? withMacdx({ subscriptions: [{ pair: "XAU/USD", interval: "1h", rule: "macdx" }] }) : withMacdx()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    fireEvent.click(screen.getByTestId("signal-alert-macdx-XAU/USD-1h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "XAU/USD", interval: "1h", on: true, rule: "macdx", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-macdx-XAU/USD-1h") as HTMLInputElement).checked).toBe(true));
    // ULTRA's tick on gold's 1-hour chart is its own
    fireEvent.click(screen.getByTestId("signal-alerts-rule-ultra"));
    expect((screen.getByTestId("signal-alert-ultra-XAU/USD-1h") as HTMLInputElement).checked).toBe(false);
  });

  it("without Pro gold cannot be newly ticked under the MACD rule (nor the all-symbols row), but a tick already there can be taken off", async () => {
    render(
      <SignalAlertSettings
        call={async () => withMacdx({ allowed: false, subscriptions: [{ pair: "XAU/USD", interval: "1h", rule: "macdx" }] })}
      />
    );
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-pro-only")).toBeTruthy();
    expect((screen.getByTestId("signal-alert-macdx-XAU/USD-1h") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("signal-alert-macdx-XAU/USD-1h") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId("signal-alert-macdx-USD/JPY-1h") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("signal-alert-macdx-all-1h") as HTMLInputElement).disabled).toBe(true);
  });

  it("without Pro, with the five pairs ticked and gold not, gold cannot be newly ticked and the all-symbols row is off, while the five ticks can be taken off", async () => {
    const five = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"];
    render(<SignalAlertSettings call={async () => withMacdx({ allowed: false, subscriptions: five.map((pair) => ({ pair, interval: "1h", rule: "macdx" })) })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-pro-only")).toBeTruthy();
    const box = (id: string) => screen.getByTestId(id) as HTMLInputElement;
    expect(box("signal-alert-macdx-XAU/USD-1h").checked).toBe(false);
    expect(box("signal-alert-macdx-XAU/USD-1h").disabled).toBe(true);
    expect(box("signal-alert-macdx-all-1h").disabled).toBe(true);
    for (const pair of five) {
      expect(box(`signal-alert-macdx-${pair}-1h`).checked).toBe(true);
      expect(box(`signal-alert-macdx-${pair}-1h`).disabled).toBe(false);
    }
  });

  it("names a MACD alert in the recent list, whatever the rule id's tail", async () => {
    const alerts = [
          // #324: the 1-hour rule's id (v25), and the 5-minute rule's (v23–v24) on the rows mailed before
          { id: "m2", kind: "signal", rule: "macdx_12_26_9_w600_1h_lv8.5p_v2", pair: "USD/JPY", interval: "1h", side: "BUY", closed_at: "2026-10-12T14:00:00.000Z", entry: 158.4, stop: 158.27, target: 158.44, status: "sent", created_at: "2026-10-12T14:00:20.000Z" },
          { id: "m1", kind: "signal", rule: "macdx_12_26_9_w600_n288_k4_2_v1", pair: "USD/JPY", interval: "5min", side: "SELL", closed_at: "2026-10-11T02:50:00.000Z", entry: 157.209, stop: 157.339, target: 157.169, status: "sent", created_at: "2026-10-11T02:50:20.000Z" },
    ];
    render(<SignalAlertSettings call={async () => withMacdx({ alerts })} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows[0].textContent).toContain("USD/JPY 1時間 買い（MACD の流れ）");
    expect(rows[0].textContent).toContain("目安 158.400 / 損切り 158.270 / 利確 158.440");
    expect(rows[1].textContent).toContain("USD/JPY 5分 売り（MACD の流れ）");
    expect(rows[1].textContent).toContain("目安 157.209 / 損切り 157.339 / 利確 157.169");
    // an old row has no ride kind
    expect(withMacdx({ alerts }).alerts.map((r) => r.ride)).toEqual([null, null]);
  });

  // #397 (docs §8.150): the three mails of the MACD ride, told apart by the full rule id the server sends
  const rideRows = [
    { id: "r-in", kind: "signal", rule: "macdx_12_26_9_w600_1h_ride90to96of120_in_v9", pair: "USD/JPY", interval: "1h", side: "BUY", closed_at: "2026-11-12T01:00:00.000Z", entry: 158.4, stop: null, target: null, status: "sent", created_at: "2026-11-12T01:00:20.000Z" },
    { id: "r-at", kind: "signal", rule: "macdx_12_26_9_w600_1h_ride90to96of120_at_v9", pair: "USD/JPY", interval: "1h", side: "SELL", closed_at: "2026-11-12T02:00:00.000Z", entry: 158.2, stop: null, target: null, status: "sent", created_at: "2026-11-12T02:00:20.000Z" },
    { id: "r-out", kind: "signal", rule: "macdx_12_26_9_w600_1h_ride90to96of120_out_v9", pair: "USD/JPY", interval: "1h", side: "BUY", closed_at: "2026-11-12T03:10:00.000Z", entry: 158.4, stop: null, target: 158.9, status: "sent", created_at: "2026-11-12T03:10:05.000Z" },
    { id: "r-out-sell", kind: "signal", rule: "macdx_12_26_9_w600_1h_ride90to96of120_out_v9", pair: "EUR/JPY", interval: "1h", side: "SELL", closed_at: "2026-11-12T03:11:00.000Z", entry: 171.2, stop: null, target: 171.5, status: "sent", created_at: "2026-11-12T03:11:05.000Z" },
    { id: "r-old", kind: "signal", rule: "macdx_12_26_9_w600_1h_z95of120_v8", pair: "USD/JPY", interval: "1h", side: "SELL", closed_at: "2026-11-11T01:00:00.000Z", entry: 158.0, stop: 158.13, target: 157.96, status: "sent", created_at: "2026-11-11T01:00:20.000Z" },
  ];

  it("#397 tells the ride's three mails apart in the recent list: the entry as an entry, email 2 and the notice in a neutral colour", async () => {
    render(<SignalAlertSettings call={async () => withMacdx({ alerts: rideRows })} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows).toHaveLength(5);
    const label = (i: number) => rows[i].querySelector("span:not(.font-mono)") as HTMLElement;
    // email 1: an entry as before (green for a BUY), with the new label and no stop, so no plan line
    expect(rows[0].textContent).toContain("USD/JPY 1時間 買い（MACD の流れ）");
    expect(label(0).className).toContain("text-success");
    expect(rows[0].textContent).not.toContain("目安");
    expect(rows[0].textContent).not.toContain("損切り");
    // the notice: neutral, not a side
    expect(rows[1].textContent).toContain("USD/JPY 1時間 知らせ（もう96%）（MACD の流れ）");
    expect(rows[1].textContent).not.toContain("売り（");
    expect(label(1).className).toContain("text-foreground");
    expect(label(1).className).not.toContain("text-destructive");
    expect(rows[1].textContent).not.toContain("目安");
    // email 2: neutral, named for its side, with the first email's price and the price when seen
    expect(rows[2].textContent).toContain("USD/JPY 1時間 96%に届いた（買いの分）（MACD の流れ）");
    expect(label(2).className).toContain("text-foreground");
    expect(label(2).className).not.toContain("text-success");
    expect(rows[2].querySelector("[data-testid='signal-alert-ride-prices']")!.textContent).toBe("1通目の値段 158.400 / 見えた時の値段 158.900");
    expect(rows[2].textContent).not.toContain("利確");
    expect(rows[3].textContent).toContain("EUR/JPY 1時間 96%に届いた（売りの分）（MACD の流れ）");
    expect(label(3).className).not.toContain("text-destructive");
    expect(rows[3].querySelector("[data-testid='signal-alert-ride-prices']")!.textContent).toBe("1通目の値段 171.200 / 見えた時の値段 171.500");
    // an old v8 row stays as it is shown today: its side in colour, its plan line
    expect(rows[4].textContent).toContain("USD/JPY 1時間 売り（MACD の流れ）");
    expect(label(4).className).toContain("text-destructive");
    expect(rows[4].textContent).toContain("目安 158.000 / 損切り 158.130 / 利確 157.960");
    expect(rows[4].querySelector("[data-testid='signal-alert-ride-prices']")).toBeNull();
    // the kind, read from the id
    expect(withMacdx({ alerts: rideRows }).alerts.map((r) => r.ride)).toEqual(["in", "at", "out", "out", null]);
  });

  it("#397 does the same for the share's ride mails (their own ids), and a sell of a SELL-side ride is red only as an entry", async () => {
    const stockRows = [
      { id: "s-in", kind: "signal", rule: "stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2", pair: "NVDA", interval: "1h", side: "SELL", closed_at: "2026-11-12T15:30:00.000Z", entry: 180.12, stop: null, target: null, status: "sent", created_at: "2026-11-12T15:30:40.000Z" },
      { id: "s-at", kind: "signal", rule: "stockmacd_12_26_9_w600_1h_ride90to96of120_at_v2", pair: "NVDA", interval: "1h", side: "BUY", closed_at: "2026-11-12T16:30:00.000Z", entry: 181, stop: null, target: null, status: "sent", created_at: "2026-11-12T16:30:40.000Z" },
      { id: "s-out", kind: "signal", rule: "stockmacd_12_26_9_w600_1h_ride90to96of120_out_v2", pair: "NVDA", interval: "1h", side: "SELL", closed_at: "2026-11-12T17:30:00.000Z", entry: 180.12, stop: null, target: 178.5, status: "sent", created_at: "2026-11-12T17:30:40.000Z" },
    ];
    render(<SignalAlertSettings call={async () => withMacdx({ alerts: stockRows })} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    const label = (i: number) => rows[i].querySelector("span:not(.font-mono)") as HTMLElement;
    expect(rows[0].textContent).toContain("NVDA 1時間 売り（株の MACD）");
    expect(label(0).className).toContain("text-destructive");
    expect(rows[1].textContent).toContain("NVDA 1時間 知らせ（もう96%）（株の MACD）");
    expect(label(1).className).toContain("text-foreground");
    expect(rows[2].textContent).toContain("NVDA 1時間 96%に届いた（売りの分）（株の MACD）");
    expect(label(2).className).toContain("text-foreground");
    expect(rows[2].querySelector("[data-testid='signal-alert-ride-prices']")!.textContent).toMatch(/^1通目の値段 .*180.* \/ 見えた時の値段 .*178\.5/);
    expect(withMacdx({ alerts: stockRows }).alerts.map((r) => [r.rule, r.ride])).toEqual([["stockmacd", "in"], ["stockmacd", "at"], ["stockmacd", "out"]]);
  });

  it("is in English too", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-rule-macdx").textContent).toBe("MACD ride");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toContain(
      "Email 1: when a 1-hour bar closes, the blue line has come into the 90% band of the top (measured from the zero line) of the MACD pane of the newest 120 bars (the range you see when you open the chart) with the bar before outside it, a BUY; into the 90% band of the pane's bottom with the bar before outside it, a SELL (an entry with the flow).",
    );
    expect(intro).toContain("If it is already at 96% or more at that close, no entry is sent, only one notice.");
    expect(intro).toContain("Email 2: sent when the blue line reaches 96% of the same edge, with the profit or loss since email 1 (not always a profit). There is no stop and no target.");
    expect(intro).toContain("Nothing is sent when the line leaves the band, and no new email 1 for the same chart and side comes until email 2 has. Emails 1 and 2 can arrive within a minute of each other.");
    expect(intro).toContain("1-hour bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold (XAU/USD) only.");
    expect(intro).toContain("Measured on the five pairs (see the notes below); not measured on gold.");
    for (const no of ["95%", "ULTRA", "peak", "valley", "0.190"]) expect(intro, no).not.toContain(no);
    expect(intro.replace("not to be called a take-profit", "")).not.toContain("take-profit");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("Email 1 is judged and sent after the bar closes: the five pairs by the reads at 0, 3 and 5 minutes after the close, gold from 1 minute after it");
    expect(notes).toContain("Email 2 is looked for every minute.");
    expect(notes).toContain("Email 1 is sent at a closed bar where the blue line (MACD) is in the 90% band of the top of the MACD pane of the newest 120 bars up to that bar with the bar before outside it (a BUY), or in the 90% band of the pane's bottom with the bar before outside it (a SELL); both are measured from the zero line.");
    expect(notes).toContain("The pane's top is the highest of those 120 bars' blue line, orange line (signal) and bars (histogram), or 0 if none is above 0; the bottom is the lowest, or 0 if none is below 0");
    expect(notes).toContain("MACD is worked out from the 600 bars ending at the bar judged. A cross with the orange line is not waited for.");
    expect(notes).toContain("If the blue line is already at 96% or more at that close, no entry is sent but one notice");
    expect(notes).toContain("The five pairs are looked at every minute with the highest high (BUY) or lowest low (SELL) so far of GMO's 1-hour bar; gold with the highest high or lowest low of the minutes recorded in that hour.");
    expect(notes).toContain("It gives the price when the reach was seen and the profit or loss since email 1 (a BUY: the price now less the first price; a SELL: the reverse; the pairs in pips, gold in dollars).");
    expect(notes).toContain("Gold's dollars hold no spread, and its bars and its minute prices come from two feeds");
    expect(notes).toContain("The result is not always a profit. Email 2 reports that the line reached 96%; it is not to be called a take-profit.");
    expect(notes).toContain("is found at the next bar's close. Its email 2 says 'it had reached during [that bar]; it could not be read then and was found now'");
    expect(notes).toContain("Nothing is sent when the blue line leaves the 90% band: it is held until it gets to 96%, and no new email 1 for the same chart and side comes until email 2 has");
    expect(notes).toContain("emails 1 and 2 can arrive within a minute of each other (half of the measured trades reached it within a minute of the entry); email 1 comes first.");
    expect(notes).toContain("Zooming the chart in or out changes the height of its MACD pane, but the email always goes by the newest 120 bars.");
    expect(notes).toContain("The blue line and the 90% and 96% marks are compared unrounded.");
    expect(notes).toContain("The chart shows MACD rounded (to 3 decimals on the yen pairs, to 2 on gold)");
    // the measured numbers, as docs §8.149 has them
    expect(notes).toContain("Not measured on gold");
    expect(notes).toContain(
      "Measured (the five pairs' 1-hour bars, 1 January 2024 to 10 November 2026, after the spread, docs §8.149): 801 entries, 800 of them reached 96% (360 at a profit, 429 at a loss, 11 at zero), +0.43 pips an entry on average, the worst −323.6 pips, the largest loss on the way 558.8 pips, the longest held about 28 days, and 1 not reached yet (−6.1 pips). 750 bars were a notice only, and 30 entries were skipped",
    );
    expect(notes).toContain("With no stop, the share that reach 96% comes out high by construction.");
    expect(notes).toContain("that difference has not been measured.");
    expect(notes).toContain("There is no stop and no target. An alert is not an instruction to trade, and no record of the alerts' outcomes is kept.");
    // gold's bars, the weekend, the quiet bars: as they were
    expect(notes).toContain("Gold's bars are Twelve Data's (GMO Coin does not carry gold;");
    expect(notes).toContain("A bar more than half an hour after its close is not sent.");
    expect(notes).toContain("The time over the weekend when nothing is judged is drawn wide: a bar that closes at or after Friday 21:00 UTC");
    expect(notes).toContain("are not judged, but they count in MACD and in the newest 120 bars.");
    expect(notes).toContain("It arrives apart from ULTRA's emails: with both on, two emails can come at the same time.");
    // nothing of the replaced rule (95%, one email per peak or valley, ULTRA's stop and targets, its measured numbers)
    for (const no of ["95%", "peak", "valley", "0.190", "110 entries", "ULTRA's stop", "Holding with no stop was not measured", "have not been measured (neither", "A SELL is sent at a closed bar where the blue line"]) {
      expect(notes, no).not.toContain(no);
    }
    expect(notes.replace("not to be called a take-profit", "")).not.toContain("take-profit");
    expect(notes).not.toContain("always comes back");
  });

  // #397: the shares' tab: the same two emails, looked at each 1-hour close; not measured, none of docs §8.133's numbers
  it("#397 the stock MACD tab describes the two emails looked at each close, says it is not measured, and keeps the Tokyo 15-minute note", async () => {
    const stockIndicator = { ...indicator, rules: ["qtrend", "ultra", "stockmacd"], stockmacd: { pairs: ["AAPL", "7203.T"], intervals: ["1h"] } };
    render(<SignalAlertSettings call={async () => settings({ indicator: stockIndicator })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-rule-stockmacd").textContent).toBe("株の MACD");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toContain("FX と同じ「MACD の流れ」のメール（2通）を送ります。");
    expect(intro).toContain("90%以上に入っていて、一つ前の足では入っていなかった時は買い");
    expect(intro).toContain("1通目のあとの1時間足の確定ごとに見て、青い線が同じ端の96%以上にいた最初の足で送ります（FX と違い、毎分は見ません）");
    expect(intro).toContain("1通目からの損益（プラスとは限りません）を書きます。損切りも目標もありません。");
    expect(intro).toContain("株では測っていません。");
    expect(intro).not.toContain("メールに損切り・利確の目安は入りません");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("決まりは FX の「MACD の流れ」と同じ2通ですが、見るのは1時間足の確定ごとです。");
    expect(notes).toContain("株の売りは空売りで、メールにもそう書きます");
    expect(notes).toContain("日本株の値段は Yahoo では約15分遅れて届くため、日本株のメールは足が確定してから約15分後に送ります（2026-11-06 に測りました）");
    expect(notes).toContain("損切りも目標もありません。2通目は「96%に届いた」という知らせで、利確の合図とは言えません。");
    expect(notes).toContain("株では測っていません。5ペアで測った数字は、株には当てはまりません。");
    // docs §8.133's numbers belong to the replaced rule
    for (const no of ["1,696回", "99.36%", "−1,837.40%", "1,709通", "95%", "山・谷", "損切り・利確の目安は付けていません"]) expect(notes, no).not.toContain(no);
    expect(notes.replace(/利確の合図とは言えません/g, "")).not.toContain("利確");
    cleanup();
    render(<SignalAlertSettings call={async () => settings({ indicator: stockIndicator })} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-rule-stockmacd").textContent).toBe("Stock MACD");
    const introEn = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(introEn).toContain("The MACD ride (the same two emails as on the currency pairs)");
    expect(introEn).toContain("Email 2: looked at at each 1-hour close after email 1 (not every minute, unlike the pairs)");
    expect(introEn).toContain("Not measured on stocks.");
    const notesEn = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notesEn).toContain("a SELL on a stock is a short sale, and the email says so");
    expect(notesEn).toContain("Yahoo's Tokyo prices come about 15 minutes late");
    expect(notesEn).toContain("Not measured on stocks. The numbers measured on the five pairs do not apply to stocks.");
    for (const no of ["1,696", "99.36%", "1,837.40%", "95%", "peak", "valley"]) expect(notesEn, no).not.toContain(no);
    expect(notesEn.replace("not to be called a take-profit", "")).not.toContain("take-profit");
  });
});

// #291: the owner's video's way (liquidity sweep + EMA cross), on its own chart (gold, 1 minute)
describe("#291 the video's way in the email-alert card", () => {
  const twelve = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).length < INDICATOR_INTERVALS.length);
  const indicator = {
    rules: ["qtrend", "ultra", "macdx", "sweepx"],
    pairs: INDICATOR_PAIRS,
    intervals: INDICATOR_INTERVALS,
    limited: Object.fromEntries(twelve.map((p) => [p, indicatorIntervalsFor(p)])),
    macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS },
    sweepx: { pairs: SWEEPX_PAIRS, intervals: SWEEPX_INTERVALS },
  };
  const withSweepx = (over: Record<string, unknown> = {}) => settings({ indicator, ...over });

  it("reads its one chart (gold, 1 minute), and offers nothing when the server sends none", () => {
    const s = withSweepx({ subscriptions: [{ pair: "XAU/USD", interval: "1min", rule: "sweepx" }, { pair: "XAU/USD", interval: "15min", rule: "ultra" }] });
    expect(s.indicator!.sweepx).toEqual({ pairs: ["XAU/USD"], intervals: ["1min"] });
    expect(s.subscriptions.map((x) => x.rule)).toEqual(["sweepx", "ultra"]);
    expect(indicatorChartOffered(s, "XAU/USD", "1min", "sweepx")).toBe(true);
    for (const [pair, iv] of [["XAU/USD", "5min"], ["XAU/USD", "15min"], ["USD/JPY", "1min"], ["USD/JPY", "5min"]]) {
      expect(indicatorChartOffered(s, pair, iv, "sweepx"), `${pair} ${iv}`).toBe(false);
    }
    // the others' are as they were: no rule but this one has gold's 1-minute chart
    expect(indicatorChartOffered(s, "XAU/USD", "15min", "ultra")).toBe(true);
    expect(indicatorChartOffered(s, "XAU/USD", "1min", "ultra")).toBe(false);
    expect(indicatorChartOffered(s, "XAU/USD", "1min", "macdx")).toBe(false);
    // a server that does not send it yet (older than v24): nothing offered for the rule, the others still are
    const old = settings({ indicator: { ...indicator, sweepx: undefined } });
    expect(old.indicator!.sweepx).toBeNull();
    expect(indicatorChartOffered(old, "XAU/USD", "1min", "sweepx")).toBe(false);
    expect(indicatorChartOffered(old, "USD/JPY", "1h", "macdx")).toBe(true);
  });

  it("has its own tab with one tick (gold, 1 minute), no all-symbols row, and saves the tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? withSweepx({ subscriptions: [{ pair: "XAU/USD", interval: "1min", rule: "sweepx" }] }) : withSweepx()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-sweepx"));
    expect(screen.getByTestId("signal-alerts-rule-sweepx").textContent).toBe("流動性狩り＋EMAクロス");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toContain("EMA20 が EMA80 を上に抜けたら買い");
    expect(intro).toContain("金の1分足だけです");
    expect(intro).toContain("まだ測っていません");
    const grid = screen.getByTestId("signal-alerts-grid");
    expect(grid.querySelectorAll("thead th")).toHaveLength(2);
    expect(grid.querySelectorAll("thead th")[1].textContent).toBe("1分");
    expect(grid.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.queryByTestId("signal-alerts-all-row")).toBeNull();
    expect(screen.queryByTestId("signal-alert-sweepx-all-1min")).toBeNull();
    expect(grid.querySelector("[data-testid$='-none']")).toBeNull();
    expect(screen.getAllByRole("checkbox").filter((el) => grid.contains(el))).toHaveLength(1);
    fireEvent.click(screen.getByTestId("signal-alert-sweepx-XAU/USD-1min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "XAU/USD", interval: "1min", on: true, rule: "sweepx", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-sweepx-XAU/USD-1min") as HTMLInputElement).checked).toBe(true));
    // the other rules' tables keep their all-symbols rows, and have no 1-minute column
    for (const k of ["ultra", "macdx"]) {
      fireEvent.click(screen.getByTestId(`signal-alerts-rule-${k}`));
      expect(screen.getByTestId("signal-alerts-all-row"), k).toBeTruthy();
      expect(screen.queryByTestId(`signal-alert-${k}-XAU/USD-1min`), k).toBeNull();
    }
    // no record is kept of these signals
    fireEvent.click(screen.getByTestId("signal-alerts-rule-sweepx"));
    expect(screen.queryByTestId("signal-alerts-record")).toBeNull();
  });

  it("its notes say what its bars are, when it is sent, and that it has not been measured", async () => {
    render(<SignalAlertSettings call={async () => withSweepx()} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-sweepx"));
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("Swissquote の金の価格をサーバーが約3秒ごとに記録して作った1分足");
    expect(notes).toContain("確定から2分を過ぎた足は送りません");
    expect(notes).toContain("実際に何秒で届くかは、まだ確かめていません");
    expect(notes).toContain("1日100通");
    expect(notes).toContain("この決まりの勝率と1回あたりの損益は、まだ測っていません");
    // the hours it is not judged, and a winter Friday's last hour told as it
    // is: gold trades on, nothing is recorded or judged
    expect(notes).toContain("金曜 21:00〜日曜 22:00 UTC〈日本時間 土曜 6:00〜月曜 7:00〉）は、記録も判定もしません");
    expect(notes).toContain("閉まる直前の1本も、ほかの足と同じく、閉まった5秒後から判定して送ります");
    expect(notes).toContain("毎日の休みと夏時間の週末では、そのメールは、市場が開くまで注文できない時間に届きます");
    expect(notes).toContain("米国の冬時間（11月初め〜3月半ば）の金曜は、金は 22:00 UTC（日本時間 土曜 7:00）まで取引していますが、21:00 UTC からの1時間は記録も判定もしません");
    expect(en.alerts.sweepxNotes.at(-1)).toContain("In US winter time (early November to mid-March) gold trades on Fridays until 22:00 UTC, but its hour from 21:00 UTC is neither recorded nor judged.");
    // not the MACD rule's, nor Q-Trend's and ULTRA's
    expect(notes).not.toContain("GMOコインの通貨ペアだけで判定します");
    expect(notes).not.toContain("Twelve Data の無料枠");
    // the card's intro names all six kinds
    expect(ja.alerts.intro("a@b.c")).toContain("流動性狩り＋EMAクロス");
    expect(ja.alerts.introNoEmail).toContain("流動性狩り＋EMAクロス");
    expect(en.alerts.intro("a@b.c")).toContain("Liquidity sweep + EMA cross");
    expect(en.alerts.introNoEmail).toContain("Liquidity sweep + EMA cross");
  });

  it("against a server that sends no chart for the rule, says so instead of drawing an empty table", async () => {
    render(<SignalAlertSettings call={async () => settings({ indicator: { ...indicator, sweepx: undefined } })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-sweepx"));
    expect(screen.getByTestId("signal-alerts-sweepx-unavailable").textContent).toContain("まだ使えません");
    expect(screen.queryByTestId("signal-alerts-grid")).toBeNull();
    fireEvent.click(screen.getByTestId("signal-alerts-rule-macdx"));
    expect(screen.queryByTestId("signal-alerts-sweepx-unavailable")).toBeNull();
    expect(screen.getByTestId("signal-alert-macdx-USD/JPY-1h")).toBeTruthy();
  });

  it("names its alert in the recent list, with its stop and first target", async () => {
    const call = vi.fn(async () =>
      withSweepx({
        alerts: [
          { id: "s1", kind: "signal", rule: SWEEPX_RULE_ID, pair: "XAU/USD", interval: "1min", side: "BUY", closed_at: "2026-10-12T01:23:00.000Z", entry: 4021.35, stop: 4019.85, target: 4022.85, status: "sent", created_at: "2026-10-12T01:24:06.000Z" },
        ],
      })
    );
    render(<SignalAlertSettings call={call} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows[0].textContent).toContain("XAU/USD 1分 買い（流動性狩り＋EMAクロス）");
    expect(rows[0].textContent).toContain("目安 4021.35 / 損切り 4019.85 / 利確 4022.85");
  });

  it("is in English too", async () => {
    render(<SignalAlertSettings call={async () => withSweepx()} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-sweepx"));
    expect(screen.getByTestId("signal-alerts-rule-sweepx").textContent).toBe("Liquidity sweep + EMA cross");
    expect(screen.getByTestId("signal-alerts-indicator-intro").textContent).toContain("On gold's 1-minute chart only");
    expect(screen.getByTestId("signal-alerts-grid").querySelectorAll("thead th")[1].textContent).toBe("1m");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("recorded by the server every 3 seconds or so");
    expect(notes).toContain("have not been measured");
  });
});
