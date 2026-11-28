// v43 (supabase/functions/signal-alerts/kline-direct.ts): the five pairs' 5-minute chart takes its ended GMO day files
// from GMO, each used only when it equals the copy public.gmo_kline_files keeps (the same bars' count and the same
// digest, public.gmo_kline_index, migration 20261128130000), else the kept copy. Here the module's pure parts: the
// digest pinned, what has no digest, the index's rows read, which charts are read this way, and the digest against an
// independent model of the migration's SQL (jsonb's ->>, concat, string_agg, sha256, written here from the SQL text,
// hashed with node:crypto, not crypto.subtle): a sound file always agrees with its kept copy, and when a GMO answer
// agrees with a kept copy, the walk reads the same bars from both (track-outcomes/quotes.ts parseKlines). The run
// itself is held in src/test/macd-fade-alerts.test.ts; the SQL on PostgreSQL 16 by scripts/kline-index-bench/check.sh.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  KLINE_DIRECT_BUDGET_MS,
  KLINE_DIRECT_TRIES,
  isKlineDirectChart,
  keptIndexOf,
  klineDataText,
  klineDigest,
  symbolsOf,
} from "../../supabase/functions/signal-alerts/kline-direct";
import { INDICATOR_INTERVALS, MACDH_PAIRS, klineFileKey, klineFileOf } from "../../supabase/functions/signal-alerts/indicators";
import { GMO_SYMBOLS, klineUrl, parseKlines } from "../../supabase/functions/track-outcomes/quotes";

type Body = { status: unknown; data: unknown[]; [k: string]: unknown };
const bar = (t: number, o: string, h: string, l: string, c: string) => ({ openTime: String(t), open: o, high: h, low: l, close: c });
const ONE = bar(1796158800000, "155.762", "155.790", "155.700", "155.781");

