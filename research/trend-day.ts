// #250 (docs §8.106, at the owner's asking on 2026-10-09: 「今日出してた判断とこれを考慮した場合で」): the
// emails of one day (EMAILS, the ledger's columns pair,side,open,T,E,sentAt), each with the chart's Dow line
// at C (15M, 1H, 4H: trend-labels.ts, as stage 0 reads it) and what followed on GMO's 5-minute bars up to the
// run, and the four candidates' split of them. A look at one day: not evidence (§8.106 12 の5, 13), and in
// neither half nor in the check after R_trend (the day is after (a)'s END and before R_trend).
//
// What followed (§8.106 3's ways, kept simple): in at the signal bar's close on the book side (BUY the ask,
// SELL the bid); TP and the stop measured from the email's entry E (TP10 or TP4, and the stop 13 pips away);
// followed on the closing side's 5-minute bars from T; a bar opening past a level fills at its open; a bar
// reaching both is the stop; not decided by the run: open, valued at the last 5-minute close.
//
// MODE=real reads GMO (Actions); MODE=syn reads a walk's folder (OUT of trend.ts MODE=syn) with the emails
// made up from its signals, to try the program here.

import { DAY, HOUR, MINUTE, iso } from "./lib.ts";
import { LEAD15, PAIRS, type Sig, type Source, load15, newLoadStats, signalsOf, unitOf } from "./ownerhold-data.ts";
import { type Bars, DIR_OF, FINE, LAG, STATE_NAMES, chartRead, fileFetcher, gapsOf, labelsOf, lowerBound, seriesOf, weekendOutOf } from "./trend-labels.ts";
import { STEP_OF, loadTf } from "./trend-data.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const MODE = env("MODE", "real");
const SYN = MODE === "syn";
const DIR = env("GMO_DIR", SYN ? "research/out/trend/syn1/gmo" : "research/.cache");
const EMAILS = env("EMAILS", "research/ledger/trend-day-20261009.csv");
// the bars are read to here (the run's own time, floored to 5 minutes, unless given)
const NOW = env("END") ? Date.parse(env("END")) : Math.floor(Date.now() / (5 * MINUTE)) * 5 * MINUTE;
if (!Number.isFinite(NOW)) throw new Error(`END ${env("END")}`);

const TFS = ["15min", "1h", "4h"] as const;
type LTf = (typeof TFS)[number];
const src: Source = { dir: DIR, fetch: !SYN };
const weekendOut = weekendOutOf("inside");
const GAPS = gapsOf(weekendOut);
const fetcher = fileFetcher((symbol, interval, side, key) => `${DIR}/${symbol}/${interval}/${side}/${key}.json`);
const CANDS = ["①1H", "②4H", "③1H+4H", "④15M"] as const;

interface Email {
  pair: string;
  side: "BUY" | "SELL";
  open: number;
  T: number;
  E: number;
  sent: number;
}
const readEmails = async (): Promise<Email[]> => {
  // the walk (MODE=syn, EMAILS=syn:YYYY-MM-DD): that day's signals of the walk as the emails
  if (EMAILS.startsWith("syn:")) {
    const d0 = Date.parse(`${EMAILS.slice(4)}T00:00:00Z`);
    const out: Email[] = [];
    for (const [pi, pair] of PAIRS.entries()) {
      const q15 = await load15(src, pair, d0 - 2 * DAY - LEAD15, d0 + DAY, newLoadStats());
      for (const s of signalsOf(pair, pi, q15, d0 - 2 * DAY, d0 + DAY, false).signals) if (s.T >= d0) out.push({ pair, side: s.side, open: s.open, T: s.T, E: s.E, sent: s.base + 5_000 });
    }
    return out;
  }
  const lines = (await Deno.readTextFile(EMAILS)).split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "pair,side,open,T,E,sentAt") throw new Error(`${EMAILS}: header ${lines[0]}`);
  return lines.slice(1).map((l) => {
    const c = l.split(",");
    return { pair: c[0], side: c[1] as "BUY" | "SELL", open: Date.parse(c[2]), T: Date.parse(c[3]), E: Number(c[4]), sent: Date.parse(c[5]) };
  });
};

