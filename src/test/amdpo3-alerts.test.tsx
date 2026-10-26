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
  AMDPO3_RULE_ID,
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  INDICATOR_RULES,
  amdpo3Signals,
  indicatorIntervalsFor,
  indicatorRuleId,
  isIndicatorChartFor,
  isIndicatorRule,
  renderIndicatorMail,
} from "../../supabase/functions/signal-alerts/indicators";
import { renderTestMail } from "../../supabase/functions/signal-alerts/logic";
import { amdPo3, amdPo3Trades, pineFmt } from "../lib/amdPo3";
import { AMD_M15, amdWalk } from "./amd-po3-walk";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const walk = amdWalk(1600);
const full = amdPo3(walk.map((b) => ({ o: b.open, h: b.high, l: b.low, c: b.close })), { mintick: 0.001 });
const trades = amdPo3Trades(full.events);
const openMs = (i: number) => Date.parse(`${walk[i].datetime.replace(" ", "T")}Z`);

describe("#385 the AMD Po3 email (signal-alerts v32)", () => {
  it("is a rule of its own, under its own id, on the charts Q-Trend and ULTRA are mailed on", () => {
    expect(INDICATOR_RULES).toContain("amdpo3");
    expect(isIndicatorRule("amdpo3")).toBe(true);
    expect(AMDPO3_RULE_ID).toBe("amdpo3_v2.4.0_defaults_v1");
    expect(indicatorRuleId("amdpo3")).toBe(AMDPO3_RULE_ID);
    for (const pair of INDICATOR_PAIRS) {
      for (const iv of ["1min", ...INDICATOR_INTERVALS]) {
        expect(isIndicatorChartFor("amdpo3", pair, iv), `${pair} ${iv}`).toBe(isIndicatorChartFor("qtrend", pair, iv));
      }
    }
    expect(isIndicatorChartFor("amdpo3", "USD/CAD", "15min")).toBe(false);
    expect(isIndicatorChartFor("amdpo3", "XAU/USD", "15min")).toBe(true);
  });

  it("mails the DIST of the bar just closed, judged on the 600 closed bars ending at it, with the original's levels", () => {
    const tr = trades.find((t) => t.bar >= 700 && t.dir === -1) ?? trades.find((t) => t.bar >= 700)!;
    const closed = walk.slice(tr.bar - 599, tr.bar + 1);
    const closeMs = openMs(tr.bar) + AMD_M15;
    const sigs = amdpo3Signals("USD/JPY", "15min", closed, closeMs + 12_000);
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    expect(s).toMatchObject({
      rule: "amdpo3",
      pair: "USD/JPY",
      interval: "15min",
      side: tr.dir === 1 ? "BUY" : "SELL",
      barTime: new Date(openMs(tr.bar)).toISOString(),
      closedAt: new Date(closeMs).toISOString(),
      close: tr.entry,
      sl: tr.stop,
      tps: [tr.target],
    });
    expect(s.close).toBe(walk[tr.bar].close);
    expect(s.amd).toEqual({
      rangeHigh: tr.rangeHigh,
      rangeLow: tr.rangeLow,
      rangeFromClosedAt: new Date(openMs(tr.rangeStart) + AMD_M15).toISOString(),
      sweepSide: tr.sweepSide === 1 ? "HIGH" : "LOW",
      sweepExtreme: tr.sweepExtreme,
      riskR: tr.riskR,
      rr: pineFmt(tr.rr, 2),
    });
    // a sweep over the range sells, under it buys
    expect(s.side === "SELL").toBe(tr.sweepSide === 1);
    // past the 15-minute chart's 20 minutes, nothing; nor a minute before the close
    expect(amdpo3Signals("USD/JPY", "15min", closed, closeMs + 20 * 60_000 + 1)).toHaveLength(0);
    expect(amdpo3Signals("USD/JPY", "15min", closed, closeMs - 1)).toHaveLength(0);
    // the bar after: the same one while it is fresh (as Q-Trend's: the claim's
    // unique key keeps it from being mailed twice), nothing new
    const next = walk.slice(tr.bar - 598, tr.bar + 2);
    const again = amdpo3Signals("USD/JPY", "15min", next, closeMs + AMD_M15 + 12_000);
    expect(again.map((x) => [x.barTime, x.close, x.sl, x.tps])).toEqual(trades.filter((t) => t.bar === tr.bar || t.bar === tr.bar + 1).map((t) => [new Date(openMs(t.bar)).toISOString(), t.entry, t.stop, [t.target]]));
    // not on a chart the rule is not offered on, nor on too few bars for a first cycle
    expect(amdpo3Signals("USD/JPY", "1min", closed, closeMs + 12_000)).toHaveLength(0);
    expect(amdpo3Signals("USD/CAD", "15min", closed, closeMs + 12_000)).toHaveLength(0);
    expect(amdpo3Signals("USD/JPY", "15min", closed.slice(-220), closeMs + 12_000)).toHaveLength(0);
  });

  it("mails every DIST the chart's run opens on the walk, at its own bar's close (and once more while it is fresh), and no other", () => {
    const mailed = new Set<string>();
    for (let b = 599; b < walk.length; b++) {
      // 5 seconds after b's close: b's own and b − 1's (15 minutes old) are fresh, older ones not
      const sigs = amdpo3Signals("USD/JPY", "15min", walk.slice(b - 599, b + 1), openMs(b) + AMD_M15 + 5_000);
      const want = trades.filter((t) => (t.bar === b || t.bar === b - 1) && t.bar >= b - 599);
      expect(sigs.map((x) => [x.barTime, x.close, x.sl, x.tps![0]]), String(b)).toEqual(want.map((t) => [new Date(openMs(t.bar)).toISOString(), t.entry, t.stop, t.target]));
      for (const x of sigs) mailed.add(x.barTime);
    }
    expect([...mailed].sort()).toEqual(trades.filter((t) => t.bar >= 599).map((t) => new Date(openMs(t.bar)).toISOString()).sort());
    expect(mailed.size).toBeGreaterThan(3);
  });

  it("writes the email in Japanese and English: the D, the range and the sweep, the original's entry, stop, target and R:R, not measured", () => {
    const tr = trades.find((t) => t.bar >= 700)!;
    const closed = walk.slice(tr.bar - 599, tr.bar + 1);
    const s = amdpo3Signals("USD/JPY", "15min", closed, openMs(tr.bar) + AMD_M15 + 12_000)[0];
    const buy = s.side === "BUY";
    const ja = renderIndicatorMail(s, "ja");
    expect(ja.subject).toBe(`【Sextant】ドル/円 15分足 ${buy ? "買い（BUY・D ▲）" : "売り（SELL・D ▼）"}のサイン（AMD Po3）`);
    expect(ja.text).toContain(`AMD Po3 の ${buy ? "D ▲（買い）" : "D ▼（売り）"}が出ました`);
    expect(ja.text).toContain(`集積（値幅が縮んだ範囲）: ${tr.rangeLow.toFixed(3)} 〜 ${tr.rangeHigh.toFixed(3)}`);
    expect(ja.text).toContain(`仕掛け: 範囲の${tr.sweepSide === 1 ? "上" : "下"}を ${tr.sweepExtreme.toFixed(3)} まで抜けたあと`);
    expect(ja.text).toContain(`エントリー ≈ ${tr.entry.toFixed(3)}`);
    expect(ja.text).toContain(`損切り ${tr.stop.toFixed(3)}（`);
    expect(ja.text).toContain(`目標 ${tr.target.toFixed(3)}（`);
    expect(ja.text).toContain(`R:R ${pineFmt(tr.rr, 2)}（目標までの幅 ÷ 損切りまでの幅）。64本たっても届かなければ時間切れ`);
    expect(ja.text).toContain("WillyAlgoTrader");
    expect(ja.text).toContain("この決まりの勝率と1回あたりの損益は、まだ測っていません。");
    expect(ja.text).toContain("「設定」→「メール通知」の「AMD Po3」でチェックを外してください");
    const en = renderIndicatorMail(s, "en");
    expect(en.subject).toBe(`[Sextant] USD/JPY 15-minute ${buy ? "BUY (D ▲)" : "SELL (D ▼)"} signal (AMD Po3)`);
    expect(en.text).toContain(`Entry ≈ ${tr.entry.toFixed(3)}`);
    expect(en.text).toContain(`R:R ${pineFmt(tr.rr, 2)}`);
    expect(en.text).toContain("have not been measured");
    expect(en.text).toContain("untick the chart under AMD Po3");
  });

  it("the sweep reads the rule's subscriptions and judges it beside the others, its failure apart; the database accepts the rule", () => {
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toMatch(/try \{\s+sigs\.push\(\.\.\.amdpo3Signals\(pair, interval, closed, nowMs\)\);\s+\} catch \(err\) \{\s+console\.error\("amdpo3 failed:", pair, interval, err\);\s+\}/);
    expect(fn).toContain('const FUNCTION_VERSION = "signal-alerts-v32-2026-10-26T15:00:00Z";');
    // the test email names the rule (not RSI + SAR)
    expect(renderTestMail([{ pair: "USD/JPY", interval: "15min", rule: "amdpo3" }], "ja").text).toContain("登録中のチャート: ドル/円 15分足（AMD Po3）");
    expect(renderTestMail([{ pair: "USD/JPY", interval: "15min", rule: "amdpo3" }], "en").text).toContain("Charts you follow: USD/JPY 15-minute (AMD Po3)");
    const mig = readFileSync("supabase/migrations/20261026150000_signal_alert_amdpo3.sql", "utf8");
    expect(mig).toContain("check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx', 'sweepx', 'amdpo3']));");
  });
});

