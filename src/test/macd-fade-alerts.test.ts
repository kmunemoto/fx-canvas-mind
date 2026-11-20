// v40 (docs §8.155; research/macdfade1h-prod-spec.md): the MACD email as the fade at a closed 1-hour bar, in the
// function, for the five pairs and gold. v41 (research/macdfade15min-prod-spec.md sections 2, 3.2, 3.4, 3.6, 3.7, 4.1 to
// 4.5 and 7.1): the same fade, each pair on its own chart, the owner's per-pair decision (2026-11-19): USD/JPY and
// AUD/USD on 15-minute bars (GMO's 15-minute files, read 0, 1 and 3 minutes after each quarter-hour close, fresh 20
// minutes, id v12), EUR/JPY, AUD/JPY and EUR/USD on 1-hour bars as v40 (read 0, 3 and 5 minutes after the hour, fresh
// 30 minutes, v40's id v11), gold on its 1-hour chart as v40 (Twelve Data's stored bars, from a minute after the close
// to :29). Each pair's mail carries its own chart's measured paragraph (fadeMeasuredLine of the signal's interval).
//
// Three parts. The first holds what indicators.ts gives for it to the spec: the ids, the price in (ridePaidAt, kept
// from v9: its checks moved here from the v9 ride's tests, deleted with the ride), the signal and its row, each mail
// variant word for word (4.2, 4.3, the measured paragraph of 4.5 written out for USD/JPY on 15 minutes and EUR/JPY on 1
// hour) and 4.1's guards. The second runs the REAL supabase/functions/signal-alerts/index.ts — imported with `Deno`
// stubbed and every outside call faked (Supabase's REST with the tables the run uses, the auth lookups, GMO's 15-minute
// and 1-hour klines, Twelve Data's stored bars and its time_series, Resend; the clock and the sleeps too, so nothing
// waits and nothing reaches the network) — over fake tables, each import of the module one instance: spec 7.1's pairs'
// and gold's list, the status, set and set_many per pair, the test mail's list and the ticks' created_at. The third
// reads the function's code as text. The rule itself (fadeCloseEntryAt) is checked in src/test/macd-fade.test.ts and
// against the study by research/macdfade-prod-check.ts. The shares' fade (spec 3.3, 4.4) is not here
// (src/test/stockmacd-alerts.test.tsx).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import {
  MACDH_FADE_VERSION_OF,
  MACDH_INTERVAL_OF,
  MACDH_INTERVALS,
  MACDH_PAIRS,
  ULTRA_RULE_ID,
  fadeSignal,
  freshFor,
  gmoIntervalsDue,
  indicatorRuleId,
  isIndicatorChartFor,
  isMacdhChart,
  macdhRuleId,
  renderIndicatorMail,
  ridePaidAt,
  rideSignalTag,
  signalRow,
  signalRuleId,
  type IndicatorSignal,
} from "../../supabase/functions/signal-alerts/indicators";
import { FADE_SHARE, fadeCloseEntryAt, fadeRuleId, type FadeEntry } from "../../supabase/functions/_shared/macd-fade";
import { fadeMeasuredLine } from "../../supabase/functions/_shared/macd-fade-measured";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import { APP_URL, renderTestMail } from "../../supabase/functions/signal-alerts/logic";

const H = 3_600_000;
const MIN = 60_000;
// a bar's length: the 15-minute chart's (USD/JPY, AUD/USD) and the 1-hour chart's (EUR/JPY, AUD/JPY, EUR/USD, gold)
const STEP = 15 * MIN;
const STEP_OF: Record<string, number> = { "15min": STEP, "1h": H };
const iso = (ms: number) => new Date(ms).toISOString();
const dt = (ms: number) => iso(ms).slice(0, 19).replace("T", " ");
// "2026-08-21 06:00", in UTC or Japan time, as the mails write a close
const utc = (ms: number) => iso(ms).slice(0, 16).replace("T", " ");
const jst = (ms: number) => utc(ms + 9 * H);
// the two ids (research/macdfade15min-prod-spec.md 3.7)
const V12 = "macdx_12_26_9_w600_15min_fade96of120_in_v12";
const V11 = "macdx_12_26_9_w600_1h_fade96of120_in_v11";

// ---- the bars: 2,600 bars of a yen pair over the hours the market is open (shut Friday 21:00 to Sunday 22:00 UTC), on
// the 15-minute grid (`times`, USD/JPY's chart) and on the 1-hour grid (`htimes`, EUR/JPY's and gold's), the same closes
// on both (the waves of the #339 / #353 blocks of indicator-alerts.test.tsx, rounded as the chart draws a yen pair);
// gold the same waves at gold's size, rounded to cents. A bar opens at the close before it and has no wick. The entries
// the scenarios stand on are found below with the shared code (by index, so the same on both grids)
const shut = (t: number) => {
  const d = new Date(t);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day === 6 || (day === 5 && h >= 21) || (day === 0 && h < 22);
};
const N = 2600;
const gridOf = (step: number) => {
  const out: number[] = [];
  for (let t = Date.UTC(2026, 6, 1); out.length < N; t += step) if (!shut(t)) out.push(t);
  return out;
};
const times = gridOf(STEP);
const htimes = gridOf(H);
const TIMES_OF: Record<string, number[]> = { "15min": times, "1h": htimes };
const indexOf: Record<string, Map<number, number>> = {
  "15min": new Map(times.map((t, i) => [t, i])),
  "1h": new Map(htimes.map((t, i) => [t, i])),
};
const wave = (i: number) => 0.9 * Math.sin(i / 90) + 0.35 * Math.sin(i / 23) + 0.12 * Math.sin(i / 7) + 0.03 * Math.sin(i * 1.9) + 0.0004 * i;
const closes = Array.from({ length: N }, (_, i) => Number((150 + wave(i)).toFixed(3)));
const gcloses = Array.from({ length: N }, (_, i) => Number((4150 + 240 * wave(i)).toFixed(2)));
const openOf = (k: number) => (k > 0 ? closes[k - 1] : closes[k]);
const bid = (mid: number) => Number((mid - 0.005).toFixed(3));
const ask = (mid: number) => Number((mid + 0.005).toFixed(3));
const entryAt = (i: number): FadeEntry | null => fadeCloseEntryAt(closes.slice(i - 599, i + 1));
const gEntryAt = (i: number): FadeEntry | null => fadeCloseEntryAt(gcloses.slice(i - 599, i + 1));

// the bars the scenarios stand on (each checked below): a SELL (the top) and a BUY (the bottom) of the pairs, and a
// SELL and a BUY of gold, each closing on a weekday with the next bar a bar's length on, on both grids (on 15 minutes:
// I_SELL closes 2026-07-14 07:45 UTC, I_BUY 2026-07-15 00:15; on 1 hour: G_SELL and G_BUY gold's, and I_SELL and I_BUY
// EUR/JPY's)
const I_SELL = 886;
const I_BUY = 952;
const G_SELL = 1012;
const G_BUY = 1222;

describe("v41 the bars the scenarios stand on (found with the shared code)", () => {
  it("hold a SELL at the pane's top and a BUY at its bottom, on the pairs and on gold, away from the weekend, on the 15-minute and the 1-hour grid", () => {
    expect(entryAt(I_SELL)).toMatchObject({ zside: "top", side: "SELL" });
    expect(entryAt(I_BUY)).toMatchObject({ zside: "bottom", side: "BUY" });
    expect(gEntryAt(G_SELL)).toMatchObject({ zside: "top", side: "SELL" });
    expect(gEntryAt(G_BUY)).toMatchObject({ zside: "bottom", side: "BUY" });
    for (const i of [I_SELL, I_BUY, G_SELL, G_BUY]) {
      expect(times[i + 1] - times[i], `bar ${i}`).toBe(STEP);
      // the 15-minute chart is read at +0, +1 and +3 minutes (and not at +2, +4 or later before the next close)
      for (const m of [0, 1, 3]) expect(gmoIntervalsDue(times[i] + STEP + m * MIN + 1_000), `bar ${i} +${m}`).toContain("15min");
      for (const m of [2, 4, 5, 10, 14]) expect(gmoIntervalsDue(times[i] + STEP + m * MIN + 1_000), `bar ${i} +${m}`).not.toContain("15min");
      expect(htimes[i + 1] - htimes[i], `bar ${i}`).toBe(H);
      // the 1-hour chart at +0, +3 and +5 minutes (and not at +1, +2 or +4)
      for (const m of [0, 3, 5]) expect(gmoIntervalsDue(htimes[i] + H + m * MIN + 1_000), `bar ${i} +${m}`).toContain("1h");
      for (const m of [1, 2, 4]) expect(gmoIntervalsDue(htimes[i] + H + m * MIN + 1_000), `bar ${i} +${m}`).not.toContain("1h");
    }
    expect([iso(times[I_SELL] + STEP), iso(times[I_BUY] + STEP)]).toEqual(["2026-07-14T07:45:00.000Z", "2026-07-15T00:15:00.000Z"]);
    // the bar before each is not an entry on the same side (no entry while the line stays at 96%)
    expect(entryAt(I_SELL - 1)?.side).not.toBe("SELL");
    expect(entryAt(I_BUY - 1)?.side).not.toBe("BUY");
  });
});

// ---- part 1: the ids, the price, the signal, its row, the mails --------------------------------------------------

// the app's regexes: RIDE_ID as src/lib/signalAlerts.ts has it (v9's rows), FADE_ID as research/macdfade1h-prod-spec.md
// section 5 writes it (research/macdfade15min-prod-spec.md section 5: unchanged; src/test/macd-fade.test.ts holds both
// against their files)
const RIDE_ID = /^(?:macdx|stockmacd)_.*_(?:touch|ride)(\d+)to(\d+)of120_(in|at|out)_/;
const FADE_ID = /^(?:macdx|stockmacd)_.*_fade(\d+)(?:tp[0-9a-z]+)?of120_in_/;

describe("v41 the ids and the charts, per pair (spec 3.2 items 1 to 4, 3.6 and 3.7)", () => {
  it("two ids, built from the constants through macdhRuleId: v12 on the 15-minute chart, v40's v11 on the 1-hour chart; no single id or version left", () => {
    expect(MACDH_FADE_VERSION_OF).toEqual({ "15min": 12, "1h": 11 });
    expect(macdhRuleId("15min")).toBe(V12);
    expect(macdhRuleId("1h")).toBe(V11);
    expect(V12).toBe(fadeRuleId("macdx", "15min", 12));
    expect(V11).toBe(fadeRuleId("macdx", "1h", 11));
    for (const iv of ["5min", "4h", "1day", "15m"]) expect(() => macdhRuleId(iv), iv).toThrow(/no version/);
    expect(() => indicatorRuleId("macdx")).toThrow(/one id per chart/);
    // the app reads both as a fade at 96% (FADE_ID), not as v9's ride (RIDE_ID)
    for (const id of [V12, V11]) {
      expect(FADE_ID.exec(id)?.[1]).toBe("96");
      expect(RIDE_ID.test(id)).toBe(false);
    }
    // v12 is none of the ids found in the repository (spec 3.7), written or never written; v11 on '1h' is v40's own
    for (const old of [
      "macdx_12_26_9_w600_n288_k4_2_v1",
      "macdx_12_26_9_w600_1h_lv8.5p_v2",
      "macdx_12_26_9_w600_1h_k0.8mv_v3",
      "macdx_12_26_9_w600_1h_z90of120_v4",
      "macdx_12_26_9_w600_1h_x80of120_v5",
      "macdx_12_26_9_w600_1h_z95of120_v6",
      "macdx_12_26_9_w600_15min_z95of120_v7",
      "macdx_12_26_9_w600_1h_z95of120_v8",
      "macdx_12_26_9_w600_1h_ride90to96of120_in_v9",
      "macdx_12_26_9_w600_1h_ride90to96of120_at_v9",
      "macdx_12_26_9_w600_1h_ride90to96of120_out_v9",
      "macdx_12_26_9_w600_1h_touch90to95of120_in_v10",
      "macdx_12_26_9_w600_1h_fade96tp10of120_in_v11",
      "macdx_12_26_9_w600_15min_fade96of120_in_v11",
      V11,
    ]) {
      expect(V12).not.toBe(old);
    }
  });

  it("the per-pair map (spec 3.2 item 1): USD/JPY and AUD/USD on '15min', EUR/JPY, AUD/JPY, EUR/USD and gold on '1h'; each pair offered and judged on its own chart only; MACDH_INTERVALS the column list", () => {
    expect(MACDH_INTERVAL_OF).toEqual({ "USD/JPY": "15min", "AUD/USD": "15min", "EUR/JPY": "1h", "AUD/JPY": "1h", "EUR/USD": "1h", "XAU/USD": "1h" });
    expect([...MACDH_INTERVALS]).toEqual(["15min", "1h"]);
    expect([...MACDH_PAIRS]).toEqual(["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD", "XAU/USD"]);
    for (const p of MACDH_PAIRS) {
      const own = MACDH_INTERVAL_OF[p];
      expect(isMacdhChart(p, own), p).toBe(true);
      expect(isIndicatorChartFor("macdx", p, own), p).toBe(true);
      for (const iv of ["1min", "5min", "15min", "1h", "4h", "1day"].filter((x) => x !== own)) {
        expect(isMacdhChart(p, iv), `${p} ${iv}`).toBe(false);
        expect(isIndicatorChartFor("macdx", p, iv), `${p} ${iv}`).toBe(false);
      }
    }
  });

  it("the rule is named 「MACD の逆張り」 / \"MACD fade\" in the test email too (the subscription's rule stays 'macdx'; the shares keep 「株の MACD」); each row with its own timeframe (spec 3.6: the function lists only the rows it mails, below)", () => {
    const ja = renderTestMail([{ pair: "USD/JPY", interval: "15min", rule: "macdx" }, { pair: "EUR/JPY", interval: "1h", rule: "macdx" }, { pair: "AAPL", interval: "15min", rule: "stockmacd" }], "ja").text;
    expect(ja).toContain("登録中のチャート: ドル/円 15分足（MACD の逆張り）、ユーロ/円 1時間足（MACD の逆張り）、AAPL 15分足（株の MACD）");
    expect(ja).toContain("（RSI＋パラボリックSAR、GA型、Q-Trend、ULTRA、MACD の逆張り、流動性狩り＋EMAクロス、AMD Po3、EMAクロス＋リターンムーブ）");
    expect(ja).not.toContain("MACD の流れ");
    const en = renderTestMail([{ pair: "USD/JPY", interval: "15min", rule: "macdx" }, { pair: "EUR/JPY", interval: "1h", rule: "macdx" }], "en").text;
    expect(en).toContain("Charts you follow: USD/JPY 15-minute (MACD fade), EUR/JPY 1-hour (MACD fade)");
    expect(en).toContain("(RSI + Parabolic SAR, the GA-style rule, Q-Trend, ULTRA, MACD fade, Liquidity sweep + EMA cross, AMD Po3 or EMA cross + return move)");
    expect(en).not.toContain("MACD ride");
  });
});

describe("v41 the price in, the signal and its row (spec 2.3 and 3.4)", () => {
  const q = (bidClose: number, askClose: number): QuoteCandle => ({
    datetime: iso(times[I_SELL]),
    bid: { datetime: iso(times[I_SELL]), open: 150, high: 150.4, low: 149.8, close: bidClose },
    ask: { datetime: iso(times[I_SELL]), open: 150.01, high: 150.41, low: 149.81, close: askClose },
  });

  // (moved from the v9 ride's tests, deleted with the ride: ridePaidAt stays)
  it("a BUY pays the ask close and a SELL the bid close, GMO's own, as given (not rounded)", () => {
    const quote = q(150.118, 150.128);
    expect(ridePaidAt("BUY", quote)).toBe(150.128);
    expect(ridePaidAt("SELL", quote)).toBe(150.118);
    // more digits than the chart draws stay as they are
    const raw = q(150.1184, 150.1287);
    expect(ridePaidAt("BUY", raw)).toBe(150.1287);
    expect(ridePaidAt("SELL", raw)).toBe(150.1184);
  });

  it("the signal on each pair's own chart: the bar's open and close (the open plus the chart's bar), its close as drawn, the price in, the line and the pane's edges, no stop, no target, the interval; its row under the chart's id (v12 on '15min', v11 on '1h')", () => {
    const e = entryAt(I_SELL)!;
    const price = bid(closes[I_SELL]);
    for (const [pair, iv, id] of [["USD/JPY", "15min", V12], ["EUR/JPY", "1h", V11]] as const) {
      const t = TIMES_OF[iv][I_SELL];
      const sig = fadeSignal("macdx", pair, iv, e, { openMs: t, closeMs: t + STEP_OF[iv], close: closes[I_SELL], price });
      expect(sig).toEqual({
        rule: "macdx",
        pair,
        interval: iv,
        side: "SELL",
        strong: false,
        barTime: iso(t),
        closedAt: iso(t + STEP_OF[iv]),
        close: closes[I_SELL],
        line: null,
        eps: null,
        rsi: null,
        rsiPrev: null,
        sl: null,
        tps: null,
        fade: { zside: "top", m: e.z.m, top: e.z.top, bottom: e.z.bottom, share0: e.share0, price },
      });
      // its row: the bar's open and close, the price in as the entry (not the mid), no stop, no target, the chart's id
      expect(signalRow(sig)).toEqual({ bar_time: iso(t), closed_at: iso(t + STEP_OF[iv]), side: "SELL", entry: price, stop: null, target: null, rule: id });
      expect(signalRow(sig).entry).not.toBe(closes[I_SELL]);
      expect(signalRuleId(sig)).toBe(id);
      // the run's record writes it "macdx:SELL"
      expect(rideSignalTag(sig)).toBe("macdx:SELL");
    }
    expect(e.share0).toBe(e.z.m / e.z.top);
    expect(e.z.m >= FADE_SHARE * e.z.top).toBe(true);
    // a chart with no version has no id (signalRuleId throws)
    expect(() => signalRuleId({ rule: "macdx", interval: "4h" })).toThrow(/no version/);
    const b = entryAt(I_BUY)!;
    const buy = fadeSignal("macdx", "USD/JPY", "15min", b, { openMs: times[I_BUY], closeMs: times[I_BUY] + STEP, close: closes[I_BUY], price: ask(closes[I_BUY]) });
    expect(buy).toMatchObject({ side: "BUY", fade: { zside: "bottom", price: ask(closes[I_BUY]) } });
    expect(signalRow(buy)).toMatchObject({ side: "BUY", entry: ask(closes[I_BUY]), stop: null, target: null, rule: V12 });
    expect(rideSignalTag(buy)).toBe("macdx:BUY");
  });

  it("a rule that is no fade keeps its row as it was (the stop, the first target, its own id)", () => {
    const e = entryAt(I_SELL)!;
    const sig = fadeSignal("macdx", "USD/JPY", "15min", e, { openMs: times[I_SELL], closeMs: times[I_SELL] + STEP, close: closes[I_SELL], price: 1 });
    const ultra: IndicatorSignal = { ...sig, rule: "ultra", fade: undefined, sl: 150.5, tps: [149.9, 149.8, 149.7] };
    expect(signalRow(ultra)).toEqual({ bar_time: sig.barTime, closed_at: sig.closedAt, side: "SELL", entry: closes[I_SELL], stop: 150.5, target: 149.9, rule: ULTRA_RULE_ID });
    expect(rideSignalTag(ultra)).toBe("ultra:SELL");
  });
});

