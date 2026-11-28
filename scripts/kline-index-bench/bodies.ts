// The TypeScript side of check.sh (the local test of supabase/migrations/20261128130000_gmo_kline_index.sql): made-up
// GMO-shaped 5-minute day files (the prices made up, none of them GMO's), the statements that put them into a scratch
// database, and the comparison of public.gmo_kline_index's rows with signal-alerts' own code (kline-direct.ts
// klineDigest, indicators.ts keepableKlines, track-outcomes/quotes.ts parseKlines). Nothing here reads a network or a
// project's database.
//   deno run --allow-read --allow-write bodies.ts gen <dir>          writes <dir>/load.sql and <dir>/expect.json
//   deno run --allow-read bodies.ts compare <dir> <rows.tsv> [want]  ok / FAIL lines; exit 1 on a FAIL ("want" = fail:
//                                                                    the rows come from a function changed on purpose)
import { keepableKlines } from "../../supabase/functions/signal-alerts/indicators.ts";
import { klineDigest } from "../../supabase/functions/signal-alerts/kline-direct.ts";
import { parseKlines } from "../../supabase/functions/track-outcomes/quotes.ts";

const SYMBOLS = ["USD_JPY", "EUR_JPY", "AUD_JPY", "EUR_USD", "AUD_USD"];
const SINCE = "20261103";

type Kind = "sound" | "odd" | "absent";
interface Entry {
  s: string;
  p: string;
  i: string;
  d: string;
  kind: Kind;
  why: string;
  raw: string;
  // sound: what klineDigest makes of the body; odd: its twin (a GMO-like answer the copy is held against)
  n?: number;
  h?: string | null;
  twin?: { n: number; h: string | null; naive: string | null; sameBars: boolean };
}

// a seeded generator (so a failure can be made again)
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const keyMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) - 3 * 3_600_000;
const bars = (r: () => number, d: string, count: number, digits: number) => {
  let p = digits === 3 ? 150 + r() * 10 : 1 + r() * 0.2;
  const step = digits === 3 ? 0.05 : 0.0005;
  return Array.from({ length: count }, (_, k) => {
    const o = p;
    p += (r() - 0.5) * step;
    const hi = Math.max(o, p) + r() * step * 0.3;
    const lo = Math.min(o, p) - r() * step * 0.3;
    return { openTime: String(keyMs(d) + k * 300_000), open: o.toFixed(digits), high: hi.toFixed(digits), low: lo.toFixed(digits), close: p.toFixed(digits) };
  });
};
// the first text the design wrote (no check of empty fields, "," or a newline), to show what the check turns away
const naiveText = (body: { data: unknown[] }): string | null => {
  const lines: string[] = [];
  for (const e of body.data) {
    if (typeof e !== "object" || e === null) return null;
    const x = e as Record<string, unknown>;
    const f = [x.openTime, x.open, x.high, x.low, x.close];
    if (!f.every((v) => typeof v === "string")) return null;
    lines.push(f.join(","));
  }
  return lines.join("\n");
};
const hex16 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");

