// #291 (docs §8.112): the owner's video's way in the gold 1-minute email
// (supabase/functions/signal-alerts/indicators.ts sweepxSignals): the rule
// it is offered on, its id, when a bar is still mailed, that the email's
// decision is the chart's mark (the same function on the same bars), and
// what the email says — the measured figures it does not have among it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INDICATOR_RULES,
  MACDX_RULE_ID,
  QTREND_RULE_ID,
  SWEEPX_INTERVALS,
  SWEEPX_PAIRS,
  SWEEPX_RULE_ID,
  ULTRA_RULE_ID,
  freshFor,
  indicatorRuleId,
  isIndicatorChartFor,
  isIndicatorRule,
  isSweepxChart,
  renderIndicatorMail,
  sweepxSignals,
  type IndicatorSignal,
} from "../../supabase/functions/signal-alerts/indicators";
import { SWEEPX, sweepCrossMarks, sweepPip } from "../../supabase/functions/_shared/sweep-cross";
import { renderTestMail } from "../../supabase/functions/signal-alerts/logic";

const M1 = 60_000;
const T0 = Date.UTC(2026, 9, 12, 0, 0);
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const closeOf = (i: number) => T0 + (i + 1) * M1;

// closes along straight legs, as in src/test/sweep-cross.test.ts
const legs = (start: number, parts: Array<[number, number]>): number[] => {
  const out: number[] = [];
  let prev = start;
  for (const [to, n] of parts) {
    for (let k = 1; k <= n; k++) out.push(prev + ((to - prev) * k) / n);
    prev = to;
  }
  return out;
};
// 1-minute candles of those closes, half a dollar of wick each side, opened at the close before
const candles = (closes: number[]) =>
  closes.map((c, i) => ({ datetime: stamp(T0 + i * M1), open: i > 0 ? closes[i - 1] : c, high: c + 0.5, low: c - 0.5, close: c }));
// the video's buy (src/test/sweep-cross.test.ts videoShape): its cross bar and nothing else marked
const video = (secondLow = 1985) => candles(legs(2000, [[2000, 400], [1990, 80], [2010, 100], [secondLow, 100], [2005, 120]]));

// a seeded walk (mulberry32) of gold-like 1-minute candles, rounded as the chart's are
const walk = (n: number, seed: number) => {
  let t = seed >>> 0;
  const rnd = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  let p = 4000;
  for (let k = 0; k < n; k++) {
    const o = p;
    p = Math.round((p + (rnd() - 0.5) * 1.6) * 100) / 100;
    const high = Math.round((Math.max(o, p) + rnd() * 0.6) * 100) / 100;
    const low = Math.round((Math.min(o, p) - rnd() * 0.6) * 100) / 100;
    out.push({ datetime: stamp(T0 + k * M1), open: o, high, low, close: p });
  }
  return out;
};

