// #387 (docs §8.130): the owner's video's EMA 20 / 200 way by email (signal-alerts
// v34) — the 15-minute chart of the five pairs and gold, each bar judged on the 600
// closed bars ending at it with the chart's code, the rule's levels, the measured
// figures — and its tab in the settings.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import SignalAlertSettings from "../components/SignalAlertSettings";
import { normalizeAlertSettings } from "../lib/signalAlerts";
import { emaReturnMarks, emaReturnNewest } from "../lib/emaReturn";
import {
  EMARM_INTERVALS,
  EMARM_PAIRS,
  EMARM_RULE_ID,
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  INDICATOR_RULES,
  emarmSignals,
  indicatorIntervalsFor,
  indicatorRuleId,
  isIndicatorChartFor,
  isIndicatorRule,
  renderIndicatorMail,
} from "../../supabase/functions/signal-alerts/indicators";
import { renderTestMail } from "../../supabase/functions/signal-alerts/logic";
import { buyCase, mirror, toCandles, walk } from "./ema-return-case";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const openMs = (c: { datetime: string }) => Date.parse(`${c.datetime.replace(" ", "T")}Z`);
const SIX = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD", "XAU/USD"];

describe("#387 the EMA 20 / 200 way's email (signal-alerts v34)", () => {
  it("is a rule of its own, under its own id, on the 15-minute chart of the five pairs and gold only", () => {
    expect(INDICATOR_RULES).toContain("emarm");
    expect(isIndicatorRule("emarm")).toBe(true);
    expect(EMARM_RULE_ID).toBe("emarm_ema20_200_w600_from400_piv3_skip2_v1");
    expect(indicatorRuleId("emarm")).toBe(EMARM_RULE_ID);
    expect([...EMARM_PAIRS]).toEqual(SIX);
    expect([...EMARM_INTERVALS]).toEqual(["15min"]);
    for (const pair of INDICATOR_PAIRS) {
      for (const iv of ["1min", ...INDICATOR_INTERVALS]) {
        expect(isIndicatorChartFor("emarm", pair, iv), `${pair} ${iv}`).toBe(SIX.includes(pair) && iv === "15min");
      }
    }
  });

  it("mails the entry of the bar just closed, judged on the 600 closed bars ending at it, with the rule's levels", () => {
    const { bars, x, t, b, k } = buyCase(undefined, 400);
    const closed = toCandles(bars).slice(-600);
    const off = bars.length - 600;
    const last = closed[closed.length - 1];
    const closeMs = openMs(last) + M15;
    const want = emaReturnNewest(bars)!;
    expect(want.side).toBe("BUY");
    const sigs = emarmSignals("USD/JPY", "15min", closed, closeMs + 12_000);
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    const closeOf = (i: number) => new Date(openMs(toCandles(bars)[i]) + M15).toISOString();
    expect(s).toMatchObject({
      rule: "emarm",
      pair: "USD/JPY",
      interval: "15min",
      side: "BUY",
      barTime: new Date(openMs(last)).toISOString(),
      closedAt: new Date(closeMs).toISOString(),
      close: want.entry,
      sl: want.stop,
      tps: [want.tp1, want.tp2],
    });
    expect(s.emarm).toEqual({
      crossClosedAt: closeOf(x),
      touchClosedAt: closeOf(t),
      a: want.a,
      aClosedAt: closeOf(x + 5),
      neck: want.neck,
      neckClosedAt: closeOf(b),
      breakClosedAt: closeOf(k),
      retestClosedAt: closeOf(k + 3),
      rr: want.rr,
    });
    expect(off).toBeGreaterThanOrEqual(0);
    // fresh for 20 minutes after the close; not before it
    expect(emarmSignals("USD/JPY", "15min", closed, closeMs + 20 * 60_000)).toHaveLength(1);
    expect(emarmSignals("USD/JPY", "15min", closed, closeMs + 20 * 60_000 + 1)).toHaveLength(0);
    expect(emarmSignals("USD/JPY", "15min", closed, closeMs - 1)).toHaveLength(0);
    // the bar after it closed too (a run missed): mailed as the bar before the newest where the
    // chart holds its 600 bars as well (gold's keeps some 1,000); on GMO's 600, the newest's only
    const next = toCandles([...bars, { o: want.entry, h: want.entry + 0.01, l: want.entry - 0.01, c: want.entry }]);
    expect(emarmSignals("USD/JPY", "15min", next.slice(-601), closeMs + M15 + 5_000).map((x) => x.barTime)).toEqual([new Date(openMs(last)).toISOString()]);
    expect(emarmSignals("USD/JPY", "15min", next.slice(-600), closeMs + M15 + 5_000)).toHaveLength(0);
    // not on a chart the rule is not offered on, nor on fewer than 600 bars
    expect(emarmSignals("GBP/JPY", "15min", closed, closeMs + 12_000)).toHaveLength(0);
    expect(emarmSignals("USD/JPY", "1h", closed, closeMs + 12_000)).toHaveLength(0);
    expect(emarmSignals("USD/JPY", "15min", closed.slice(1), closeMs + 12_000)).toHaveLength(0);
    // gold's 15-minute chart is
    expect(emarmSignals("XAU/USD", "15min", closed, closeMs + 12_000)).toHaveLength(1);
  });

  it("mails every mark the chart draws on a full window, at its own bar's close (and once more while it is fresh), and no other", () => {
    let mailed = 0;
    for (let seed = 11; seed <= 20; seed++) {
      const bars = walk(2000, seed);
      const candles = toCandles(bars);
      const marks = emaReturnMarks(bars, 599).filter((m) => m.full);
      for (let i = 599; i < bars.length; i++) {
        // the 600 bars ending at i, and the one before them (i − 1 judged on its own 600)
        const closed = candles.slice(Math.max(0, i - 600), i + 1);
        // 5 seconds after i's close: i's own and i − 1's (15 minutes old) are fresh
        const sigs = emarmSignals("USD/JPY", "15min", closed, openMs(candles[i]) + M15 + 5_000);
        const want = marks.filter((m) => m.at === i || (m.at === i - 1 && i - 1 >= 599));
        expect(sigs.map((x) => [x.barTime, x.side, x.close, x.sl]), `${seed} ${i}`).toEqual(
          want.map((m) => [new Date(openMs(candles[m.at])).toISOString(), m.side, m.entry, m.stop]),
        );
        mailed += sigs.filter((x) => x.barTime === new Date(openMs(candles[i])).toISOString()).length;
      }
    }
    // 6 when written
    expect(mailed).toBeGreaterThan(3);
  });

  it("writes the email in Japanese and English: the lines, the entry, stop and targets, the measured figures", () => {
    const { bars } = buyCase(undefined, 400);
    const closed = toCandles(bars).slice(-600);
    const closeMs = openMs(closed[closed.length - 1]) + M15;
    const s = emarmSignals("USD/JPY", "15min", closed, closeMs + 12_000)[0];
    const m = emaReturnNewest(bars)!;
    const f = (v: number) => v.toFixed(3);
    const ja = renderIndicatorMail(s, "ja");
    expect(ja.subject).toBe("【Sextant】ドル/円 15分足 買い（BUY）のサイン（EMAクロス＋リターンムーブ）");
    expect(ja.text).toContain("EMAクロス＋リターンムーブ（動画のやり方）の買い（BUY）が出ました。リターンムーブの足の実体を、終値で上に抜けた足です。");
    expect(ja.text).toContain("ゴールデンクロス（EMA20 が EMA200 を上に抜けた）: ");
    expect(ja.text).toContain(`水平線 ${f(m.neck)}（`);
    expect(ja.text).toContain(`A ${f(m.a)}（`);
    expect(ja.text).toContain(`エントリー ≈ ${f(m.entry)}`);
    expect(ja.text).toContain(`損切り ${f(m.stop)}（${((m.entry - m.stop) / 0.01).toFixed(1)}pips。斜めの線を抜けた足からこの足までの最安値）`);
    expect(ja.text).toContain(`利確1 ${f(m.tp1)}（${((m.tp1 - m.entry) / 0.01).toFixed(1)}pips。A：クロスからの最高値、直近高値）`);
    expect(ja.text).toContain(`利確2 ${f(m.tp2!)}（`);
    expect(ja.text).toContain(`利確1までの幅 ÷ 損切りまでの幅: ${m.rr.toFixed(2)}`);
    expect(ja.text).toContain("この損切りと利確1では11勝11敗（勝率50.0%）、平均で勝ち +18.2 pips・負け −16.7 pips、1回あたり +0.7 pips でした");
    // the owner's way with all CLAUDE.md asks beside its rate: a trade's profit or loss, the ones still open, how far
    // against, how long
    expect(ja.text).toContain("ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの15分足の過去52週");
    expect(ja.text).toContain(
      "損切りなしで利確1まで持つと、22回のうち20回が届き（平均 +21.4 pips、届くまでの足は中ほど35本・最長1,894本）、2回はまだ届いていません（含み損 −786.1 pips と −607.2 pips、18,594本と11,741本持っている）。この2回を最後の終値で数えると、合計 −964.7 pips、1回あたり −43.9 pips です。持っている間に逆へ動いた幅は、中ほど7.7 pips、最大861.2 pips でした。",
    );
    expect(ja.text).toContain("「設定」→「メール通知」の「EMAクロス＋リターンムーブ」でチェックを外してください");
    expect(ja.text).not.toContain("金そのものは測っていません");
    const en = renderIndicatorMail(s, "en");
    expect(en.subject).toBe("[Sextant] USD/JPY 15-minute BUY signal (EMA cross + return move)");
    expect(en.text).toContain(`Entry ≈ ${f(m.entry)}`);
    expect(en.text).toContain("11 won and 11 lost (50.0%)");
    expect(en.text).toContain("counting those at the last close, −964.7 pips in all, −43.9 pips a trade. The price went against the entry 7.7 pips in the middle and 861.2 pips at most.");
    expect(en.text).toContain("untick the chart under EMA cross + return move");
    // a sell (the mirror), on gold: its words, and gold not measured
    const down = toCandles(mirror(bars)).slice(-600);
    const sell = emarmSignals("XAU/USD", "15min", down, closeMs + 12_000)[0];
    expect(sell.side).toBe("SELL");
    const jaS = renderIndicatorMail(sell, "ja");
    expect(jaS.subject).toBe("【Sextant】金 15分足 売り（SELL）のサイン（EMAクロス＋リターンムーブ）");
    expect(jaS.text).toContain("デッドクロス（EMA20 が EMA200 を下に抜けた）");
    expect(jaS.text).toContain("この足までの最高値）");
    expect(jaS.text).toContain("金そのものは測っていません。");
    expect(jaS.text).toContain("Twelve Data");
    expect(renderIndicatorMail(sell, "en").text).toContain("Gold itself has not been measured.");
  });

  it("the sweep reads the rule's subscriptions and judges it beside the others, its failure apart; the database accepts the rule", () => {
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3,emarm)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toMatch(/try \{\s+sigs\.push\(\.\.\.emarmSignals\(pair, interval, closed, nowMs\)\);\s+\} catch \(err\) \{\s+console\.error\("emarm failed:", pair, interval, err\);\s+\}/);
    expect(fn).toContain("emarm: { pairs: EMARM_PAIRS, intervals: EMARM_INTERVALS },");
    expect(fn).toContain('const FUNCTION_VERSION = "signal-alerts-v35-2026-10-31T16:00:00Z";');
    expect(renderTestMail([{ pair: "USD/JPY", interval: "15min", rule: "emarm" }], "ja").text).toContain("登録中のチャート: ドル/円 15分足（EMAクロス＋リターンムーブ）");
    expect(renderTestMail([{ pair: "USD/JPY", interval: "15min", rule: "emarm" }], "en").text).toContain("Charts you follow: USD/JPY 15-minute (EMA cross + return move)");
    const mig = readFileSync("supabase/migrations/20261030070000_signal_alert_emarm.sql", "utf8");
    expect(mig).toContain("check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx', 'sweepx', 'amdpo3', 'emarm']));");
  });
});