// The signals the mails are written for, each on its pair's own chart: a pair's at the bid (SELL) or ask (BUY) close,
// gold's at its close (1 hour)
const pairSig = (i: number, pair = "USD/JPY") => {
  const e = entryAt(i)!;
  const iv = MACDH_INTERVAL_OF[pair];
  const t = TIMES_OF[iv][i];
  return fadeSignal("macdx", pair, iv, e, { openMs: t, closeMs: t + STEP_OF[iv], close: closes[i], price: e.side === "BUY" ? ask(closes[i]) : bid(closes[i]) });
};
const goldSig = (i: number) => {
  const e = gEntryAt(i)!;
  return fadeSignal("macdx", "XAU/USD", "1h", e, { openMs: htimes[i], closeMs: htimes[i] + H, close: gcloses[i], price: gcloses[i] });
};
// a number as the mails write the MACD line and the edges (the minus the chart's, U+2212)
const num = (v: number, d: number) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

// Each variant written out here from the spec's words (research/macdfade15min-prod-spec.md 4.2, 4.3; the 1-hour pairs'
// and gold's v40's, research/macdfade1h-prod-spec.md 4.3), the numbers filled in
const TF_JA: Record<string, string> = { "15min": "15分足", "1h": "1時間足" };
const TF_EN: Record<string, string> = { "15min": "15-minute", "1h": "1-hour" };
const subjectJa = (pairJa: string, side: "SELL" | "BUY", iv = "15min") =>
  side === "SELL"
    ? `【Sextant】${pairJa} ${TF_JA[iv]} 売り（SELL）: 青い線が上の端の96%で確定（MACD の逆張り）`
    : `【Sextant】${pairJa} ${TF_JA[iv]} 買い（BUY）: 青い線が下の端の96%で確定（MACD の逆張り）`;
const subjectEn = (pair: string, side: "SELL" | "BUY", iv = "15min") =>
  side === "SELL"
    ? `[Sextant] ${pair} ${TF_EN[iv]} SELL: the MACD line closed at 96% of the top (MACD fade)`
    : `[Sextant] ${pair} ${TF_EN[iv]} BUY: the MACD line closed at 96% of the bottom (MACD fade)`;
const ITEM6_JA = "利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。";
const ITEM7_JA = "メールはこの1通だけです。このあと、この合図について知らせは送りません。同じチャート・同じ向きに前の合図があっても、次の合図は送ります。";
// item 8: the 15-minute pairs' (4.3, rewritten), the 1-hour pairs' and gold's (v40's)
const ITEM8_PAIR15_JA = "このメールは、足の確定の直後・1分後・3分後の読み込みで判定して送ります（実際に何分で届くかは測っていません）。";
const ITEM8_PAIR1H_JA = "このメールは、足の確定の直後・3分後・5分後の読み込みで判定して送ります（実際に何分で届くかは測っていません）。";
const ITEM8_GOLD_JA = "このメールは、足の確定の1分後から30分後までの間に判定して送ります（実際に何分で届くかは測っていません）。";
const ITEM8_BOTH_JA = "届いた時の値段は、上の終値と違うことがあります（その差は測っていません）。週末の止まっている時間（日本時間 土曜6:00〜月曜7:00）に確定した足は判定しません。";
const GOLD9_JA = "金では測っていません（足は Twelve Data のもので、売値・買値の別はありません）。5ペアで測った数字は、アプリの設定の注にあります。";
// item 10: the 15-minute pairs' (4.3, rewritten: the pane the owner's choice), the 1-hour pairs' and gold's (v40's)
const ITEM10_15_JA = "この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・メールを15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。";
const ITEM10_1H_JA = "この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・メールを1時間足で判定すること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠（新しい120本）は、アプリの1時間足のチャートの枠と同じです。";
const sourcePairJa = (iv: string) => `足は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じです。上の値段は、同じ${TF_JA[iv]}の売値・買値の終値です。`;
const SOURCE_GOLD_JA = "足は Twelve Data のもの（金は GMOコインにないため）で、アプリのチャートと同じです。";
const STOP_JA = "この通知を止めるには、アプリの「設定」→「メール通知」の「MACD の逆張り」（画面が新しくなる前は「MACD の流れ」）でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。";
const ITEM6_EN = "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a stop.";
const ITEM7_EN = "This is the only email: nothing more is sent about this signal. A later signal on the same chart and side is sent too, whatever came before it.";
const ITEM8_PAIR15_EN = "This email is judged and sent at the reads right after the bar closes and 1 and 3 minutes after (how long it takes to arrive has not been measured).";
const ITEM8_PAIR1H_EN = "This email is judged and sent at the reads right after the bar closes and 3 and 5 minutes after (how long it takes to arrive has not been measured).";
const ITEM8_GOLD_EN = "This email is judged and sent between 1 and 30 minutes after the bar closes (how long it takes to arrive has not been measured).";
const ITEM8_BOTH_EN = "The price when it arrives may differ from the close above (the difference has not been measured). Bars that close in the weekend pause (Friday 21:00 to Sunday 22:00 UTC) are not judged.";
const GOLD9_EN = "Not measured on gold (its bars are Twelve Data's, with no separate bid and ask). The numbers measured on the five pairs are in the app's settings notes.";
const ITEM10_15_EN = "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging the email on 15-minute bars, the MACD pane of the newest 120 15-minute bars, the fade side and stating no take-profit or stop price are the app owner's choices. That pane is the same as the app's 15-minute chart's.";
const ITEM10_1H_EN = "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging the email on 1-hour bars, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane (the newest 120 bars) is the same as the app's 1-hour chart's.";
const sourcePairEn = (iv: string) => `The bars are the mid of GMO Coin's public bid and ask, as the app's chart draws them; the price above is the same ${TF_EN[iv]} bar's bid or ask close.`;
const SOURCE_GOLD_EN = "The bars are Twelve Data's (GMO Coin does not carry XAU/USD), as the app's chart draws them.";
const STOP_EN = "To stop these emails, open Settings → Email alerts in the app and untick the chart under MACD fade (MACD ride until the screen is updated).\nThis is reference information, not investment advice. Every trading decision is your own.";

// The measured paragraphs as the owner reads them, written out: a USD/JPY mail's (the 15-minute run 44535888012) and an
// EUR/JPY mail's (the 1-hour run 44555599946). Each equals section 4.5's text of its chart filled with its run's values
// (src/test/macd-fade.test.ts holds the module's paragraphs to the spec file's text and the ledger copies, word for
// word); written out here from the module's output so that a change of either shows here as a changed mail
const MEASURED_USDJPY_JA =
  "測った数字（5ペア、2024年1月1日 0:00（UTC）以後、2026年11月10日 21:00（UTC）より前に確定した15分足、スプレッド込み、docs §8.156）。" +
  "この5ペアのうち、メールを15分足で判定するのはドル/円・豪ドル/ドルです。" +
  "ユーロ/円・豪ドル/円・ユーロ/ドルのメールは1時間足で判定し、そのメールには1時間足で測った数字を載せています（この段落の数字は、どのペアの分も、すべて15分足で測ったものです）。" +
  "過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。" +
  "このメールの決まりで足の終値で入り、+10 pips で利確・損切りなしで持ったとして測りました（オーナーの持ち方です。" +
  "メールには利確の値段を書いていません）: 合図は6,006回、うち5,926回が+10 pips に届きました。" +
  "80回は2026年11月10日 21:00（UTC）の時点でまだ届いておらず、その含み損益は合わせて-44,784.5 pips（マイナスが損）、いちばん悪いもので-1,913.4 pips、いちばん長いもので約666日持ったままでした（その後は追っていません）。" +
  "1回あたり平均+2.41 pips（届いていないものは、その時の含み損益で数えました）。" +
  "途中の含み損は中央値11.9 pips、最大2,975.8 pips。" +
  "+10 pips に届くまでの時間は中央値約2時間、10回に1回は約4日より長く、いちばん長いもので約545日でした。" +
  "足の終値で入るので指値ではなく、入らなかった注文はありません（週末の止まっている時間に確定した足のもの〈下〉を除き、この決まりの合図は、そのペアのメールをこの時間足で判定するかどうかに関わらず、すべて入ったとして数えました）。" +
  "損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。" +
  "同じ合図で逆向き（上で買い・下で売り）に入ると1回あたり+3.19 pips、合図なしで5ペアの15分足ごとの最初の1分に（週末の止まっている時間に確定した足を除く。" +
  "買いと売りを1回ずつ）入ると+3.32 pips でした（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく15分足の最初の1分に入ったもので、同じ入りではありません）。" +
  "合図なしとの差（この決まり − 合図なし）は1回あたり-0.91 pips で、合図なしで入った時より低くありました。" +
  "値動きに傾きのない作り物の値段10本で同じように測った差は-0.80〜+2.24 pips で、この差はその幅より下（合図なしより悪い側）でした。" +
  "逆向きとの差は-0.78 pips で、10本の幅（-2.25〜+5.70 pips）の中でした（偶然で出る幅の中なので、逆向きより良いとも悪いとも言えません）。" +
  "10本の幅の外には偶然だけでも11回に約2回は出るので、幅の外に出たことも確かめ〈検定〉ではありません（作り物の値段は GMO のものではありません）。" +
  "ドル/円だけでは平均+2.67 pips（合図なしでは+5.69 pips）です。" +
  "ペアごとの合図なしとの差は、偶然で出る差より大きいとは示せていません（値動きに傾きのない作り物の値段10本の幅の外には、偶然だけでも11回に約2回は出ます）。" +
  "平均がマイナスだったペア: 豪ドル/円（-0.82 pips）。" +
  "ほかに3回、週末の止まっている時間に確定した足に合図がありましたが、その足はどのペアのメールでも判定しないので、上の数字に入れていません。";
const MEASURED_USDJPY_EN = [
  "Measured (five pairs, 15-minute bars that closed from 1 January 2024, 00:00 UTC up to, not including, 10 November 2026, 21:00 UTC, spread paid, docs §8.156).",
  "Of these five pairs, the email is judged on 15-minute bars for USD/JPY and AUD/USD.",
  "The emails of EUR/JPY, AUD/JPY and EUR/USD are judged on 1-hour bars and carry the numbers measured on 1-hour bars (every number in this paragraph, for every pair, was measured on 15-minute bars).",
  "The measurement re-reads GMO's past bars; times this email's reads failed and the like are not in it (how often: not measured).",
  "Entered by this email's rule at the bar's close and held with a take profit of +10 pips and no stop (the owner's way of holding; this email states no take-profit price): 6,006 signals, of which 5,926 reached +10 pips.",
  "80 had not reached it by 10 November 2026, 21:00 UTC; their unrealised result was -44,784.5 pips in all (a minus is a loss), the worst -1,913.4 pips, the longest held about 666 days (not followed after that).",
  "The mean was +2.41 pips a trade (those not reached counted at their unrealised result then).",
  "The largest loss on the way: median 11.9 pips, largest 2,975.8 pips.",
  "Time to +10 pips: median about 2 hours, longer than about 4 days one time in ten, longest about 545 days.",
  "The entry is at the bar's close, not a limit order, so no order went unfilled (every signal of this rule, but those on bars that closed in the weekend pause (below), is counted as entered, whether or not that pair's email is judged on this timeframe).",
  "With no stop, the share reaching +10 pips comes out high by construction.",
  "Entering the other way on the same signals (a BUY at the top, a SELL at the bottom) gave +3.19 pips a trade, and entering with no signal at the first minute of every 15-minute bar of the five pairs (bars that closed in the weekend pause left out; a BUY and a SELL) gave +3.32 pips (held the same way, +10 pips and no stop, but entered at the 15-minute bar's first minute, not at its close, so not the same entry).",
  "The difference from no signal (this rule less no signal) was -0.91 pips a trade: lower than entering with no signal.",
  "The same difference measured on ten made-up price walks with no trend ranged from -0.80 to +2.24 pips, and this one was below that range (on the side of doing worse than no signal).",
  "The difference from the other way was -0.78 pips, within the walks' range (-2.25 to +5.70 pips; a range chance alone gives, so it is not shown to do better or worse than the other way).",
  "Chance alone puts a gap outside ten walks' range about 2 times in 11, so being outside it is not a test either (the walks' prices are not GMO's).",
  "On USD/JPY alone the mean was +2.67 pips (with no signal, +5.69 pips).",
  "Each pair's difference from no signal has not been shown to be larger than chance gives (chance alone puts a gap outside the range of ten made-up price walks with no trend about 2 times in 11).",
  "Pairs whose mean was below zero: AUD/JPY (-0.82 pips).",
  "Besides these, 3 signals fell on bars that closed in the weekend pause; no pair's email judges those bars, so they are not in the numbers above.",
].join(" ");
const MEASURED_EURJPY_JA =
  "測った数字（5ペア、2024年1月1日 0:00（UTC）以後、2026年11月10日 21:00（UTC）より前に確定した1時間足、スプレッド込み、docs §8.156）。" +
  "この5ペアのうち、メールを1時間足で判定するのはユーロ/円・豪ドル/円・ユーロ/ドルです。" +
  "ドル/円・豪ドル/ドルのメールは15分足で判定し、そのメールには15分足で測った数字を載せています（この段落の数字は、どのペアの分も、すべて1時間足で測ったものです）。" +
  "過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。" +
  "このメールの決まりで足の終値で入り、+10 pips で利確・損切りなしで持ったとして測りました（オーナーの持ち方です。" +
  "メールには利確の値段を書いていません）: 合図は1,490回、うち1,468回が+10 pips に届きました。" +
  "22回は2026年11月10日 21:00（UTC）の時点でまだ届いておらず、その含み損益は合わせて-9,820.9 pips（マイナスが損）、いちばん悪いもので-1,733.2 pips、いちばん長いもので約617日持ったままでした（その後は追っていません）。" +
  "1回あたり平均+3.26 pips（届いていないものは、その時の含み損益で数えました）。" +
  "途中の含み損は中央値10.7 pips、最大2,243.6 pips。" +
  "+10 pips に届くまでの時間は中央値約2時間、10回に1回は約3日より長く、いちばん長いもので約477日でした。" +
  "足の終値で入るので指値ではなく、入らなかった注文はありません（週末の止まっている時間に確定した足のもの〈下〉を除き、この決まりの合図は、そのペアのメールをこの時間足で判定するかどうかに関わらず、すべて入ったとして数えました）。" +
  "損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。" +
  "同じ合図で逆向き（上で買い・下で売り）に入ると1回あたり-2.08 pips、合図なしで5ペアの1時間足ごとの最初の1分に（週末の止まっている時間に確定した足を除く。" +
  "買いと売りを1回ずつ）入ると+3.21 pips でした（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく1時間足の最初の1分に入ったもので、同じ入りではありません）。" +
  "合図なしとの差も、逆向きとの差も、値動きに傾きのない作り物の値段10本で同じように測った差の幅の中でした（偶然で出る幅の中なので、どちらより良いとも言えません。" +
  "作り物の値段は GMO のものではなく、10本で分かるのは幅だけで、確かめ〈検定〉ではありません）。" +
  "ユーロ/円だけでは平均+4.30 pips（合図なしでは+3.28 pips）です。" +
  "ペアごとの合図なしとの差は、偶然で出る差より大きいとは示せていません（値動きに傾きのない作り物の値段10本の幅の外には、偶然だけでも11回に約2回は出ます）。" +
  "平均がマイナスだったペア: ドル/円（-0.26 pips）。" +
  "ほかに11回、週末の止まっている時間に確定した足に合図がありましたが、その足はどのペアのメールでも判定しないので、上の数字に入れていません。";