describe("#291 the video's way is a rule of its own, on gold's 1-minute chart only", () => {
  it("has its own id, which the app reads the rule back from", () => {
    expect(INDICATOR_RULES).toContain("sweepx");
    expect(isIndicatorRule("sweepx")).toBe(true);
    expect(indicatorRuleId("sweepx")).toBe(SWEEPX_RULE_ID);
    expect(SWEEPX_RULE_ID).toBe("sweepx_ema20_80_w600_from240_sl5b1p_tp15_20_v1");
    expect(new Set([SWEEPX_RULE_ID, MACDX_RULE_ID, ULTRA_RULE_ID, QTREND_RULE_ID]).size).toBe(4);
    for (const other of [MACDX_RULE_ID, ULTRA_RULE_ID, QTREND_RULE_ID]) expect(other.startsWith("sweepx")).toBe(false);
  });

  it("is offered on XAU/USD 1-minute and nowhere else; the other rules are not offered there", () => {
    expect([...SWEEPX_PAIRS]).toEqual(["XAU/USD"]);
    expect([...SWEEPX_INTERVALS]).toEqual(["1min"]);
    expect(isSweepxChart("XAU/USD", "1min")).toBe(true);
    expect(isIndicatorChartFor("sweepx", "XAU/USD", "1min")).toBe(true);
    for (const [p, iv] of [["XAU/USD", "5min"], ["XAU/USD", "15min"], ["USD/JPY", "1min"], ["EUR/USD", "1min"], ["xau/usd", "1min"]]) {
      expect(isIndicatorChartFor("sweepx", p, iv)).toBe(false);
    }
    for (const rule of ["qtrend", "ultra", "macdx"]) expect(isIndicatorChartFor(rule, "XAU/USD", "1min")).toBe(false);
    expect(isIndicatorChartFor("sweepx", null, "1min")).toBe(false);
  });

  it("mails a bar while it closed at most two minutes ago", () => {
    expect(freshFor("1min")).toBe(2 * M1);
    // the others' as they were
    expect(freshFor("5min")).toBe(10 * M1);
    expect(freshFor("15min")).toBe(20 * M1);
    expect(freshFor("1h")).toBe(30 * M1);
  });
});