export interface Outcome {
  end: "TP" | "SL" | "open";
  exit: number;
  at: number;
  pips: number;
}
// one email followed on the closing side's 5-minute bars from T (above)
export const follow = (f: Bars, T: number, dir: 1 | -1, entry: number, E: number, tpPips: number, slPips: number, pip: number): Outcome => {
  const tp = E + dir * tpPips * pip;
  const sl = E - dir * slPips * pip;
  const pips = (exit: number) => (dir * (exit - entry)) / pip;
  let i = lowerBound(f.t, T);
  for (; i < f.n; i++) {
    const o = dir === 1 ? f.bo[i] : f.ao[i];
    const h = dir === 1 ? f.bh[i] : f.ah[i];
    const l = dir === 1 ? f.bl[i] : f.al[i];
    const pastSl = dir === 1 ? o <= sl : o >= sl;
    const pastTp = dir === 1 ? o >= tp : o <= tp;
    if (pastSl) return { end: "SL", exit: o, at: f.t[i], pips: pips(o) };
    if (pastTp) return { end: "TP", exit: o, at: f.t[i], pips: pips(o) };
    const hitSl = dir === 1 ? l <= sl : h >= sl;
    const hitTp = dir === 1 ? h >= tp : l <= tp;
    if (hitSl) return { end: "SL", exit: sl, at: f.t[i], pips: pips(sl) };
    if (hitTp) return { end: "TP", exit: tp, at: f.t[i], pips: pips(tp) };
  }
  const k = f.n - 1;
  const last = dir === 1 ? f.bc[k] : f.ac[k];
  return { end: "open", exit: last, at: f.t[k], pips: pips(last) };
};

// 手の例: a BUY at 100.000 (in at the ask 100.010), E 100.000; TP10 100.100, SL13 99.870
const handFollow = (): string[] => {
  const mk = (rows: Array<[number, number, number, number]>): Bars => {
    const n = rows.length;
    const b: Bars = { n, t: new Float64Array(n), bo: new Float64Array(n), bh: new Float64Array(n), bl: new Float64Array(n), bc: new Float64Array(n), ao: new Float64Array(n), ah: new Float64Array(n), al: new Float64Array(n), ac: new Float64Array(n), key: new Int32Array(n) };
    rows.forEach(([o, h, l, c], i) => {
      b.t[i] = i * 5 * MINUTE;
      b.bo[i] = o; b.bh[i] = h; b.bl[i] = l; b.bc[i] = c;
      b.ao[i] = o + 0.01; b.ah[i] = h + 0.01; b.al[i] = l + 0.01; b.ac[i] = c + 0.01;
    });
    return b;
  };
  const bad: string[] = [];
  const want = (name: string, got: Outcome, end: string, pips: number) => {
    if (got.end !== end || Math.abs(got.pips - pips) > 1e-9) bad.push(`${name}: ${got.end} ${got.pips.toFixed(3)} (want ${end} ${pips})`);
  };
  // TP first: up to 100.105 in the second bar
  want("TP first", follow(mk([[100.0, 100.05, 99.95, 100.02], [100.02, 100.105, 100.0, 100.09]]), 0, 1, 100.01, 100.0, 10, 13, 0.01), "TP", 9);
  // both in one bar: the stop
  want("both in a bar", follow(mk([[100.0, 100.12, 99.86, 100.0]]), 0, 1, 100.01, 100.0, 10, 13, 0.01), "SL", -14);
  // a bar opening past the stop fills at its open
  want("gap past the stop", follow(mk([[100.0, 100.05, 99.95, 100.0], [99.80, 99.85, 99.75, 99.8]]), 0, 1, 100.01, 100.0, 10, 13, 0.01), "SL", -21);
  // a SELL: in at the bid 100.000, E 100.000; TP10 99.900 on the ask (the bid + 0.01)
  want("SELL TP", follow(mk([[100.0, 100.02, 99.88, 99.9]]), 0, -1, 100.0, 100.0, 10, 13, 0.01), "TP", 10);
  // not decided: open at the last close (BUY: the bid)
  want("open", follow(mk([[100.0, 100.05, 99.95, 100.03]]), 0, 1, 100.01, 100.0, 10, 13, 0.01), "open", 2);
  return bad;
};