describe("#387 the EMA 20 / 200 way's email in the settings", () => {
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
      emarm: { pairs: EMARM_PAIRS, intervals: EMARM_INTERVALS },
    },
    ...over,
  });

  it("has its own tab on the six's 15-minute chart, its own notes, and saves a tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      normalizeAlertSettings(body.action === "set" ? payload({ subscriptions: [{ pair: "XAU/USD", interval: "15min", rule: "emarm" }] }) : payload())!
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-emarm"));
    expect(screen.getByTestId("signal-alerts-rule-emarm").textContent).toBe("EMAクロス＋リターンムーブ");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toContain("15分足だけです");
    expect(intro).toContain("11勝11敗（勝率50.0%）");
    const rows = screen.getByTestId("signal-alerts-grid").querySelectorAll("tbody tr");
    expect(rows.length).toBeLessThanOrEqual(SIX.length + 1);
    expect(screen.getByTestId("signal-alert-emarm-USD/JPY-15min")).toBeTruthy();
    expect(screen.queryByTestId("signal-alert-emarm-USD/JPY-1h")).toBeNull();
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("クロスからエントリーまで約200本");
    expect(notes).toContain("2回はまだ届いていません");
    fireEvent.click(screen.getByTestId("signal-alert-emarm-XAU/USD-15min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "XAU/USD", interval: "15min", on: true, rule: "emarm", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-emarm-XAU/USD-15min") as HTMLInputElement).checked).toBe(true));
    // AMD Po3's tick is another rule's
    fireEvent.click(screen.getByTestId("signal-alerts-rule-amdpo3"));
    expect((screen.getByTestId("signal-alert-amdpo3-XAU/USD-15min") as HTMLInputElement).checked).toBe(false);
  });

  it("from a server that does not send the rule's charts: says it is not available yet", async () => {
    const call = vi.fn(async () => normalizeAlertSettings(payload({ indicator: { rules: INDICATOR_RULES, pairs: INDICATOR_PAIRS, intervals: INDICATOR_INTERVALS, limited: {} } }))!);
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-emarm"));
    expect(screen.getByTestId("signal-alerts-emarm-unavailable")).toBeTruthy();
  });
});
