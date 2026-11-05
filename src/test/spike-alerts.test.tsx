// #395 (docs §8.138): a sharp rise or fall of the 1-hour bar by email (signal-alerts
// v36) — the rule (its high or low 3 times the mean range of the 120 closed bars
// before it from its open), read on the forming bar as it forms, the five pairs and
// gold, once a bar and side — and its tab in the settings.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import SignalAlertSettings from "../components/SignalAlertSettings";
import { normalizeAlertSettings } from "../lib/signalAlerts";
import { SPIKE, spikeMarks, spikeOf, spikeRange } from "../lib/spike";
import {
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  INDICATOR_RULES,
  SPIKE_INTERVALS,
  SPIKE_LATE_MS,
  SPIKE_PAIRS,
  SPIKE_RULE_ID,
  goldHourBar,
  indicatorIntervalsFor,
  indicatorRuleId,
  isIndicatorChartFor,
  isIndicatorRule,
  renderIndicatorMail,
  spikeRangeFor,
  spikeSignals,
} from "../../supabase/functions/signal-alerts/indicators";
import { renderTestMail } from "../../supabase/functions/signal-alerts/logic";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult => rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const H = 3_600_000;
const SIX = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD", "XAU/USD"];
// Wednesday 2026-10-28 00:00 UTC: T0 + 130 hours is Monday 2026-11-02 10:00 UTC (19:00 JST)
const T0 = Date.UTC(2026, 9, 28, 0);
const dt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
// `n` closed 1-hour bars from `from`, each 0.125 high to low around 100 (R = 0.125, exact
// in binary; made through the weekend too, which spikeRangeFor's count of open hours
// without a bar does not mind)
const flat = (n: number, from = T0) =>
  Array.from({ length: n }, (_, i) => ({ datetime: dt(from + i * H), open: 100, high: 100.0625, low: 99.9375, close: 100 }));
// each bar's R as the sweep keeps it (spikeRangeFor), for spikeSignals
const rangesOf = (pair: string, history: ReturnType<typeof flat>, ...opens: number[]) =>
  new Map(opens.flatMap((t) => {
    const g = spikeRangeFor(pair, history, t);
    return g.status === "ok" && g.r !== null ? [[t, { r: g.r, behind: g.behind }] as const] : [];
  }));

describe("#395 the rule (_shared/spike.ts)", () => {
  it("R is the mean high − low of exactly the 120 bars before; none without them or when not above zero", () => {
    const bars = flat(120).map((b) => ({ h: b.high, l: b.low }));
    expect(spikeRange(bars)).toBe(0.125);
    expect(spikeRange(bars.slice(1))).toBeNull();
    expect(spikeRange(bars.map((b) => ({ h: b.l, l: b.l })))).toBeNull();
    expect(SPIKE).toEqual({ k: 3, bars: 120 });
  });

  it("a rise when the high has gone 3 R above the open (3 R itself counts), a fall when the low has gone as far below", () => {
    expect(spikeOf({ o: 100, h: 100.375, l: 100 }, 0.125)).toMatchObject({ isUp: true, isDown: false, upX: 3, downX: 0 });
    expect(spikeOf({ o: 100, h: 100.37, l: 100 }, 0.125).isUp).toBe(false);
    expect(spikeOf({ o: 100, h: 100, l: 99.5 }, 0.125)).toMatchObject({ isUp: false, isDown: true, downX: 4 });
    // both on one bar
    expect(spikeOf({ o: 100, h: 100.5, l: 99.5 }, 0.125)).toMatchObject({ isUp: true, isDown: true });
  });

  it("marks each bar from the 120th on against the 120 bars before it", () => {
    const bars = flat(130).map((b) => ({ o: b.open, h: b.high, l: b.low }));
    bars[125] = { o: 100, h: 100.5, l: 99.9375 };
    bars[60] = { o: 100, h: 101, l: 99 };
    const m = spikeMarks(bars);
    expect(m.map((x) => x.i)).toEqual([125]);
    // bar 60 is too early to be read, and it widens R for the bars after it
    expect(m[0].r).toBeCloseTo((119 * 0.125 + 2) / 120, 12);
  });
});