const MEASURED_EURJPY_EN = [
  "Measured (five pairs, 1-hour bars that closed from 1 January 2024, 00:00 UTC up to, not including, 10 November 2026, 21:00 UTC, spread paid, docs §8.156).",
  "Of these five pairs, the email is judged on 1-hour bars for EUR/JPY, AUD/JPY and EUR/USD.",
  "The emails of USD/JPY and AUD/USD are judged on 15-minute bars and carry the numbers measured on 15-minute bars (every number in this paragraph, for every pair, was measured on 1-hour bars).",
  "The measurement re-reads GMO's past bars; times this email's reads failed and the like are not in it (how often: not measured).",
  "Entered by this email's rule at the bar's close and held with a take profit of +10 pips and no stop (the owner's way of holding; this email states no take-profit price): 1,490 signals, of which 1,468 reached +10 pips.",
  "22 had not reached it by 10 November 2026, 21:00 UTC; their unrealised result was -9,820.9 pips in all (a minus is a loss), the worst -1,733.2 pips, the longest held about 617 days (not followed after that).",
  "The mean was +3.26 pips a trade (those not reached counted at their unrealised result then).",
  "The largest loss on the way: median 10.7 pips, largest 2,243.6 pips.",
  "Time to +10 pips: median about 2 hours, longer than about 3 days one time in ten, longest about 477 days.",
  "The entry is at the bar's close, not a limit order, so no order went unfilled (every signal of this rule, but those on bars that closed in the weekend pause (below), is counted as entered, whether or not that pair's email is judged on this timeframe).",
  "With no stop, the share reaching +10 pips comes out high by construction.",
  "Entering the other way on the same signals (a BUY at the top, a SELL at the bottom) gave -2.08 pips a trade, and entering with no signal at the first minute of every 1-hour bar of the five pairs (bars that closed in the weekend pause left out; a BUY and a SELL) gave +3.21 pips (held the same way, +10 pips and no stop, but entered at the 1-hour bar's first minute, not at its close, so not the same entry).",
  "The differences from no signal and from the other way were both within the range of the same differences measured on ten made-up price walks with no trend (a range chance alone gives, so it is not shown to do better than either; the walks' prices are not GMO's, and ten walks give a range, not a test).",
  "On EUR/JPY alone the mean was +4.30 pips (with no signal, +3.28 pips).",
  "Each pair's difference from no signal has not been shown to be larger than chance gives (chance alone puts a gap outside the range of ten made-up price walks with no trend about 2 times in 11).",
  "Pairs whose mean was below zero: USD/JPY (-0.26 pips).",
  "Besides these, 11 signals fell on bars that closed in the weekend pause; no pair's email judges those bars, so they are not in the numbers above.",
].join(" ");

// a mail as the spec words it, on the signal's own chart (its interval)
const textJa = (s: IndicatorSignal, pairJa: string, d: number, md: number) => {
  const f = s.fade!;
  const sell = s.side === "SELL";
  const close = Date.parse(s.closedAt);
  const gold = s.pair === "XAU/USD";
  const iv = s.interval;
  const tf = TF_JA[iv];
  return [
    `${pairJa}の${tf}で、MACD の逆張りの${sell ? "売り（SELL）" : "買い（BUY）"}の合図が出ました。`,
    [
      `判定した足: ${jst(close)}（日本時間）に確定した${tf}`,
      sell
        ? `この足の終わりで、青い線（MACD）が、新しい120本（${tf}）の MACD の枠の上の端（青い線・オレンジの線・棒の一番高い所）の96%以上（0の線から測って）でした。一つ前の足の終わりでは、96%に届いていませんでした。上の端なので、逆張りの売り（SELL）の合図です。`
        : `この足の終わりで、青い線（MACD）が、新しい120本（${tf}）の MACD の枠の下の端（青い線・オレンジの線・棒の一番低い所）の96%以上（0の線から測って）でした。一つ前の足の終わりでは、96%に届いていませんでした。下の端なので、逆張りの買い（BUY）の合図です。`,
      sell
        ? `MACD = ${num(f.m, md)}、枠の上の端 = ${num(f.top, md)}（その96% = ${num(0.96 * f.top, md)}）`
        : `MACD = ${num(f.m, md)}、枠の下の端 = ${num(f.bottom, md)}（その96% = ${num(0.96 * f.bottom, md)}）`,
      gold
        ? `この足の終値: ${f.price.toFixed(d)}（売値・買値の別はありません）`
        : sell
        ? `売値（この足の終値の売値）: ${f.price.toFixed(d)}`
        : `買値（この足の終値の買値）: ${f.price.toFixed(d)}`,
    ].join("\n"),
    ITEM6_JA,
    ITEM7_JA,
    (iv === "15min" ? ITEM8_PAIR15_JA : gold ? ITEM8_GOLD_JA : ITEM8_PAIR1H_JA) + ITEM8_BOTH_JA,
    gold ? GOLD9_JA : fadeMeasuredLine("ja", s.pair, iv),
    iv === "15min" ? ITEM10_15_JA : ITEM10_1H_JA,
    `${gold ? SOURCE_GOLD_JA : sourcePairJa(iv)}注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
    STOP_JA,
  ].join("\n\n");
};
const textEn = (s: IndicatorSignal, d: number, md: number) => {
  const f = s.fade!;
  const sell = s.side === "SELL";
  const close = Date.parse(s.closedAt);
  const gold = s.pair === "XAU/USD";
  const iv = s.interval;
  const tf = TF_EN[iv];
  return [
    `A MACD fade ${sell ? "SELL" : "BUY"} signal on ${s.pair}'s ${tf} chart.`,
    [
      `Bar judged: the ${tf} bar that closed at ${utc(close)} UTC (${jst(close)} JST)`,
      sell
        ? `At this bar's close the MACD line (blue) was at 96% or more of the top of the MACD pane of the newest 120 bars (${tf}) (the highest of the blue line, the orange line and the bars), measured from the zero line. At the close of the bar before, it was below 96%. It is the top, so this is a fade SELL signal.`
        : `At this bar's close the MACD line (blue) was at 96% or more of the bottom of the MACD pane of the newest 120 bars (${tf}) (the lowest of the blue line, the orange line and the bars), measured from the zero line. At the close of the bar before, it was below 96%. It is the bottom, so this is a fade BUY signal.`,
      sell
        ? `MACD = ${num(f.m, md)}, the pane's top = ${num(f.top, md)} (96% of it = ${num(0.96 * f.top, md)})`
        : `MACD = ${num(f.m, md)}, the pane's bottom = ${num(f.bottom, md)} (96% of it = ${num(0.96 * f.bottom, md)})`,
      gold ? `This bar's close: ${f.price.toFixed(d)} (no separate bid and ask)` : sell ? `Bid at this bar's close: ${f.price.toFixed(d)}` : `Ask at this bar's close: ${f.price.toFixed(d)}`,
    ].join("\n"),
    ITEM6_EN,
    ITEM7_EN,
    `${iv === "15min" ? ITEM8_PAIR15_EN : gold ? ITEM8_GOLD_EN : ITEM8_PAIR1H_EN} ${ITEM8_BOTH_EN}`,
    gold ? GOLD9_EN : fadeMeasuredLine("en", s.pair, iv),
    iv === "15min" ? ITEM10_15_EN : ITEM10_1H_EN,
    `${gold ? SOURCE_GOLD_EN : sourcePairEn(iv)} Check the latest state in the app before you place an order:\n${APP_URL}`,
    STOP_EN,
  ].join("\n\n");
};

// research/macdfade96-spec.md 6.1's two patterns: no text says a price will come back (src/test/macd-fade.test.ts
// holds them against that file)
const COME_BACK_JA = /(必ず|いずれ|きっと|そのうち|やがて)[^。]{0,8}戻|戻ってく|戻ってき|戻るはず|戻ります/;
const COME_BACK_EN =
  /\b(always|will|surely|certainly|eventually)\s+(come|comes|go|goes)\s+back\b|\b(always|will|surely|certainly|eventually)\s+(return|returns|recover|recovers)\b|\bcomes?\s+back\s+(eventually|in\s+the\s+end)\b/i;