const gen = async (dir: string) => {
  const r = rng(20261128);
  const out: Entry[] = [];
  const add = async (e: Omit<Entry, "n" | "h">, twin?: unknown) => {
    const body = JSON.parse(e.raw);
    const x: Entry = { ...e };
    if (e.kind === "sound") {
      if (!keepableKlines(body)) throw new Error(`not sound: ${e.why}`);
      x.n = body.data.length;
      x.h = await klineDigest(body);
      if (x.h === null) throw new Error(`no digest: ${e.why}`);
    }
    if (e.kind === "odd") {
      x.h = await klineDigest(body);
      // a GMO answer: status 0 and its bars
      const t = { status: 0, ...(twin as { data: unknown[] }) };
      const naive = naiveText(t);
      x.twin = { n: t.data.length, h: await klineDigest(t), naive: naive === null ? null : await hex16(naive), sameBars: JSON.stringify(parseKlines(t)) === JSON.stringify(parseKlines(body)) };
    }
    if (e.kind === "absent") x.h = await klineDigest(body);
    out.push(x);
  };
  // 300 sound files: the five symbols, both sides, 30 days of November (the 1st and 2nd before p_since)
  for (let day = 1; day <= 30; day++) {
    const d = `202611${String(day).padStart(2, "0")}`;
    const dow = new Date(Date.UTC(2026, 10, day)).getUTCDay();
    for (const s of SYMBOLS) {
      for (const p of ["BID", "ASK"]) {
        const k = out.length;
        const digits = s.endsWith("_JPY") ? 3 : 5;
        const count = dow === 0 || dow === 6 ? 0 : dow === 1 ? 276 : r() < 0.1 ? 1 + Math.floor(r() * 287) : 288;
        const data = bars(r, d, count, digits);
        let raw: string;
        let why = "GMO's shape";
        if (k % 17 === 0 && count > 0) {
          // the keys in another order, a field the walk does not read
          raw = JSON.stringify({ data: data.map((b) => ({ close: b.close, volume: "0", low: b.low, high: b.high, open: b.open, openTime: b.openTime })), status: 0 });
          why = "keys reordered, an extra field";
        } else if (k % 23 === 0 && count > 0) {
          // a digit written as a \u escape (jsonb and JSON.parse both read the same string)
          raw = JSON.stringify({ status: 0, data }).replaceAll('"close":"1', '"close":"\\u0031');
          why = "\\u escapes";
        } else if (k % 29 === 0 && count > 0) {
          // a key twice in a bar: the last one counts, in jsonb and in JSON.parse
          raw = JSON.stringify({ status: 0, data }).replace('{"openTime"', '{"close":"0.000","openTime"');
          why = "a duplicated key";
        } else if (k % 31 === 0) {
          // status written 0.0 (jsonb's 0.0 = 0, JSON.parse's 0 === 0)
          raw = JSON.stringify({ status: 0, data, responsetime: "2026-11-28T00:00:00.000Z" }).replace('"status":0', '"status":0.0');
          why = "status 0.0";
        } else {
          raw = JSON.stringify({ status: 0, data, responsetime: "2026-11-28T00:00:00.000Z" });
        }
        await add({ s, p, i: "5min", d, kind: d < SINCE ? "absent" : "sound", why: d < SINCE ? "before p_since" : why, raw });
      }
    }
  }
  // non-ASCII in the fields read (UTF-8 both sides), and in a field not read
  await add({ s: "USD_JPY", p: "BID", i: "5min", d: "20261231", kind: "sound", why: "non-ASCII fields", raw: JSON.stringify({ status: 0, data: [{ openTime: "１", open: "é", high: "\u{1F600}", low: "終値", close: "x" }], note: "終値" }) });
  // odd copies (status 0, a list: the function gives them a row), each held against a GMO-like twin: when they agree
  // (the same count and digest), the walk must read the same bars from both
  const t1 = 1796158800000;
  const one = { openTime: String(t1), open: "155.762", high: "155.790", low: "155.700", close: "155.781" };
  const two = { openTime: String(t1 + 300_000), open: "155.781", high: "155.801", low: "155.770", close: "155.799" };
  const odd: Array<[string, string, unknown]> = [
    ["a number for open", `{"status":0,"data":[{"openTime":"${t1}","open":155.762,"high":"155.790","low":"155.700","close":"155.781"}]}`, { data: [one] }],
    ["a number with a trailing zero", `{"status":0,"data":[{"openTime":"${t1}","open":"155.762","high":155.790,"low":"155.700","close":"155.781"}]}`, { data: [one] }],
    ["a number for openTime", `{"status":0,"data":[{"openTime":${t1},"open":"155.762","high":"155.790","low":"155.700","close":"155.781"}]}`, { data: [one] }],
    ["a huge number", `{"status":0,"data":[{"openTime":"${t1}","open":1e400,"high":"155.790","low":"155.700","close":"155.781"}]}`, { data: [{ ...one, open: `1${"0".repeat(400)}` }] }],
    ["close missing (twin: empty)", `{"status":0,"data":[{"openTime":"${t1}","open":"155.762","high":"155.790","low":"155.700"}]}`, { data: [{ ...one, close: "" }] }],
    ["low null (twin: empty)", `{"status":0,"data":[{"openTime":"${t1}","open":"155.762","high":"155.790","low":null,"close":"155.781"}]}`, { data: [{ ...one, low: "" }] }],
    ["a bar that is a number (twin: empty fields)", `{"status":0,"data":[7]}`, { data: [{ openTime: "", open: "", high: "", low: "", close: "" }] }],
    ["a bar that is a list", `{"status":0,"data":[["${t1}","155.762","155.790","155.700","155.781"]]}`, { data: [{ openTime: "", open: "", high: "", low: "", close: "" }] }],
    ["a bar's end moved across a newline", JSON.stringify({ status: 0, data: [one, { ...two, openTime: `155.700\n${two.openTime}` }] }), { data: [{ ...one, close: "155.781\n155.700" }, two] }],
    ["a field split across ','", JSON.stringify({ status: 0, data: [{ ...one, high: "155.790,155.700", low: "155.781", close: "1" }] }), { data: [{ ...one, low: "155.700,155.781", close: "1" }] }],
    ["a true", `{"status":0,"data":[{"openTime":"${t1}","open":"155.762","high":true,"low":"155.700","close":"155.781"}]}`, { data: [{ ...one, high: "true" }] }],
    ["a list in a field", `{"status":0,"data":[{"openTime":"${t1}","open":"155.762","high":["155.790"],"low":"155.700","close":"155.781"}]}`, { data: [{ ...one, high: '["155.790"]' }] }],
    ["an object in a field", `{"status":0,"data":[{"openTime":"${t1}","open":"155.762","high":{"v":1},"low":"155.700","close":"155.781"}]}`, { data: [{ ...one, high: '{"v": 1}' }] }],
    ["an empty close (twin: none)", JSON.stringify({ status: 0, data: [{ ...one, close: "" }] }), { data: [(({ close: _c, ...rest }) => rest)(one)] }],
  ];
  for (const [k, [why, raw, twin]] of odd.entries()) await add({ s: "USD_JPY", p: "BID", i: "5min", d: `202612${String(k + 1).padStart(2, "0")}`, kind: "odd", why, raw }, twin);
  // no row: not status 0 with a list
  const absent: Array<[string, string]> = [
    ["status 5", `{"status":5,"messages":[{"message_code":"ERR-5201","message_string":"MAINTENANCE."}]}`],
    ["status '0'", `{"status":"0","data":[]}`],
    ["status null", `{"status":null,"data":[]}`],
    ["status true", `{"status":true,"data":[]}`],
    ["no status", `{"data":[]}`],
    ["data an object", `{"status":0,"data":{}}`],
    ["data a string", `{"status":0,"data":"x"}`],
    ["data null", `{"status":0,"data":null}`],
    ["no data", `{"status":0}`],
    ["a list for a body", `[{"status":0,"data":[]}]`],
    ["a string for a body", `"x"`],
    ["a number for a body", `0`],
  ];
  for (const [k, [why, raw]] of absent.entries()) await add({ s: "USD_JPY", p: "ASK", i: "5min", d: `202612${String(k + 1).padStart(2, "0")}`, kind: "absent", why, raw });
  // no row: another interval, a symbol not asked for
  const sound = JSON.stringify({ status: 0, data: bars(r, "20261110", 12, 3) });
  for (const i of ["15min", "1hour", "1min"]) await add({ s: "USD_JPY", p: "BID", i, d: "20261110", kind: "absent", why: `interval ${i}`, raw: sound });
  await add({ s: "GBP_JPY", p: "BID", i: "5min", d: "20261110", kind: "absent", why: "a symbol not asked for", raw: sound });
  const q = (v: string) => `'${v.replaceAll("'", "''")}'`;
  const load = out.map((e) => {
    if (e.raw.includes("$j$")) throw new Error("raw holds $j$");
    return `insert into public.gmo_kline_files (symbol, price_type, interval, date_key, body) values (${q(e.s)}, ${q(e.p)}, ${q(e.i)}, ${q(e.d)}, $j$${e.raw}$j$::jsonb);`;
  });
  await Deno.writeTextFile(`${dir}/load.sql`, load.join("\n") + "\n");
  await Deno.writeTextFile(`${dir}/expect.json`, JSON.stringify(out));
  const n = (k: Kind) => out.filter((e) => e.kind === k).length;
  console.log(`made ${out.length} files: ${n("sound")} sound, ${n("odd")} odd, ${n("absent")} with no row`);
};