describe("#291 the email's decision is the chart's mark", () => {
  it("the video's buy: mailed at its close, with the chart's mark's levels", () => {
    const bars = video();
    const marks = sweepCrossMarks(bars, sweepPip("XAU/USD"), 0);
    expect(marks).toHaveLength(1);
    const m = marks[0];
    expect(m.full).toBe(true);
    const sigs = sweepxSignals("XAU/USD", "1min", bars.slice(0, m.at + 1), closeOf(m.at) + 5_000);
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    expect(s.rule).toBe("sweepx");
    expect(s.side).toBe("BUY");
    expect(s.barTime).toBe(new Date(T0 + m.at * M1).toISOString());
    expect(s.closedAt).toBe(new Date(closeOf(m.at)).toISOString());
    expect(s.close).toBe(m.entry);
    expect(s.sl).toBe(m.sl);
    expect(s.tps).toEqual(m.tps);
    expect(s.tps).toHaveLength(2);
    expect(s.strong).toBe(false);
    expect(s.sweep).toEqual({
      level: m.level,
      levelClosedAt: new Date(closeOf(m.levelAt)).toISOString(),
      extreme: m.extreme,
      extremeClosedAt: new Date(closeOf(m.extremeAt)).toISOString(),
      legFromClosedAt: new Date(closeOf(m.legFrom)).toISOString(),
      waveFromClosedAt: new Date(closeOf(m.waveFrom)).toISOString(),
      fast: m.fast,
      slow: m.slow,
    });
    // the video's levels in dollars: the stop a pip ($0.10) below the last five lows, $1.50 and $2.00 up
    expect(s.tps![0] - s.close).toBeCloseTo(1.5, 9);
    expect(s.tps![1] - s.close).toBeCloseTo(2.0, 9);
    const lows = bars.slice(m.at - 4, m.at + 1).map((b) => b.low);
    expect(s.sl!).toBeCloseTo(Math.min(...lows) - 0.1, 9);
  });

  it("the same shape without the low taken: no email", () => {
    const bars = video(1992);
    for (let i = SWEEPX.window - 1; i < bars.length; i++) {
      expect(sweepxSignals("XAU/USD", "1min", bars.slice(0, i + 1), closeOf(i) + 5_000)).toEqual([]);
    }
  });

  it("not before its close, and not past two minutes after it; a run missed is covered by the next", () => {
    const bars = video();
    const at = sweepCrossMarks(bars, sweepPip("XAU/USD"), 0)[0].at;
    const upTo = bars.slice(0, at + 1);
    expect(sweepxSignals("XAU/USD", "1min", upTo, closeOf(at) - 1)).toEqual([]);
    expect(sweepxSignals("XAU/USD", "1min", upTo, closeOf(at))).toHaveLength(1);
    expect(sweepxSignals("XAU/USD", "1min", upTo, closeOf(at) + 2 * M1)).toHaveLength(1);
    expect(sweepxSignals("XAU/USD", "1min", upTo, closeOf(at) + 2 * M1 + 1)).toEqual([]);
    // the next minute's run, with the next bar closed too: the bar is still mailed, and only it
    const next = sweepxSignals("XAU/USD", "1min", bars.slice(0, at + 2), closeOf(at + 1) + 5_000);
    expect(next).toHaveLength(1);
    expect(next[0].barTime).toBe(new Date(T0 + at * M1).toISOString());
  });

  it("on a history shorter than the window, or a chart it is not offered on, nothing", () => {
    const bars = video();
    const at = sweepCrossMarks(bars, sweepPip("XAU/USD"), 0)[0].at;
    const now = closeOf(at) + 5_000;
    expect(sweepxSignals("XAU/USD", "1min", bars.slice(at - SWEEPX.window + 1, at + 1), now)).toHaveLength(1);
    expect(sweepxSignals("XAU/USD", "1min", bars.slice(at - SWEEPX.window + 2, at + 1), now)).toEqual([]);
    expect(sweepxSignals("XAU/USD", "5min", bars.slice(0, at + 1), now)).toEqual([]);
    expect(sweepxSignals("USD/JPY", "1min", bars.slice(0, at + 1), now)).toEqual([]);
    expect(sweepxSignals("XAU/USD", "1min", [], now)).toEqual([]);
  });

  it("on seeded walks, every bar: an email exactly where the chart marks a bar judged on a full window, the same one", () => {
    let fired = 0;
    for (const seed of [11, 12, 13]) {
      const bars = walk(1800, seed);
      const marks = new Map(sweepCrossMarks(bars, 0.1, 0).filter((m) => m.full).map((m) => [m.at, m]));
      for (let i = SWEEPX.window - 1; i < bars.length; i++) {
        // the run 5 seconds after bar i closed; it looks at bar i - 1 again too
        // (still fresh), whose email the claim keeps from going out twice
        const sigs = sweepxSignals("XAU/USD", "1min", bars.slice(0, i + 1), closeOf(i) + 5_000);
        const at = (k: number) => new Date(T0 + k * M1).toISOString();
        expect(sigs.every((s) => s.barTime === at(i) || s.barTime === at(i - 1))).toBe(true);
        expect(sigs.filter((s) => s.barTime === at(i - 1)).length).toBe(i - 1 >= SWEEPX.window - 1 && marks.has(i - 1) ? 1 : 0);
        const own = sigs.filter((s) => s.barTime === at(i));
        const m = marks.get(i);
        if (!m) {
          expect(own).toEqual([]);
          continue;
        }
        fired++;
        expect(own).toHaveLength(1);
        expect(own[0].side).toBe(m.side);
        expect(own[0].close).toBe(m.entry);
        expect(own[0].sl).toBe(m.sl);
        expect(own[0].tps).toEqual(m.tps);
        expect(own[0].sweep?.level).toBe(m.level);
      }
    }
    expect(fired).toBeGreaterThan(5);
  });
});