describe("v41 the pairs' and gold's email per chart, word for word (spec 4.1 to 4.5)", () => {
  it("the measured paragraph of a USD/JPY mail is the 15-minute run's and of an EUR/JPY mail the 1-hour run's, each its own chart's, ja and en", () => {
    expect(fadeMeasuredLine("ja", "USD/JPY", "15min")).toBe(MEASURED_USDJPY_JA);
    expect(fadeMeasuredLine("en", "USD/JPY", "15min")).toBe(MEASURED_USDJPY_EN);
    expect(fadeMeasuredLine("ja", "EUR/JPY", "1h")).toBe(MEASURED_EURJPY_JA);
    expect(fadeMeasuredLine("en", "EUR/JPY", "1h")).toBe(MEASURED_EURJPY_EN);
    // the run of the chart only: nothing of the other run's totals in either
    expect(MEASURED_USDJPY_JA).toContain("合図は6,006回、うち5,926回が+10 pips に届きました。");
    expect(MEASURED_USDJPY_JA).not.toContain("1,490");
    expect(MEASURED_EURJPY_JA).toContain("合図は1,490回、うち1,468回が+10 pips に届きました。");
    expect(MEASURED_EURJPY_JA).not.toContain("6,006");
    expect(MEASURED_EURJPY_EN).toContain("docs §8.156");
    expect(MEASURED_EURJPY_EN).not.toContain("8.155");
  });

  it("a 15-minute pair's SELL in Japanese (USD/JPY): the bar, the line at 96% of the TOP with the bar before not, the numbers, the bid close, no take-profit and no stop price, one email, when it is judged (0, 1 and 3 minutes), what was measured (the 15-minute run), whose choices (the pane the owner's), the source, how to stop", () => {
    const s = pairSig(I_SELL);
    expect(s.interval).toBe("15min");
    expect(s.fade!.top).toBeGreaterThan(0.01);
    const mail = renderIndicatorMail(s, "ja");
    expect(mail.subject).toBe(subjectJa("ドル/円", "SELL"));
    expect(mail.subject).toBe("【Sextant】ドル/円 15分足 売り（SELL）: 青い線が上の端の96%で確定（MACD の逆張り）");
    expect(mail.text).toBe(textJa(s, "ドル/円", 3, 3));
    // the bid close of the bar, not the mid
    expect(mail.text).toContain(`\n売値（この足の終値の売値）: ${bid(closes[I_SELL]).toFixed(3)}\n`);
    // the bar judged, in Japan time: the bar that opened 2026-07-14 07:30 UTC closed 16:45 JST
    expect(mail.text).toContain("判定した足: 2026-07-14 16:45（日本時間）に確定した15分足\n");
    expect(mail.text).toContain(`\n\n${MEASURED_USDJPY_JA}\n\n`);
  });

  it("a 15-minute pair's BUY in Japanese: the BOTTOM, the ask close, the chart's minus", () => {
    const s = pairSig(I_BUY);
    const mail = renderIndicatorMail(s, "ja");
    expect(mail.subject).toBe(subjectJa("ドル/円", "BUY"));
    expect(mail.text).toBe(textJa(s, "ドル/円", 3, 3));
    expect(s.fade!.m).toBeLessThan(0);
    expect(mail.text).toContain(`\n買値（この足の終値の買値）: ${ask(closes[I_BUY]).toFixed(3)}\n`);
    // below zero the minus is the chart's (U+2212), not toFixed's hyphen
    expect(mail.text).toContain(`MACD = −${(-s.fade!.m).toFixed(3)}、枠の下の端 = −${(-s.fade!.bottom).toFixed(3)}`);
    expect(mail.text).not.toContain("= -");
  });

  it("a 15-minute pair's SELL and BUY in English", () => {
    for (const i of [I_SELL, I_BUY]) {
      const s = pairSig(i);
      const mail = renderIndicatorMail(s, "en");
      expect(mail.subject).toBe(subjectEn("USD/JPY", s.side));
      expect(mail.text).toBe(textEn(s, 3, 3));
    }
    const sell = renderIndicatorMail(pairSig(I_SELL), "en").text;
    expect(sell).toContain(`\nBid at this bar's close: ${bid(closes[I_SELL]).toFixed(3)}\n`);
    expect(sell).toContain("Bar judged: the 15-minute bar that closed at 2026-07-14 07:45 UTC (2026-07-14 16:45 JST)\n");
    expect(sell).toContain(`\n\n${MEASURED_USDJPY_EN}\n\n`);
    expect(renderIndicatorMail(pairSig(I_BUY), "en").text).toContain(`\nAsk at this bar's close: ${ask(closes[I_BUY]).toFixed(3)}\n`);
  });

  it("a 1-hour pair's SELL and BUY (EUR/JPY), ja and en: v40's email word for word but for item 9, the 1-hour run's paragraph; 「1時間足」 / \"1-hour\" throughout", () => {
    for (const i of [I_SELL, I_BUY]) {
      const s = pairSig(i, "EUR/JPY");
      expect(s.interval).toBe("1h");
      const ja = renderIndicatorMail(s, "ja");
      expect(ja.subject).toBe(subjectJa("ユーロ/円", s.side, "1h"));
      expect(ja.text).toBe(textJa(s, "ユーロ/円", 3, 3));
      const en = renderIndicatorMail(s, "en");
      expect(en.subject).toBe(subjectEn("EUR/JPY", s.side, "1h"));
      expect(en.text).toBe(textEn(s, 3, 3));
      expect(ja.text).toContain(`\n\n${MEASURED_EURJPY_JA}\n\n`);
      expect(en.text).toContain(`\n\n${MEASURED_EURJPY_EN}\n\n`);
      // no 15-minute word but in the measured paragraph's 〔mailedOn〕 (the other chart's pairs)
      expect(ja.text.replace(MEASURED_EURJPY_JA, "")).not.toContain("15分足");
      expect(en.text.replace(MEASURED_EURJPY_EN, "")).not.toContain("15-minute");
      expect(ja.text).toContain(`\n\n${ITEM8_PAIR1H_JA}${ITEM8_BOTH_JA}\n\n`);
      expect(en.text).toContain(`\n\n${ITEM8_PAIR1H_EN} ${ITEM8_BOTH_EN}\n\n`);
    }
    // the bar judged: the 1-hour bar that opened 2026-07-xx closed an hour later
    const s = pairSig(I_SELL, "EUR/JPY");
    expect(renderIndicatorMail(s, "ja").text).toContain(`判定した足: ${jst(htimes[I_SELL] + H)}（日本時間）に確定した1時間足\n`);
  });

  it("each of the five pairs on its own chart: its name, its digits, its chart's paragraph and its own measured sentence (USD/JPY +2.67 (+5.69) and AUD/USD +4.94 (+5.18) of the 15-minute run; EUR/JPY +4.30 (+3.28), AUD/JPY +4.44 (-0.75) and EUR/USD +3.11 (+2.61) of the 1-hour run)", () => {
    const want: Record<string, { ja: string; en: string; d: number; iv: string; neg: [string, string] }> = {
      "USD/JPY": { ja: "ドル/円だけでは平均+2.67 pips（合図なしでは+5.69 pips）です。", en: "On USD/JPY alone the mean was +2.67 pips (with no signal, +5.69 pips).", d: 3, iv: "15min", neg: ["豪ドル/円（-0.82 pips）", "AUD/JPY (-0.82 pips)"] },
      "EUR/JPY": { ja: "ユーロ/円だけでは平均+4.30 pips（合図なしでは+3.28 pips）です。", en: "On EUR/JPY alone the mean was +4.30 pips (with no signal, +3.28 pips).", d: 3, iv: "1h", neg: ["ドル/円（-0.26 pips）", "USD/JPY (-0.26 pips)"] },
      "AUD/JPY": { ja: "豪ドル/円だけでは平均+4.44 pips（合図なしでは-0.75 pips）です。", en: "On AUD/JPY alone the mean was +4.44 pips (with no signal, -0.75 pips).", d: 3, iv: "1h", neg: ["ドル/円（-0.26 pips）", "USD/JPY (-0.26 pips)"] },
      "EUR/USD": { ja: "ユーロ/ドルだけでは平均+3.11 pips（合図なしでは+2.61 pips）です。", en: "On EUR/USD alone the mean was +3.11 pips (with no signal, +2.61 pips).", d: 5, iv: "1h", neg: ["ドル/円（-0.26 pips）", "USD/JPY (-0.26 pips)"] },
      "AUD/USD": { ja: "豪ドル/ドルだけでは平均+4.94 pips（合図なしでは+5.18 pips）です。", en: "On AUD/USD alone the mean was +4.94 pips (with no signal, +5.18 pips).", d: 5, iv: "15min", neg: ["豪ドル/円（-0.82 pips）", "AUD/JPY (-0.82 pips)"] },
    };
    const names: Record<string, string> = { "USD/JPY": "ドル/円", "EUR/JPY": "ユーロ/円", "AUD/JPY": "豪ドル/円", "EUR/USD": "ユーロ/ドル", "AUD/USD": "豪ドル/ドル" };
    expect(MACDH_PAIRS.filter((p) => p !== "XAU/USD")).toEqual(Object.keys(want));
    for (const [pair, w] of Object.entries(want)) {
      expect(MACDH_INTERVAL_OF[pair], pair).toBe(w.iv);
      const usd = pair.endsWith("/USD");
      const base = pairSig(I_SELL, pair);
      const s: IndicatorSignal = usd ? { ...base, fade: { ...base.fade!, top: 0.0021, m: 0.00205, bottom: -0.0009, price: 1.10123 } } : base;
      const ja = renderIndicatorMail(s, "ja");
      expect(ja.subject).toBe(subjectJa(names[pair], "SELL", w.iv));
      expect(ja.text).toBe(textJa(s, names[pair], w.d, w.d));
      expect(ja.text, pair).toContain(w.ja);
      const en = renderIndicatorMail(s, "en");
      expect(en.subject).toBe(subjectEn(pair, "SELL", w.iv));
      expect(en.text).toBe(textEn(s, w.d, w.d));
      expect(en.text, pair).toContain(w.en);
      if (usd) expect(ja.text).toContain("\n売値（この足の終値の売値）: 1.10123\n");
      // every pair's mail carries its chart's five-pair total and the pair below zero on that chart
      expect(ja.text).toContain(`平均がマイナスだったペア: ${w.neg[0]}。`);
      expect(en.text).toContain(`Pairs whose mean was below zero: ${w.neg[1]}.`);
      // and the per-pair chance sentence right after its own pair's
      expect(ja.text).toContain(`${w.ja}ペアごとの合図なしとの差は、偶然で出る差より大きいとは示せていません`);
      expect(en.text).toContain(`${w.en} Each pair's difference from no signal has not been shown to be larger than chance gives`);
    }
  });

  it("gold's SELL and BUY on its 1-hour chart, Japanese and English: v40's email word for word (the bar's close, its own timing 1 to 30 minutes, not measured on gold and no number, Twelve Data's source)", () => {
    for (const i of [G_SELL, G_BUY]) {
      const s = goldSig(i);
      expect(Math.abs(s.side === "SELL" ? s.fade!.top : s.fade!.bottom)).toBeGreaterThan(1);
      const ja = renderIndicatorMail(s, "ja");
      expect(ja.subject).toBe(subjectJa("金", s.side, "1h"));
      expect(ja.text).toBe(textJa(s, "金", 2, 2));
      expect(ja.text).toContain(`\nこの足の終値: ${gcloses[i].toFixed(2)}（売値・買値の別はありません）\n`);
      const en = renderIndicatorMail(s, "en");
      expect(en.subject).toBe(subjectEn("XAU/USD", s.side, "1h"));
      expect(en.text).toBe(textEn(s, 2, 2));
      // no measured number on gold, nothing of GMO's bid and ask, not the pairs' read times, no 15-minute word
      for (const t of [ja.text, en.text]) {
        for (const no of ["1,490", "1,468", "6,006", "5,926", "pips", "GMOコインの公開レート", "GMO Coin's public bid and ask", "docs §8.155", "docs §8.156", "3分後", "1 and 3 minutes", "15分足", "15-minute", "次の足が確定するまで", "until the next bar closes"]) expect(t, no).not.toContain(no);
      }
    }
  });

  it("renderFadeMail refuses a signal off its pair's chart (spec 3.2 item 7): gold on '15min', USD/JPY on '1h', EUR/JPY on '15min'", () => {
    const g = goldSig(G_SELL);
    const u = pairSig(I_SELL);
    const e = pairSig(I_SELL, "EUR/JPY");
    for (const s of [{ ...g, interval: "15min" }, { ...u, interval: "1h" }, { ...e, interval: "15min" }, { ...u, pair: "AUD/USD", interval: "1h" }]) {
      for (const lang of ["ja", "en"] as const) expect(() => renderIndicatorMail(s, lang), `${s.pair} ${s.interval}`).toThrow(/is not judged on/);
    }
  });

  it("each kind's timing sentence (item 8): a 15-minute pair's reads at 0, 1 and 3 minutes, a 1-hour pair's at 0, 3 and 5, gold's 1 to 30 minutes; how long the mail takes not measured; the arrival price; none says 「数分後」 / \"a few minutes\"", () => {
    const pj = renderIndicatorMail(pairSig(I_SELL), "ja").text;
    const pe = renderIndicatorMail(pairSig(I_SELL), "en").text;
    const hj = renderIndicatorMail(pairSig(I_SELL, "EUR/JPY"), "ja").text;
    const he = renderIndicatorMail(pairSig(I_SELL, "EUR/JPY"), "en").text;
    const gj = renderIndicatorMail(goldSig(G_SELL), "ja").text;
    const ge = renderIndicatorMail(goldSig(G_SELL), "en").text;
    expect(pj).toContain(`\n\n${ITEM8_PAIR15_JA}${ITEM8_BOTH_JA}\n\n`);
    expect(pe).toContain(`\n\n${ITEM8_PAIR15_EN} ${ITEM8_BOTH_EN}\n\n`);
    expect(hj).toContain(`\n\n${ITEM8_PAIR1H_JA}${ITEM8_BOTH_JA}\n\n`);
    expect(he).toContain(`\n\n${ITEM8_PAIR1H_EN} ${ITEM8_BOTH_EN}\n\n`);
    expect(gj).toContain(`\n\n${ITEM8_GOLD_JA}${ITEM8_BOTH_JA}\n\n`);
    expect(ge).toContain(`\n\n${ITEM8_GOLD_EN} ${ITEM8_BOTH_EN}\n\n`);
    for (const t of [pj, hj, gj]) {
      expect(t).toContain("実際に何分で届くかは測っていません");
      expect(t).not.toContain("数分後");
    }
    for (const t of [pe, he, ge]) {
      expect(t).toContain("how long it takes to arrive has not been measured");
      expect(t).not.toContain("a few minutes");
    }
    // item 10 (spec 4.3): on 15 minutes the owner is named for the pane of the newest 120 15-minute bars too (the
    // owner's choice of 2026-11-17); the 1-hour mails keep v40's sentence, which does not attribute the 1-hour pane
    expect(pj).toContain(ITEM10_15_JA);
    expect(pe).toContain(ITEM10_15_EN);
    for (const t of [hj, gj]) expect(t).toContain(ITEM10_1H_JA);
    for (const t of [he, ge]) expect(t).toContain(ITEM10_1H_EN);
    expect(ITEM10_15_JA.split("アプリのオーナーが決めたものです。")[0]).toContain("・MACD の枠を15分足の新しい120本にすること・");
    expect(ITEM10_15_JA.split("アプリのオーナーが決めたものです。")[1]).toBe("この枠は、アプリの15分足のチャートの枠と同じです。");
    expect(ITEM10_15_EN.split("are the app owner's choices.")[0]).toContain(", the MACD pane of the newest 120 15-minute bars,");
    expect(ITEM10_15_EN.split("are the app owner's choices.")[1]).toBe(" That pane is the same as the app's 15-minute chart's.");
    // a text names each pair's own chart: no 「1時間足」 / "1-hour" in a 15-minute pair's mail but its paragraph's
    // 〔mailedOn〕, and the reverse
    expect(pj.replace(MEASURED_USDJPY_JA, "")).not.toContain("1時間足");
    expect(pe.replace(MEASURED_USDJPY_EN, "")).not.toContain("1-hour");
  });

  it("4.1's guards: 「利確」 / \"take profit\" only in the sentences that say there is no take-profit price, in item 10 and in the measured paragraph; 「利確の目安」, \"take-profit level\" never; no price labelled a target or a stop; no text says a price will come back; no text puts the five pairs and gold on one chart", () => {
    expect(COME_BACK_JA.test("必ず戻ってくる")).toBe(true);
    expect(COME_BACK_EN.test("the price will come back")).toBe(true);
    const spec96 = readFileSync("research/macdfade96-spec.md", "utf8");
    expect(spec96).toContain(`\`/${COME_BACK_JA.source}/\``);
    expect(spec96).toContain(`\`/${COME_BACK_EN.source}/i\``);
    const variants = [pairSig(I_SELL), pairSig(I_BUY), pairSig(I_SELL, "EUR/JPY"), pairSig(I_BUY, "EUR/JPY"), pairSig(I_SELL, "AUD/USD"), goldSig(G_SELL), goldSig(G_BUY)];
    for (const s of variants) {
      const ja = renderIndicatorMail(s, "ja");
      const en = renderIndicatorMail(s, "en");
      // the whole mail first (subject too)
      for (const t of [ja.subject, ja.text]) {
        expect(t).not.toContain("利確の目安");
        expect(t).not.toMatch(COME_BACK_JA);
        expect(t).not.toContain("必ず");
        expect(t).not.toMatch(/(利確|損切り|目標)[^。\n]{0,6}[0-9]/);
        // 4.1: no text gives the reason for a pair's chart, and none puts every pair and gold on one chart
        expect(t).not.toContain("勝率");
        expect(t).not.toMatch(/5ペアと金を?(15分足|1時間足)/);
      }
      for (const t of [en.subject, en.text]) {
        expect(t.toLowerCase()).not.toContain("take-profit level");
        expect(t).not.toMatch(COME_BACK_EN);
        expect(t).not.toMatch(/\b(take profit|take-profit|stop|target|TP\d)\s*(price)?\s*[:=]?\s*[0-9]/i);
        expect(t.toLowerCase()).not.toContain("win rate");
        expect(t).not.toMatch(/five pairs and gold on (15-minute|1-hour)/);
      }
      // the sentences 4.1 allows, written out (4.3 items 6 and 10; the measured paragraph, 4.5), taken out: none left
      const strip = (t: string, allowed: string[]) =>
        allowed.reduce((x, a) => {
          expect(x, a.slice(0, 30)).toContain(a);
          return x.replace(a, "");
        }, t);
      const pair = s.pair !== "XAU/USD";
      const q = s.interval === "15min";
      const jaLeft = strip(ja.text, [ITEM6_JA, q ? ITEM10_15_JA : ITEM10_1H_JA, ...(pair ? [fadeMeasuredLine("ja", s.pair, s.interval)] : [])]);
      const enLeft = strip(en.text, [ITEM6_EN, q ? ITEM10_15_EN : ITEM10_1H_EN, ...(pair ? [fadeMeasuredLine("en", s.pair, s.interval)] : [])]);
      expect(jaLeft).not.toContain("利確");
      expect(enLeft.toLowerCase()).not.toContain("take profit");
      expect(enLeft.toLowerCase()).not.toContain("take-profit");
    }
  });

  it("4.1: a count reaching +10 pips never comes without 4.5's fields (the mean, the open trades' count and result, the largest loss on the way, the holding time, the other side, the baseline, no order unfilled, the weekend's), each chart's own", () => {
    const ja = renderIndicatorMail(pairSig(I_SELL), "ja").text;
    for (const want of [
      "合図は6,006回、うち5,926回が+10 pips に届きました。",
      "80回は2026年11月10日 21:00（UTC）の時点でまだ届いておらず、その含み損益は合わせて-44,784.5 pips（マイナスが損）、いちばん悪いもので-1,913.4 pips、いちばん長いもので約666日持ったままでした（その後は追っていません）。",
      "1回あたり平均+2.41 pips（届いていないものは、その時の含み損益で数えました）。",
      "途中の含み損は中央値11.9 pips、最大2,975.8 pips。",
      "+10 pips に届くまでの時間は中央値約2時間、10回に1回は約4日より長く、いちばん長いもので約545日でした。",
      "入らなかった注文はありません（週末の止まっている時間に確定した足のもの〈下〉を除き、この決まりの合図は、そのペアのメールをこの時間足で判定するかどうかに関わらず、すべて入ったとして数えました）。",
      "損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。",
      "同じ合図で逆向き（上で買い・下で売り）に入ると1回あたり+3.19 pips",
      "合図なしで5ペアの15分足ごとの最初の1分に（週末の止まっている時間に確定した足を除く。買いと売りを1回ずつ）入ると+3.32 pips でした（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく15分足の最初の1分に入ったもので、同じ入りではありません）。",
      "過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。",
      "平均がマイナスだったペア: 豪ドル/円（-0.82 pips）。",
      "ほかに3回、週末の止まっている時間に確定した足に合図がありましたが、その足はどのペアのメールでも判定しないので、上の数字に入れていません。",
    ]) {
      expect(ja, want).toContain(want);
    }
    const en = renderIndicatorMail(pairSig(I_SELL, "EUR/JPY"), "en").text;
    for (const want of [
      "1,490 signals, of which 1,468 reached +10 pips.",
      "22 had not reached it by 10 November 2026, 21:00 UTC; their unrealised result was -9,820.9 pips in all (a minus is a loss), the worst -1,733.2 pips, the longest held about 617 days (not followed after that).",
      "The mean was +3.26 pips a trade (those not reached counted at their unrealised result then).",
      "The largest loss on the way: median 10.7 pips, largest 2,243.6 pips.",
      "Time to +10 pips: median about 2 hours, longer than about 3 days one time in ten, longest about 477 days.",
      "so no order went unfilled (every signal of this rule, but those on bars that closed in the weekend pause (below), is counted as entered, whether or not that pair's email is judged on this timeframe).",
      "With no stop, the share reaching +10 pips comes out high by construction.",
      "gave -2.08 pips a trade",
      "entering with no signal at the first minute of every 1-hour bar of the five pairs (bars that closed in the weekend pause left out; a BUY and a SELL) gave +3.21 pips (held the same way, +10 pips and no stop, but entered at the 1-hour bar's first minute, not at its close, so not the same entry).",
      "The measurement re-reads GMO's past bars; times this email's reads failed and the like are not in it (how often: not measured).",
      "Pairs whose mean was below zero: USD/JPY (-0.26 pips).",
      "Besides these, 11 signals fell on bars that closed in the weekend pause; no pair's email judges those bars, so they are not in the numbers above.",
    ]) {
      expect(en, want).toContain(want);
    }
  });
});

// ---- part 2: the real index.ts over fake tables ----------------------------------------------------------------------

type Row = Record<string, unknown>;
const SB = "https://sb.test";
const TIME_COLS = new Set(["bar_time", "closed_at", "created_at"]);

const world = {
  subs: [] as Row[],
  alerts: [] as Row[],
  klineFiles: new Map<string, Row>(),
  sent: [] as Array<{ to: string; subject: string; text: string }>,
  // followers whose plan lookup fails (a 503); followers whose address lookup answers this status
  failPlanFor: new Set<string>(),
  failAuthFor: new Map<string, number>(),
  // signal_alerts cannot be read (its GET answers a 503); its inserts still work
  failAlertsRead: false,
  gold: null as null | { bars: Row[]; fetched_at: string },
  gmoCalls: 0,
  // v41: Twelve Data's key given to the run (the env), its time_series answers (the newest bar it holds: an index of
  // `times`), how many times it was read, and the day's counts taken
  twelveKey: false,
  twelveUpTo: -1,
  twelveCalls: 0,
  twelveCredits: 0,
  // the app's user (the auth lookup of a Bearer token answers this id), the subscription upserts as the fake received
  // them (the Prefer header and the body), and the deletes' URLs
  me: "userM",
  subPosts: [] as Array<{ prefer: string; url: string; body: unknown }>,
  subDeletes: [] as string[],
  // every REST read as "table select"; every REST request as "METHOD table"; every request no route took
  reads: [] as string[],
  requests: [] as string[],
  unrouted: [] as string[],
  ids: 0,
};
const resetWorld = () => {
  Object.assign(world, {
    subs: [], alerts: [], sent: [], gold: null, gmoCalls: 0, reads: [], requests: [], unrouted: [], ids: 0, failAlertsRead: false,
    twelveKey: false, twelveUpTo: -1, twelveCalls: 0, twelveCredits: 0, me: "userM", subPosts: [], subDeletes: [],
  });
  world.klineFiles.clear();
  world.failPlanFor.clear();
  world.failAuthFor.clear();
};
let clock = 0;

// GMO's file of a JST day key, on the chart `iv` ("15min" or "1h"): the bars opened from 21:00 UTC the day before
// (06:00 JST, GMO's roll in summer), 96 or 24 a day, the same waves on each grid (so USD/JPY's and EUR/JPY's files are
// alike), bid and ask a spread of 0.010 around the mid; the bar forming 0.007 above its open, so that a price taken
// from the forming bar (or from the read's last quote) is not the judged bar's and the price tests catch it
const midBar = (k: number, iv: string) => {
  const open = openOf(k);
  if (TIMES_OF[iv][k] + STEP_OF[iv] > clock) return { o: open, h: open + 0.007, l: open, c: open + 0.007 };
  return { o: open, h: Math.max(open, closes[k]), l: Math.min(open, closes[k]), c: closes[k] };
};
const gmoFile = (iv: string, side: string, key: string) => {
  const start = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8))) - 3 * H;
  const data: Row[] = [];
  for (let t = start; t < start + 24 * H; t += STEP_OF[iv]) {
    const k = indexOf[iv].get(t);
    if (k === undefined || t > clock) continue;
    const m = midBar(k, iv);
    const f = (v: number) => (v + (side === "BID" ? -0.005 : 0.005)).toFixed(3);
    data.push({ openTime: String(t), open: f(m.o), high: f(m.h), low: f(m.l), close: f(m.c) });
  }
  return { status: 0, data, responsetime: iso(clock) };
};
// GMO's interval names (track-outcomes/quotes.ts GMO_INTERVALS) of the two charts served here
const GMO_IV: Record<string, string> = { "15min": "15min", "1hour": "1h" };
// gold's 1-hour bars, the 700 ending at bar i, as Twelve Data gives them and the live chart keeps them
const goldBars = (i: number) =>
  Array.from({ length: 700 }, (_, n) => {
    const k = i - 699 + n;
    const open = gcloses[k - 1];
    return { datetime: dt(htimes[k]), open, high: Math.max(open, gcloses[k]), low: Math.min(open, gcloses[k]), close: gcloses[k] };
  });