describe("#395 the email (signal-alerts v36)", () => {
  it("is a rule of its own, under its own id, on the 1-hour chart of the five pairs and gold only", () => {
    expect(INDICATOR_RULES).toContain("spike");
    expect(isIndicatorRule("spike")).toBe(true);
    expect(SPIKE_RULE_ID).toBe("spike_1h_x3_r120_v1");
    expect(indicatorRuleId("spike")).toBe(SPIKE_RULE_ID);
    expect([...SPIKE_PAIRS]).toEqual(SIX);
    expect([...SPIKE_INTERVALS]).toEqual(["1h"]);
    for (const pair of INDICATOR_PAIRS) {
      for (const iv of ["1min", ...INDICATOR_INTERVALS]) {
        expect(isIndicatorChartFor("spike", pair, iv), `${pair} ${iv}`).toBe(SIX.includes(pair) && iv === "1h");
      }
    }
  });

  it("works R out of the newest 120 bars before the bar (not the bar itself, nor older ones)", () => {
    // 30 older bars twice as wide, then 120 of 0.125; the bar itself (in the history) wider still
    const wide = flat(30).map((c) => ({ ...c, high: 100.125, low: 99.875 }));
    const history = [...wide, ...flat(120, T0 + 30 * H), { datetime: dt(T0 + 150 * H), open: 100, high: 101, low: 99, close: 100 }];
    expect(spikeRangeFor("USD/JPY", history, T0 + 150 * H)).toEqual({ status: "ok", r: 0.125, behind: 0, lastBar: T0 + 149 * H });
    // the bar after it: its 120 hold the wide bar
    expect(spikeRangeFor("USD/JPY", history, T0 + 151 * H).r).toBeCloseTo((119 * 0.125 + 2) / 120, 12);
    // fewer than 120 before it
    expect(spikeRangeFor("USD/JPY", flat(119), T0 + 119 * H)).toMatchObject({ status: "short", r: null });
    // not above zero
    expect(spikeRangeFor("USD/JPY", flat(130).map((c) => ({ ...c, high: 100, low: 100 })), T0 + 130 * H)).toMatchObject({ status: "zero", r: null });
  });

  it("allows the bars to end one open hour early, not two; the weekend and gold's daily hour are not counted", () => {
    const history = flat(130); // to Monday 2026-11-02 09:00 UTC
    expect(spikeRangeFor("USD/JPY", history, T0 + 131 * H)).toMatchObject({ status: "ok", behind: 1, r: 0.125 });
    expect(spikeRangeFor("USD/JPY", history, T0 + 132 * H)).toMatchObject({ status: "stale", behind: 2, r: null });
    // bars to Friday 2026-11-06 20:00 UTC, the bar Sunday 22:00 UTC: the weekend between
    const fri20 = Date.UTC(2026, 10, 6, 20);
    const toFri = flat(125, fri20 - 124 * H);
    expect(spikeRangeFor("USD/JPY", toFri, fri20 + (2 * 24 + 2) * H)).toMatchObject({ status: "ok", behind: 0 });
    expect(spikeRangeFor("USD/JPY", toFri, fri20 + (2 * 24 + 4) * H)).toMatchObject({ status: "stale", behind: 2 });
    // gold, bars to Tuesday 2026-11-03 21:00 UTC and the bar at 23:00: 22:00 is its daily
    // hour (17:00 New York, winter time)
    const tue21 = Date.UTC(2026, 10, 3, 21);
    const toTue = flat(125, tue21 - 124 * H);
    expect(spikeRangeFor("XAU/USD", toTue, tue21 + 2 * H)).toMatchObject({ status: "ok", behind: 0 });
    expect(spikeRangeFor("USD/JPY", toTue, tue21 + 2 * H)).toMatchObject({ status: "ok", behind: 1 });
  });

  it("mails the forming bar in the minute it gets there, against its R", () => {
    const history = flat(130);
    const open = T0 + 130 * H;
    const now = open + 23 * 60_000;
    const forming = { datetime: dt(open), open: 100, high: 100.4, low: 99.95, close: 100.3 };
    const ranges = rangesOf("USD/JPY", history, open);
    const sigs = spikeSignals("USD/JPY", "1h", [{ bar: forming, forming: true }], ranges, now);
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    expect(s).toMatchObject({ rule: "spike", pair: "USD/JPY", interval: "1h", side: "BUY", barTime: new Date(open).toISOString(), closedAt: new Date(now).toISOString(), close: 100.3, sl: null, tps: null });
    expect(s.spike).toMatchObject({ open: 100, extreme: 100.4, r: 0.125, forming: true, closesAt: new Date(open + H).toISOString(), behind: 0 });
    expect(s.spike!.x).toBeCloseTo(3.2, 10);
    // short of 3 R: nothing
    expect(spikeSignals("USD/JPY", "1h", [{ bar: { ...forming, high: 100.37 }, forming: true }], ranges, now)).toEqual([]);
    // a fall and a rise on one bar: both
    expect(spikeSignals("USD/JPY", "1h", [{ bar: { ...forming, low: 99.6 }, forming: true }], ranges, now).map((x) => x.side)).toEqual(["BUY", "SELL"]);
    // a bar that is not the one forming now is not read as forming
    expect(spikeSignals("USD/JPY", "1h", [{ bar: forming, forming: true }], ranges, open + H + 1)).toEqual([]);
    // no R for the bar (none kept, or not "ok"): nothing
    expect(spikeSignals("USD/JPY", "1h", [{ bar: forming, forming: true }], new Map(), now)).toEqual([]);
    expect(spikeSignals("USD/JPY", "1h", [{ bar: forming, forming: true }], new Map([[open, { r: 0, behind: 0 }]]), now)).toEqual([]);
  });

  it("mails the newest closed bar while it closed at most 10 minutes ago (a move in its last minute), not later", () => {
    const bars = flat(131);
    bars[130] = { ...bars[130], low: 99.5 };
    const close = T0 + 131 * H;
    const ranges = rangesOf("EUR/JPY", bars, T0 + 130 * H);
    const got = spikeSignals("EUR/JPY", "1h", [{ bar: bars[130], forming: false }], ranges, close + 4 * 60_000);
    expect(got.map((x) => [x.side, x.spike?.forming])).toEqual([["SELL", false]]);
    expect(SPIKE_LATE_MS).toBe(10 * 60_000);
    expect(spikeSignals("EUR/JPY", "1h", [{ bar: bars[130], forming: false }], ranges, close + 11 * 60_000)).toEqual([]);
  });

  it("is judged only on a chart the rule is offered on", () => {
    const h2 = flat(130);
    const open = T0 + 130 * H;
    const b2 = { datetime: dt(open), open: 100, high: 101, low: 100, close: 101 };
    const ranges = rangesOf("USD/JPY", h2, open);
    expect(spikeSignals("USD/JPY", "15min", [{ bar: b2, forming: true }], ranges, open + 60_000)).toEqual([]);
    expect(spikeSignals("GBP/JPY", "1h", [{ bar: b2, forming: true }], ranges, open + 60_000)).toEqual([]);
    expect(spikeSignals("XAU/USD", "1h", [{ bar: b2, forming: true }], ranges, open + 60_000)).toHaveLength(1);
  });

  it("makes gold's hour of its recorded minutes, and not when its first minute began more than 2 minutes after the hour", () => {
    const hour = Date.UTC(2026, 10, 4, 6);
    const m = (k: number, o: number, h: number, l: number, c: number) => ({ minute: new Date(hour + k * 60_000).toISOString(), open: o, high: h, low: l, close: c });
    const minutes = [m(-1, 1, 9, 0, 1), m(1, 4010.123, 4012, 4009, 4011), m(2, 4011, 4030.456, 4010, 4029), m(3, 4029, 4030, 4005.004, 4020)];
    expect(goldHourBar(minutes, hour)).toEqual({ datetime: "2026-11-04 06:00:00", open: 4010.12, high: 4030.46, low: 4005, close: 4020 });
    // the first minute 2 minutes after the hour still counts, 3 minutes after does not
    expect(goldHourBar(minutes.slice(2), hour)?.open).toBe(4011);
    expect(goldHourBar(minutes.slice(3), hour)).toBeNull();
    expect(goldHourBar([], hour)).toBeNull();
  });

  it("writes the email in Japanese and English: the move, the open, how far, the usual range, that it is not a signal, what was counted", () => {
    const history = flat(130);
    const open = T0 + 130 * H;
    const ranges = rangesOf("USD/JPY", history, open);
    const s = spikeSignals("USD/JPY", "1h", [{ bar: { datetime: dt(open), open: 100, high: 100.4, low: 99.95, close: 100.3 }, forming: true }], ranges, open + 23 * 60_000)[0];
    const ja = renderIndicatorMail(s, "ja");
    expect(ja.subject).toBe("【Sextant】ドル/円 1時間足 急騰（始値からふだんの値幅の3.2倍）");
    expect(ja.text).toContain("に始まった1時間足（20:00 に確定します）");
    expect(ja.text).toContain("始値 100.000、高値 100.400（始値から +40.0pips）");
    expect(ja.text).toContain("見た時の値段: 100.300（日本時間 19:23 に見ました）");
    expect(ja.text).toContain("ふだんの1時間の値幅: 12.5pips（この足の前の確定足120本の「高値 − 安値」の平均）。その3倍は 37.5pips");
    expect(ja.text).toContain("足の途中で見た値なので、確定までに値段が戻ることがあります。");
    expect(ja.text).toContain("売買の合図ではありません。");
    expect(ja.text).toContain("急騰36回・急落116回");
    expect(ja.text).toContain("測っていません");
    expect(ja.text).toContain("チャートの「急騰・急落（1時間足）」も同じ決まりで印を付けますが");
    expect(ja.text).not.toContain("同じ印が出ます");
    expect(ja.text).toContain("「急騰・急落」でチェックを外してください");
    const en = renderIndicatorMail(s, "en");
    expect(en.subject).toBe("[Sextant] USD/JPY 1-hour sharp rise (3.2× its usual range from the open)");
    expect(en.text).toContain("Open 100.000, high 100.400 (+40.0 pips from the open)");
    expect(en.text).toContain("This is not a signal to buy or sell.");
    expect(en.text).toContain("36 times for a rise and 116 for a fall");
    expect(en.text).not.toContain("The chart shows the same mark");
    // a closed bar: its close, seen after it
    const bars = flat(131);
    bars[130] = { ...bars[130], high: 100.5, close: 100.45 };
    const c = spikeSignals("USD/JPY", "1h", [{ bar: bars[130], forming: false }], ranges, open + H + 2 * 60_000)[0];
    const cja = renderIndicatorMail(c, "ja");
    expect(cja.text).toContain("（20:00 に確定した足）");
    expect(cja.text).toContain("終値: 100.450（確定のあと、日本時間 20:02 に見ました）");
    expect(renderIndicatorMail(c, "en").text).toContain("Close: 100.450 (seen after the close,");
    // gold: dollars, what is gold's own, and R from stored bars one behind
    const gOpen = open + H;
    const gRanges = rangesOf("XAU/USD", history, gOpen);
    expect(gRanges.get(gOpen)?.behind).toBe(1);
    const g = spikeSignals("XAU/USD", "1h", [{ bar: { datetime: dt(gOpen), open: 100, high: 100, low: 99.5, close: 99.6 }, forming: true }], gRanges, gOpen + 60_000)[0];
    const gja = renderIndicatorMail(g, "ja");
    expect(gja.subject).toContain("急落");
    expect(gja.text).toContain("安値 99.50（始値から −0.50ドル）");
    expect(gja.text).toContain("Swissquote");
    expect(gja.text).not.toContain("アプリの金のチャートと同じ");
    expect(gja.text).toContain("（金は値段の出所も違う）");
    expect(gja.text).toContain("保存した足が1本遅れていたため、その1本前までの120本");
    expect(gja.text).toContain("金は Twelve Data の1時間足〈2026/09/14〜2026/11/05、約7.4週〉で、急騰2回・急落6回");
    expect(renderIndicatorMail(g, "en").text).toContain("the stored bars were 1 behind, so the 120 up to 1 bar earlier");
  });

  it("the sweep's code (read as text here; run in a Deno harness for docs §8.138): the rule's subscriptions every minute, each hour's R kept in its table, a follower already mailed left out before any lookup, its failure apart; the database accepts the rule", () => {
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3,emarm,spike)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toContain("const sigs = spikeSignals(pair, \"1h\", candidates, usable, nowMs);");
    expect(fn).toContain("spike_ranges?pair=eq.${enc(pair)}&bar_time=in.(");
    expect(fn).toContain('rest("spike_ranges?on_conflict=pair,bar_time"');
    expect(fn).toContain("signal_alerts?kind=eq.signal&pair=eq.${enc(x.pair)}&interval=eq.${enc(x.interval)}&bar_time=eq.${enc(x.barTime)}&side=eq.${x.side}&rule=eq.${enc(SPIKE_RULE_ID)}&select=user_id");
    expect(fn).not.toContain("spikeMailed");
    expect(fn).toMatch(/try \{\s+reads\.push\(await spikeRead\(pair\)\);\s+\} catch \(err\) \{\s+console\.error\("spike failed:", pair, err\);/);
    expect(fn).toContain("spike: { pairs: SPIKE_PAIRS, intervals: SPIKE_INTERVALS },");
    expect(fn).toContain('const FUNCTION_VERSION = "signal-alerts-v36-2026-11-05T06:00:00Z";');
    expect(renderTestMail([{ pair: "USD/JPY", interval: "1h", rule: "spike" }], "ja").text).toContain("登録中のチャート: ドル/円 1時間足（急騰・急落）");
    const mig = readFileSync("supabase/migrations/20261105060000_signal_alert_spike.sql", "utf8");
    expect(mig).toContain("check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx', 'sweepx', 'amdpo3', 'emarm', 'stockmacd', 'spike']));");
    expect(mig).toContain("create table if not exists public.spike_ranges (");
    expect(mig).toContain("revoke all on public.spike_ranges from anon, authenticated;");
  });
});