describe("#291 what the email says", () => {
  const sample = (side: "BUY" | "SELL"): IndicatorSignal => {
    const bars = video();
    const m = sweepCrossMarks(bars, 0.1, 0)[0];
    const s = sweepxSignals("XAU/USD", "1min", bars.slice(0, m.at + 1), closeOf(m.at) + 5_000)[0];
    if (side === "BUY") return s;
    // the same numbers mirrored, for the words
    return { ...s, side: "SELL", sl: s.close + (s.close - (s.sl as number)), tps: s.tps!.map((v) => s.close - (v - s.close)) };
  };

  it("in Japanese: the rule's own name, the low taken and the cross, the video's levels, and that it is not measured", () => {
    const s = sample("BUY");
    const mail = renderIndicatorMail(s, "ja");
    expect(mail.subject).toBe("【Sextant】金 1分足 買い（BUY）のサイン（流動性狩り＋EMAクロス）");
    const t = mail.text;
    expect(t).toContain("金の1分足で、動画のやり方（流動性狩り → EMAクロス）の買い（BUY）のサインが出ました。");
    expect(t).toContain(`安値 ${s.sweep!.level.toFixed(2)}（一つ前の波の谷）`);
    expect(t).toContain(`${s.sweep!.extreme.toFixed(2)} まで下回りました（Low taken）`);
    expect(t).toContain("EMAクロス: EMA20（");
    expect(t).toContain("を下から上に抜けました");
    expect(t).toContain(`エントリー ≈ ${s.close.toFixed(2)}`);
    expect(t).toContain(`損切り ${(s.sl as number).toFixed(2)}`);
    expect(t).toContain("直近5本の安値の最安値より0.1ドル下");
    expect(t).toContain(`利確1 ${s.tps![0].toFixed(2)}（$1.50）`);
    expect(t).toContain(`利確2 ${s.tps![1].toFixed(2)}（$2.00）`);
    expect(t).not.toContain("利確3");
    expect(t).toContain("構造の崩壊（BOS）は待ちません");
    expect(t).toContain("この決まりの勝率と1回あたりの損益は、まだ測っていません。");
    expect(t).toContain("Swissquote の金の値段（約3秒ごとに記録した中値）から作った1分足（記録を始める前の分は Twelve Data の1分足）");
    expect(t).toContain("「流動性狩り＋EMAクロス」でチェックを外してください");
    // no measured figure of another rule
    expect(t).not.toMatch(/\d+\.\d%/);
    expect(t).not.toContain("ULTRA");
  });

  it("in Japanese, a sell: the high taken and the cross down", () => {
    const t = renderIndicatorMail(sample("SELL"), "ja").text;
    expect(renderIndicatorMail(sample("SELL"), "ja").subject).toBe("【Sextant】金 1分足 売り（SELL）のサイン（流動性狩り＋EMAクロス）");
    expect(t).toContain("（一つ前の波の山）");
    expect(t).toContain("まで上回りました（High taken）");
    expect(t).toContain("を上から下に抜けました");
    expect(t).toContain("直近5本の高値の最高値より0.1ドル上");
  });

  it("in English, likewise", () => {
    const s = sample("BUY");
    const mail = renderIndicatorMail(s, "en");
    expect(mail.subject).toBe("[Sextant] XAU/USD 1-minute BUY signal (liquidity sweep + EMA cross)");
    const t = mail.text;
    expect(t).toContain("Low taken: the last wave's low");
    expect(t).toContain("EMA cross: EMA 20 (");
    expect(t).toContain("crossed above EMA 80");
    expect(t).toContain("$0.10 beyond the lowest low of the last 5 bars");
    expect(t).toContain(`TP1 ${s.tps![0].toFixed(2)} ($1.50)`);
    expect(t).toContain(`TP2 ${s.tps![1].toFixed(2)} ($2.00)`);
    expect(t).not.toContain("TP3");
    expect(t).toContain("This rule's win rate and its profit or loss a trade have not been measured.");
    expect(t).toContain('untick "Liquidity sweep + EMA cross"');
    expect(t).not.toMatch(/\d+\.\d%/);
  });

  it("the test email names the rule and the 1-minute chart", () => {
    expect(renderTestMail([{ pair: "XAU/USD", interval: "1min", rule: "sweepx" }], "ja").text).toContain("金 1分足（流動性狩り＋EMAクロス）");
    expect(renderTestMail([{ pair: "XAU/USD", interval: "1min", rule: "sweepx" }], "en").text).toContain("XAU/USD 1-minute (Liquidity sweep + EMA cross)");
  });
});

