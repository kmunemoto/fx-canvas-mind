// deno test --allow-env --allow-read --allow-write research/allstocks-scan/scan_test.ts
// A fake Yahoo (made-up prices only); nothing is read from the network.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { stockBarsOf } from "../../supabase/functions/signal-alerts/stocks.ts";
import { judgeLastSession } from "./judge.ts";
import { runScan } from "./scan.ts";
import { fakeAnswer, weekdays } from "./fake.ts";

const NOW = Date.parse("2026-11-22T07:00:00Z");
const DAYS = weekdays("2026-09-21", "2026-11-20");
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// a fake fetch: each symbol's answers in turn (the last one repeats); records the symbols asked
const fakeYahoo = (plan: Record<string, Array<() => Response>>) => {
  const asked: string[] = [];
  const fn = ((url: string | URL | Request) => {
    const u = String(url);
    assert(u.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/"), u);
    assert(u.includes("interval=15m&range=60d&includePrePost=false"), u);
    const sym = decodeURIComponent(u.split("/chart/")[1].split("?")[0]);
    asked.push(sym);
    const q = plan[sym] ?? [() => json({}, 404)];
    const f = q.length > 1 ? q.shift()! : q[0];
    return Promise.resolve(f());
  }) as typeof fetch;
  return { fn, asked };
};

const opts = (outPath: string, fetchFn: typeof fetch, list: { symbol: string }[], extra: Record<string, unknown> = {}) => {
  let clock = NOW;
  const slept: number[] = [];
  return {
    o: {
      list, outPath, fetchFn, now: () => clock, log: () => {},
      sleep: (ms: number) => { slept.push(ms); clock += ms; return Promise.resolve(); },
      ...extra,
    },
    slept,
  };
};

const readLines = async (p: string) => (await Deno.readTextFile(p)).trim().split("\n").map((l) => JSON.parse(l));

Deno.test("each share is judged as judge.ts judges stockBarsOf's bars; a 404 and a 500 are written as such", async () => {
  const dir = await Deno.makeTempDir();
  const us = fakeAnswer("XYZ", DAYS, 11);
  const jp = fakeAnswer("9999.T", DAYS, 12);
  const y = fakeYahoo({ XYZ: [() => json(us)], "9999.T": [() => json(jp)], ABSNT: [() => json({}, 404)], BROKE: [() => json({}, 500)] });
  const { o } = opts(`${dir}/r.jsonl`, y.fn, [{ symbol: "XYZ" }, { symbol: "9999.T" }, { symbol: "ABSNT" }, { symbol: "BROKE" }, { symbol: "not a share" }]);
  const res = await runScan(o);
  assertEquals(res.stopped, false);
  assertEquals(y.asked, ["XYZ", "9999.T", "ABSNT", "BROKE"]);
  const lines = await readLines(`${dir}/r.jsonl`);
  assertEquals(lines.map((l) => [l.symbol, l.status]), [["XYZ", "ok"], ["9999.T", "ok"], ["ABSNT", "not_found"], ["BROKE", "http_500"]]);
  for (const [sym, body] of [["XYZ", us], ["9999.T", jp]] as const) {
    const want = judgeLastSession(sym, stockBarsOf(sym, body, NOW)!.bars);
    const got = lines.find((l) => l.symbol === sym)!;
    assertEquals(got.signals, want.signals);
    assertEquals(got.day, want.day);
    assertEquals(got.sessionBars, want.sessionBars);
    assertEquals(got.zone.side, want.zone!.side);
  }
  // no price in the output: only these keys
  for (const l of lines) for (const k of Object.keys(l)) assert(["symbol", "status", "day", "closedBars", "sessionBars", "shortBars", "signals", "zone"].includes(k), k);
});

Deno.test("reads are spaced by the gap, a 429 waits and is tried again, and a stopped scan goes on where it stopped", async () => {
  const dir = await Deno.makeTempDir();
  const body = fakeAnswer("XYZ", DAYS, 11);
  const y = fakeYahoo({
    AAA: [() => json(body)],
    BBB: [() => json({}, 429), () => json(body)],
    CCC: [() => json({}, 429)],
    DDD: [() => json({}, 429)],
    EEE: [() => json({}, 429)],
    FFF: [() => json(body)],
  });
  const list = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((symbol) => ({ symbol }));
  const { o, slept } = opts(`${dir}/r.jsonl`, y.fn, list, { gapMs: 600, refusedWaitMs: 60_000, refusedTries: 3, refusedStop: 3 });
  const res = await runScan(o);
  // BBB: refused once, then read; CCC, DDD, EEE: refused 3 times each -> stop
  assertEquals(res.stopped, true);
  assertEquals(y.asked, ["AAA", "BBB", "BBB", "CCC", "CCC", "CCC", "DDD", "DDD", "DDD", "EEE", "EEE", "EEE"]);
  assert(slept.filter((ms) => ms === 60_000).length === 10);
  assertEquals((await readLines(`${dir}/r.jsonl`)).map((l) => l.symbol), ["AAA", "BBB"]);
  // the next run reads only what is not written yet
  const y2 = fakeYahoo({ CCC: [() => json(body)], DDD: [() => json({}, 404)], EEE: [() => json(body)], FFF: [() => json(body)] });
  const res2 = await runScan(opts(`${dir}/r.jsonl`, y2.fn, list).o);
  assertEquals(res2.stopped, false);
  assertEquals(y2.asked, ["CCC", "DDD", "EEE", "FFF"]);
  assertEquals((await readLines(`${dir}/r.jsonl`)).map((l) => [l.symbol, l.status]), [
    ["AAA", "ok"], ["BBB", "ok"], ["CCC", "ok"], ["DDD", "not_found"], ["EEE", "ok"], ["FFF", "ok"],
  ]);
});

Deno.test("the gap between reads is kept", async () => {
  const dir = await Deno.makeTempDir();
  const body = fakeAnswer("XYZ", DAYS, 11);
  const y = fakeYahoo({ AAA: [() => json(body)], BBB: [() => json(body)], CCC: [() => json(body)] });
  const { o, slept } = opts(`${dir}/r.jsonl`, y.fn, ["AAA", "BBB", "CCC"].map((symbol) => ({ symbol })), { gapMs: 600 });
  await runScan(o);
  // the clock moves only by the sleeps, so each read after the first waits the whole gap
  assertEquals(slept, [600, 600]);
});

Deno.test("an answer that is not JSON, and one with no bars", async () => {
  const dir = await Deno.makeTempDir();
  const y = fakeYahoo({
    AAA: [() => new Response("<html>", { status: 200 })],
    BBB: [() => json({ chart: { result: null, error: { code: "Not Found" } } })],
  });
  await runScan(opts(`${dir}/r.jsonl`, y.fn, [{ symbol: "AAA" }, { symbol: "BBB" }]).o);
  assertEquals((await readLines(`${dir}/r.jsonl`)).map((l) => [l.symbol, l.status]), [["AAA", "unreadable"], ["BBB", "no_bars"]]);
});
