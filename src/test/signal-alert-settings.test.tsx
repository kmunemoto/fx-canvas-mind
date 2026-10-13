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
describe("#275 the MACD peak-and-valley rule in the email-alert card", () => {
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
    expect(screen.getByTestId("signal-alerts-rule-macdx").textContent).toBe("MACD の山・谷");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    // #353 (v28): the blue line at 90% of the newest 120 bars' top or bottom, no cross (#339's level, 0.8 times the
    // usual move, and #324's 0.085 are gone)
    expect(intro).toContain(
      "1時間足の MACD(12・26・9)の青い線が、新しい120本（チャートを開いた時に見える範囲）で一番高かった所の90%以上（0の線から測って）まで上がったら売り、一番低かった所の90%以上まで下がったら買いとするサインです",
    );
    // one email as the line gets there, and another after it has gone back inside the 90% mark and come back (not
    // "only one": the notes and the email say the same)
    expect(intro).toContain("一つの山・谷では、届いた時に1通送ります（90%の所より内側に戻ってから、また届けばもう1通）");
    expect(intro).not.toContain("1通だけ");
    for (const no of ["クロス", "ふだんの動き", "0.8倍", "高い位置で下に抜けた"]) expect(intro, no).not.toContain(no);
    expect(intro).not.toContain("0.085");
    expect(intro).toContain("ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルと金（XAU/USD）の1時間足だけです");
    expect(intro).toContain("勝率と1回あたりの損益は、まだ測っていません");
    expect(intro).toContain("この決まり自体には損切り・利確がないため、メールには ULTRA と同じ損切り・利確の目安（ペアは損切り13pips・利確 4・10・16pips、金は損切り13ドル・利確 4・10・16ドル）を付けます");
    expect(intro).not.toContain("0から遠い山・谷の近く");
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
    expect(ja.chart.macd.note).toContain("メール通知の「MACD の山・谷」だけが、この MACD（12・26・9）を使います");
    expect(en.chart.macd.note).not.toContain("no signal uses it");
    expect(en.chart.macd.note).toContain("only the \"MACD peak/valley\" email alert does");
    expect(ja.alerts.intro("a@b.c")).toContain("MACD の山・谷");
    expect(ja.alerts.introNoEmail).toContain("MACD の山・谷");
    expect(en.alerts.intro("a@b.c")).toContain("MACD peak/valley");
    expect(en.alerts.introNoEmail).toContain("MACD peak/valley");
  });

  // #324: the 1-hour rule's notes: its levels, that it is not measured (and that the 5-minute
  // rule's figures are another rule's), and that it comes apart from ULTRA's
  it("says in the notes what the 1-hour rule mails, that it is not measured, and that it comes apart from ULTRA's", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルと金の1時間足だけで判定します（オーナーが選んだ5ペアと、あとから足した金）");
    // #345: gold's bars are Twelve Data's, rounded to 2 decimals, read from a minute after the close (and not checked against a later
    // read); its quiet bars (the daily break, the hour before Sunday's open) are judged, and the weekend's last bar is not
    expect(notes).toContain("金の足は Twelve Data のものです（GMOコインに金がないため。");
    expect(notes).toContain("足は小数2桁に丸めた値で、MACD もその値で計算します");
    expect(notes).toContain("確定の1分後から判定します。足は、すでに保存されている足（チャートや、サーバーの前回までの確認が読んで保存したもの）にその足があればそれを使い");
    expect(notes).toContain("5ペアは足が確定した後、毎時0分・3分・5分の読み込みで判定して送ります");
    expect(notes).toContain("Twelve Data の1日の読み込み回数は、チャートや金のほかの通知と分け合っています。1日の上限に達した日は、足を読めずに、金のメールが出ないことがあります");
    expect(notes).not.toContain("巡回");
    expect(notes).not.toContain("そのあとチャートが保存した足があれば");
    expect(notes).toContain("金のチャートを開いていると、確定の数秒後に保存されることがあります");
    expect(notes).toContain("読めたのに足がまだ無い時は、確定の約4分後にもう1回だけ読み、それでも無ければその足は送りません");
    expect(notes).toContain("読み込みそのものが失敗した時は、確定から30分まで、1〜3分おきに読み直します。確定から30分を過ぎた足は送りません");
    expect(notes).toContain("確定の直後（数秒後〜1分後）に読んだ足が、あとで読み直した足と同じかは、まだ確かめていません");
    expect(notes).toContain("金の1時間足を、本番で確定の何秒後に送るかも、まだ見ていません");
    expect(notes).toContain("チャートは MACD を丸めて見せる（円のペアは小数3桁、金は小数2桁）");
    expect(notes).toContain("金曜 21:00 UTC（日本時間 土曜 6:00）以後、日曜 22:00 UTC（日本時間 月曜 7:00）より前に確定する足は判定しない");
    expect(notes).toContain("週末は、判定しない時間を広めに取っています。金曜 21:00 UTC");
    expect(notes).toContain("週末の前の最後の足は判定されません（米国の夏時間は金曜 20:00〜21:00 UTC の足、冬時間は金曜 20:00〜22:00 UTC の2本）");
    expect(notes).toContain("金は、毎日の休み（1時間）の足と、日曜に市場が開く前の足（日曜 22:00 UTC 以後に確定するもの）にも、Twelve Data がほとんど動かない足を返すので、それらの足は判定します");
    // #353 (v28): the quiet bars count in MACD and in the newest 120 bars (no usual move any more)
    expect(notes).toContain("金曜の引け後の1本と、日曜の市場が開く前の数時間の足（日曜 22:00 UTC より前に確定するもの）は、判定はしませんが、MACD の計算と、新しい120本には入ります");
    expect(notes).toContain("これは、保存された足（2026年8月16日〜10月12日、米国の夏時間）で見たことです。冬時間（11月1日から）の足と、祝日の足の動きは、まだ見ていません");
    expect(notes).toContain("毎日の休みの頭に確定する足（米国の夏時間は 21:00 UTC、日本時間 6:00）のメールは、休みの間に届きます。休みの間に注文が通るかは、確かめていません");
    expect(notes).toContain("ほかのペアは選べません");
    // #353 (v28): the rule, the one email to a peak or valley, the band's edge cases, the zoom, unrounded
    expect(notes).toContain(
      "売りは、確定した足で、青い線（MACD）が、その足までの新しい120本の中で一番高かった値の90%以上に届いた時、買いは、一番低かった値の90%以上に届いた時です（どちらも0の線から測ります。一番高かった値が 0.200 なら、0.180 以上に届いた時に売り）",
    );
    expect(notes).toContain("120本は、チャートを開いた時に見える足の数です。MACD は、判定する足で終わる600本の足から計算します。オレンジの線（シグナル）とのクロスは待ちません");
    expect(notes).toContain("一つの山・谷では、届いた足で1通だけ送ります。青い線が90%の所より内側に戻るまでは、次は送りません。戻ってからまた届けば、もう1通送ります（90%の所のすぐそばで出入りを繰り返すと、そのたびに送ります）");
    expect(notes).toContain("届いた足を判定できなかった時（読み込みの失敗など）は、次の足では「一つ前の足でもう届いていた」ことになるので、そのメールは送りません（あとから送ることはしません）");
    expect(notes).toContain("新しい120本の青い線がずっと0以下の時は、上の90%の所が無いので、売りは出ません（買いも同じで、ずっと0以上の時は出ません）");
    expect(notes).toContain("一番高かった足（買いは一番低かった足）が120本の外に出ると、90%の所が0の線に近づくので、青い線が動かなくても届くことがあります。");
    expect(notes).toContain("チャートを拡大・縮小すると MACD の枠の高さは変わりますが、メールはいつも新しい120本で決めます");
    // the 90% mark is the blue line's alone; the chart's MACD pane takes its edges from the orange line and the bars too,
    // and adds a margin (PriceChart.tsx), so the two are not said to be the same (docs §8.119: on the stored bars the
    // line was under 90% of the drawn edge at 144 of 147 entries)
    expect(notes).toContain(
      "90%の所は、青い線だけで決めます。チャートの MACD の枠の上と下の端は、オレンジの線と棒も入れて決まり、少し余白も足して描くので、メールが届いた時に、画面では青い線が枠の端の90%より下に見えることがほとんどです（長く0の反対側にいた青い線が0の線を越えたばかりの時は、0の線の近くに見えます）",
    );
    expect(notes).not.toContain("枠が縮むのと同じ");
    expect(notes).toContain("チャートの MACD は、チャートが読んだ足から計算するので、メールの600本で出した値とわずかに違うことがあります");
    expect(notes).toContain("青い線と90%の所は、丸めない値で比べます");
    expect(notes).toContain("この決まりの勝率と1回あたりの損益は、まだ測っていません");
    expect(notes).toContain("5分足の決まりの測った数字は、この決まりには当てはまりません");
    expect(notes).toContain("その後に送っていたクロスの決まり〈±0.085 と、ペアごとの水準〉も、測っていません");
    expect(notes).toContain("同じ時刻に2通届くことがあります");
    expect(notes).toContain("1時間足で実際に何秒で届くかは、まだ確かめていません");
    // the 5-minute rule's figures are not given as this rule's; #353: nor is anything of the cross rule of v26 and v27
    expect(notes).not.toContain("72.3%");
    expect(notes).not.toContain("1日100通");
    for (const no of ["ふだんの動き", "0.8倍", "約6.2ドル", "MACD と水準"]) expect(notes, no).not.toContain(no);
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
    const call = vi.fn(async () =>
      withMacdx({
        alerts: [
          // #324: the 1-hour rule's id (v25), and the 5-minute rule's (v23–v24) on the rows mailed before
          { id: "m2", kind: "signal", rule: "macdx_12_26_9_w600_1h_lv8.5p_v2", pair: "USD/JPY", interval: "1h", side: "BUY", closed_at: "2026-10-12T14:00:00.000Z", entry: 158.4, stop: 158.27, target: 158.44, status: "sent", created_at: "2026-10-12T14:00:20.000Z" },
          { id: "m1", kind: "signal", rule: "macdx_12_26_9_w600_n288_k4_2_v1", pair: "USD/JPY", interval: "5min", side: "SELL", closed_at: "2026-10-11T02:50:00.000Z", entry: 157.209, stop: 157.339, target: 157.169, status: "sent", created_at: "2026-10-11T02:50:20.000Z" },
        ],
      })
    );
    render(<SignalAlertSettings call={call} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows[0].textContent).toContain("USD/JPY 1時間 買い（MACD の山・谷）");
    expect(rows[0].textContent).toContain("目安 158.400 / 損切り 158.270 / 利確 158.440");
    expect(rows[1].textContent).toContain("USD/JPY 5分 売り（MACD の山・谷）");
    expect(rows[1].textContent).toContain("目安 157.209 / 損切り 157.339 / 利確 157.169");
  });

  it("is in English too", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-rule-macdx").textContent).toBe("MACD peak/valley");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    // #353 (v28)
    expect(intro).toContain(
      "BUY and SELL signals from the 1-hour chart's MACD(12, 26, 9) blue line: a SELL when it comes up to 90% or more of the highest it reached over the newest 120 bars (what the chart shows when it is opened), measured from the zero line, and a BUY when it comes down to 90% or more of the lowest.",
    );
    expect(intro).toContain("One email when the line gets there; another only after it has gone back inside the 90% mark and come back to it.");
    expect(intro).not.toContain("One email per peak or valley");
    for (const no of ["cross", "usual", "0.8 times"]) expect(intro, no).not.toContain(no);
    expect(intro).not.toContain("0.085");
    expect(intro).toContain("On the 1-hour chart of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold (XAU/USD) only.");
    expect(intro).toContain("have not been measured");
    expect(intro).toContain("The rule has no stop or target of its own, so the email carries ULTRA's stop and targets (13 pips and 4, 10 and 16 pips on a currency pair; $13 and $4, $10 and $16 on gold)");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    // #353 (v28): the rule, the one email to a peak or valley, the band's edge cases, the zoom, unrounded
    expect(notes).toContain(
      "A SELL is sent at a closed bar where the blue line (MACD) has come to 90% or more of the highest it reached over the newest 120 bars up to that bar, a BUY where it has come to 90% or more of the lowest (both measured from the zero line: with a highest of 0.200, a SELL from 0.180).",
    );
    expect(notes).toContain("The 120 bars are as many as the chart shows when it is opened. MACD is worked out on the 600 bars ending at the bar judged. No cross with the orange line (the signal) is waited for.");
    expect(notes).toContain("One email per peak or valley, at the bar that gets there: no next one until the blue line has gone back inside the 90% mark; if it then comes back to the mark, another is sent (going in and out right at the mark sends one each time).");
    expect(notes).toContain("If the bar that got there could not be judged (a failed read, say), at the next bar the line counts as having been there already, and that email is not sent (nothing is sent late).");
    expect(notes).toContain("While the blue line stays at or below zero over the newest 120 bars there is no 90% mark above, and no SELL (likewise no BUY while it stays at or above zero).");
    expect(notes).toContain("When the bar of the highest (for a BUY, the lowest) leaves the 120, the mark moves toward the zero line, so the line can reach it without moving.");
    expect(notes).toContain("Zooming the chart in or out changes the height of its MACD pane, but the email always goes by the newest 120 bars.");
    expect(notes).toContain(
      "The 90% mark is set by the blue line alone. The top and bottom edges of the chart's MACD pane take in the orange line and the bars as well, and a little margin is added, so when an email comes the blue line nearly always looks short of 90% of the way to the pane's edge on the screen (when it has just crossed the zero line after a long time on the other side, it looks close to the zero line).",
    );
    expect(notes).not.toContain("pane shrinks");
    expect(notes).toContain("The chart works MACD out from the bars it has read, so it can differ a little from the email's, worked out on 600 bars.");
    expect(notes).toContain("the cross rules mailed after it, ±0.085 and each pair's own level, were not measured either");
    expect(notes).toContain("This rule's win rate and its profit or loss a trade have not been measured");
    for (const no of ["usual move", "0.8 times", "about $6.2", "MACD and the level"]) expect(notes, no).not.toContain(no);
    expect(notes).toContain("The other pairs are not offered.");
    expect(notes).toContain("Gold's bars are Twelve Data's (GMO Coin does not carry gold;");
    expect(notes).toContain("A bar more than half an hour after its close is not sent.");
    expect(notes).toContain("Judging starts a minute after the close. The bar is taken from the bars already stored (read and kept by the chart or by the server's earlier checks) if they have it");
    expect(notes).toContain("The five pairs are judged and sent by the reads at 0, 3 and 5 minutes after the bar closes");
    expect(notes).toContain("Twelve Data's daily allowance of reads is shared with the chart and gold's other alerts, and on a day it runs out the bar cannot be read and no gold email may come");
    expect(notes).not.toContain("sweep");
    expect(notes).not.toContain("if the chart keeps it afterwards");
    expect(notes).toContain("it is read once more about four minutes after the close, and if it is still not there the bar is not sent");
    expect(notes).toContain("If the read itself fails, it is tried again every one to three minutes until half an hour after the close.");
    expect(notes).toContain("The bars are rounded to 2 decimals and MACD is worked out on those.");
    expect(notes).toContain("Whether a bar read soon after its close (a few seconds to a minute) is the same as one read again later has not been checked, and how many seconds after the close gold's 1-hour alert is sent has not been seen in production yet.");
    expect(notes).toContain("The chart shows MACD rounded (to 3 decimals on the yen pairs, to 2 on gold)");
    expect(notes).toContain("a bar that closes at or after Friday 21:00 UTC (Saturday 6:00 Japan time) and before Sunday 22:00 UTC (Monday 7:00 Japan time) is not judged, so the last bar before the weekend is not judged either (in US summer time the bar 20:00–21:00 UTC on Friday, in winter time the two bars 20:00–22:00 UTC)");
    expect(notes).toContain("On gold, Twelve Data returns a bar that barely moves for the daily break (one hour) and for the hour before the market opens on Sunday (a bar that closes from 22:00 UTC on Sunday), and those bars are judged");
    // #353 (v28): the quiet bars count in MACD and in the newest 120 bars (no usual move any more)
    expect(notes).toContain("are not judged, but they count in MACD and in the newest 120 bars.");
    expect(notes).toContain("The time over the weekend when nothing is judged is drawn wide: a bar that closes at or after Friday 21:00 UTC");
    expect(notes).toContain("the stored bars of 16 August to 12 October 2026 (US summer time) show");
    expect(notes).toContain("winter-time bars (from 1 November) and the bars of holidays have not been looked at yet");
    expect(notes).toContain("(21:00 UTC, 6:00 Japan time, in US summer time) arrives during the break; whether an order goes through during the break has not been checked");
    expect(notes).toContain("The blue line and the 90% mark are compared unrounded.");
    expect(notes).toContain("with both on, two emails can come at the same time");
    expect(notes).not.toContain("72.3%");
    expect(notes).not.toContain("comes out smaller than it would without them");
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