describe("#291 the function judges it in the gold-ticks run only", () => {
  const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
  it("the indicators sweep never reads the rule's subscriptions (gold's 1-minute chart would be a Twelve Data read a minute)", () => {
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toContain('r.rule !== "sweepx"');
  });
  it("the gold-ticks run reads its subscriptions, the recorded minutes rounded as the chart's history, and mails through the same path", () => {
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=eq.sweepx&select=user_id,pair,interval,lang,rule")');
    expect(fn).toContain('isSweepxChart(r.pair, r.interval)');
    expect(fn).toContain('historyOfBars(GOLD, "1min", tickMinuteCandles(minutes), now, new Date(now).toISOString()).candles');
    expect(fn).toContain('const sigs = sweepxSignals(GOLD, "1min", closed, now);');
    expect(fn).toContain("await mailerFor(subs, counts)(sigs);");
    // in the background, the request answered at once: the job's call waits
    // for the answer (10 seconds at most), and the run takes the minute and more
    expect(fn).toMatch(/if \(body\.mode === "gold-ticks"\) \{[\s\S]{0,700}runtime\.waitUntil\(\s*goldTicks\(\)\.then\(/);
    expect(fn).not.toContain("json(await goldTicks())");
    // while gold is shut, only the runs that can still find its last minute
    // fresh judge (gold-minutes.ts judgesWhileShut)
    expect(fn).toContain('if (!judgesWhileShut(plan.minuteStart)) return { ...summary, skipped: "market_closed" };');
    expect(fn).toContain("sweepx: { pairs: SWEEPX_PAIRS, intervals: SWEEPX_INTERVALS },");
    expect(fn).toContain("signal-alerts-v24");
  });
  it("the job calls the run every minute through the http extension, not pg_net (which sends nothing while a request it sent is open)", () => {
    const sql = readFileSync("supabase/migrations/20261011120100_gold_ticks_every_minute.sql", "utf8");
    const job = sql.slice(sql.indexOf("select cron.schedule("));
    expect(sql).toContain("create extension if not exists http with schema extensions;");
    expect(sql.indexOf("create extension if not exists http")).toBeLessThan(sql.indexOf("select cron.schedule("));
    expect(job).toContain("'signal-alerts-gold-ticks',\n  '* * * * *',");
    expect(job).toContain("select extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '10000');");
    expect(job).toContain("select status from extensions.http((\n    'POST',\n    'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/signal-alerts',");
    expect(job).toContain("array[extensions.http_header('x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token'))],");
    expect(job).toContain("'{\"mode\":\"gold-ticks\"}'\n  )::extensions.http_request);");
    expect(job).not.toContain("net.http_post");
    // (scheduled once: an earlier job of the name is taken away first)
    expect(sql).toContain("select cron.unschedule(jobid) from cron.job where jobname = 'signal-alerts-gold-ticks';");
  });

  it("the migration lets a subscription name the rule and the 1-minute chart", () => {
    const sql = readFileSync("supabase/migrations/20261011120000_gold_minutes_all_day.sql", "utf8");
    expect(sql).toContain("check (\"interval\" = any (array['1min', '5min', '15min', '1h', '4h', '1day']));");
    expect(sql).toContain("check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx', 'sweepx']));");
    // every row recorded before the recording all day is removed, and the
    // minutes are read as one answer, from a time on when asked
    expect(sql).toContain("delete from public.gold_tick_bars;");
    expect(sql).toContain("create or replace function public.gold_tick_minutes(p_count integer, p_from timestamptz default null)");
    // (and no one-argument function beside it: a call naming p_count alone
    // would be ambiguous)
    expect(sql.indexOf("drop function if exists public.gold_tick_minutes(integer);")).toBeGreaterThan(-1);
    expect(sql.indexOf("drop function if exists public.gold_tick_minutes(integer);")).toBeLessThan(sql.indexOf("create or replace function public.gold_tick_minutes("));
    expect(sql).toContain("where p_from is null or minute >= p_from");
  });
});