describe("#385 the AMD Po3 email in the settings", () => {
  const twelve = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).length < INDICATOR_INTERVALS.length);
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
      limited: Object.fromEntries(twelve.map((p) => [p, indicatorIntervalsFor(p)])),
    },
    ...over,
  });

  it("has its own tab on Q-Trend's and ULTRA's charts, its own notes, and saves a tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      normalizeAlertSettings(body.action === "set" ? payload({ subscriptions: [{ pair: "XAU/USD", interval: "15min", rule: "amdpo3" }] }) : payload())!
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-amdpo3"));
    expect(screen.getByTestId("signal-alerts-rule-amdpo3").textContent).toBe("AMD Po3");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toContain("D ▲（買い）・D ▼（売り）");
    expect(intro).toContain("まだ測っていません");
    const rows = screen.getByTestId("signal-alerts-grid").querySelectorAll("tbody tr");
    expect(rows).toHaveLength(INDICATOR_PAIRS.length + 1);
    expect(screen.getByTestId("signal-alert-amdpo3-USD/JPY-5min")).toBeTruthy();
    expect(screen.getByTestId("signal-alert-amdpo3-USD/CAD-15min-none").textContent).toBe("—");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("1,527回すべてで同じでした");
    expect(notes).toContain("このメールの勝率ではありません");
    fireEvent.click(screen.getByTestId("signal-alert-amdpo3-XAU/USD-15min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "XAU/USD", interval: "15min", on: true, rule: "amdpo3", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-amdpo3-XAU/USD-15min") as HTMLInputElement).checked).toBe(true));
    // Q-Trend's tick is another rule's
    fireEvent.click(screen.getByTestId("signal-alerts-rule-qtrend"));
    expect((screen.getByTestId("signal-alert-qtrend-XAU/USD-15min") as HTMLInputElement).checked).toBe(false);
  });
});