const main = async () => {
  const hb = handFollow();
  if (hb.length) throw new Error(`the hand examples of follow: ${hb.join("; ")}`);
  console.log(`MODE ${MODE}; bars to ${iso(NOW)} UTC; emails ${EMAILS}`);
  const emails = await readEmails();
  const st = newLoadStats();
  const day0 = Math.min(...emails.map((e) => e.T)) - 2 * DAY;
  const bars: Record<string, Record<LTf | "5min", Bars>> = {};
  for (const pair of PAIRS) {
    if (!emails.some((e) => e.pair === pair)) continue;
    const b = {} as Record<LTf | "5min", Bars>;
    for (const tf of TFS) b[tf] = (await loadTf(src, pair, tf, day0 - (tf === "4h" ? 120 : tf === "1h" ? 45 : 12) * DAY, NOW, st, weekendOut)).bars;
    b["5min"] = (await loadTf(src, pair, "5min", day0, NOW, st, weekendOut)).bars;
    bars[pair] = b;
  }
  if (st.failed) throw new Error(`GMO reads failed: ${st.failed} (${st.failedExamples.join("; ")})`);
  const holes = {} as Record<LTf, Set<number>>;
  for (const tf of TFS) holes[tf] = GAPS.commonMissing(Object.values(bars).map((b) => b[tf]), STEP_OF[tf]);

  interface Row {
    e: Email;
    sig: Sig | null;
    C: number;
    lab: Record<LTf, { state: number; excl: number; chart: string | null }>;
    w2: Outcome;
    w1: Outcome;
  }
  const rows: Row[] = [];
  for (const [pi, pair] of PAIRS.entries()) {
    const mine = emails.filter((e) => e.pair === pair);
    if (!mine.length) continue;
    const q15 = await load15(src, pair, day0 - LEAD15, NOW, st);
    const sigs = signalsOf(pair, pi, q15, day0, NOW, false).signals;
    const pip = unitOf(pair);
    for (const e of mine) {
      const sig = sigs.find((s) => s.open === e.open && s.side === e.side) ?? null;
      const C = sig ? sig.base : e.T;
      const lab = {} as Row["lab"];
      for (const tf of TFS) {
        const s = seriesOf(tf, bars[pair][tf], holes[tf], GAPS, true);
        const L = labelsOf(s, Float64Array.of(C - FINE));
        const c = await chartRead(pair, tf, C + LAG, fetcher);
        lab[tf] = { state: L.state[0], excl: L.state[0] >= 0 ? L.excl[0] : 9, chart: c.state };
      }
      const dir = e.side === "BUY" ? 1 : -1;
      const q = q15.find((x) => Date.parse(x.datetime) === e.open);
      const entry = q ? (dir === 1 ? q.ask.close : q.bid.close) : NaN;
      const f = bars[pair]["5min"];
      rows.push({ e, sig, C, lab, w2: follow(f, e.T, dir, entry, e.E, 10, 13, pip), w1: follow(f, e.T, dir, entry, e.E, 4, 13, pip) });
    }
  }
  rows.sort((a, b) => a.e.sent - b.e.sent);
  if (st.failed) throw new Error(`GMO reads failed: ${st.failed}`);

  const name = (s: number) => (s >= 0 ? STATE_NAMES[s] : "-");
  const verdict = (c: number, r: Row): number => {
    const d = r.e.side === "BUY" ? 1 : -1;
    const ok = (tf: LTf) => r.lab[tf].state >= 0 && r.lab[tf].excl === 0;
    const against = (tf: LTf) => DIR_OF[r.lab[tf].state] === -d;
    if (c === 0) return ok("1h") ? (against("1h") ? -1 : 1) : 0;
    if (c === 1) return ok("4h") ? (against("4h") ? -1 : 1) : 0;
    if (c === 2) return ok("1h") && ok("4h") ? (against("1h") && against("4h") ? -1 : 1) : 0;
    return ok("15min") ? (against("15min") ? -1 : 1) : 0;
  };
  const jst = (ms: number) => new Date(ms + 9 * HOUR).toISOString().slice(5, 16).replace("T", " ");
  console.log(`\n== each email (JST; labels at C, what the chart showed a minute later in []; TP10/SL13 and TP4/SL13 from E)`);
  let chartBad = 0;
  for (const r of rows) {
    const labs = TFS.map((tf) => {
      const same = r.lab[tf].chart === (r.lab[tf].state >= 0 ? name(r.lab[tf].state) : null);
      if (!same) chartBad++;
      return `${tf} ${name(r.lab[tf].state)}${r.lab[tf].excl ? `(x${r.lab[tf].excl})` : ""}${same ? "" : ` [chart ${r.lab[tf].chart}]`}`;
    }).join(", ");
    const out = (o: Outcome) => `${o.end}${o.end === "open" ? " now" : ` ${jst(o.at)}`} ${o.pips >= 0 ? "+" : ""}${o.pips.toFixed(1)}`;
    const v = CANDS.map((n, c) => `${n}:${["?", "kept", "out"][verdict(c, r) === 1 ? 1 : verdict(c, r) === -1 ? 2 : 0]}`).join(" ");
    console.log(`${jst(r.e.T)} ${r.e.pair} ${r.e.side} E ${r.e.E}${r.sig ? (r.sig.late ? " (late)" : "") : " (no signal found)"} | ${labs} | TP10/SL13 ${out(r.w2)} | TP4/SL13 ${out(r.w1)} | ${v}`);
  }
  console.log(`chart check: ${rows.length * TFS.length} readings, ${chartBad} different`);
  const sum = (rs: Row[], key: "w2" | "w1") => {
    const tp = rs.filter((r) => r[key].end === "TP").length;
    const sl = rs.filter((r) => r[key].end === "SL").length;
    const open = rs.filter((r) => r[key].end === "open").length;
    const done = rs.filter((r) => r[key].end !== "open");
    const p = done.reduce((a, r) => a + r[key].pips, 0);
    const po = rs.filter((r) => r[key].end === "open").reduce((a, r) => a + r[key].pips, 0);
    return `${rs.length} emails: TP first ${tp}, stop first ${sl}, open ${open}; win ${tp + sl ? ((100 * tp) / (tp + sl)).toFixed(0) : "-"}% of decided; decided ${p >= 0 ? "+" : ""}${p.toFixed(1)} pips (${done.length ? (p / done.length).toFixed(1) : "-"} a trade), open now ${po >= 0 ? "+" : ""}${po.toFixed(1)} pips`;
  };
  console.log(`\n== all the emails`);
  console.log(`TP10/SL13: ${sum(rows, "w2")}`);
  console.log(`TP4/SL13:  ${sum(rows, "w1")}`);
  CANDS.forEach((n, c) => {
    const kept = rows.filter((r) => verdict(c, r) === 1);
    const out = rows.filter((r) => verdict(c, r) === -1);
    const un = rows.filter((r) => verdict(c, r) === 0);
    console.log(`\n== ${n}: kept ${kept.length}, left out ${out.length}, unreadable ${un.length}`);
    console.log(`kept     TP10/SL13: ${sum(kept, "w2")}`);
    console.log(`kept     TP4/SL13:  ${sum(kept, "w1")}`);
    console.log(`left out TP10/SL13: ${sum(out, "w2")}`);
    console.log(`left out TP4/SL13:  ${sum(out, "w1")}`);
  });
  console.log(`\nloads: requests ${st.requests}, kept files ${st.cached}, read again ${st.partial}, failed ${st.failed}`);
};

await main();