// gold's stored 1-hour bars (public.live_chart_fallback), the 700 ending at bar i, read at `readAt`
const goldStored = (i: number, readAt: number) => ({ bars: goldBars(i), fetched_at: iso(readAt) });

// PostgREST's filters, as far as the function uses them here
const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
const same = (col: string, a: unknown, b: string) => (TIME_COLS.has(col) ? Date.parse(String(a)) === Date.parse(b) : String(a) === b);
const condOf = (col: string, expr: string): ((r: Row) => boolean) => {
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  if (op === "in") {
    const list = raw.slice(1, -1).split(",").map(unquote);
    return (r) => r[col] !== null && r[col] !== undefined && list.some((v) => same(col, r[col], v));
  }
  const val = unquote(raw);
  if (op === "eq") return (r) => r[col] !== null && r[col] !== undefined && same(col, r[col], val);
  if (op === "gte" || op === "lt" || op === "gt") {
    return (r) => {
      if (r[col] === null || r[col] === undefined) return false;
      const d = TIME_COLS.has(col) ? Date.parse(String(r[col])) - Date.parse(val) : String(r[col]).localeCompare(val);
      return op === "gte" ? d >= 0 : op === "gt" ? d > 0 : d < 0;
    };
  }
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
  if (url.startsWith("https://forex-api.coin.z.com/public/v1/klines")) {
    world.gmoCalls++;
    const u = new URL(url);
    // USD/JPY's and EUR/JPY's 15-minute and 1-hour files (the same waves); any other: nothing
    const iv = GMO_IV[u.searchParams.get("interval") ?? ""];
    if (!["USD_JPY", "EUR_JPY"].includes(u.searchParams.get("symbol") ?? "") || iv === undefined) return reply({ status: 0, data: [], responsetime: iso(clock) });
    return reply(gmoFile(iv, u.searchParams.get("priceType")!, u.searchParams.get("date")!));
  }
  // Twelve Data's time_series of gold's 1-hour bars, newest first, up to bar world.twelveUpTo
  if (url.startsWith("https://api.twelvedata.com/time_series")) {
    world.twelveCalls++;
    const u = new URL(url);
    if (u.searchParams.get("symbol") !== "XAU/USD" || u.searchParams.get("interval") !== "1h") return reply({ status: "error", message: "not here" });
    const values = goldBars(world.twelveUpTo).reverse().map((b) => ({ datetime: b.datetime, open: String(b.open), high: String(b.high), low: String(b.low), close: String(b.close) }));
    return reply({ meta: { symbol: "XAU/USD", interval: "1h" }, values, status: "ok" });
  }
  if (url === "https://api.resend.com/emails") {
    world.sent.push({ to: body.to[0], subject: body.subject, text: body.text });
    return reply({ id: `re_${world.sent.length}` });
  }
  // the app's user behind a Bearer token
  if (url === `${SB}/auth/v1/user`) return reply({ id: world.me, email: `${world.me}@example.test` });
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
  const where = whereOf(u);
  world.requests.push(`${method} ${table}`);
  if (method === "GET") world.reads.push(`${table} ${select ?? "*"}`);
  if (table === "rpc/track_outcomes_sweep_token") return reply("tok");
  if (table === "signal_alert_subscriptions" && method === "GET") return reply(world.subs.filter(where).map((r) => pick(r, select)));
  // the app's ticks: an upsert on (user_id, pair, interval, rule) merging into a row that is there, and the unticks
  if (table === "signal_alert_subscriptions" && method === "POST") {
    const prefer = new Headers(init?.headers).get("Prefer") ?? "";
    world.subPosts.push({ prefer, url, body });
    for (const r of Array.isArray(body) ? body : [body]) {
      const there = world.subs.find((x) => x.user_id === r.user_id && x.pair === r.pair && x.interval === r.interval && x.rule === r.rule);
      if (there) Object.assign(there, r);
      else world.subs.push({ created_at: iso(clock), ...r });
    }
    return empty(201);
  }
  if (table === "signal_alert_subscriptions" && method === "DELETE") {
    world.subDeletes.push(url);
    world.subs = world.subs.filter((r) => !where(r));
    return empty(204);
  }
  if (table === "signal_events" && method === "GET") return reply([]);
  if (table === "profiles" && method === "GET") {
    const uid = u.searchParams.get("id")!.slice(3);
    return world.failPlanFor.has(uid) ? reply({ message: "boom" }, 503) : reply([{ plan: "light" }]);
  }
  if (table === "gmo_kline_files") {
    if (method === "GET") return reply([...world.klineFiles.values()].filter(where).map((r) => pick(r, select)));
    if (method === "POST") {
      world.klineFiles.set(`${body.symbol}|${body.price_type}|${body.interval}|${body.date_key}`, body);
      return empty(201);
    }
  }
  if (table === "live_chart_fallback" && method === "GET") {
    return reply(world.gold && u.searchParams.get("pair") === "eq.XAU/USD" && u.searchParams.get("interval") === "eq.1h" ? [pick(world.gold, select)] : []);
  }
  // a Twelve Data read stored for the chart (the run keeps it in the chart's shape), and the day's count taken
  if (table === "live_chart_fallback" && method === "POST") {
    if (body.pair === "XAU/USD" && body.interval === "1h") world.gold = { bars: body.bars, fetched_at: body.fetched_at };
    return empty(201);
  }
  if (table === "rpc/take_twelve_data_credit" && method === "POST") {
    world.twelveCredits++;
    return reply(true);
  }
  if (table === "signal_alerts") {
    if (method === "GET" && world.failAlertsRead) return reply({ message: "boom" }, 503);
    if (method === "GET") return reply(world.alerts.filter(where).map((r) => pick(r, select)));
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
type Read = Record<string, unknown> & { pair?: string; interval?: string; signals?: string[]; fade?: Record<string, unknown> };
type Summary = Record<string, unknown> & { reads?: Read[] };

const INDEX = "../../supabase/functions/signal-alerts/index.ts";
const INDICATORS = "../../supabase/functions/signal-alerts/indicators.ts";

describe("v41 the fade in the function, each pair on its own chart: the real index.ts over fake tables (spec 2.4, 2.5, 3.2, 3.4, 3.6 and 7.1)", () => {
  let captured: Handler | null = null;
  const realSetTimeout = globalThis.setTimeout;
  beforeAll(() => {
    vi.stubGlobal("Deno", {
      env: {
        get: (k: string) =>
          ({ SUPABASE_URL: SB, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "svc", RESEND_API_KEY: "re_test", ...(world.twelveKey ? { TWELVE_DATA_API_KEY: "td_test" } : {}) } as Record<string, string>)[k],
      },
      serve: (h: Handler) => {
        captured = h;
      },
    });
    vi.stubGlobal("fetch", fakeFetch);
    // the function's sleeps (GMO a request at a time, Resend two a second) pass at once, the clock moved on by them
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
  const instance = async (): Promise<Handler> => {
    vi.resetModules();
    captured = null;
    await import(/* @vite-ignore */ INDEX);
    if (!captured) throw new Error("the function did not start");
    return captured;
  };
  // a run of the "indicators" mode at `at`
  const sweep = async (h: Handler, at: number): Promise<Summary> => {
    clock = at;
    const res = await h(new Request("https://fn.test/signal-alerts", { method: "POST", headers: { "x-sweep-token": "tok", "Content-Type": "application/json" }, body: JSON.stringify({ mode: "indicators" }) }));
    expect(res.status).toBe(200);
    const text = await res.text();
    // no run's record holds a follower, an address or a row id
    for (const no of ["userA", "userB", "userC", "userZ", "example.test", "alert-", "user_id"]) expect(text, no).not.toContain(no);
    return JSON.parse(text) as Summary;
  };
  const fresh = async (at: number) => sweep(await instance(), at);
  // a second into minute `minute` after bar i's close on the chart `iv` (the cron's run reads its clock a second into
  // the minute)
  const at = (i: number, minute: number, iv = "15min") => TIMES_OF[iv][i] + STEP_OF[iv] + minute * MIN + 1_000;
  const follow = (user: string, lang = "ja", pair = "USD/JPY", interval = "15min", rule = "macdx") => ({ user_id: user, pair, interval, lang, rule });
  // the judged chart's entry of a run's record, its signals the fade's alone
  const judged = (s: Summary, pair = "USD/JPY", iv = "15min"): Read | undefined => {
    const r = (s.reads ?? []).find((x) => x.pair === pair && x.interval === iv && typeof x.fade === "object" && x.fade !== null);
    return r ? { ...r, signals: (r.signals ?? []).filter((x) => x.startsWith("macdx")) } : undefined;
  };
  const readOf = (s: Summary, pair = "USD/JPY", iv = "15min") => (s.reads ?? []).find((x) => x.pair === pair && x.interval === iv);
  const mails = () => world.sent.map((m) => `${m.to.split("@")[0]}: ${m.subject}`);
  const alertsOf = (rule: string) => world.alerts.filter((r) => r.rule === rule);
  // nothing the function asked for went unanswered, no read took every column, the alerts were read by user and side
  // only, and nothing of v9's ride tables was asked for (spec 3.2 and 7.1: nothing read or written each minute, no state
  // row)
  const clean = () => {
    expect(world.unrouted).toEqual([]);
    for (const r of world.reads) {
      expect(r, r).not.toMatch(/ \*$/);
      if (r.startsWith("signal_alerts ")) expect(r).toBe("signal_alerts user_id,side");
    }
    expect(world.requests.filter((r) => /macd_ride/.test(r))).toEqual([]);
  };

  it("a pair's close judged at minutes 0, 1 and 3 by fresh instances: one email a follower, the same price (the bar's 15-minute bid close for a SELL, from the run's own 15-minute read, fadeQuotes), the row of spec 3.4", async () => {
    world.subs = [follow("userA"), follow("userB"), follow("userC", "en")];
    const s0 = await fresh(at(I_SELL, 0));
    const want = pairSig(I_SELL);
    expect(judged(s0)).toMatchObject({
      pair: "USD/JPY", interval: "15min", bars: 600, newest: iso(times[I_SELL]), signals: ["macdx:SELL"],
      fade: { fresh: true, entry: "SELL", price: bid(closes[I_SELL]) },
    });
    expect(Object.keys(judged(s0)!.fade!).sort()).toEqual(["entry", "fresh", "price"]);
    expect(s0).toMatchObject({ sent: 3 });
    expect(mails()).toEqual([`userA: ${subjectJa("ドル/円", "SELL")}`, `userB: ${subjectJa("ドル/円", "SELL")}`, `userC: ${subjectEn("USD/JPY", "SELL")}`]);
    // the mail as the spec words it, from the chart's own bars and GMO's bid close of the bar
    expect(world.sent[0].text).toBe(textJa(want, "ドル/円", 3, 3));
    expect(world.sent[1].text).toBe(world.sent[0].text);
    expect(world.sent[2].text).toBe(textEn(want, 3, 3));
    // the rows: the bar's open and close (the open plus 15 minutes), the price in, no stop and no target, the 15-minute
    // chart, the fade's id
    expect(alertsOf(V12)).toHaveLength(3);
    for (const r of alertsOf(V12)) {
      expect(r).toMatchObject({
        kind: "signal", pair: "USD/JPY", interval: "15min", bar_time: iso(times[I_SELL]), closed_at: iso(times[I_SELL] + STEP), side: "SELL",
        entry: bid(closes[I_SELL]), stop: null, target: null, rule: V12, status: "sent", event_id: null,
      });
    }
    // nothing else was mailed or written (no other rule is followed here)
    expect(world.alerts).toHaveLength(3);
    // minutes 1 and 3, fresh instances: the same bar judged again, the same decision and price, nobody mailed twice
    for (const m of [1, 3]) {
      const s = await fresh(at(I_SELL, m));
      expect(judged(s), `minute ${m}`).toMatchObject({ newest: iso(times[I_SELL]), signals: ["macdx:SELL"], fade: { fresh: true, entry: "SELL", price: bid(closes[I_SELL]) } });
      expect(s.sent ?? 0).toBe(0);
    }
    expect(world.sent).toHaveLength(3);
    expect(world.alerts).toHaveLength(3);
    // minutes 2, 4 and 10: the 15-minute chart is not read
    for (const m of [2, 4, 10]) expect(readOf(await fresh(at(I_SELL, m))), `minute ${m}`).toBeUndefined();
    // the price came from the 15-minute read: GMO's 15-minute files were read, never its 1-hour ones (the 1-hour reads,
    // hourQuotes, are the sharp rise's; nobody follows a 1-hour chart here)
    expect(world.gmoCalls).toBeGreaterThan(0);
    expect([...world.klineFiles.values()].map((r) => r.interval).filter((v, k, a) => a.indexOf(v) === k)).toEqual(["15min"]);
    clean();
  });

  it("a BUY: the ask close of the bar; the mail and the row say it", async () => {
    world.subs = [follow("userA"), follow("userC", "en")];
    const s0 = await fresh(at(I_BUY, 0));
    expect(judged(s0)).toMatchObject({ signals: ["macdx:BUY"], fade: { fresh: true, entry: "BUY", price: ask(closes[I_BUY]) } });
    expect(world.sent.map((m) => m.text)).toEqual([textJa(pairSig(I_BUY), "ドル/円", 3, 3), textEn(pairSig(I_BUY), 3, 3)]);
    expect(alertsOf(V12).map((r) => [r.side, r.entry, r.stop, r.target, r.interval])).toEqual([
      ["BUY", ask(closes[I_BUY]), null, null, "15min"],
      ["BUY", ask(closes[I_BUY]), null, null, "15min"],
    ]);
    clean();
  });

  it("a close with no entry: nothing mailed, the record says so (fresh, no entry, no price)", async () => {
    world.subs = [follow("userA")];
    expect(entryAt(I_SELL + 1)).toBeNull();
    const s0 = await fresh(at(I_SELL + 1, 0));
    expect(judged(s0)).toMatchObject({ newest: iso(times[I_SELL + 1]), signals: [], fade: { fresh: true, entry: null, price: null } });
    expect(world.sent).toEqual([]);
    expect(world.alerts).toEqual([]);
    clean();
  });

  it("a follower whose address lookup failed gets no row and is mailed when the bar is judged again (minute 3, a fresh instance); the failure alone does not unsettle the bar on a warm instance", async () => {
    world.subs = [follow("userA"), follow("userB")];
    world.failAuthFor.set("userB", 503);
    const h = await instance();
    const s0 = await sweep(h, at(I_BUY, 0));
    expect(judged(s0)).toMatchObject({ signals: ["macdx:BUY"], fade: { fresh: true, entry: "BUY", unsent: ["lookup_failed"] } });
    expect(s0).toMatchObject({ sent: 1, lookup_failed: 1 });
    expect(mails()).toEqual([`userA: ${subjectJa("ドル/円", "BUY")}`]);
    expect(alertsOf(V12).map((r) => r.user_id)).toEqual(["userA"]);
    world.failAuthFor.delete("userB");
    // the same instance at minute 1: the bar is held judged (a lookup that failed does not unsettle it)
    const w1 = await sweep(h, at(I_BUY, 1));
    expect(readOf(w1)).toMatchObject({ skipped: "judged" });
    expect(world.sent).toHaveLength(1);
    // a fresh instance at minute 3 judges it again: the follower is mailed, the same mail
    const s5 = await fresh(at(I_BUY, 3));
    expect(judged(s5)).toMatchObject({ signals: ["macdx:BUY"], fade: { fresh: true, entry: "BUY" } });
    expect(judged(s5)!.fade).not.toHaveProperty("unsent");
    expect(s5).not.toHaveProperty("lookup_failed");
    expect(mails()).toEqual([`userA: ${subjectJa("ドル/円", "BUY")}`, `userB: ${subjectJa("ドル/円", "BUY")}`]);
    expect(world.sent[1].text).toBe(world.sent[0].text);
    expect(alertsOf(V12).map((r) => r.user_id)).toEqual(["userA", "userB"]);
    clean();
  });

  it("one side a bar: a row of the other side at the bar under the fade's id — nothing mailed, the record says other_side, and the bar stays judged", async () => {
    world.subs = [follow("userA")];
    // a SELL row at the BUY bar (as a feed that changed the closed bars between two judgings could leave)
    world.alerts.push({
      id: "alert-planted", user_id: "userZ", kind: "signal", pair: "USD/JPY", interval: "15min", bar_time: iso(times[I_BUY]), closed_at: iso(times[I_BUY] + STEP),
      side: "SELL", entry: 150, stop: null, target: null, rule: V12, status: "sent",
    });
    const h = await instance();
    const s0 = await sweep(h, at(I_BUY, 0));
    expect(judged(s0)).toMatchObject({ signals: [], fade: { fresh: true, entry: "BUY", price: ask(closes[I_BUY]), other_side: true } });
    expect(judged(s0)!.fade).not.toHaveProperty("error");
    expect(world.sent).toEqual([]);
    expect(world.alerts).toHaveLength(1);
    // (nobody was looked up)
    expect(world.requests.filter((r) => r === "GET profiles")).toEqual([]);
    // held judged: the same instance does not judge it again at minute 1
    const s3 = await sweep(h, at(I_BUY, 1));
    expect(readOf(s3)).toMatchObject({ skipped: "judged" });
    // a row of another rule's id at the bar (v31's 15-minute zone email, v7) is not the other side
    resetWorld();
    world.subs = [follow("userA")];
    world.alerts.push({ id: "alert-other", user_id: "userZ", kind: "signal", pair: "USD/JPY", interval: "15min", bar_time: iso(times[I_BUY]), side: "SELL", rule: "macdx_12_26_9_w600_15min_z95of120_v7", status: "sent" });
    const t0 = await fresh(at(I_BUY, 0));
    expect(judged(t0)).toMatchObject({ signals: ["macdx:BUY"], fade: { fresh: true, entry: "BUY" } });
    expect(judged(t0)!.fade).not.toHaveProperty("other_side");
    expect(mails()).toEqual([`userA: ${subjectJa("ドル/円", "BUY")}`]);
    clean();
  });

  it("one side a bar holds when the bar's rows cannot be read: nothing mailed, an error, the bar left unsettled; read again at the next read, other_side", async () => {
    world.subs = [follow("userA")];
    // a SELL row at the BUY bar, and signal_alerts answering its read with a 503 (its inserts would still work)
    world.alerts.push({
      id: "alert-planted", user_id: "userZ", kind: "signal", pair: "USD/JPY", interval: "15min", bar_time: iso(times[I_BUY]), closed_at: iso(times[I_BUY] + STEP),
      side: "SELL", entry: 150, stop: null, target: null, rule: V12, status: "sent",
    });
    world.failAlertsRead = true;
    const h = await instance();
    const s0 = await sweep(h, at(I_BUY, 0));
    // (an unread table is not "no row of either side": the read throws before anything is mailed or claimed)
    expect(judged(s0)).toMatchObject({ signals: [], fade: { fresh: true, entry: "BUY", price: ask(closes[I_BUY]), error: "failed" } });
    expect(judged(s0)!.fade).not.toHaveProperty("other_side");
    expect(world.sent).toEqual([]);
    expect(world.alerts.map((r) => r.side)).toEqual(["SELL"]);
    expect(world.requests.filter((r) => r === "GET profiles" || r === "POST signal_alerts")).toEqual([]);
    // minute 1, the same instance, the table read again: the bar was left unsettled, so it is judged again, and the row
    // of the other side is seen: nothing mailed, other_side, no error, and the bar held judged from then on
    world.failAlertsRead = false;
    const s3 = await sweep(h, at(I_BUY, 1));
    expect(judged(s3)).toMatchObject({ newest: iso(times[I_BUY]), signals: [], fade: { fresh: true, entry: "BUY", other_side: true } });
    expect(judged(s3)!.fade).not.toHaveProperty("error");
    expect(world.sent).toEqual([]);
    const s5 = await sweep(h, at(I_BUY, 3));
    expect(readOf(s5)).toMatchObject({ skipped: "judged" });
    expect(world.alerts.map((r) => r.side)).toEqual(["SELL"]);
    // with no row of the other side: the unread table at minute 0 mails nothing; minute 1 mails the follower once
    resetWorld();
    world.subs = [follow("userA")];
    world.failAlertsRead = true;
    const g = await instance();
    const t0 = await sweep(g, at(I_BUY, 0));
    expect(judged(t0)).toMatchObject({ signals: [], fade: { fresh: true, entry: "BUY", error: "failed" } });
    expect(world.sent).toEqual([]);
    expect(world.alerts).toEqual([]);
    world.failAlertsRead = false;
    const t3 = await sweep(g, at(I_BUY, 1));
    expect(judged(t3)).toMatchObject({ signals: ["macdx:BUY"], fade: { fresh: true, entry: "BUY", price: ask(closes[I_BUY]) } });
    expect(judged(t3)!.fade).not.toHaveProperty("error");
    expect(mails()).toEqual([`userA: ${subjectJa("ドル/円", "BUY")}`]);
    expect(alertsOf(V12).map((r) => [r.user_id, r.side])).toEqual([["userA", "BUY"]]);
    clean();
  });

  it("not fresh at 21 minutes: nothing (fade.fresh false); fresh at 19 minutes: mailed (freshFor('15min') is 20 minutes)", async () => {
    expect(freshFor("15min")).toBe(20 * MIN);
    world.subs = [follow("userA")];
    // A run never judges a pair's 15-minute close more than about 3 minutes after it (GMO's chart is judged at minutes 0,
    // 1 and 3 only; gold is on its 1-hour chart, judged from a minute after the close to :29, twelveCloseDue and
    // freshFor('1h')), so the window is moved instead: freshFor as index.ts
    // takes it gives `less` minutes less, so a judging a second after the close is held against the window as one
    // `less` minutes after it
    const withWindowLess = async (less: number) => {
      vi.doMock(INDICATORS, async (importOriginal) => {
        const real = await importOriginal<Record<string, unknown>>();
        const realFresh = real.freshFor as (iv: string) => number;
        return { ...real, freshFor: (iv: string) => (iv === "15min" ? realFresh(iv) - less * MIN : realFresh(iv)) };
      });
      try {
        return await fresh(at(I_SELL, 0));
      } finally {
        vi.doUnmock(INDICATORS);
      }
    };
    // 21 minutes: not fresh
    const s21 = await withWindowLess(21);
    expect(judged(s21)).toMatchObject({ signals: [], fade: { fresh: false, entry: null, price: null } });
    expect(world.sent).toEqual([]);
    expect(world.alerts).toEqual([]);
    // 19 minutes: fresh, mailed
    const s19 = await withWindowLess(19);
    expect(judged(s19)).toMatchObject({ signals: ["macdx:SELL"], fade: { fresh: true, entry: "SELL", price: bid(closes[I_SELL]) } });
    expect(world.sent).toHaveLength(1);
    // the window as it is: the same close is fresh, and nobody is mailed twice
    const s3 = await fresh(at(I_SELL, 3));
    expect(judged(s3)).toMatchObject({ signals: ["macdx:SELL"], fade: { fresh: true } });
    expect(world.sent).toHaveLength(1);
    clean();
  });

  it("no price: nothing mailed, no_price, and the bar left unsettled, so the same instance judges it again at the next read and mails it", async () => {
    // GMO's bars come with both sides or not at all (parseKlines, mergeSides), so the bar's quote cannot go missing in
    // a read; the price is made to fail instead, until it is let through
    let broken = true;
    vi.doMock(INDICATORS, async (importOriginal) => {
      const real = await importOriginal<Record<string, unknown>>();
      const paid = real.ridePaidAt as (side: "BUY" | "SELL", q: QuoteCandle) => number;
      return { ...real, ridePaidAt: (side: "BUY" | "SELL", q: QuoteCandle) => (broken ? Number.NaN : paid(side, q)) };
    });
    try {
      world.subs = [follow("userA")];
      const h = await instance();
      const s0 = await sweep(h, at(I_SELL, 0));
      expect(judged(s0)).toMatchObject({ signals: [], fade: { fresh: true, entry: "SELL", price: null, error: "no_price" } });
      expect(world.sent).toEqual([]);
      expect(world.alerts).toEqual([]);
      broken = false;
      // minute 1, the same instance: not held judged, so read and judged again
      const s3 = await sweep(h, at(I_SELL, 1));
      expect(judged(s3)).toMatchObject({ newest: iso(times[I_SELL]), signals: ["macdx:SELL"], fade: { fresh: true, entry: "SELL", price: bid(closes[I_SELL]) } });
      expect(judged(s3)!.fade).not.toHaveProperty("error");
      expect(mails()).toEqual([`userA: ${subjectJa("ドル/円", "SELL")}`]);
      // settled now: minute 3 skips it
      const s5 = await sweep(h, at(I_SELL, 3));
      expect(readOf(s5)).toMatchObject({ skipped: "judged" });
      expect(world.sent).toHaveLength(1);
    } finally {
      vi.doUnmock(INDICATORS);
    }
    clean();
  });

  it("nobody follows the chart under 'macdx' (another rule on the same chart): nothing of the fade is done or said", async () => {
    world.subs = [{ user_id: "userA", pair: "USD/JPY", interval: "15min", lang: "ja", rule: "ultra" }];
    const s0 = await fresh(at(I_SELL, 0));
    const r = readOf(s0)!;
    expect(r).toMatchObject({ pair: "USD/JPY", interval: "15min", newest: iso(times[I_SELL]) });
    expect(r).not.toHaveProperty("fade");
    expect((r.signals ?? []).filter((x) => x.startsWith("macdx"))).toEqual([]);
    expect(alertsOf(V12)).toEqual([]);
    clean();
  });

  it("a '15min' follower is mailed while a '1h' follower of the same pair (v40's row, left until spec 3.6's later delete) is not: v41 reads USD/JPY's 'macdx' on its 15-minute chart only", async () => {
    world.subs = [follow("userA"), follow("userB", "ja", "USD/JPY", "1h")];
    const s0 = await fresh(at(I_SELL, 0));
    expect(s0.subscriptions).toBe(1);
    expect(judged(s0)).toMatchObject({ signals: ["macdx:SELL"], fade: { fresh: true, entry: "SELL" } });
    expect(mails()).toEqual([`userA: ${subjectJa("ドル/円", "SELL")}`]);
    expect(alertsOf(V12).map((r) => [r.user_id, r.interval])).toEqual([["userA", "15min"]]);
    // the '1h' row alone: nobody is read as a follower, nothing is read or mailed
    resetWorld();
    world.subs = [follow("userB", "ja", "USD/JPY", "1h")];
    const t0 = await fresh(at(I_SELL, 0));
    expect(t0.subscriptions).toBe(0);
    expect(world.gmoCalls).toBe(0);
    expect(world.sent).toEqual([]);
    clean();
  });

  // ---- the 1-hour pairs (EUR/JPY, AUD/JPY, EUR/USD): v40's chart, reads, freshness and id, the price from the read of
  // the pair's own chart (fadeQuotes under `EUR/JPY|1h`)

  it("a 1-hour pair's close (EUR/JPY) judged at minutes 0, 3 and 5 by fresh instances under v40's v11 id on '1h': one email a follower, the bar's 1-hour bid close; minutes 1, 2 and 4 read nothing", async () => {
    world.subs = [follow("userA", "ja", "EUR/JPY", "1h"), follow("userC", "en", "EUR/JPY", "1h")];
    const s0 = await fresh(at(I_SELL, 0, "1h"));
    const want = pairSig(I_SELL, "EUR/JPY");
    expect(want.interval).toBe("1h");
    expect(judged(s0, "EUR/JPY", "1h")).toMatchObject({
      pair: "EUR/JPY", interval: "1h", bars: 600, newest: iso(htimes[I_SELL]), signals: ["macdx:SELL"],
      fade: { fresh: true, entry: "SELL", price: bid(closes[I_SELL]) },
    });
    expect(mails()).toEqual([`userA: ${subjectJa("ユーロ/円", "SELL", "1h")}`, `userC: ${subjectEn("EUR/JPY", "SELL", "1h")}`]);
    expect(world.sent[0].text).toBe(textJa(want, "ユーロ/円", 3, 3));
    expect(world.sent[1].text).toBe(textEn(want, 3, 3));
    // the rows: the bar's open and close (the open plus an hour), '1h', v40's id
    expect(alertsOf(V11)).toHaveLength(2);
    expect(alertsOf(V12)).toEqual([]);
    for (const r of alertsOf(V11)) {
      expect(r).toMatchObject({
        kind: "signal", pair: "EUR/JPY", interval: "1h", bar_time: iso(htimes[I_SELL]), closed_at: iso(htimes[I_SELL] + H), side: "SELL",
        entry: bid(closes[I_SELL]), stop: null, target: null, rule: V11, status: "sent",
      });
    }
    for (const m of [3, 5]) {
      const s = await fresh(at(I_SELL, m, "1h"));
      expect(judged(s, "EUR/JPY", "1h"), `minute ${m}`).toMatchObject({ newest: iso(htimes[I_SELL]), signals: ["macdx:SELL"], fade: { fresh: true, entry: "SELL", price: bid(closes[I_SELL]) } });
      expect(s.sent ?? 0).toBe(0);
    }
    expect(world.sent).toHaveLength(2);
    for (const m of [1, 2, 4]) expect(readOf(await fresh(at(I_SELL, m, "1h")), "EUR/JPY", "1h"), `minute ${m}`).toBeUndefined();
    // GMO's 1-hour files were read, never its 15-minute ones (nobody follows EUR/JPY's 15-minute chart here)
    expect([...world.klineFiles.values()].map((r) => r.interval).filter((v, k, a) => a.indexOf(v) === k)).toEqual(["1hour"]);
    clean();
  });

  it("a 1-hour pair: fresh at 29 minutes, not at 31 (freshFor('1h') is 30 minutes)", async () => {
    expect(freshFor("1h")).toBe(30 * MIN);
    world.subs = [follow("userA", "ja", "EUR/JPY", "1h")];
    // as the 15-minute pairs' freshness test: the window moved by `less` minutes, the judging a second after the close
    const withWindowLess = async (less: number) => {
      vi.doMock(INDICATORS, async (importOriginal) => {
        const real = await importOriginal<Record<string, unknown>>();
        const realFresh = real.freshFor as (iv: string) => number;
        return { ...real, freshFor: (iv: string) => (iv === "1h" ? realFresh(iv) - less * MIN : realFresh(iv)) };
      });
      try {
        return await fresh(at(I_SELL, 0, "1h"));
      } finally {
        vi.doUnmock(INDICATORS);
      }
    };
    const s31 = await withWindowLess(31);
    expect(judged(s31, "EUR/JPY", "1h")).toMatchObject({ signals: [], fade: { fresh: false, entry: null, price: null } });
    expect(world.sent).toEqual([]);
    const s29 = await withWindowLess(29);
    expect(judged(s29, "EUR/JPY", "1h")).toMatchObject({ signals: ["macdx:SELL"], fade: { fresh: true, entry: "SELL", price: bid(closes[I_SELL]) } });
    expect(world.sent).toHaveLength(1);
    clean();
  });

  it("a 15-minute read of EUR/JPY (followed under another rule, 'emarm') neither judges the fade nor prices it: its record has no fade, and the 1-hour chart's judging takes the 1-hour bar's price", async () => {
    expect(isMacdhChart("EUR/JPY", "15min")).toBe(false);
    // the 1-hour bar judged here lies inside the 15-minute grid (2026-07-01 to 2026-08-07 06:45 UTC), so GMO's
    // 15-minute file at its close holds 600 closed bars and the 15-minute read gets as far as the judging (I_SELL's
    // 1-hour bar, 2026-08-21, is past that grid: a 15-minute read there is "unavailable" and would show nothing). It is
    // the one 1-hour entry inside that grid: EUR/JPY's bar opened 2026-08-07 05:00 UTC (a Friday), a BUY at the pane's
    // bottom, the next bar an hour on
    const j = 648;
    expect(iso(htimes[j])).toBe("2026-08-07T05:00:00.000Z");
    expect(entryAt(j)).toMatchObject({ zside: "bottom", side: "BUY" });
    expect(htimes[j + 1] - htimes[j]).toBe(H);
    const k15 = indexOf["15min"].get(htimes[j]);
    expect(k15).toBeDefined();
    expect(times[k15! + 4]).toBe(htimes[j] + H);
    world.subs = [follow("userE", "ja", "EUR/JPY", "15min", "emarm"), follow("userA", "ja", "EUR/JPY", "1h")];
    // on the hour both charts are read: the 15-minute read is a real read (600 closed bars, the newest the quarter
    // closing on the hour) and no fade chart; the 1-hour one is
    const s0 = await fresh(at(j, 0, "1h"));
    const q = readOf(s0, "EUR/JPY", "15min")!;
    expect(q).toMatchObject({ pair: "EUR/JPY", interval: "15min", bars: 600, newest: iso(times[k15! + 3]) });
    expect(q).not.toHaveProperty("error");
    expect(q).not.toHaveProperty("fade");
    expect(judged(s0, "EUR/JPY", "1h")).toMatchObject({ bars: 600, newest: iso(htimes[j]), signals: ["macdx:BUY"], fade: { fresh: true, entry: "BUY", price: ask(closes[j]) } });
    // (the 15-minute bars opened at the 1-hour bar's open and in its last quarter have other closes on this grid: had
    // the 15-minute read priced the fade, the price would differ)
    expect(ask(closes[k15!])).not.toBe(ask(closes[j]));
    expect(ask(closes[k15! + 3])).not.toBe(ask(closes[j]));
    expect(world.sent.filter((m) => m.subject.includes("MACD の逆張り")).map((m) => m.to.split("@")[0])).toEqual(["userA"]);
    expect(alertsOf(V11).map((r) => [r.user_id, r.interval, r.entry])).toEqual([["userA", "1h", ask(closes[j])]]);
    // a quarter past the hour: only the 15-minute chart is due, read whole; nothing of the fade
    resetWorld();
    world.subs = [follow("userE", "ja", "EUR/JPY", "15min", "emarm"), follow("userA", "ja", "EUR/JPY", "1h")];
    const s15 = await fresh(htimes[j] + H + 15 * MIN + 1_000);
    expect((s15.reads ?? []).filter((r) => r.pair === "EUR/JPY").map((r) => r.interval)).toEqual(["15min"]);
    const q15 = readOf(s15, "EUR/JPY", "15min")!;
    expect(q15).toMatchObject({ bars: 600, newest: iso(times[k15! + 4]) });
    expect(q15).not.toHaveProperty("error");
    expect((s15.reads ?? []).some((r) => typeof r.fade === "object")).toBe(false);
    expect(alertsOf(V11)).toEqual([]);
    clean();
  });

  it("a v40 row of the same 1-hour bar under the v11 id (as at the switch, spec 2.5): its follower is not mailed again; a follower with no row is", async () => {
    world.subs = [follow("userA", "ja", "EUR/JPY", "1h"), follow("userB", "ja", "EUR/JPY", "1h")];
    world.alerts.push({
      id: "alert-v40", user_id: "userA", kind: "signal", pair: "EUR/JPY", interval: "1h", bar_time: iso(htimes[I_SELL]), closed_at: iso(htimes[I_SELL] + H),
      side: "SELL", entry: bid(closes[I_SELL]), stop: null, target: null, rule: V11, status: "sent",
    });
    const s0 = await fresh(at(I_SELL, 0, "1h"));
    expect(judged(s0, "EUR/JPY", "1h")).toMatchObject({ signals: ["macdx:SELL"], fade: { fresh: true, entry: "SELL" } });
    expect(mails()).toEqual([`userB: ${subjectJa("ユーロ/円", "SELL", "1h")}`]);
    expect(alertsOf(V11).map((r) => r.user_id).sort()).toEqual(["userA", "userB"]);
    // judged again at minute 3 by a fresh instance: nobody mailed twice
    await fresh(at(I_SELL, 3, "1h"));
    expect(world.sent).toHaveLength(1);
    clean();
  });

  it("a 1-hour pair's follower whose address lookup failed is mailed at the next judging (minute 3 or 5, a fresh instance); a row of the other side: nothing, other_side", async () => {
    world.subs = [follow("userA", "ja", "EUR/JPY", "1h"), follow("userB", "ja", "EUR/JPY", "1h")];
    world.failAuthFor.set("userB", 503);
    const h = await instance();
    const s0 = await sweep(h, at(I_BUY, 0, "1h"));
    expect(judged(s0, "EUR/JPY", "1h")).toMatchObject({ signals: ["macdx:BUY"], fade: { fresh: true, entry: "BUY", price: ask(closes[I_BUY]), unsent: ["lookup_failed"] } });
    expect(mails()).toEqual([`userA: ${subjectJa("ユーロ/円", "BUY", "1h")}`]);
    world.failAuthFor.delete("userB");
    // the same instance at minute 3: held judged
    expect(readOf(await sweep(h, at(I_BUY, 3, "1h")), "EUR/JPY", "1h")).toMatchObject({ skipped: "judged" });
    const s5 = await fresh(at(I_BUY, 5, "1h"));
    expect(judged(s5, "EUR/JPY", "1h")).toMatchObject({ signals: ["macdx:BUY"], fade: { fresh: true, entry: "BUY" } });
    expect(mails()).toEqual([`userA: ${subjectJa("ユーロ/円", "BUY", "1h")}`, `userB: ${subjectJa("ユーロ/円", "BUY", "1h")}`]);
    // a row of the other side at the bar under v11: nothing mailed, other_side
    resetWorld();
    world.subs = [follow("userA", "ja", "EUR/JPY", "1h")];
    world.alerts.push({ id: "alert-planted", user_id: "userZ", kind: "signal", pair: "EUR/JPY", interval: "1h", bar_time: iso(htimes[I_BUY]), side: "SELL", rule: V11, status: "sent" });
    const t0 = await fresh(at(I_BUY, 0, "1h"));
    expect(judged(t0, "EUR/JPY", "1h")).toMatchObject({ signals: [], fade: { fresh: true, entry: "BUY", other_side: true } });
    expect(world.sent).toEqual([]);
    clean();
  });

  it("per pair, the followers: an EUR/JPY '1h' follower is mailed and an EUR/JPY '15min' row is not (dropped by the run's filter)", async () => {
    world.subs = [follow("userA", "ja", "EUR/JPY", "1h"), follow("userB", "ja", "EUR/JPY", "15min")];
    const s0 = await fresh(at(I_SELL, 0, "1h"));
    expect(s0.subscriptions).toBe(1);
    expect(mails()).toEqual([`userA: ${subjectJa("ユーロ/円", "SELL", "1h")}`]);
    expect(alertsOf(V11).map((r) => [r.user_id, r.interval])).toEqual([["userA", "1h"]]);
    expect(world.alerts.filter((r) => r.interval === "15min")).toEqual([]);
    clean();
  });

  // ---- gold: v40's chart, reads and id (Twelve Data's stored 1-hour bars, from a minute after the close to :29)

  describe("gold: Twelve Data's 1-hour bars (stored, else read), judged from a minute after the close to :29, under v40's v11 id", () => {
    const goldFollow = (user: string, lang = "ja") => ({ user_id: user, pair: "XAU/USD", interval: "1h", lang, rule: "macdx" });
    const goldRead = (s: Summary) => (s.reads ?? []).find((r) => r.pair === "XAU/USD" && r.twelve === true);

    it("a minute after the close: the bar's close as the price, one email a follower; judged again each minute to :29 by fresh instances (a follower whose lookup failed is mailed then); not before, and not after", async () => {
      const e = gEntryAt(G_SELL)!;
      const close = htimes[G_SELL] + H;
      world.subs = [goldFollow("userA"), goldFollow("userB"), goldFollow("userC", "en")];
      world.failAuthFor.set("userB", 503);
      world.gold = goldStored(G_SELL, close + 61_000);
      // minute 0: Twelve Data's bar is not looked for before a minute past the close
      const s0 = await fresh(close + 1_000);
      expect(goldRead(s0)).toBeUndefined();
      expect(world.sent).toEqual([]);
      // minute 1: the stored read holds the closed bar
      const s1 = await fresh(close + MIN + 2_000);
      const j1 = goldRead(s1)!;
      expect(j1).toMatchObject({ interval: "1h", newest: iso(htimes[G_SELL]), fetched_at: iso(close + 61_000), close: gcloses[G_SELL], fade: { fresh: true, entry: e.side, price: gcloses[G_SELL], unsent: ["lookup_failed"] } });
      expect(j1.signals!.filter((x) => x.startsWith("macdx"))).toEqual(["macdx:SELL"]);
      expect(mails()).toEqual([`userA: ${subjectJa("金", "SELL", "1h")}`, `userC: ${subjectEn("XAU/USD", "SELL", "1h")}`]);
      expect(world.sent[0].text).toBe(textJa(goldSig(G_SELL), "金", 2, 2));
      expect(world.sent[1].text).toBe(textEn(goldSig(G_SELL), 2, 2));
      for (const r of alertsOf(V11)) {
        expect(r).toMatchObject({
          pair: "XAU/USD", interval: "1h", bar_time: iso(htimes[G_SELL]), closed_at: iso(close), side: "SELL", entry: gcloses[G_SELL], stop: null, target: null, rule: V11,
        });
      }
      expect(alertsOf(V12)).toEqual([]);
      // minute 2, the lookup working: judged again, the follower left is mailed, the same mail
      world.failAuthFor.delete("userB");
      const s2 = await fresh(close + 2 * MIN + 2_000);
      expect(goldRead(s2)).toMatchObject({ newest: iso(htimes[G_SELL]), fade: { fresh: true, entry: "SELL" } });
      expect(goldRead(s2)!.fade).not.toHaveProperty("unsent");
      expect(mails()).toEqual([`userA: ${subjectJa("金", "SELL", "1h")}`, `userC: ${subjectEn("XAU/USD", "SELL", "1h")}`, `userB: ${subjectJa("金", "SELL", "1h")}`]);
      expect(world.sent[2].text).toBe(world.sent[0].text);
      // minutes 10 and 29: judged again, nothing new
      for (const m of [10, 29]) {
        const s = await fresh(close + m * MIN + 2_000);
        expect(goldRead(s), `minute ${m}`).toMatchObject({ newest: iso(htimes[G_SELL]), signals: expect.arrayContaining(["macdx:SELL"]), fade: { fresh: true } });
      }
      expect(world.sent).toHaveLength(3);
      expect(alertsOf(V11)).toHaveLength(3);
      // minute 31: no longer looked at (past freshFor("1h"))
      const s31 = await fresh(close + 31 * MIN + 2_000);
      expect(goldRead(s31)).toBeUndefined();
      expect(world.sent).toHaveLength(3);
      // nothing was read from Twelve Data: the stored bars had the bar
      expect(world.twelveCalls).toBe(0);
      clean();
    });

    it("a BUY on gold: the close, in gold's digits", async () => {
      const close = htimes[G_BUY] + H;
      world.subs = [goldFollow("userA")];
      world.gold = goldStored(G_BUY, close + 61_000);
      const s1 = await fresh(close + MIN + 2_000);
      expect(goldRead(s1)).toMatchObject({ fade: { fresh: true, entry: "BUY", price: gcloses[G_BUY] } });
      expect(world.sent.map((m) => m.subject)).toEqual([subjectJa("金", "BUY", "1h")]);
      expect(world.sent[0].text).toBe(textJa(goldSig(G_BUY), "金", 2, 2));
      expect(alertsOf(V11).map((r) => [r.side, r.entry, r.stop, r.target, r.interval])).toEqual([["BUY", gcloses[G_BUY], null, null, "1h"]]);
      clean();
    });

    it("the stored bars lack the bar: Twelve Data is read at most twice a close (a minute after it, and once more from about four minutes after it), each read counted for the day; a bar it never gives is not sent", async () => {
      const close = htimes[G_SELL] + H;
      world.subs = [goldFollow("userA")];
      world.twelveKey = true;
      // stored and Twelve Data both end at the bar before
      world.gold = goldStored(G_SELL - 1, close - 30_000);
      world.twelveUpTo = G_SELL - 1;
      const notYet = (s: Summary) => (s.reads ?? []).filter((r) => r.pair === "XAU/USD").map((r) => r.skipped ?? r.error ?? "judged");
      // minute 1: read once, the bar not there
      expect(notYet(await fresh(close + MIN + 2_000))).toEqual(["not_yet"]);
      expect(world.twelveCalls).toBe(1);
      // minutes 2 and 3: not read again yet
      for (const m of [2, 3]) expect(notYet(await fresh(close + m * MIN + 2_000)), `minute ${m}`).toEqual(["not_yet"]);
      expect(world.twelveCalls).toBe(1);
      // minute 4: the second read, the bar still not there
      expect(notYet(await fresh(close + 4 * MIN + 2_000))).toEqual(["not_yet"]);
      expect(world.twelveCalls).toBe(2);
      // minutes 5 to 29: never a third read; nothing judged, nothing sent
      for (const m of [5, 14, 29]) expect(notYet(await fresh(close + m * MIN + 2_000)), `minute ${m}`).toEqual(["not_yet"]);
      expect(world.twelveCalls).toBe(2);
      expect(world.twelveCredits).toBe(2);
      expect(world.sent).toEqual([]);
      expect(world.alerts).toEqual([]);
      clean();
    });

    it("the stored bars lack the bar and Twelve Data has it at its second read: judged then, at the bar's close, and mailed once; later minutes judge it from the stored read", async () => {
      const close = htimes[G_SELL] + H;
      world.subs = [goldFollow("userA")];
      world.twelveKey = true;
      world.gold = goldStored(G_SELL - 1, close - 30_000);
      world.twelveUpTo = G_SELL - 1;
      await fresh(close + MIN + 2_000);
      expect(world.twelveCalls).toBe(1);
      expect(world.sent).toEqual([]);
      world.twelveUpTo = G_SELL;
      const s4 = await fresh(close + 4 * MIN + 2_000);
      expect(world.twelveCalls).toBe(2);
      expect(goldRead(s4)).toMatchObject({ newest: iso(htimes[G_SELL]), fetched_at: iso(close + 4 * MIN + 2_000), fade: { fresh: true, entry: "SELL", price: gcloses[G_SELL] } });
      expect(mails()).toEqual([`userA: ${subjectJa("金", "SELL", "1h")}`]);
      expect(world.sent[0].text).toBe(textJa(goldSig(G_SELL), "金", 2, 2));
      // minute 6: from the stored read, no Twelve Data read, nobody mailed twice
      const s6 = await fresh(close + 6 * MIN + 2_000);
      expect(goldRead(s6)).toMatchObject({ newest: iso(htimes[G_SELL]), fade: { fresh: true, entry: "SELL" } });
      expect(world.twelveCalls).toBe(2);
      expect(world.sent).toHaveLength(1);
      clean();
    });

    it("a '15min' gold row is not followed under 'macdx' (gold stays on its 1-hour chart): nothing read for it, nobody mailed", async () => {
      world.subs = [{ user_id: "userA", pair: "XAU/USD", interval: "15min", lang: "ja", rule: "macdx" }];
      world.gold = goldStored(G_SELL, htimes[G_SELL] + H + 61_000);
      const s1 = await fresh(htimes[G_SELL] + H + MIN + 2_000);
      expect(s1.subscriptions).toBe(0);
      expect(world.sent).toEqual([]);
      clean();
    });
  });

  // ---- the app's calls, per pair (spec 3.2 item 6, 3.6): the status's macdx.limited, set and set_many on each pair's
  // own chart only, created_at in every tick, the test mail's list

  // a call of the app (a user's Bearer token; the user is world.me) on a warm instance at `clockAt`
  const call = async (h: Handler, body: Record<string, unknown>, clockAt = Date.UTC(2026, 6, 15, 3, 7, 30)) => {
    clock = clockAt;
    const res = await h(new Request("https://fn.test/signal-alerts", { method: "POST", headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { indicator?: Record<string, Record<string, unknown>>; error?: string } };
  };

  it("the status gives 'macdx' one chart a pair as `limited` (USD/JPY and AUD/USD '15min', the other four '1h'), the columns ['15min', '1h']", async () => {
    const h = await instance();
    const r = await call(h, { action: "status" });
    expect(r.status).toBe(200);
    const m = r.body.indicator!.macdx as { pairs: string[]; intervals: string[]; limited: Record<string, string[]> };
    expect(m.pairs).toEqual(["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD", "XAU/USD"]);
    expect(m.intervals).toEqual(["15min", "1h"]);
    expect(m.limited).toEqual({ "USD/JPY": ["15min"], "EUR/JPY": ["1h"], "AUD/JPY": ["1h"], "EUR/USD": ["1h"], "AUD/USD": ["15min"], "XAU/USD": ["1h"] });
    // the same shape as the base block's per-pair `limited`
    expect(Object.values(r.body.indicator!.limited as Record<string, unknown>).every((v) => Array.isArray(v))).toBe(true);
  });

  it("set refuses EUR/JPY on '15min' and USD/JPY on '1h' (400), and takes each pair's own chart; its upsert holds created_at (the function's now) beside lang, with resolution=merge-duplicates", async () => {
    const h = await instance();
    for (const [pair, interval] of [["EUR/JPY", "15min"], ["USD/JPY", "1h"], ["AUD/USD", "1h"], ["XAU/USD", "15min"]]) {
      const r = await call(h, { action: "set", rule: "macdx", pair, interval, on: true, lang: "ja" });
      expect(r.status, `${pair} ${interval}`).toBe(400);
      expect(r.body.error).toBe("invalid_request");
    }
    expect(world.subPosts).toEqual([]);
    const at = Date.UTC(2026, 6, 15, 3, 7, 30);
    for (const [pair, interval] of [["USD/JPY", "15min"], ["EUR/JPY", "1h"]]) {
      const r = await call(h, { action: "set", rule: "macdx", pair, interval, on: true, lang: "en" }, at);
      expect(r.status, `${pair} ${interval}`).toBe(200);
    }
    expect(world.subPosts).toHaveLength(2);
    for (const p of world.subPosts) {
      expect(p.prefer).toContain("resolution=merge-duplicates");
      expect(p.url).toContain("on_conflict=user_id,pair,interval,rule");
      expect(p.body).toMatchObject({ user_id: "userM", rule: "macdx", lang: "en", created_at: iso(at) });
      expect(Object.keys(p.body as object)).toEqual(["user_id", "pair", "interval", "rule", "lang", "created_at"]);
    }
    // a tick of a row that is there (an old twin) brings its created_at to the tick's time (spec 3.6)
    world.subs = [{ user_id: "userM", pair: "USD/JPY", interval: "15min", rule: "macdx", lang: "ja", created_at: "2026-07-01T00:00:00.000Z" }];
    const later = at + 5 * MIN;
    await call(h, { action: "set", rule: "macdx", pair: "USD/JPY", interval: "15min", on: true, lang: "ja" }, later);
    expect(world.subs).toEqual([{ user_id: "userM", pair: "USD/JPY", interval: "15min", rule: "macdx", lang: "ja", created_at: iso(later) }]);
    // every rule's rows alike
    await call(h, { action: "set", rule: "ultra", pair: "USD/JPY", interval: "1h", on: true, lang: "ja" }, later);
    expect(world.subPosts[world.subPosts.length - 1].body).toMatchObject({ rule: "ultra", created_at: iso(later) });
    // an untick is a delete of that interval only, plan or not
    const off = await call(h, { action: "set", rule: "macdx", pair: "USD/JPY", interval: "15min", on: false }, later);
    expect(off.status).toBe(200);
    expect(world.subDeletes.at(-1)).toContain("interval=eq.15min");
  });

  it("set_many refuses a batch with one chart not offered, and takes the 15分 column of USD/JPY and AUD/USD and the 1時間 column of the other four; every row of its upsert holds created_at beside lang", async () => {
    const h = await instance();
    const bad = await call(h, { action: "set_many", rule: "macdx", on: true, lang: "ja", charts: [{ pair: "USD/JPY", interval: "15min" }, { pair: "EUR/JPY", interval: "15min" }] });
    expect(bad.status).toBe(400);
    const bad2 = await call(h, { action: "set_many", rule: "macdx", on: true, lang: "ja", charts: [{ pair: "EUR/JPY", interval: "1h" }, { pair: "USD/JPY", interval: "1h" }] });
    expect(bad2.status).toBe(400);
    expect(world.subPosts).toEqual([]);
    const at = Date.UTC(2026, 6, 15, 3, 9, 0);
    const q = await call(h, { action: "set_many", rule: "macdx", on: true, lang: "ja", charts: [{ pair: "USD/JPY", interval: "15min" }, { pair: "AUD/USD", interval: "15min" }] }, at);
    expect(q.status).toBe(200);
    const hr = await call(h, { action: "set_many", rule: "macdx", on: true, lang: "ja", charts: ["EUR/JPY", "AUD/JPY", "EUR/USD", "XAU/USD"].map((pair) => ({ pair, interval: "1h" })) }, at);
    expect(hr.status).toBe(200);
    expect(world.subPosts).toHaveLength(2);
    for (const p of world.subPosts) {
      expect(p.prefer).toContain("resolution=merge-duplicates");
      for (const row of p.body as Row[]) {
        expect(row).toMatchObject({ user_id: "userM", rule: "macdx", lang: "ja", created_at: iso(at) });
        expect(Object.keys(row)).toEqual(["user_id", "pair", "interval", "rule", "lang", "created_at"]);
      }
    }
    expect((world.subPosts[0].body as Row[]).map((r) => r.pair)).toEqual(["USD/JPY", "AUD/USD"]);
    expect((world.subPosts[1].body as Row[]).map((r) => [r.pair, r.interval])).toEqual([["EUR/JPY", "1h"], ["AUD/JPY", "1h"], ["EUR/USD", "1h"], ["XAU/USD", "1h"]]);
  });

  it("the test mail lists only the rows this version mails (spec 3.6): of a USD/JPY 'macdx' row on '1h' and its '15min' twin, and a share's two rows, only the '15min' ones; EUR/JPY's '1h' row and not its '15min' one; an 'rsi_sar' row, an 'emarm' row on USD/JPY '15min' and a 'spike' row on USD/JPY '1h' as before", async () => {
    world.subs = [
      { user_id: "userM", pair: "USD/JPY", interval: "1h", rule: "macdx", lang: "ja", created_at: "2026-07-01T00:00:00Z" },
      { user_id: "userM", pair: "USD/JPY", interval: "15min", rule: "macdx", lang: "ja", created_at: "2026-07-01T00:00:01Z" },
      { user_id: "userM", pair: "AAPL", interval: "1h", rule: "stockmacd", lang: "ja", created_at: "2026-07-01T00:00:02Z" },
      { user_id: "userM", pair: "AAPL", interval: "15min", rule: "stockmacd", lang: "ja", created_at: "2026-07-01T00:00:03Z" },
      { user_id: "userM", pair: "EUR/JPY", interval: "1h", rule: "macdx", lang: "ja", created_at: "2026-07-01T00:00:04Z" },
      { user_id: "userM", pair: "EUR/JPY", interval: "15min", rule: "macdx", lang: "ja", created_at: "2026-07-01T00:00:05Z" },
      { user_id: "userM", pair: "USD/JPY", interval: "1h", rule: "rsi_sar", lang: "ja", created_at: "2026-07-01T00:00:06Z" },
      { user_id: "userM", pair: "USD/JPY", interval: "15min", rule: "emarm", lang: "ja", created_at: "2026-07-01T00:00:07Z" },
      { user_id: "userM", pair: "USD/JPY", interval: "1h", rule: "spike", lang: "ja", created_at: "2026-07-01T00:00:08Z" },
    ];
    const h = await instance();
    const r = await call(h, { action: "test", lang: "ja" });
    expect(r.status).toBe(200);
    expect(world.sent).toHaveLength(1);
    const want = renderTestMail(
      [
        { pair: "USD/JPY", interval: "15min", rule: "macdx" },
        { pair: "AAPL", interval: "15min", rule: "stockmacd" },
        { pair: "EUR/JPY", interval: "1h", rule: "macdx" },
        { pair: "USD/JPY", interval: "1h", rule: "rsi_sar" },
        { pair: "USD/JPY", interval: "15min", rule: "emarm" },
        { pair: "USD/JPY", interval: "1h", rule: "spike" },
      ],
      "ja",
    );
    expect(world.sent[0].text).toBe(want.text);
    expect(world.sent[0].text).not.toContain("ドル/円 1時間足（MACD の逆張り）");
    expect(world.sent[0].text).not.toContain("ユーロ/円 15分足（MACD の逆張り）");
    expect(world.sent[0].text).not.toContain("AAPL 1時間足");
  });
});

// ---- part 3: the function's code, read as text ------------------------------------------------------------------------

describe("v41 the function's code, read as text", () => {
  const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
  const ind = readFileSync("supabase/functions/signal-alerts/indicators.ts", "utf8");
  const logic = readFileSync("supabase/functions/signal-alerts/logic.ts", "utf8");
  // the code without its comment lines (the history in the comments names v9's ride)
  const codeOf = (src: string) => src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  // the first argument of every call of `name(` in `src`, as written (to its comma or closing parenthesis at depth 0;
  // strings and template literals with their ${…} taken whole)
  const firstArgs = (src: string, name: string): string[] => {
    const out: string[] = [];
    const re = new RegExp(`(?<![\\w.])${name}\\(`, "g");
    for (let m = re.exec(src); m; m = re.exec(src)) {
      let i = m.index + m[0].length;
      let depth = 0;
      let quote: string | null = null;
      const start = i;
      for (; i < src.length; i++) {
        const c = src[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
          else if (quote === "`" && c === "$" && src[i + 1] === "{") {
            // a template's ${…}: to its closing brace
            let d = 0;
            for (i += 1; i < src.length; i++) {
              if (src[i] === "{") d++;
              else if (src[i] === "}" && --d === 0) break;
            }
          }
          continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
          if (depth === 0) break;
          depth--;
        } else if (c === "," && depth === 0) break;
      }
      out.push(src.slice(start, i).trim());
    }
    return out;
  };

  it("is v41", () => {
    expect(fn).toContain('const FUNCTION_VERSION = "signal-alerts-v41-2026-11-20";');
  });

  it("the fade is judged in its own try / catch after the other rules' mails; its price from the run's own read of the pair's own chart (fadeQuotes keyed by pair and chart, spec 3.2 item 5); unsettled only on an error; one side a bar", () => {
    expect(fn).toMatch(
      /if \(sigs\.length > 0\) await mailSignals\(sigs\);[\s\S]{0,900}try \{\s+await fadeAtClose\(pair, interval, closed, newest, said\);\s+\} catch \(err\) \{\s+console\.error\("macdx failed:", pair, interval, errText\(err\)\);/,
    );
    expect(fn).toContain("const faded = isMacdhChart(pair, interval) && fadePairs.includes(pair);");
    // the 1-hour reads stay the sharp rise's (hourQuotes); the read of each pair's own fade chart is kept apart,
    // keyed `${pair}|${interval}` (fadeQuotes), and looked up by the chart judged
    expect(fn).toContain("if (c.interval === \"1h\") hourQuotes.set(c.pair, quotes);");
    expect(fn).toContain("if (isMacdhChart(c.pair, c.interval)) fadeQuotes.set(`${c.pair}|${c.interval}`, quotes);");
    expect(fn).toContain("const fadeQuotes = new Map<string, QuoteCandle[]>();");
    expect(fn).toContain("const entry = fadeCloseEntryAt(closed.map((c) => c.close));");
    expect(fn).toContain("const quote = gold ? null : (fadeQuotes.get(`${pair}|${interval}`) ?? []).find((x) => Date.parse(x.datetime) === newest) ?? null;");
    // the one-chart lines of the first build are gone (spec 3.2 item 5)
    expect(fn).not.toContain("if (c.interval === MACDH_INTERVALS[0]) fadeQuotes.set(c.pair, quotes);");
    expect(fn).not.toContain("fadeQuotes.get(pair)");
    expect(fn).not.toContain("fadeQuotes.set(c.pair,");
    expect(fn).toContain("const price = gold ? last.close : quote ? ridePaidAt(entry.side, quote) : Number.NaN;");
    // spec 3.2 item 2: the bar's length and freshness from the chart's interval
    expect(fn).toContain("const step = LIVE_STEP_MS[interval];");
    expect(fn).toContain("const age = nowMs - (newest + step);");
    expect(fn).toContain("if (age < 0 || age > freshFor(interval)) {");
    expect(fn).toContain('const sig = fadeSignal("macdx", pair, interval, entry, { openMs: newest, closeMs: newest + step, close: last.close, price });');
    // no "1h" and no hour left in fadeAtClose (spec 7.1)
    const fade = fn.slice(fn.indexOf("const fadeAtClose = async ("), fn.indexOf("const judge = async ("));
    expect(fade.length).toBeGreaterThan(500);
    expect(codeOf(fade)).not.toContain('"1h"');
    expect(codeOf(fade)).not.toMatch(/\bHOUR\b/);
    expect(codeOf(fade)).not.toContain("hourQuotes");
    expect(fn).toContain("if (said.fade.error !== undefined) judgedBar.delete(`${pair}|${interval}`);");
    expect(fn).toContain("...signalRow(sig),");
    // one side a bar: mailRide's read has no side filter
    expect(fn).toContain("&bar_time=eq.${e(row.bar_time)}&rule=eq.${e(row.rule)}&select=user_id,side`");
    expect(fn.includes("&side=eq.${row.side}&rule=eq.${e(row.rule)}&select=user_id`")).toBe(false);
    // the charts the app is told of: the columns (MACDH_INTERVALS) and each pair's one chart as `limited` (spec 3.2
    // item 6); the subscriptions read are v39's
    expect(fn).toContain("macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS, limited: Object.fromEntries(MACDH_PAIRS.map((p) => [p, [MACDH_INTERVAL_OF[p]]])) },");
    expect(fn).not.toContain("macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS },");
    // spec 3.6: the ticks send created_at (set and set_many, every rule), and the test mail lists the rows mailed only
    expect(fn).toContain('body: JSON.stringify({ user_id: userId, pair: body.pair, interval: body.interval, rule, lang: isLang(body.lang) ? body.lang : "ja", created_at: new Date(nowMs).toISOString() }),');
    expect(fn).toContain("body: JSON.stringify(list.map((c) => ({ user_id: userId, pair: c.pair, interval: c.interval, rule, lang, created_at: createdAt }))),");
    expect(fn).toContain(".filter((s) => !isIndicatorRule(s.rule) || isIndicatorChartFor(s.rule, s.pair, s.interval))");
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3,emarm,spike)&select=user_id,pair,interval,lang,rule")');
    // nothing of a follower is logged by the fade's catch
    for (const line of fn.split("\n").filter((l) => l.includes("console.error") && /macdx/.test(l))) expect(line, line).not.toMatch(/user_id|email|\bid\b/);
  });

  // spec 7.1: "nothing read or written each minute, no state row" held as code text: no rest( or readRows( call in
  // index.ts names macd_rides or macd_ride_state (comments may still name the tables, so the calls are read, not the
  // lines). (It holds with the shares' v9 path still in index.ts too, since that path reached the table only through
  // the helpers removed here; it is to hold once the shares' fade is in, spec 3.3)
  it("no rest( or readRows( call in index.ts names macd_rides or macd_ride_state", () => {
    const calls = [...firstArgs(fn, "rest"), ...firstArgs(fn, "readRows")];
    // the reader found the calls (the sweep's many), and reads their arguments whole
    expect(calls.length).toBeGreaterThan(20);
    expect(calls).toContain('"signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3,emarm,spike)&select=user_id,pair,interval,lang,rule"');
    expect(calls.some((c) => c.startsWith("`signal_alerts?kind=eq.signal&pair=eq.${e(sig.pair)}"))).toBe(true);
    for (const c of calls) {
      expect(c, c).not.toContain("macd_rides");
      expect(c, c).not.toContain("macd_ride_state");
    }
    // and the check can fail: v39's index.ts (origin/main's, kept in the git history) had six such calls
    const v39like = 'const res = await rest(`macd_rides?${filters}&select=${MACD_RIDE_COLUMNS}`);\nconst rows = await readRows(`macd_ride_state?pair=eq.${enc(pair)}`);';
    expect([...firstArgs(v39like, "rest"), ...firstArgs(v39like, "readRows")].filter((c) => /macd_ride/.test(c))).toHaveLength(2);
  });

  it("v9's ride is gone from the pairs' and gold's path: no ride at a close, no minute's check, no state kept", () => {
    for (const gone of [
      "rideAtClose", "rideMinute", "rideStateMemo", "RIDE_STATE_MEMO_MAX", "RIDE_STATE_KEEP_MS", "macd_ride_state", "rideStateOf", "rideStateFrom",
      "rideTouch", "rideCatchUp", "rideEntryAt", "rideCloseStep", "rideFormingOf", "goldHourExtremes", "RIDE_OUT_FRESH_MS", "rideLeaveAt", "ridePairs", "rideSubs",
      "const readRides", "const rideKey", "const rideNow", "const openRide", "const reachRide", "const rideMailThere", "macd-ride.ts", "MACD_RIDE_COLUMNS", "macdRideOf",
    ]) {
      expect(codeOf(fn).includes(gone), gone).toBe(false);
    }
    for (const gone of [
      "RideFacts", "rideCloseSignal", "rideOutSignal", "MACD_RIDE_COLUMNS", "macdRideOf", "rideRowOf", "rideLeaveAt", "rideFormingOf", "goldHourExtremes",
      "RIDE_OUT_FRESH_MS", "ridePnl", "RIDE_MEASURED", "rideMeasuredLine", "renderRideMail", "rideRuleIdOf", "MACDH_AT_RULE_ID", "MACDH_OUT_RULE_ID", "MACDH_RIDE_VERSION",
      "export interface MacdRide", "macd-ride.ts", "rideHeldText", "ride?:", "s.ride",
    ]) {
      expect(codeOf(ind).includes(gone), gone).toBe(false);
    }
    // logic.ts's rideHeldText (v9's email 2's) goes with the ride (spec 3.5): no file of the function defines or calls it
    expect(codeOf(ind).includes("rideHeldText") || codeOf(fn).includes("rideHeldText") || codeOf(logic).includes("rideHeldText")).toBe(false);
    // the fade's signal takes no stop or target from ULTRA's
    const body = ind.slice(ind.indexOf("export const fadeSignal = ("), ind.indexOf("export const signalRow = ("));
    expect(body).not.toContain("ultraLevels");
    expect(body).toMatch(/sl: null,\n\s+tps: null,/);
    // v41 (spec 3.2 items 1 and 3): the ids per chart, built from the constants through macdhRuleId; the single id and
    // version of the first build are gone, and MACDH_INTERVALS is derived from the per-pair map
    expect(ind).not.toContain('export const MACDH_RULE_ID = fadeRuleId("macdx", MACDH_INTERVALS[0], MACDH_FADE_VERSION);');
    expect(ind).not.toContain('export const MACDH_INTERVALS = ["15min"] as const;');
    expect(ind).not.toContain("export const MACDH_FADE_VERSION = 12;");
    expect(ind).toContain('export const MACDH_FADE_VERSION_OF: Readonly<Record<"15min" | "1h", number>> = { "15min": 12, "1h": 11 };');
    expect(ind).toContain("export const MACDH_INTERVALS: readonly string[] = INDICATOR_INTERVALS.filter((iv) => MACDH_CHARTS.includes(iv));");
    expect(ind).toContain("const MACDH_CHARTS: readonly string[] = Object.values(MACDH_INTERVAL_OF);");
    expect(ind).toContain('return fadeRuleId("macdx", interval, MACDH_FADE_VERSION_OF[interval as keyof typeof MACDH_FADE_VERSION_OF]);');
    expect(codeOf(ind)).not.toContain("MACDH_INTERVALS[0]");
    expect(codeOf(fn)).not.toContain("MACDH_INTERVALS[0]");
  });

  it("the pairs' and gold's files import nothing of _shared/macd-ride.ts, and no file under supabase/functions does", () => {
    for (const [name, src] of [["index.ts", fn], ["indicators.ts", ind], ["logic.ts", logic]] as const) {
      expect(src.split("\n").filter((l) => /^\s*(import|export)\b.*macd-ride/.test(l) || /from "\.\.\/_shared\/macd-ride\.ts"/.test(l)), name).toEqual([]);
    }
    // spec 3.5: after the build no file under supabase/functions imports it (the shares' stocks.ts included); it stays
    // as main's v9 file for the v9 morning-check bench, v9's replay and a rollback
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = `${dir}/${f}`;
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /from "[^"]*macd-ride\.ts"/.test(readFileSync(p, "utf8"))) importers.push(p);
      }
    };
    walk("supabase/functions");
    expect(importers).toEqual([]);
  });
});
