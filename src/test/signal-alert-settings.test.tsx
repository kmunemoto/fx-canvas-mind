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
import { FADE_MEASURED_NOTES } from "../../supabase/functions/_shared/macd-fade-measured";

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
    expect(screen.getByTestId("signal-alerts-rule-macdx").textContent).toBe("MACD の逆張り");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    // the MACD fade (research/macdfade1h-prod-spec.md section 5): one email when the blue line closes at 96% with the
    // bar before not at 96%, the fade side, the price in, no take-profit and no stop price, whose choices these are
    expect(intro).toBe(ja.alerts.indicatorIntro.macdx);
    expect(intro).toContain("1時間足の MACD(12・26・9)の青い線を使った、逆張りのサインです。");
    expect(intro).toContain(
      "1時間足が確定した時に、青い線が、新しい120本の MACD の枠の上の端（青い線・オレンジの線・棒のうち一番高い所）の96%以上（0の線から測って）にいて、一つ前の足の終わりでは96%に届いていなかった時は売り（SELL）、下の端（一番低い所）の96%以上にいて、一つ前の足の終わりでは96%に届いていなかった時は買い（BUY）です（上の端で売り、下の端で買いの、逆張りの向きです）。",
    );
    expect(intro).toContain("メールは1つの足で1通だけで、入りの値段（5ペアは、売りはその足の終値の売値、買いは買値。金はその足の終値）を書きます。");
    expect(intro).toContain("青い線が96%以上にいる間は、次のメールは送りません。一度96%より下で確定し、また96%以上で確定した時に、次のメールを送ります。");
    expect(intro).toContain("同じチャート・同じ向きに前の合図があっても、次の合図は送ります。");
    expect(intro).toContain(NO_TP_JA);
    expect(intro).toContain("ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルと金（XAU/USD）の1時間足だけです。");
    expect(intro).toContain(OWNER_JA);
    expect(intro).toContain("5ペアで測った数字は下の注に、金では測っていません。");
    // nothing of v9's two emails (in at 90%, the notice, email 2 at 96%), nor of the rules before it
    for (const no of ["90%", "1通目", "2通目", "知らせ", "毎分", "流れに乗って", "MACD の流れ", "95%", "山・谷", "一つの山", "ULTRA", "損切り・利確の目安", "目標", "0.085"]) expect(intro, no).not.toContain(no);
    expectFadeGuards(intro, "ja", "the intro");
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

  it("the MACD pane's note on the chart names the fade, the card's intro names all five kinds, and the FAQ says of the fade what section 5 does", async () => {
    expect(ja.chart.macd.note).not.toContain("サインの判定には使っていません");
    expect(ja.chart.macd.note).toContain("メール通知の「MACD の逆張り」と「株の MACD」だけが、この MACD（12・26・9）を使います。");
    expect(en.chart.macd.note).not.toContain("no signal uses it");
    expect(en.chart.macd.note).toContain("only the \"MACD fade\" and \"Stock MACD\" email alerts do.");
    expect(ja.chart.macd.note).not.toContain("MACD の流れ");
    expect(en.chart.macd.note).not.toContain("MACD ride");
    expect(ja.alerts.intro("a@b.c")).toContain("・ULTRA・MACD の逆張り・流動性狩り＋EMAクロス）");
    expect(ja.alerts.introNoEmail).toContain("・ULTRA・MACD の逆張り・流動性狩り＋EMAクロス）");
    expect(en.alerts.intro("a@b.c")).toContain("ULTRA, MACD fade or Liquidity sweep + EMA cross)");
    expect(en.alerts.introNoEmail).toContain("ULTRA, MACD fade or Liquidity sweep + EMA cross)");
    // v9's email 2 (not at a close) is gone; the fade's pairs are judged at the reads 0, 3 and 5 minutes after the close,
    // its gold from 1 to 30 minutes after it, and how long the fade's mail takes to arrive is not measured (spec 2.4 and 5)
    expect(ja.alerts.intro("a@b.c")).toContain("足が確定してから数分で届きます（MACD の逆張りは、5ペアは確定の直後・3分後・5分後の読み込みで、金は確定の1分後から30分後までの間に判定して送ります。実際に何分で届くかは測っていません）。");
    expect(en.alerts.intro("a@b.c")).toContain("It arrives a few minutes after the bar closes (the MACD fade is judged and sent on the five pairs at the reads right after the close and 3 and 5 minutes after, and on gold between 1 and 30 minutes after the close; how long it takes to arrive has not been measured).");
    for (const t of [ja.alerts.intro("a@b.c"), ja.alerts.introNoEmail]) expect(t).not.toMatch(/MACD の流れ|2通目|96%/);
    for (const t of [en.alerts.intro("a@b.c"), en.alerts.introNoEmail]) expect(t).not.toMatch(/MACD ride|email 2|96%/);
    // the FAQ: the chart list and when the emails arrive name the fade (v9's email-2 parenthesis gone); its numbers are
    // in the settings' notes
    const faq = (d: typeof ja | typeof en) => d.lp.faqs.map((x: { q: string; a: string }) => `${x.q} ${x.a}`).join("\n");
    expect(faq(ja)).toContain("MACD の逆張りのサインをドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドル・金の1時間足から選べます。");
    expect(faq(en)).toContain("and for the MACD fade signals on the 1-hour bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold.");
    expect(faq(ja)).toContain(
      "足が確定してから数分で届きます（MACD の逆張りは、5ペアは確定の直後・3分後・5分後の読み込みで、金は確定の1分後から30分後までの間に、株は1時間足の確定の後の読み込みで判定して送ります。日本株は Yahoo の値段が約15分遅れて届くため、確定の約15分後です。MACD の逆張りが実際に何分で届くかは測っていません）。",
    );
    expect(faq(en)).toContain(
      "Within minutes of the bar closing (the MACD fade is judged and sent on the five pairs at the reads right after the close and 3 and 5 minutes after, on gold between 1 and 30 minutes after the close, and on stocks at a read after each 1-hour close; Yahoo's Tokyo prices come about 15 minutes late, so Japanese stocks' emails come about 15 minutes after the close; how long the MACD fade's emails take to arrive has not been measured).",
    );
    expect(faq(ja)).toContain("Q-Trend・ULTRA・MACD の逆張り・流動性狩り＋EMAクロスは、この時間もメールします。");
    expect(faq(en)).toContain("Q-Trend, ULTRA, MACD fade and liquidity sweep + EMA cross are emailed at those hours too.");
    expect(faq(ja)).toContain("MACD の逆張り（1時間足）は、5ペアで測った数字が設定の注にあります。");
    expect(faq(en)).toContain("The MACD fade (1-hour) has its own numbers, measured on the five pairs only, in the settings' notes.");
    expect(faq(ja)).toContain("金・株と、流動性狩り＋EMAクロスは、まだ測っていません");
    expect(faq(en)).toContain("Gold, stocks and the liquidity sweep + EMA cross have not been measured.");
    // the sales page quotes no number (src/test/landing.test.tsx, which also pins its three texts on the fade word for
    // word): what the numbers cannot hide is said without one (〔adverse〕 of section 5: a pair's mean below zero, trades
    // left open at a loss at the end of the period)
    expect(faq(ja)).toContain("5ペアのうち、1回あたりの平均がマイナスのペアがありました。測った期間の終わりに、含み損のまま残っていた取引がありました。");
    expect(faq(en)).toContain("On some of the five pairs its mean a trade was below zero. At the end of the period measured, some trades were still open at an unrealised loss.");
    for (const d of [ja, en]) {
      // neither v9's numbers nor the fade's
      expect(faq(d)).not.toMatch(/801|800|429|96\s?%|1,?490|1,?468|3\.26|3\.20|2\.08|9,?820|1,?733|2,?243|0\.26|8\.155/);
      expect(faq(d)).not.toMatch(/MACD の流れ|MACD ride|2通目|email 2/);
      expect(faq(d)).not.toContain("山・谷");
      expect(faq(d)).not.toContain("peak/valley");
      expect(BACK_JA.test(faq(d))).toBe(false);
      expect(BACK_EN.test(faq(d))).toBe(false);
    }
  });

  // the MACD fade's notes (research/macdfade1h-prod-spec.md section 5, item by item, the same order): the charts and when
  // closes are judged; gold's bars as they were; the rule and the fade side; the zoom, pane-margin and unrounded notes
  // naming 96% only; the measured paragraph's notes' version (4.5) word for word, then gold not measured; ULTRA's; no
  // take-profit and no stop price, whose choices, nothing recorded; the weekend; gold's quiet bars
  it("says in the notes what the one email is, when it is judged, the measured numbers (the notes' version of 4.5, five pairs only), and that it comes apart from ULTRA's", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    const items = ja.alerts.macdxNotes;
    // v9's 16 items: 5 went (the notice, email 2, the catch-up, the band, v9's numbers), 2 came in their place
    expect(items).toHaveLength(13);
    expect(en.alerts.macdxNotes).toHaveLength(13);
    expect(notes).toBe(items.join(""));
    // rewritten: the charts, and when closes are judged (the pairs at the reads 0, 3 and 5 minutes after the hour, gold
    // from 1 to 30 minutes after); how long the mail takes is not measured
    expect(items[0]).toBe(
      "ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルと金の1時間足だけで判定します（オーナーが選んだ5ペアと、あとから足した金）。足が確定した後、5ペアは確定の直後・3分後・5分後（毎時0分・3分・5分）の読み込みで、金は確定の1分後から30分後までの間に判定して送ります（実際に何分で届くかは測っていません）。届いた時の値段は、メールに書いた値段と違うことがあります（その差は測っていません）。",
    );
    // stay: gold's Twelve Data notes (「確定から30分」 is freshFor("1h"))
    expect(items[1]).toContain("金の足は Twelve Data のものです（GMOコインに金がないため。");
    expect(items[1]).toContain("足は小数2桁に丸めた値で、MACD もその値で計算します");
    expect(items[1]).toContain("確定の1分後から判定します。足は、すでに保存されている足（チャートや、サーバーの前回までの確認が読んで保存したもの）にその足があればそれを使い");
    expect(items[1]).toContain("Twelve Data の1日の読み込み回数は、チャートや金のほかの通知と分け合っています。1日の上限に達した日は、足を読めずに、金のメールが出ないことがあります");
    expect(items[1]).toContain("読めたのに足がまだ無い時は、確定の約4分後にもう1回だけ読み、それでも無ければその足は送りません");
    expect(items[1]).toContain("読み込みそのものが失敗した時は、確定から30分まで、1〜3分おきに読み直します。確定から30分を過ぎた足は送りません");
    expect(items[2]).toBe("金の足は、確定の直後（数秒後〜1分後）に読んだ足が、あとで読み直した足と同じかは、まだ確かめていません。金の1時間足を、本番で確定の何秒後に送るかも、まだ見ていません。");
    // rewritten: the rule of 2.1-2.2 and the fade side; one email a bar, none more while the line stays, no skip; the price
    expect(items[3]).toBe(
      "確定した足で、青い線（MACD）が、その足までの新しい120本の MACD の枠の上の端の96%以上にいて、一つ前の足の終わりでは96%に届いていなかった時は売り、枠の下の端の96%以上にいて、一つ前の足の終わりでは96%に届いていなかった時は買いです（どちらも0の線から測ります。上の端で売り、下の端で買いの、逆張りの向きです）。" +
        "枠の上の端は、その120本の青い線・オレンジの線（シグナル）・棒（ヒストグラム）のうち一番高い値で、どれも0より上に無い時は0です。下の端は一番低い値で、どれも0より下に無い時は0です（チャートの MACD の枠と同じ決め方です）。" +
        "端がオレンジの線や棒で決まっている時は、青い線がその96%まで行かないと出ません。96%の所に届いたかは、青い線だけで見ます（オレンジの線と棒は、端を決めるのにだけ使います）。" +
        "MACD は、判定する足で終わる600本の足から計算し、一つ前の足の終わりも、同じ600本の中で見ます。オレンジの線とのクロスは待ちません。" +
        "メールは1つの足で1通だけです。青い線が96%以上にいる間は、次のメールは送りません。一度96%より下で確定し、また96%以上で確定した時に、次のメールを送ります。同じチャート・同じ向きに前の合図があっても、次の合図は送ります。" +
        "入りの値段は、5ペアは、売りはその足の終値の売値、買いは買値で、金はその足の終値です（金には売値・買値の別はありません）。ほかのペアは選べません。",
    );
    // stay: the zoom note; the pane-margin and unrounded notes naming 96% only, the pane-margin note's last sentence the
    // closed bars'
    expect(items[4]).toBe("チャートを拡大・縮小すると MACD の枠の高さは変わりますが、メールはいつも新しい120本で決めます。チャートの MACD は、チャートが読んだ足から計算するので、メールの600本で出した値とわずかに違うことがあります。");
    expect(items[5]).toBe(
      "チャートは、MACD の枠を描く時に、上と下に枠の高さの8%ずつ余白を足しますが、メールの枠の端には、この余白を入れていません。そのため、画面で青い線が、描かれた枠の端から見て、メールの96%の所より内側に見えることがあります。また、チャートは作っている途中の足（まだ確定していない足）も入れて枠を決めます。メールは、確定した足までの新しい120本で決めます。",
    );
    expect(items[6]).toBe("青い線と96%の所は、丸めない値で比べます。チャートは MACD を丸めて見せる（円のペアは小数3桁、金は小数2桁）ので、96%の所のすぐ手前は、画面では届いて見えても出ないことがあります。");
    // in place of v9's numbers: the measured paragraph's notes' version (4.5), word for word as the function's shared
    // code builds it from the 1-hour run, and gold not measured (no number)
    expect(items[7]).toBe(FADE_MEASURED_NOTES.ja);
    expect(items[7]).toContain("合図は1,490回、うち1,468回が+10 pips に届きました。22回は2026年11月10日 21:00（UTC）の時点でまだ届いておらず、その含み損益は合わせて-9,820.9 pips（マイナスが損）");
    expect(items[7]).toContain("メールの決まりで足の終値で入り、");
    expect(items[7]).not.toContain("このメールの決まりで");
    expect(items[7]).not.toContain("このメールでは判定しないので");
    expect(items[8]).toBe("金では測っていません（足は Twelve Data のもので、売値・買値の別はありません）。上の数字は5ペアのもので、金には当てはまりません。");
    expect(items[8]).not.toMatch(/pips|回|%/);
    // stay: ULTRA's
    expect(items[9]).toBe("ULTRA のメールとは別に届きます。両方をオンにすると、同じ時刻に2通届くことがあります。");
    // rewritten: no take-profit and no stop price, how the rule is built and not advice; whose choices (4.3 item 10);
    // nothing recorded
    expect(items[10]).toBe(`${NO_TP_JA}${OWNER_JA}通知は注文の指示ではありません。届いたサインの成績（+10 pips に届いたかどうかも）は、記録も表示もしていません。`);
    // stay: the weekend (its bar counts the 1-hour ones) and gold's quiet bars
    expect(items[11]).toContain("金曜 21:00 UTC（日本時間 土曜 6:00）以後、日曜 22:00 UTC（日本時間 月曜 7:00）より前に確定する足は判定しない");
    expect(items[11]).toContain("週末の前の最後の足は判定されません（米国の夏時間は金曜 20:00〜21:00 UTC の足、冬時間は金曜 20:00〜22:00 UTC の2本）");
    expect(items[12]).toContain("金は、毎日の休み（1時間）の足と、日曜に市場が開く前の足（日曜 22:00 UTC 以後に確定するもの）にも、Twelve Data がほとんど動かない足を返すので、それらの足は判定します");
    expect(items[12]).toContain("金曜の引け後の1本と、日曜の市場が開く前の数時間の足（日曜 22:00 UTC より前に確定するもの）は、判定はしませんが、MACD の計算と、新しい120本には入ります");
    // what went: v9's two emails, the notice, the minute checks, the catch-up, the band, v9's numbers; and older rules'
    for (const no of ["90%", "1通目", "2通目", "知らせを", "毎分", "帯", "持ち続ける", "§8.150", "§8.149", "801回", "+0.19", "−323.6", "95%", "山・谷", "0.190", "ULTRA と同じ", "損切り・利確の目安", "損切りも目標もありません", "MACD の流れ"]) {
      expect(notes, no).not.toContain(no);
    }
    expectFadeGuards(notes, "ja", "the notes");
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
    // (#397: a MACD row that is not a ride's is tagged as an earlier rule's, not as the ride)
    expect(rows[0].textContent).toContain("USD/JPY 1時間 買い（MACD・前の決まり）");
    expect(rows[0].textContent).toContain("目安 158.400 / 損切り 158.270 / 利確 158.440");
    expect(rows[1].textContent).toContain("USD/JPY 5分 売り（MACD・前の決まり）");
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
    // an old v8 row (the 95% email's) keeps its side in colour and its plan line, under a tag that does not call it
    // the ride (that email had a stop and a target, and its side was the other way round)
    expect(rows[4].textContent).toContain("USD/JPY 1時間 売り（MACD・前の決まり）");
    expect(rows[4].textContent).not.toContain("MACD の流れ");
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

  // the MACD fade (research/macdfade1h-prod-spec.md section 5): one email a bar, an entry with the price in only (no
  // take-profit or stop price), its id "…_1h_fade96of120_in_v11" (the shares' "…_v4", 3.7); tagged as the fade, a share's
  // as the stock MACD's fade (not as a v9 share email 1, whose side was the other way round), its side in its colour,
  // and the plan line 「入り 〔entry〕 / 利確・損切りなし」. v9's and older rows read as before (the tests above)
  const fadeRows = [
    { id: "f-pair", kind: "signal", rule: "macdx_12_26_9_w600_1h_fade96of120_in_v11", pair: "USD/JPY", interval: "1h", side: "SELL", closed_at: "2026-11-18T02:00:00.000Z", entry: 158.412, stop: null, target: null, status: "sent", created_at: "2026-11-18T02:05:02.000Z" },
    { id: "f-gold", kind: "signal", rule: "macdx_12_26_9_w600_1h_fade96of120_in_v11", pair: "XAU/USD", interval: "1h", side: "BUY", closed_at: "2026-11-18T03:00:00.000Z", entry: 4139.89, stop: null, target: null, status: "sent", created_at: "2026-11-18T03:01:20.000Z" },
    { id: "f-share", kind: "signal", rule: "stockmacd_12_26_9_w600_1h_fade96of120_in_v4", pair: "NVDA", interval: "1h", side: "SELL", closed_at: "2026-11-18T15:30:00.000Z", entry: 180.12, stop: null, target: null, status: "sent", created_at: "2026-11-18T15:30:40.000Z" },
    { id: "v9-share-in", kind: "signal", rule: "stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2", pair: "NVDA", interval: "1h", side: "BUY", closed_at: "2026-11-12T15:30:00.000Z", entry: 181, stop: null, target: null, status: "sent", created_at: "2026-11-12T15:30:40.000Z" },
    { id: "v9-in", kind: "signal", rule: "macdx_12_26_9_w600_1h_ride90to96of120_in_v9", pair: "USD/JPY", interval: "1h", side: "BUY", closed_at: "2026-11-12T01:00:00.000Z", entry: 158.4, stop: null, target: null, status: "sent", created_at: "2026-11-12T01:00:20.000Z" },
    { id: "v8", kind: "signal", rule: "macdx_12_26_9_w600_1h_z95of120_v8", pair: "USD/JPY", interval: "1h", side: "SELL", closed_at: "2026-11-11T01:00:00.000Z", entry: 158.0, stop: 158.13, target: 157.96, status: "sent", created_at: "2026-11-11T01:00:20.000Z" },
  ];
  // research/macdfade96-spec.md 6.1's two patterns (no text says a price will come back), as 4.1 runs them
  const BACK_JA = /(必ず|いずれ|きっと|そのうち|やがて)[^。]{0,8}戻|戻ってく|戻ってき|戻るはず|戻ります/;
  const BACK_EN =
    /\b(always|will|surely|certainly|eventually)\s+(come|comes|go|goes)\s+back\b|\b(always|will|surely|certainly|eventually)\s+(return|returns|recover|recovers)\b|\bcomes?\s+back\s+(eventually|in\s+the\s+end)\b/i;
  // the screen's texts on the fade (research/macdfade1h-prod-spec.md section 5): no take-profit and no stop price, how
  // the rule is built, not advice (4.3 item 6, the notes' and intros' sentence), and whose choices these are (4.3 item 10;
  // the shares' 4.4 item 10)
  const NO_TP_JA = "利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。";
  const NO_TP_EN = "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a stop.";
  const OWNER_JA =
    "この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・メールを1時間足で判定すること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠（新しい120本）は、アプリの1時間足のチャートの枠と同じです。";
  const OWNER_EN =
    "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging the email on 1-hour bars, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane (the newest 120 bars) is the same as the app's 1-hour chart's.";
  const STOCK_OWNER_JA =
    "この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・逆張りの向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。株は1時間足で判定し、MACD の枠（新しい120本）は、アプリの1時間足のチャートの枠と同じです。";
  const STOCK_OWNER_EN =
    "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, the fade side (shares included) and stating no take-profit or stop price are the app owner's choices. Shares are judged on 1-hour bars, and the MACD pane (the newest 120 bars) is the same as the app's 1-hour chart's.";
  // 4.1: 「利確」 / "take profit" only in the sentences it allows, each written out here (the no-take-profit sentence, the
  // owner's choices, the measured paragraph of 4.5, the plan line's words), stripped before none is looked for;
  // 「利確の目安」 / "take-profit level" never; and the two patterns find nothing
  const ALLOWED_JA = [
    "利確の値段も損切りの値段もありません。",
    "96%・足の確定で判定すること・メールを1時間足で判定すること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。",
    "96%・足の確定で判定すること・逆張りの向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。",
    FADE_MEASURED_NOTES.ja,
    "利確・損切りなし",
  ];
  const ALLOWED_EN = [
    "There is no take-profit price and no stop price.",
    "96%, judging at the bar's close, judging the email on 1-hour bars, the fade side and stating no take-profit or stop price are the app owner's choices.",
    "96%, judging at the bar's close, the fade side (shares included) and stating no take-profit or stop price are the app owner's choices.",
    FADE_MEASURED_NOTES.en,
    "no take profit, no stop",
  ];
  const expectFadeGuards = (t: string, lang: "ja" | "en", what: string) => {
    expect(BACK_JA.test(t), what).toBe(false);
    expect(BACK_EN.test(t), what).toBe(false);
    if (lang === "ja") {
      expect(t, what).not.toContain("利確の目安");
      expect(ALLOWED_JA.reduce((rest, a) => rest.split(a).join(""), t), what).not.toContain("利確");
    } else {
      expect(t.toLowerCase(), what).not.toContain("take-profit level");
      expect(ALLOWED_EN.reduce((rest, a) => rest.split(a).join(""), t), what).not.toMatch(/take.?profit/i);
    }
  };
  // the allowed sentences are in the texts as written (so the strip above takes out what it says)
  it("4.1's allowed sentences are the screen's own, and the guards catch a sentence they do not allow", () => {
    expect(ja.alerts.macdxNotes).toContain(FADE_MEASURED_NOTES.ja);
    expect(en.alerts.macdxNotes).toContain(FADE_MEASURED_NOTES.en);
    for (const a of ALLOWED_JA.slice(0, 3)) expect(`${ja.alerts.indicatorIntro.macdx}${ja.alerts.macdxNotes.join("")}${ja.alerts.stockmacdNotes.join("")}`, a).toContain(a);
    for (const a of ALLOWED_EN.slice(0, 3)) expect(`${en.alerts.indicatorIntro.macdx} ${en.alerts.macdxNotes.join(" ")} ${en.alerts.stockmacdNotes.join(" ")}`, a).toContain(a);
    expect(ja.alerts.fadePlan("1")).toContain(ALLOWED_JA[4]);
    expect(en.alerts.fadePlan("1")).toContain(ALLOWED_EN[4]);
    expect(() => expectFadeGuards(`${NO_TP_JA}利確は10 pipsです。`, "ja", "planted")).toThrow();
    expect(() => expectFadeGuards(`${NO_TP_JA}利確の目安`, "ja", "planted")).toThrow();
    expect(() => expectFadeGuards("どうせ必ず戻ってくる", "ja", "planted")).toThrow();
    expect(() => expectFadeGuards(`${NO_TP_EN} Take profit at 10 pips.`, "en", "planted")).toThrow();
    expect(() => expectFadeGuards("the price will come back", "en", "planted")).toThrow();
    expect(() => expectFadeGuards(`${NO_TP_JA}${OWNER_JA}`, "ja", "clean")).not.toThrow();
    expect(() => expectFadeGuards(`${NO_TP_EN} ${OWNER_EN}`, "en", "clean")).not.toThrow();
  });

  it("the MACD fade's rows: a pair's, gold's and a share's, each an entry in its side's colour, tagged as the fade, with the price in and no take-profit or stop, in Japanese and English", async () => {
    const read = withMacdx({ alerts: fadeRows }).alerts;
    // the fade is read from the id (its level 96); a ride's and an older row's are not the fade's, and a fade row is no ride's
    expect(read.map((r) => [r.rule, r.ride, r.rideOutPct, r.fade])).toEqual([
      ["macdx", null, null, { pct: 96 }],
      ["macdx", null, null, { pct: 96 }],
      ["stockmacd", null, null, { pct: 96 }],
      ["stockmacd", "in", 96, null],
      ["macdx", "in", 96, null],
      ["macdx", null, null, null],
    ]);
    expect(read.map((r) => [r.interval, r.closedAt, r.entry, r.stop, r.target])).toEqual([
      ["1h", "2026-11-18T02:00:00.000Z", 158.412, null, null],
      ["1h", "2026-11-18T03:00:00.000Z", 4139.89, null, null],
      ["1h", "2026-11-18T15:30:00.000Z", 180.12, null, null],
      ["1h", "2026-11-12T15:30:00.000Z", 181, null, null],
      ["1h", "2026-11-12T01:00:00.000Z", 158.4, null, null],
      ["1h", "2026-11-11T01:00:00.000Z", 158.0, 158.13, 157.96],
    ]);
    // the v9 rows' and the earlier rule's tests above hold for every other id
    for (const r of [...rideRows, { ...rideRows[0], rule: "macdx_12_26_9_w600_1h_touch90to95of120_in_v10" }, { ...rideRows[0], rule: "stockmacd_12_26_9_w600_1h_z95of120_v1" }]) {
      expect(withMacdx({ alerts: [r] }).alerts[0].fade, r.rule).toBeNull();
    }
    const { unmount } = render(<SignalAlertSettings call={async () => withMacdx({ alerts: fadeRows })} />);
    let rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows).toHaveLength(6);
    const label = (i: number) => rows[i].querySelector("span:not(.font-mono)") as HTMLElement;
    const time = (i: number) => rows[i].querySelector("span.font-mono") as HTMLElement;
    const plan = (i: number) => rows[i].querySelector("[data-testid='signal-alert-fade-plan']");
    // a pair's: SELL in red, the bar's close as the time (JST), the 1-hour timeframe from its interval
    expect(label(0).textContent).toBe("USD/JPY 1時間 売り（MACD の逆張り）");
    expect(label(0).className).toContain("text-destructive");
    expect(time(0).textContent).toBe("11-18 11:00");
    expect(plan(0)!.textContent).toBe("入り 158.412 / 利確・損切りなし");
    // gold's: BUY in green
    expect(label(1).textContent).toBe("XAU/USD 1時間 買い（MACD の逆張り）");
    expect(label(1).className).toContain("text-success");
    expect(time(1).textContent).toBe("11-18 12:00");
    expect(plan(1)!.textContent).toBe("入り 4139.89 / 利確・損切りなし");
    // a share's: tagged as the stock MACD's fade, not as a v9 share email 1
    expect(label(2).textContent).toBe("NVDA 1時間 売り（株の MACD・逆張り）");
    expect(label(2).className).toContain("text-destructive");
    expect(time(2).textContent).toBe("11-19 00:30");
    expect(plan(2)!.textContent).toBe("入り 180.12 / 利確・損切りなし");
    // v9's rows keep their tags, and no fade plan line; the earlier rule's row its own plan line
    expect(label(3).textContent).toBe("NVDA 1時間 買い（株の MACD）");
    expect(label(4).textContent).toBe("USD/JPY 1時間 買い（MACD の流れ）");
    expect(label(5).textContent).toBe("USD/JPY 1時間 売り（MACD・前の決まり）");
    expect(rows[5].textContent).toContain("目安 158.000 / 損切り 158.130 / 利確 157.960");
    for (const i of [3, 4, 5]) expect(plan(i), String(i)).toBeNull();
    for (const i of [0, 1, 2]) {
      const t = rows[i].textContent!;
      // no price is labelled a take-profit or a stop: 「利確」 and 「損切り」 only in the plan line's 「利確・損切りなし」
      expect(t.replace("利確・損切りなし", ""), String(i)).not.toMatch(/利確|損切り|目安/);
      expect(t, String(i)).not.toContain("MACD の流れ");
      expect(t, String(i)).not.toContain("前の決まり");
      expect(rows[i].querySelector("[data-testid='signal-alert-ride-prices']"), String(i)).toBeNull();
      expect(BACK_JA.test(t), String(i)).toBe(false);
    }
    unmount();
    render(<SignalAlertSettings call={async () => withMacdx({ alerts: fadeRows })} />, "en");
    rows = await screen.findAllByTestId("signal-alert-row");
    expect(label(0).textContent).toBe("USD/JPY 1h Sell (MACD fade)");
    expect(plan(0)!.textContent).toBe("In 158.412 / no take profit, no stop");
    expect(label(1).textContent).toBe("XAU/USD 1h Buy (MACD fade)");
    expect(plan(1)!.textContent).toBe("In 4139.89 / no take profit, no stop");
    expect(label(2).textContent).toBe("NVDA 1h Sell (Stock MACD fade)");
    expect(plan(2)!.textContent).toBe("In 180.12 / no take profit, no stop");
    expect(label(3).textContent).toBe("NVDA 1h Buy (Stock MACD)");
    expect(label(4).textContent).toBe("USD/JPY 1h Buy (MACD ride)");
    for (const i of [0, 1, 2]) {
      const t = rows[i].textContent!;
      expect(t.replace("no take profit, no stop", "").toLowerCase(), String(i)).not.toMatch(/take.profit|stop|target/);
      expect(t, String(i)).not.toContain("MACD ride");
      expect(BACK_EN.test(t), String(i)).toBe(false);
    }
    // the two new texts themselves
    for (const [d, tag] of [[ja, "（MACD の逆張り）"], [en, " (MACD fade)"]] as const) expect(d.alerts.ruleTagFade.macdx).toBe(tag);
    expect(ja.alerts.ruleTagFade.stockmacd).toBe("（株の MACD・逆張り）");
    expect(en.alerts.ruleTagFade.stockmacd).toBe(" (Stock MACD fade)");
    expect(ja.alerts.fadePlan("1")).not.toContain("利確の目安");
    expect(en.alerts.fadePlan("1").toLowerCase()).not.toContain("take-profit level");
  });

  it("is in English too", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-rule-macdx").textContent).toBe("MACD fade");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toBe(en.alerts.indicatorIntro.macdx);
    expect(intro).toContain("A fade signal from the 1-hour chart's MACD(12, 26, 9) blue line.");
    expect(intro).toContain(
      "When a 1-hour bar closes with the blue line at 96% or more of the top of the MACD pane of the newest 120 bars (the highest of the blue line, the orange line and the bars), measured from the zero line, and it was below 96% at the close of the bar before, a SELL; at 96% or more of the bottom (the lowest) and below 96% at the close of the bar before, a BUY (the fade side: a SELL at the top, a BUY at the bottom).",
    );
    expect(intro).toContain("One email a bar, with the price in (on the five pairs the bar's bid close for a SELL and its ask close for a BUY; on gold the bar's close).");
    expect(intro).toContain("No further email while the blue line stays at 96% or more; the next comes after a close below 96% and then a close at 96% or more.");
    expect(intro).toContain("A later signal on the same chart and side is sent too, whatever came before it.");
    expect(intro).toContain(NO_TP_EN);
    expect(intro).toContain("1-hour bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold (XAU/USD) only.");
    expect(intro).toContain(OWNER_EN);
    expect(intro).toContain("Measured on the five pairs (see the notes below); not measured on gold.");
    for (const no of ["90%", "Email 1", "Email 2", "email 2", "notice", "every minute", "with the flow", "MACD ride", "95%", "ULTRA", "peak", "valley", "0.190", "target"]) expect(intro, no).not.toContain(no);
    expectFadeGuards(intro, "en", "the intro (en)");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    const items = en.alerts.macdxNotes;
    expect(notes).toBe(items.join(""));
    expect(items[0]).toBe(
      "Judged on the 1-hour chart of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold only (the five pairs the owner chose, and gold added since). After the bar closes it is judged and sent: the five pairs at the reads right after the close and 3 and 5 minutes after (0, 3 and 5 minutes past each hour), gold between 1 and 30 minutes after the close (how long it takes to arrive has not been measured). The price when it arrives may differ from the price in the email (the difference has not been measured).",
    );
    expect(items[1]).toContain("Gold's bars are Twelve Data's (GMO Coin does not carry gold;");
    expect(items[1]).toContain("A bar more than half an hour after its close is not sent.");
    expect(items[2]).toContain("Whether a bar read soon after its close (a few seconds to a minute) is the same as one read again later has not been checked");
    expect(items[3]).toBe(
      "Sent at a closed bar where the blue line (MACD) is at 96% or more of the top of the MACD pane of the newest 120 bars up to that bar and was below 96% at the close of the bar before (a SELL), or at 96% or more of the pane's bottom and below 96% at the close of the bar before (a BUY); both are measured from the zero line (the fade side: a SELL at the top, a BUY at the bottom). " +
        "The pane's top is the highest of those 120 bars' blue line, orange line (signal) and bars (histogram), or 0 if none is above 0; the bottom is the lowest, or 0 if none is below 0 (as the chart's MACD pane decides it). " +
        "Where the orange line or the bars set the edge, the blue line has to get to 96% of that. Whether it has reached 96% is judged on the blue line alone (the orange line and the bars only set the edge). " +
        "MACD is worked out from the 600 bars ending at the bar judged, and the close of the bar before is read within the same 600 bars. A cross with the orange line is not waited for. " +
        "One email a bar. No further email while the blue line stays at 96% or more; the next comes after a close below 96% and then a close at 96% or more. A later signal on the same chart and side is sent too, whatever came before it. " +
        "The price in is, on the five pairs, the bar's bid close for a SELL and its ask close for a BUY, and on gold the bar's close (gold has no separate bid and ask). No other pair can be chosen.",
    );
    expect(items[4]).toBe("Zooming the chart in or out changes the height of its MACD pane, but the email always goes by the newest 120 bars. The chart works MACD out from the bars it has read, so it can differ a little from the email's, worked out on 600 bars.");
    expect(items[5]).toBe(
      "The chart adds a margin of 8% of the pane's height above and below as it draws the MACD pane; the email's edges do not include it, so the blue line on the screen can look inside the email's 96% mark, seen from the drawn edge. The chart also takes the bar still forming (not closed yet) into its pane. The email goes by the newest 120 bars up to the closed bar.",
    );
    expect(items[6]).toBe("The blue line and the 96% mark are compared unrounded. The chart shows MACD rounded (to 3 decimals on the yen pairs, to 2 on gold), so just short of the mark it can look reached on the chart while nothing is sent.");
    expect(items[7]).toBe(FADE_MEASURED_NOTES.en);
    expect(items[7]).toContain("Entered by the email's rule at the bar's close");
    expect(items[7]).not.toContain("this email's rule");
    expect(items[8]).toBe("Not measured on gold (its bars are Twelve Data's, with no separate bid and ask). The numbers above are the five pairs' and do not apply to gold.");
    expect(items[9]).toBe("It arrives apart from ULTRA's emails: with both on, two emails can come at the same time.");
    expect(items[10]).toBe(`${NO_TP_EN} ${OWNER_EN} An alert is not an instruction to trade. The alerts' results (whether one reached +10 pips included) are not recorded or shown.`);
    expect(items[11]).toContain("The time over the weekend when nothing is judged is drawn wide: a bar that closes at or after Friday 21:00 UTC");
    expect(items[12]).toContain("are not judged, but they count in MACD and in the newest 120 bars.");
    for (const no of ["90%", "Email 1", "Email 2", "email 1", "email 2", "notice", "every minute", "minute by minute", "band", "§8.150", "§8.149", "801", "+0.19", "95%", "peak", "valley", "0.190", "There is no stop and no target", "MACD ride"]) {
      expect(notes, no).not.toContain(no);
    }
    expectFadeGuards(notes, "en", "the notes (en)");
  });

  // the shares' tab (research/macdfade1h-prod-spec.md section 5): the same fade, one email a bar, judged at each 1-hour
  // close; not measured; the shares, the list of 1-hour closes with the Tokyo delay, the weekend and "not an order" as
  // they were
  it("the stock MACD tab describes the fade's one email judged at each 1-hour close, says it is not measured, and keeps the Tokyo 15-minute note", async () => {
    const stockIndicator = { ...indicator, rules: ["qtrend", "ultra", "stockmacd"], stockmacd: { pairs: ["AAPL", "7203.T"], intervals: ["1h"] } };
    render(<SignalAlertSettings call={async () => settings({ indicator: stockIndicator })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-rule-stockmacd").textContent).toBe("株の MACD");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toBe(ja.alerts.indicatorIntro.stockmacd);
    expect(intro).toContain("米国株と日本株の1時間足で、FX と同じ「MACD の逆張り」のメールを送ります（1つの足で1通だけ）。");
    expect(intro).toContain("一つ前の足の終わりでは96%に届いていなかった時は売り（株の売りは空売りです）");
    expect(intro).toContain("入りの値段は、その足の終値です。青い線が96%以上にいる間は、次のメールは送りません。同じ株・同じ向きに前の合図があっても、次の合図は送ります。");
    expect(intro).toContain(NO_TP_JA);
    expect(intro).toContain("株では測っていません。");
    for (const no of ["90%", "1通目", "2通目", "知らせ", "毎分", "MACD の流れ", "目標", "メールに損切り・利確の目安は入りません"]) expect(intro, no).not.toContain(no);
    expectFadeGuards(intro, "ja", "the stock intro");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    const items = ja.alerts.stockmacdNotes;
    expect(items).toHaveLength(7);
    expect(en.alerts.stockmacdNotes).toHaveLength(7);
    expect(notes).toBe(items.join(""));
    expect(items[1]).toBe(
      "決まりは FX の「MACD の逆張り」と同じで、見るのは1時間足の確定ごとです。" +
        "その足で終わる確定足600本から計算した MACD(12・26・9)の青い線が、新しい120本の枠の上の端の96%以上にいて、一つ前の足の終わりでは96%に届いていなかった足で売り、下の端の96%以上にいて、一つ前の足の終わりでは96%に届いていなかった足で買いです（逆張りの向きです。株の売りは空売りで、メールにもそう書きます）。" +
        "メールは1つの足で1通だけで、入りの値段はその足の終値です。青い線が96%以上にいる間は、次のメールは送りません。一度96%より下で確定し、また96%以上で確定した時に、次のメールを送ります。同じ株・同じ向きに前の合図があっても、次の合図は送ります。" +
        "届いた時の値段は、メールに書いた終値と違うことがあります（その差は測っていません）。",
    );
    expect(items[3]).toBe(`${NO_TP_JA}${STOCK_OWNER_JA}取引時間の最後の足の終値は、次の取引時間の始まりまで売買できないことがあります（測っていません）。`);
    expect(items[4]).toBe("株では測っていません。5ペアで測った数字は、株には当てはまりません。損切りをしないので、含み損のまま残る取引が出ることがあります。その株に誰もチェックを入れていない間は、見ていません。");
    // as they were: the shares, the list of 1-hour closes (with the Tokyo delay and "not checked" for the inbox), the
    // weekend and the US half day, "not an order"
    expect(items[0]).toContain("の1時間足だけで判定します（前の決まりで過去の数字を測った銘柄です。今の決まりは、株では測っていません。");
    expect(items[2]).toContain("米国株はニューヨークの 10:30〜15:30 の毎時30分と 16:00、日本株は 10:00・11:00・11:30・13:00・14:00・15:00・15:30 に足が確定し");
    expect(items[2]).toContain("日本株の値段は Yahoo では約15分遅れて届くため、日本株のメールは足が確定してから約15分後に送ります（2026-11-06 に測りました）");
    expect(items[2]).toContain("受信箱に届くまでの時間は確かめていません。");
    expect(items[5]).toBe("週末と、足が無い日（祝日など）は判定しません。米国の取引が早く終わる日は、最後の足を、終わってから30分後に判定します。");
    expect(items[6]).toBe("通知は注文の指示ではありません。届いたサインの勝ち負けの記録は付けていません。");
    // docs §8.133's numbers belong to an earlier rule; v9's two emails are gone
    for (const no of ["1,696回", "99.36%", "−1,837.40%", "1,709通", "95%", "90%", "山・谷", "1通目", "2通目", "損切りも目標もありません", "損切り・利確の目安は付けていません", "MACD の流れ"]) expect(notes, no).not.toContain(no);
    expectFadeGuards(notes, "ja", "the stock notes");
    cleanup();
    render(<SignalAlertSettings call={async () => settings({ indicator: stockIndicator })} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-rule-stockmacd").textContent).toBe("Stock MACD");
    const introEn = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(introEn).toBe(en.alerts.indicatorIntro.stockmacd);
    expect(introEn).toContain("The MACD fade (the same email as on the currency pairs, one a bar) on US and Japanese stocks' 1-hour charts.");
    expect(introEn).toContain("and it was below 96% at the close of the bar before, a SELL (a SELL on a stock is a short sale)");
    expect(introEn).toContain("The price in is the bar's close. No further email while the blue line stays at 96% or more. A later signal on the same stock and side is sent too, whatever came before it.");
    expect(introEn).toContain(NO_TP_EN);
    expect(introEn).toContain("Not measured on stocks.");
    for (const no of ["90%", "Email 1", "Email 2", "notice", "every minute", "MACD ride", "target"]) expect(introEn, no).not.toContain(no);
    expectFadeGuards(introEn, "en", "the stock intro (en)");
    const notesEn = screen.getByTestId("signal-alerts-notes").textContent!;
    const itemsEn = en.alerts.stockmacdNotes;
    expect(notesEn).toBe(itemsEn.join(""));
    expect(itemsEn[1]).toBe(
      "The rule is the currency pairs' MACD fade, looked at at each 1-hour close. " +
        "The MACD(12, 26, 9) blue line, computed on the 600 closed bars ending at the bar, is at 96% or more of the top of the newest 120 bars' pane and was below 96% at the close of the bar before: a SELL; at 96% or more of its bottom and below 96% at the close of the bar before: a BUY (the fade side; a SELL on a stock is a short sale, and the email says so). " +
        "One email a bar, with the bar's close as the price in. No further email while the blue line stays at 96% or more; the next comes after a close below 96% and then a close at 96% or more. A later signal on the same stock and side is sent too, whatever came before it. " +
        "The price when it arrives may differ from the close in the email (the difference has not been measured).",
    );
    expect(itemsEn[3]).toBe(`${NO_TP_EN} ${STOCK_OWNER_EN} The close of a session's last bar may not be tradable until the next session opens (not measured).`);
    expect(itemsEn[4]).toBe("Not measured on stocks. The numbers measured on the five pairs do not apply to stocks. With no stop, some trades can stay open at an unrealised loss. While nobody has a stock ticked it is not watched.");
    expect(itemsEn[2]).toContain("Yahoo's Tokyo prices come about 15 minutes late");
    for (const no of ["1,696", "99.36%", "1,837.40%", "95%", "90%", "peak", "valley", "Email 1", "Email 2", "There is no stop and no target", "MACD ride"]) expect(notesEn, no).not.toContain(no);
    expectFadeGuards(notesEn, "en", "the stock notes (en)");
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