// ---- the model of the migration's SQL (supabase/migrations/20261128130000_gmo_kline_index.sql), as jsonb reads a body
// that came as JSON: e ->> 'k' is a string's own text, another value's JSON text in jsonb's form, NULL for a key not
// there, a JSON null, or an element that is no object; concat(...) drops NULLs (a missing field is empty);
// string_agg(..., chr(10) order by ordinality) over no element is NULL, coalesce(..., '') makes it ''; then
// left(encode(sha256(convert_to(text, 'UTF8')), 'hex'), 16). A row only for status 0 and data a list
const jsonbText = (v: unknown): string => {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(", ")}]`;
  // jsonb keeps an object's keys shorter first, then by their bytes
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${jsonbText(o[k])}`).join(", ")}}`;
};
const field = (e: unknown, k: string): string | null => {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return null;
  const v = (e as Record<string, unknown>)[k];
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : jsonbText(v);
};
const sqlRow = (body: Body): { n: number; h: string } | null => {
  if (body.status !== 0 || !Array.isArray(body.data)) return null;
  const text = body.data.map((e) => ["openTime", "open", "high", "low", "close"].map((k) => field(e, k) ?? "").join(",")).join("\n");
  return { n: body.data.length, h: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, 16) };
};
// the text the design first wrote (no check of empty fields, "," or a newline), to show the check below can fail
const naiveText = (body: Body): string | null => {
  const lines: string[] = [];
  for (const e of body.data) {
    if (typeof e !== "object" || e === null) return null;
    const r = e as Record<string, unknown>;
    const f = [r.openTime, r.open, r.high, r.low, r.close];
    if (!f.every((v) => typeof v === "string")) return null;
    lines.push(f.join(","));
  }
  return lines.join("\n");
};
const hex16 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, 16);

// a seeded generator, so a failure can be run again
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// a GMO-shaped 5-minute day file: openTime from the day's first bar 5 minutes apart, prices as strings with the pair's
// digits (3 for a yen pair, 5 for a dollar one), high and low around open and close
const gmoBody = (r: () => number, bars: number, digits: number): Body => {
  const start = Date.UTC(2026, 10, 1, 21, 0) + Math.floor(r() * 30) * 86_400_000;
  let p = digits === 3 ? 150 + r() * 10 : 1 + r() * 0.2;
  const data = Array.from({ length: bars }, (_, i) => {
    const o = p;
    p += (r() - 0.5) * (digits === 3 ? 0.1 : 0.001);
    const hi = Math.max(o, p) + r() * (digits === 3 ? 0.02 : 0.0002);
    const lo = Math.min(o, p) - r() * (digits === 3 ? 0.02 : 0.0002);
    return bar(start + i * 300_000, o.toFixed(digits), hi.toFixed(digits), lo.toFixed(digits), p.toFixed(digits));
  });
  return { status: 0, data, responsetime: "2026-11-28T00:00:00.000Z" };
};

describe("v43 kline-direct.ts: the digest of a GMO answer", () => {
  it("is the first 16 hex digits of the SHA-256 of a line a bar (openTime, open, high, low, close joined by ','), the lines joined by a newline: pinned for one bar and for a day with no bars", async () => {
    expect(klineDataText({ status: 0, data: [ONE] })).toBe("1796158800000,155.762,155.790,155.700,155.781");
    expect(await klineDigest({ status: 0, data: [ONE] })).toBe("cd184068d0a3ad89");
    expect(klineDataText({ status: 0, data: [] })).toBe("");
    expect(await klineDigest({ status: 0, data: [] })).toBe("e3b0c44298fc1c14");
    const two = { status: 0, data: [ONE, bar(1796159100000, "155.781", "155.801", "155.770", "155.799")] };
    expect(klineDataText(two)).toBe("1796158800000,155.762,155.790,155.700,155.781\n1796159100000,155.781,155.801,155.770,155.799");
    // crypto.subtle's digest is node:crypto's, over the UTF-8 text, first 8 bytes in lowercase hex
    const r = rng(7);
    for (let i = 0; i < 50; i++) {
      const b = gmoBody(r, Math.floor(r() * 289), r() < 0.5 ? 3 : 5);
      expect(await klineDigest(b)).toBe(hex16(klineDataText(b)!));
    }
    // a non-ASCII field is hashed as UTF-8 (the SQL's convert_to(.., 'UTF8'))
    const wide = { status: 0, data: [bar(1, "１５５", "é", "\u{1F600}", "x")] };
    expect(await klineDigest(wide)).toBe(createHash("sha256").update(Buffer.from("1,１５５,é,\u{1F600},x", "utf8")).digest("hex").slice(0, 16));
  });

  it("reads only the five fields, in the answer's own order: the other fields, the keys' order and the answer's time leave it; another order of the bars, another price or another bar count change it", async () => {
    const base = { status: 0, data: [ONE, bar(1796159100000, "155.781", "155.801", "155.770", "155.799")] };
    const h = await klineDigest(base);
    expect(await klineDigest({ ...base, responsetime: "2026-11-28T00:00:01.000Z", extra: [1, 2] })).toBe(h);
    expect(await klineDigest({ status: 0, data: base.data.map((b) => ({ close: b.close, volume: "12", low: b.low, high: b.high, open: b.open, openTime: b.openTime })) })).toBe(h);
    expect(await klineDigest({ status: 0, data: [...base.data].reverse() })).not.toBe(h);
    expect(await klineDigest({ status: 0, data: [base.data[0], { ...base.data[1], close: "155.798" }] })).not.toBe(h);
    expect(await klineDigest({ status: 0, data: [base.data[0]] })).not.toBe(h);
    expect(await klineDigest({ status: 0, data: [base.data[0], { ...base.data[1], close: "155.7990" }] })).not.toBe(h);
  });

  it("none for an answer that is not sound, a bar that is not an object, or a field that is not a non-empty string free of ',' and newlines", async () => {
    for (const body of [null, undefined, "x", 0, [], { status: 5, messages: [] }, { status: "0", data: [] }, { status: 0 }, { status: 0, data: {} }, { status: 0, data: "x" }, { data: [] }]) {
      expect(klineDataText(body), JSON.stringify(body)).toBeNull();
      expect(await klineDigest(body), JSON.stringify(body)).toBeNull();
    }
    const odd: unknown[] = [
      { ...ONE, open: 155.762 },
      { ...ONE, openTime: 1796158800000 },
      (({ close: _c, ...rest }) => rest)(ONE),
      { ...ONE, high: null },
      { ...ONE, low: true },
      { ...ONE, close: ["155.781"] },
      { ...ONE, close: { v: "155.781" } },
      { ...ONE, close: "" },
      { ...ONE, close: "155,781" },
      { ...ONE, close: "155.781\n1" },
      null,
      42,
      "1796158800000,155.762,155.790,155.700,155.781",
      ["1796158800000", "155.762", "155.790", "155.700", "155.781"],
    ];
    for (const e of odd) {
      const body = { status: 0, data: [ONE, e] };
      expect(klineDataText(body), JSON.stringify(e)).toBeNull();
      expect(await klineDigest(body), JSON.stringify(e)).toBeNull();
    }
  });

  it("the constants: GMO asked twice at most for a kept file, for 30 s after the index was read", () => {
    expect(KLINE_DIRECT_TRIES).toBe(2);
    expect(KLINE_DIRECT_BUDGET_MS).toBe(30_000);
  });
});

describe("v43 kline-direct.ts: the index's rows and the charts read this way", () => {
  const row = (s: string, p: string, d: string, n = 288, h = "0123456789abcdef") => ({ s, p, d, n, h });

  it("keys each row as indicators.ts klineFileKey of the GMO request for that file, under GMO's interval name; its bars' count and digest", () => {
    const rows = [row("USD_JPY", "BID", "20261127"), row("USD_JPY", "ASK", "20261127", 287, "fedcba9876543210"), row("EUR_JPY", "BID", "20261126", 0, "e3b0c44298fc1c14")];
    const idx = keptIndexOf(rows, "5min")!;
    expect(idx.size).toBe(3);
    for (const r of rows) {
      const side = r.p === "BID" ? "bid" : "ask";
      const key = klineFileKey(klineFileOf(klineUrl(r.s, side, "5min", r.d))!);
      expect(idx.get(key), key).toEqual({ n: r.n, h: r.h });
    }
    expect([...idx.keys()]).toEqual(["USD_JPY|BID|5min|20261127", "USD_JPY|ASK|5min|20261127", "EUR_JPY|BID|5min|20261126"]);
    expect(keptIndexOf([], "5min")!.size).toBe(0);
    expect([...symbolsOf(idx)].sort()).toEqual(["EUR_JPY", "USD_JPY"]);
    expect(symbolsOf(new Map()).size).toBe(0);
  });

  it("is none (the run reads as before) for an answer that is no list of such rows: s and p strings, d eight digits, n a whole number from 0, h 16 lowercase hex digits", () => {
    const good = row("USD_JPY", "BID", "20261127");
    expect(keptIndexOf([good], "5min")).not.toBeNull();
    for (const bad of [
      null,
      undefined,
      {},
      "[]",
      { rows: [good] },
      [null],
      [[good]],
      ["USD_JPY|BID|5min|20261127"],
      [{ ...good, s: 1 }],
      [{ ...good, s: undefined }],
      [{ ...good, p: null }],
      [{ ...good, d: "2026112" }],
      [{ ...good, d: "202611270" }],
      [{ ...good, d: "2026-11-2" }],
      [{ ...good, d: 20261127 }],
      [{ ...good, n: -1 }],
      [{ ...good, n: 1.5 }],
      [{ ...good, n: "288" }],
      [{ ...good, n: Number.NaN }],
      [{ ...good, n: 2 ** 53 }],
      [{ ...good, h: "0123456789ABCDEF" }],
      [{ ...good, h: "0123456789abcde" }],
      [{ ...good, h: "0123456789abcdef0" }],
      [{ ...good, h: "0123456789abcdeg" }],
      [{ ...good, h: null }],
      [good, { ...good, h: "x" }],
    ]) {
      expect(keptIndexOf(bad, "5min"), JSON.stringify(bad)).toBeNull();
    }
  });

  it("isKlineDirectChart: the five pairs' 5-minute chart only (not gold on any chart, not the pairs on 15 minutes or 1 hour, not another GMO pair on 5 minutes)", () => {
    const five = ["USD/JPY", "AUD/USD", "EUR/JPY", "AUD/JPY", "EUR/USD"];
    for (const p of five) expect(isKlineDirectChart(p, "5min"), p).toBe(true);
    for (const p of [...MACDH_PAIRS, "GBP/JPY", "NZD/USD", "EUR/GBP", "USD/CAD", "XAU/USD", "AAPL", "4063.T"]) {
      for (const iv of [...INDICATOR_INTERVALS, "1min", "5m", "5MIN"]) {
        expect(isKlineDirectChart(p, iv), `${p} ${iv}`).toBe(five.includes(p) && iv === "5min");
      }
    }
    for (const [p, iv] of [[undefined, "5min"], ["USD/JPY", undefined], [null, null], [5, "5min"]]) expect(isKlineDirectChart(p, iv)).toBe(false);
    // the five are GMO's symbols the index is asked for
    expect(five.map((p) => GMO_SYMBOLS[p])).toEqual(["USD_JPY", "AUD_USD", "EUR_JPY", "AUD_JPY", "EUR_USD"]);
  });
});

describe("v43 kline-direct.ts against a model of the migration's SQL", () => {
  it("the model is the migration's text: concat of the five fields by ',' and chr(10) between bars, ordinality, coalesce to '', sha256 of the UTF-8 text, 16 hex digits; status 0 and a list only", () => {
    const sql = readFileSync("supabase/migrations/20261128130000_gmo_kline_index.sql", "utf8");
    expect(sql).toContain("string_agg(concat(t.e ->> 'openTime', ',', t.e ->> 'open', ',', t.e ->> 'high', ',', t.e ->> 'low', ',', t.e ->> 'close'), chr(10) order by t.i)");
    expect(sql).toContain("from jsonb_array_elements(f.body -> 'data') with ordinality as t(e, i)");
    expect(sql).toContain("left(encode(sha256(convert_to(coalesce((");
    expect(sql).toContain("), ''), 'UTF8')), 'hex'), 16)");
    expect(sql).toContain("jsonb_array_length(f.body -> 'data'),");
    expect(sql).toContain("and f.body -> 'status' = '0'::jsonb");
    expect(sql).toContain("and jsonb_typeof(f.body -> 'data') = 'array'");
    // the model's pins: the same two digests, and a missing field empty
    expect(sqlRow({ status: 0, data: [ONE] })).toEqual({ n: 1, h: "cd184068d0a3ad89" });
    expect(sqlRow({ status: 0, data: [] })).toEqual({ n: 0, h: "e3b0c44298fc1c14" });
    expect(sqlRow({ status: 0, data: [{ openTime: "1" }, 7] })!.h).toBe(hex16("1,,,,\n,,,,"));
    expect(sqlRow({ status: 5, data: [] })).toBeNull();
    expect(sqlRow({ status: "0", data: [] })).toBeNull();
  });

  it("a sound GMO-shaped file (strings, 0 to 288 bars, 3 or 5 digits) has the digest and the count its kept copy's row has, over 400 made-up files", async () => {
    const r = rng(20261128);
    for (let i = 0; i < 400; i++) {
      const b = gmoBody(r, i % 9 === 0 ? 0 : i % 4 === 0 ? 288 : 1 + Math.floor(r() * 288), r() < 0.6 ? 3 : 5);
      // the kept copy as the table holds it: what the function stored, read back as JSON
      const kept = JSON.parse(JSON.stringify(b)) as Body;
      expect(await klineDigest(b), `file ${i}`).toBe(sqlRow(kept)!.h);
      expect(b.data.length).toBe(sqlRow(kept)!.n);
    }
  });

  // When GMO's answer has its kept copy's count and digest, the walk must read the same bars from it as from the copy.
  // Pairs of a kept copy and an answer: made-up files with one bar changed in many ways, and pairs built to give the
  // same text under the design's first text (a field split across ",", a bar's end moved across a newline, an empty
  // field for a missing one). Agreement is the SQL model's (n, h) of the copy against klineDigest of the answer
  it("an answer agrees with a kept copy only when the walk reads the same bars from both (parseKlines); the design's first text would have let pairs through that it does not", async () => {
    const r = rng(43);
    const pairs: Array<[Body, Body]> = [];
    const mutate = (b: Body, k: number): Body => {
      const data = b.data.map((x) => ({ ...(x as Record<string, unknown>) }));
      const j = Math.floor(r() * data.length);
      const e = data[j];
      const keys = ["openTime", "open", "high", "low", "close"];
      const f = keys[k % 5];
      const v = String(e[f]);
      switch (Math.floor(k / 5) % 8) {
        case 0: e[f] = Number(v); break;
        case 1: delete e[f]; break;
        case 2: e[f] = null; break;
        case 3: e[f] = ""; break;
        case 4: e[f] = `${v}0`; break;
        case 5: e[f] = true; break;
        case 6: e[f] = [v]; break;
        case 7: data[j] = 7 as unknown as Record<string, unknown>; break;
      }
      return { ...b, data };
    };
    for (let i = 0; i < 160; i++) {
      const g = gmoBody(r, 1 + Math.floor(r() * 40), r() < 0.5 ? 3 : 5);
      pairs.push([mutate(g, i), g], [g, mutate(g, i)], [g, g]);
    }
    // a field split across "," between two fields: the same text, and the walk drops the bar on both sides (a field
    // holding "," is no number)
    pairs.push([{ status: 0, data: [{ ...ONE, high: "155.790,155.700", low: "155.781", close: "1" }] }, { status: 0, data: [{ ...ONE, low: "155.700,155.781", close: "1" }] }]);
    // built to collide under the first text, with other bars read from each
    const t1 = 1796158800000;
    const t2 = t1 + 300_000;
    const split: Array<[Body, Body]> = [
      // a bar's end moved across a newline: the copy's 2nd bar's openTime is "X\n<t2>", the answer's 1st bar's close
      // is "<c>\nX": the copy's 1st bar is read, the answer's 2nd
      [
        { status: 0, data: [bar(t1, "155.762", "155.790", "155.700", "155.781"), { openTime: `155.700\n${t2}`, open: "155.781", high: "155.801", low: "155.770", close: "155.799" }] },
        { status: 0, data: [{ ...bar(t1, "155.762", "155.790", "155.700", "155.781"), close: "155.781\n155.700" }, bar(t2, "155.781", "155.801", "155.770", "155.799")] },
      ],
      // a field missing in the copy, empty in the answer (Number("") is 0, a bar the walk would keep)
      [{ status: 0, data: [(({ close: _c, ...rest }) => rest)(ONE)] }, { status: 0, data: [{ ...ONE, close: "" }] }],
      [{ status: 0, data: [{ ...ONE, low: null }] }, { status: 0, data: [{ ...ONE, low: "" }] }],
      // an element that is no object in the copy (a line of empty fields), empty strings in the answer
      [{ status: 0, data: [7] }, { status: 0, data: [{ openTime: "", open: "", high: "", low: "", close: "" }] }],
    ];
    let agreed = 0;
    let naiveUnsafe = 0;
    for (const [kept, answer] of [...pairs, ...split]) {
      const row = sqlRow(kept)!;
      const same = JSON.stringify(parseKlines(answer)) === JSON.stringify(parseKlines(kept));
      if (row.n === answer.data.length && row.h === (await klineDigest(answer))) {
        agreed++;
        expect(same, `${JSON.stringify(kept).slice(0, 200)} / ${JSON.stringify(answer).slice(0, 200)}`).toBe(true);
      }
      const naive = naiveText(answer);
      if (naive !== null && row.n === answer.data.length && row.h === hex16(naive) && !same) naiveUnsafe++;
    }
    // every unchanged pair agrees (160), and some more: a copy holding a number where GMO gave the same text; the
    // walk reads the same bars from each
    expect(agreed).toBeGreaterThan(160);
    // the first text lets each built pair through with other bars; this one lets none
    expect(naiveUnsafe).toBeGreaterThanOrEqual(split.length);
    for (const [kept, answer] of split) {
      expect(JSON.stringify(parseKlines(answer))).not.toBe(JSON.stringify(parseKlines(kept)));
      expect(hex16(naiveText(answer)!)).toBe(sqlRow(kept)!.h);
      expect(await klineDigest(answer)).toBeNull();
    }
  });
});
