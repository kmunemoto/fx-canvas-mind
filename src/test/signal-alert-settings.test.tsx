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
import { INDICATOR_INTERVALS, INDICATOR_PAIRS, MACDX_INTERVALS, MACDX_MEASURED, MACDX_PAIRS, indicatorIntervalsFor } from "../../supabase/functions/signal-alerts/indicators";

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

// #275: the MACD peak-and-valley rule, on its own charts (5 minutes, GMO's currency pairs)
describe("#275 the MACD peak-and-valley rule in the email-alert card", () => {
  const twelve = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).length < INDICATOR_INTERVALS.length);
  const indicator = {
    rules: ["qtrend", "ultra", "macdx"],
    pairs: INDICATOR_PAIRS,
    intervals: INDICATOR_INTERVALS,
    limited: Object.fromEntries(twelve.map((p) => [p, indicatorIntervalsFor(p)])),
    macdx: { pairs: MACDX_PAIRS, intervals: MACDX_INTERVALS },
  };
  const withMacdx = (over: Record<string, unknown> = {}) => settings({ indicator, ...over });

  it("reads the charts the rule is offered on, and offers nothing when the server sends none", () => {
    const s = withMacdx({ subscriptions: [{ pair: "USD/JPY", interval: "5min", rule: "macdx" }, { pair: "USD/JPY", interval: "5min", rule: "ultra" }] });
    expect(s.indicator!.macdx).toEqual({ pairs: [...MACDX_PAIRS], intervals: ["5min"] });
    expect(s.subscriptions.map((x) => x.rule)).toEqual(["macdx", "ultra"]);
    // its own charts: the 5-minute chart of GMO's pairs
    expect(indicatorChartOffered(s, "USD/JPY", "5min", "macdx")).toBe(true);
    expect(indicatorChartOffered(s, "EUR/USD", "5min", "macdx")).toBe(true);
    expect(indicatorChartOffered(s, "USD/JPY", "15min", "macdx")).toBe(false);
    expect(indicatorChartOffered(s, "XAU/USD", "5min", "macdx")).toBe(false);
    expect(indicatorChartOffered(s, "XAU/USD", "15min", "macdx")).toBe(false);
    expect(indicatorChartOffered(s, "HKD/JPY", "1h", "macdx")).toBe(false);
    // the others' are as they were
    expect(indicatorChartOffered(s, "XAU/USD", "15min", "ultra")).toBe(true);
    expect(indicatorChartOffered(s, "HKD/JPY", "1h")).toBe(true);
    // a server that does not send them yet: nothing offered for the rule, the others still are
    const old = settings({ indicator: { ...indicator, macdx: undefined } });
    expect(old.indicator!.macdx).toBeNull();
    expect(indicatorChartOffered(old, "USD/JPY", "5min", "macdx")).toBe(false);
    expect(indicatorChartOffered(old, "USD/JPY", "5min", "ultra")).toBe(true);
  });

  it("has its own tab, with only the 5-minute column and GMO's pairs, and saves a tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? withMacdx({ subscriptions: [{ pair: "USD/JPY", interval: "5min", rule: "macdx" }] }) : withMacdx()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-rule-macdx").textContent).toBe("MACD の山・谷");
    expect(screen.getByTestId("signal-alerts-indicator-intro").textContent).toContain("0から遠い山・谷の近く");
    const grid = screen.getByTestId("signal-alerts-grid");
    // one timeframe, the all-symbols row and the 14 GMO pairs
    expect(grid.querySelectorAll("thead th")).toHaveLength(2);
    expect(grid.querySelectorAll("thead th")[1].textContent).toBe("5分");
    expect(grid.querySelectorAll("tbody tr")).toHaveLength(1 + MACDX_PAIRS.length);
    expect(MACDX_PAIRS).toHaveLength(14);
    expect(screen.getByTestId("signal-alert-macdx-USD/JPY-5min")).toBeTruthy();
    expect(screen.queryByTestId("signal-alert-macdx-XAU/USD-5min")).toBeNull();
    expect(screen.queryByTestId("signal-alert-macdx-HKD/JPY-1h")).toBeNull();
    expect(grid.querySelector("[data-testid$='-none']")).toBeNull();
    fireEvent.click(screen.getByTestId("signal-alert-macdx-USD/JPY-5min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "USD/JPY", interval: "5min", on: true, rule: "macdx", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-macdx-USD/JPY-5min") as HTMLInputElement).checked).toBe(true));
    // ULTRA's tick on the same chart is its own
    fireEvent.click(screen.getByTestId("signal-alerts-rule-ultra"));
    expect((screen.getByTestId("signal-alert-ultra-USD/JPY-5min") as HTMLInputElement).checked).toBe(false);
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
    expect(ja.chart.macd.note).toContain("メール通知の「MACD の山・谷」だけが、この MACD（12・26・9）を使います");
    expect(en.chart.macd.note).not.toContain("no signal uses it");
    expect(en.chart.macd.note).toContain("only the \"MACD peak/valley\" email alert does");
    expect(ja.alerts.intro("a@b.c")).toContain("MACD の山・谷");
    expect(ja.alerts.introNoEmail).toContain("MACD の山・谷");
    expect(en.alerts.intro("a@b.c")).toContain("MACD peak/valley");
    expect(en.alerts.introNoEmail).toContain("MACD peak/valley");
  });

  it("states what the rule did on past charts against ULTRA's, in the notes, as the emails' figures hold them", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    const f = MACDX_MEASURED.fiveFigures;
    expect(notes).toContain(`損切りより先に利確1に届いたのは ${f.win.toFixed(1)}%、1回あたり平均で約${Math.abs(f.pips).toFixed(2)} pips の負け`);
    expect(notes).toContain(`同じ期間の ULTRA の5分足は ${f.ultraWin.toFixed(1)}%・約${Math.abs(f.ultraPips).toFixed(2)} pips の負け`);
    expect(notes).toContain("この決まりのほうが良いとは言えない結果でした");
    expect(notes).toContain("同じ足で2通届くことがあります");
    expect(notes).not.toContain("1日100通");
  });

  it("the all-symbols row follows the 5-minute chart of every GMO pair under the rule, at once", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set_many" ? withMacdx({ subscriptions: body.on ? MACDX_PAIRS.map((pair) => ({ pair, interval: "5min", rule: "macdx" })) : [] }) : withMacdx()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    fireEvent.click(screen.getByTestId("signal-alert-macdx-all-5min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "set_many", rule: "macdx", on: true, lang: "ja" })));
    const sent = call.mock.calls.find((c) => c[0].action === "set_many")![0] as { charts: Array<{ pair: string; interval: string }> };
    expect(sent.charts.map((c) => c.pair)).toEqual([...MACDX_PAIRS]);
    expect(new Set(sent.charts.map((c) => c.interval))).toEqual(new Set(["5min"]));
    await waitFor(() => expect((screen.getByTestId("signal-alert-macdx-all-5min") as HTMLInputElement).checked).toBe(true));
  });

  it("names a MACD alert in the recent list, whatever the rule id's tail", async () => {
    const call = vi.fn(async () =>
      withMacdx({
        alerts: [
          { id: "m1", kind: "signal", rule: "macdx_12_26_9_w600_n288_k4_2_v1", pair: "USD/JPY", interval: "5min", side: "SELL", closed_at: "2026-10-11T02:50:00.000Z", entry: 157.209, stop: 157.339, target: 157.169, status: "sent", created_at: "2026-10-11T02:50:20.000Z" },
        ],
      })
    );
    render(<SignalAlertSettings call={call} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows[0].textContent).toContain("USD/JPY 5分 売り（MACD の山・谷）");
    expect(rows[0].textContent).toContain("目安 157.209 / 損切り 157.339 / 利確 157.169");
  });

  it("is in English too", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-rule-macdx").textContent).toBe("MACD peak/valley");
    expect(screen.getByTestId("signal-alerts-indicator-intro").textContent).toContain("near a peak or a valley far from zero");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("72.3% of the time");
    expect(notes).toContain("This rule was not shown to be better.");
    expect(notes).toContain("with both on, one bar can send two emails");
  });
});
