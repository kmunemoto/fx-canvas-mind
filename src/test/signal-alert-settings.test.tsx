import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import SignalAlertSettings from "../components/SignalAlertSettings";
import { AlertRequestError, normalizeAlertSettings, type AlertSettings } from "../lib/signalAlerts";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const payload = (over: Record<string, unknown> = {}) => ({
  ok: true,
  allowed: true,
  email_configured: true,
  email: "me@example.com",
  pairs: ["USD/JPY", "EUR/USD"],
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
      body.action === "set" ? settings({ subscriptions: [{ pair: "USD/JPY", interval: "15min" }, { pair: "EUR/USD", interval: "1h" }] }) : settings()
    );
    render(<SignalAlertSettings call={call} />);
    const on = await screen.findByTestId("signal-alert-USD/JPY-15min");
    expect((on as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/me@example\.com/)).toBeTruthy();
    const off = screen.getByTestId("signal-alert-EUR/USD-1h") as HTMLInputElement;
    expect(off.checked).toBe(false);
    fireEvent.click(off);
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "EUR/USD", interval: "1h", on: true, lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-EUR/USD-1h") as HTMLInputElement).checked).toBe(true));
  });

  it("without Pro nothing new can be ticked, but a tick can still be removed", async () => {
    render(<SignalAlertSettings call={async () => settings({ allowed: false })} />);
    expect(await screen.findByTestId("signal-alerts-pro-only")).toBeTruthy();
    expect((screen.getByTestId("signal-alert-EUR/USD-1h") as HTMLInputElement).disabled).toBe(true);
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