describe("#395 the email in the settings", () => {
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
      spike: { pairs: SPIKE_PAIRS, intervals: SPIKE_INTERVALS },
    },
    ...over,
  });

  it("has its own tab on the six's 1-hour chart, its own notes, and saves a tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      normalizeAlertSettings(body.action === "set" ? payload({ subscriptions: [{ pair: "XAU/USD", interval: "1h", rule: "spike" }] }) : payload())!
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-spike"));
    expect(screen.getByTestId("signal-alerts-rule-spike").textContent).toBe("急騰・急落");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toContain("3倍以上上がったら急騰");
    expect(intro).toContain("足の途中でも、届いたその分に送ります");
    expect(screen.getByTestId("signal-alert-spike-USD/JPY-1h")).toBeTruthy();
    expect(screen.queryByTestId("signal-alert-spike-USD/JPY-15min")).toBeNull();
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("急騰36回・急落116回");
    expect(notes).toContain("金の毎日の最初の1時間（日本時間の朝8時台、夏は7時台）も判定しません");
    expect(notes).toContain("測っていません");
    fireEvent.click(screen.getByTestId("signal-alert-spike-XAU/USD-1h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "XAU/USD", interval: "1h", on: true, rule: "spike", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-spike-XAU/USD-1h") as HTMLInputElement).checked).toBe(true));
    // the MACD email's tick is another rule's
    fireEvent.click(screen.getByTestId("signal-alerts-rule-macdx"));
    expect(screen.queryByTestId("signal-alert-macdx-XAU/USD-1h")).toBeNull();
  });

  it("lists a sharp rise or fall it sent as 急騰 or 急落, not as a side to trade", async () => {
    const row = (side: string, pair: string) => ({
      id: `${pair}-${side}`, kind: "signal", pair, interval: "1h", bar_time: "2026-11-05T05:00:00Z", closed_at: "2026-11-05T05:50:00Z",
      side, entry: 1, stop: null, target: null, rsi: null, rsi_prev: null, sar: null, rule: SPIKE_RULE_ID, strong: null,
      status: "sent", skip_reason: null, error: null, created_at: "2026-11-05T05:50:01Z", sent_at: "2026-11-05T05:50:02Z", event: null,
    });
    const call = vi.fn(async () => normalizeAlertSettings(payload({ alerts: [row("BUY", "USD/JPY"), row("SELL", "XAU/USD")] }))!);
    render(<SignalAlertSettings call={call} />);
    await screen.findByText("USD/JPY 1時間 急騰");
    const up = screen.getByText("USD/JPY 1時間 急騰");
    expect(up.className).toContain("text-foreground");
    expect(up.className).not.toContain("text-success");
    expect(screen.getByText("XAU/USD 1時間 急落").className).not.toContain("text-destructive");
  });

  it("from a server that does not send the rule's charts: says it is not available yet", async () => {
    const call = vi.fn(async () => normalizeAlertSettings(payload({ indicator: { rules: INDICATOR_RULES, pairs: INDICATOR_PAIRS, intervals: INDICATOR_INTERVALS, limited: {} } }))!);
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-spike"));
    expect(screen.getByTestId("signal-alerts-spike-unavailable")).toBeTruthy();
  });
});