const compare = async (dir: string, tsv: string, want: string | undefined) => {
  const expect: Entry[] = JSON.parse(await Deno.readTextFile(`${dir}/expect.json`));
  const rows = new Map<string, { n: number; h: string }>();
  const lines = (await Deno.readTextFile(tsv)).split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    const [s, p, d, n, h] = line.split("\t");
    rows.set(`${s}|${p}|${d}`, { n: Number(n), h });
  }
  let bad = 0;
  const say = (ok: boolean, what: string) => {
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  };
  const keyOf = (e: Entry) => `${e.s}|${e.p}|${e.d}`;
  const sound = expect.filter((e) => e.kind === "sound");
  const soundBad = sound.filter((e) => {
    const r = rows.get(keyOf(e));
    return !r || r.n !== e.n || r.h !== e.h;
  });
  say(soundBad.length === 0, `sound files: the function's (n, h) = klineDigest's for ${sound.length - soundBad.length} of ${sound.length}${soundBad.length ? ` (first: ${keyOf(soundBad[0])} ${soundBad[0].why})` : ""}`);
  for (const why of [...new Set(sound.map((e) => e.why))]) {
    const of = sound.filter((e) => e.why === why);
    say(of.every((e) => !soundBad.includes(e)), `  of them "${why}": ${of.length}`);
  }
  const odd = expect.filter((e) => e.kind === "odd");
  say(odd.every((e) => rows.has(keyOf(e))), `odd copies (status 0, a list): a row each (${odd.filter((e) => rows.has(keyOf(e))).length} of ${odd.length})`);
  say(odd.every((e) => e.h === null), "odd copies: klineDigest gives none of them a digest, so none agrees with its own row");
  let agreed = 0;
  let naiveUnsafe = 0;
  for (const e of odd) {
    const r = rows.get(keyOf(e));
    if (!r || !e.twin) continue;
    const agree = r.n === e.twin.n && r.h === e.twin.h;
    if (agree) {
      agreed++;
      say(e.twin.sameBars, `  "${e.why}": its twin agrees, and the walk reads the same bars from both`);
    } else {
      say(true, `  "${e.why}": its twin does not agree (the kept copy is read)`);
    }
    if (e.twin.naive !== null && r.n === e.twin.n && r.h === e.twin.naive && !e.twin.sameBars) naiveUnsafe++;
  }
  say(agreed > 0, `odd copies whose twin agrees: ${agreed} (a number where GMO gives the same text, or a value the walk drops on both sides)`);
  console.log(`info the design's first text would have let ${naiveUnsafe} twin(s) through with other bars; klineDataText lets none`);
  // the files with no row: not sound (status not 0, data not a list), before p_since, of another interval (their keys
  // are a 5-minute file's too, so a row of theirs would be a second row of that key), of a symbol not asked for
  const absent = expect.filter((e) => e.kind === "absent");
  const unsound = absent.filter((e) => e.i === "5min" && SYMBOLS.includes(e.s) && e.why !== "before p_since");
  say(unsound.every((e) => !rows.has(keyOf(e))), `not status 0 with a list: no row (${unsound.length} files: ${unsound.map((e) => e.why).join(", ")})`);
  say(unsound.every((e) => !keepableKlines(JSON.parse(e.raw)) && e.h === null), "  and keepableKlines takes none of them, klineDigest gives none a digest");
  const early = absent.filter((e) => e.why === "before p_since");
  say(early.length === 20 && early.every((e) => !rows.has(keyOf(e))), `before p_since (${SINCE}): no row (${early.length} files)`);
  const other = absent.filter((e) => e.i !== "5min" || !SYMBOLS.includes(e.s));
  say(other.every((e) => e.i !== "5min" || !rows.has(keyOf(e))), `another interval or a symbol not asked for: no row (${other.length} files)`);
  const wanted = new Set([...sound, ...odd].map(keyOf));
  const extra = [...rows.keys()].filter((k) => !wanted.has(k));
  say(extra.length === 0 && lines.length === rows.size && rows.size === wanted.size, `the answer: ${lines.length} rows, ${rows.size} keys, ${wanted.size} wanted, ${extra.length} unexpected`);
  if (want === "fail") {
    console.log(bad > 0 ? `compare: differs, as it must for a function changed on purpose (${bad} FAIL)` : "compare: SAME — the changed function was not caught");
    Deno.exit(bad > 0 ? 0 : 1);
  }
  console.log(bad === 0 ? "compare: all as expected" : `compare: ${bad} FAIL`);
  Deno.exit(bad === 0 ? 0 : 1);
};

const [cmd, dir, tsv, want] = Deno.args;
if (cmd === "gen") await gen(dir);
else if (cmd === "compare") await compare(dir, tsv, want);
else {
  console.error("usage: bodies.ts gen <dir> | compare <dir> <rows.tsv> [fail]");
  Deno.exit(2);
}
