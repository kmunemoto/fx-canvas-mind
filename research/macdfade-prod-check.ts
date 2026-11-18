// The study check of the MACD fade on 1-hour bars (research/macdfade1h-prod-spec.md section 7.2): the shared function
// the email runs gives the study's entries. The study (research/macdfade15.ts with TF=1h, its rule
// research/macdfade15-spec.md "On 1-hour bars (TF=1h)", checked by its own Python research/macdfade15-check.py) is
// written apart from the shared code; this ties the code the function runs to it: _shared/macd-fade.ts
// fadeCloseEntryAt for the entry, and signal-alerts/indicators.ts ridePaidAt for the price (the bar's ask close for a
// BUY, its bid close for a SELL, track-outcomes/quotes.ts fillSide, as GMO wrote them).
//
// Run after the study, with the same environment (research/macdfade15.ts :50-59):
//   TF        must be 1h (not given or empty is the study's 15min: refused)
//   MODE      walkfiles: the walk's GMO files under $OUT/gmo (written, and with MESS=1 made untidy, by the study);
//             real: research/.cache (the study read or fetched them there). Never fetched here: a missing file fails.
//   OUT       the study's output folder (rows.csv, summary.json); the study's default for 1h research/out/macdfade1h
//   START, END, LOAD_FROM   the study's (defaults 2024-01-01T00:00:00Z, 2026-11-10T21:00:00Z, 2023-10-01T00:00:00Z)
//   SHARE is not read: the function's share is FADE_SHARE, and the study's summary.json must say it ran at it.
//
// The five pairs' 1-hour bars are loaded exactly as the study loads them (research/macdfade15.ts loadFiles and
// chartOf, :85-95, :1057-1069): loadTf(src, pair, "1h", LOAD_FROM, END, st, weekendOutOf("inside")) → quotesOf →
// historyRead(pair, "1h", quotes, END), each chart bar with its own quote. For every bar n whose close T = open + 1
// hour is in [START, END): fewer than 600 bars up to it counted short; else fadeCloseEntryAt on the 600 closes ending
// at n; an entry is mailed when one of the function's reads at T + 0, 3 and 5 minutes (a second into the minute,
// :78-79) is not in isPossiblyClosed, else counted not mailed; a mailed entry's price is ridePaidAt(side, bar n's
// quote). Against the study, keyed by pair|open: rows.csv's fade rows are the same set of bars, each with the same
// zside, side, entry and share0 (as written); per pair summary.json's entries, notMailed, signals (the two together),
// short, zoneless and judged. Also, at every such bar, the function's Z and Zp (closeZonesAt) bit for bit against the
// spec's definitions read again here (Z = zoneAt(macd(w), 599), Zp = zoneAt(macd(the 599 closes before n), 598)).
// Any difference: the first 20 printed and exit 1.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import { LEVEL_WINDOW, zoneAt } from "../supabase/functions/_shared/macd-level.ts";
import { macd } from "../supabase/functions/_shared/macd.ts";
import { closeZonesAt, FADE_SHARE, type FadeZone, fadeCloseEntryAt } from "../supabase/functions/_shared/macd-fade.ts";
import { ridePaidAt } from "../supabase/functions/signal-alerts/indicators.ts";
import { newLoadStats, type Source } from "./ownerhold-data.ts";
import { loadTf, quotesOf } from "./trend-data.ts";
import { weekendOutOf } from "./trend-labels.ts";

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const W = LEVEL_WINDOW;
const SHOW = 20;

const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const TF = env("TF", "") || "15min";
if (TF !== "1h") throw new Error(`TF "${TF}": this check is for the 1-hour email (TF=1h)`);
const STEP = HOUR;
const MODE = env("MODE", "");
if (MODE !== "walkfiles" && MODE !== "real") throw new Error(`MODE "${MODE}": walkfiles or real (the study's run being checked)`);
const START = Date.parse(env("START", "2024-01-01T00:00:00Z"));
const END = Date.parse(env("END", "2026-11-10T21:00:00Z"));
const LOAD_FROM = Date.parse(env("LOAD_FROM", "2023-10-01T00:00:00Z"));
const OUT = env("OUT", "research/out/macdfade1h");
if (!(Number.isFinite(START) && Number.isFinite(END) && Number.isFinite(LOAD_FROM) && LOAD_FROM <= START && START < END)) throw new Error("LOAD_FROM <= START < END, as times");
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

// the function reads the 1-hour chart 0, 3 and 5 minutes after a close (indicators.ts gmoIntervalsDue), from a
// second into the minute, and does not run while isPossiblyClosed holds (research/macdfade15.ts mailedAt)
const READS = [0, 3, 5] as const;
const mailedAt = (T: number): boolean => READS.some((r) => !isPossiblyClosed(T + r * MINUTE + 1000));

const zoneOf = (r: ReturnType<typeof zoneAt>): FadeZone | null => (r === null ? null : { m: r.m, top: r.top, bottom: r.bottom });
const sameBits = (a: FadeZone | null, b: FadeZone | null) => (a === null || b === null ? a === b : Object.is(a.m, b.m) && Object.is(a.top, b.top) && Object.is(a.bottom, b.bottom));

interface Row {
  zside: string;
  side: string;
  entry: string;
  share0: string;
}
interface PairSum {
  pair: string;
  short: number;
  zoneless: number;
  judged: number;
  signals: number;
  entries: number;
  notMailed: number;
}

const check = async (bad: (m: string) => void) => {
  const summary = JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`));
  const meta = summary.meta ?? {};
  if (meta.tf !== "1h") bad(`the study's summary.json says tf ${JSON.stringify(meta.tf)}, not "1h"`);
  if (meta.share !== FADE_SHARE) bad(`the study's summary.json says share ${meta.share}; the function's is ${FADE_SHARE}: not the same rule`);
  if (meta.start !== iso(START) || meta.end !== iso(END) || meta.loadFrom !== iso(LOAD_FROM)) {
    bad(`the study's period ${meta.loadFrom} / ${meta.start} / ${meta.end} is not this check's ${iso(LOAD_FROM)} / ${iso(START)} / ${iso(END)} (LOAD_FROM / START / END)`);
  }
  const sumPairs: PairSum[] = summary.pairs ?? [];
  if (sumPairs.map((p) => p.pair).join() !== PAIRS.join()) bad(`summary.json's pairs ${sumPairs.map((p) => p.pair).join(", ")}, not ${PAIRS.join(", ")}`);

  // the study's fade rows by pair|open
  const text = await Deno.readTextFile(`${OUT}/rows.csv`);
  const lines = text.split("\n");
  const HEAD = "dir,pair,open,T0,zside,side,entry,share0,target,result,T,exit,pips,mae,minutes";
  if (lines[0] !== HEAD) bad(`rows.csv's header "${lines[0]}", not "${HEAD}"`);
  if (lines[lines.length - 1] !== "") bad("rows.csv does not end with a newline");
  const study = new Map<string, Row>();
  let flowRows = 0;
  for (const line of lines.slice(1, -1)) {
    const c = line.split(",");
    if (c.length !== 15) {
      bad(`rows.csv: a line of ${c.length} cells: ${line}`);
      continue;
    }
    if (c[0] === "flow") flowRows++;
    if (c[0] !== "fade") continue;
    const key = `${c[1]}|${c[2]}`;
    if (study.has(key)) bad(`rows.csv: two fade rows at ${key}`);
    if (Date.parse(c[3]) !== Date.parse(c[2]) + STEP) bad(`rows.csv: ${key}: T0 ${c[3]} is not the bar's open + 1 hour`);
    study.set(key, { zside: c[4], side: c[5], entry: c[6], share0: c[7] });
  }
  if (flowRows !== study.size) bad(`rows.csv: ${study.size} fade rows, ${flowRows} flow rows`);

  const src: Source = { dir: MODE === "walkfiles" ? `${OUT}/gmo` : "research/.cache", fetch: false };
  const st = newLoadStats();
  const weekend = weekendOutOf("inside");
  const mine = new Map<string, Row & { price: number; share: number }>();
  const tot = { bars: 0, inRange: 0, short: 0, zoneless: 0, judged: 0, zRead: 0, signals: 0, entries: 0, notMailed: 0, top: 0, bottom: 0 };
  for (const [pi, pair] of PAIRS.entries()) {
    const q = await loadTf(src, pair, "1h", LOAD_FROM, END, st, weekend);
    const qs: QuoteCandle[] = quotesOf(q.bars);
    const byT = new Map(qs.map((x) => [Date.parse(x.datetime), x]));
    const t: number[] = [];
    const closes: number[] = [];
    const quotes: QuoteCandle[] = [];
    for (const c of historyRead(pair, "1h", qs, END).candles) {
      const tt = Date.parse(c.datetime.replace(" ", "T") + "Z");
      const qq = byT.get(tt);
      if (!qq) throw new Error(`${pair} ${iso(tt)}: a chart bar without its quote`);
      t.push(tt);
      closes.push(c.close);
      quotes.push(qq);
    }
    const c = { inRange: 0, short: 0, zoneless: 0, judged: 0, entries: 0, notMailed: 0 };
    for (let n = 0; n < t.length; n++) {
      const T0 = t[n] + STEP;
      if (T0 < START || T0 >= END) continue;
      c.inRange++;
      if (n < W - 1) {
        c.short++;
        // fewer than 600 closes: the function reads nothing
        if (fadeCloseEntryAt(closes.slice(0, n + 1)) !== null) bad(`${pair}|${iso(t[n])}: an entry on ${n + 1} closes`);
        continue;
      }
      const w = closes.slice(n - (W - 1), n + 1);
      // the line at the close: the function's Z and Zp against the spec's definitions read again
      const zs = closeZonesAt(w);
      const z = zoneOf(zoneAt(macd(w), W - 1));
      const zp = zoneOf(zoneAt(macd(closes.slice(n - (W - 1), n)), W - 2));
      const again = z === null || zp === null ? null : { z, zp };
      tot.zRead++;
      if ((zs === null) !== (again === null) || (zs !== null && again !== null && !(sameBits(zs.z, again.z) && sameBits(zs.zp, again.zp)))) {
        bad(`${pair}|${iso(t[n])}: the function's Z / Zp ${JSON.stringify(zs)}, read again ${JSON.stringify({ z, zp })}`);
      }
      if (zs === null) {
        c.zoneless++;
        continue;
      }
      c.judged++;
      const e = fadeCloseEntryAt(w);
      if (e === null) continue;
      if (!mailedAt(T0)) {
        c.notMailed++;
        continue;
      }
      c.entries++;
      if (e.zside === "top") tot.top++;
      else tot.bottom++;
      const price = ridePaidAt(e.side, quotes[n]);
      mine.set(`${pair}|${iso(t[n])}`, { zside: e.zside, side: e.side, entry: String(price), share0: String(e.share0), price, share: e.share0 });
    }
    tot.bars += t.length;
    tot.inRange += c.inRange;
    tot.short += c.short;
    tot.zoneless += c.zoneless;
    tot.judged += c.judged;
    tot.signals += c.entries + c.notMailed;
    tot.entries += c.entries;
    tot.notMailed += c.notMailed;
    const p = sumPairs[pi];
    console.log(
      `${pair}: chart ${t.length} 1-hour bars, ${c.inRange} closing in [START, END) (short ${c.short}, zoneless ${c.zoneless}, judged ${c.judged}); the function: ${c.entries + c.notMailed} signals, ${c.entries} mailed, ${c.notMailed} not mailed (weekend gate) | the study: ${p?.signals} signals, ${p?.entries} entries, ${p?.notMailed} not mailed (short ${p?.short}, zoneless ${p?.zoneless}, judged ${p?.judged})`,
    );
    if (!p || p.pair !== pair) continue;
    const same = (what: keyof typeof c | "signals", mineV: number, theirs: number) => {
      if (mineV !== theirs) bad(`${pair}: ${what}: the function ${mineV}, the study ${theirs}`);
    };
    same("entries", c.entries, p.entries);
    same("notMailed", c.notMailed, p.notMailed);
    same("signals", c.entries + c.notMailed, p.signals);
    same("short", c.short, p.short);
    same("zoneless", c.zoneless, p.zoneless);
    same("judged", c.judged, p.judged);
  }
  console.log(`files ${st.files} cached ${st.cached} requests ${st.requests} failed ${st.failed} ${st.failedExamples.join("; ")}`);
  if (st.requests !== 0) bad(`${st.requests} requests made (none should be: the files are read only)`);
  if (st.failed) bad(`${st.failed} files could not be read from ${src.dir}`);

  let compared = 0;
  for (const [key, m] of mine) {
    const s = study.get(key);
    if (!s) {
      bad(`${key}: an entry of the function (${m.zside} ${m.side} at ${m.entry}, share0 ${m.share0}) not in the study's rows`);
      continue;
    }
    compared++;
    const diff: string[] = [];
    if (s.zside !== m.zside) diff.push(`zside ${m.zside} / ${s.zside}`);
    if (s.side !== m.side) diff.push(`side ${m.side} / ${s.side}`);
    if (Number(s.entry) !== m.price || s.entry !== m.entry) diff.push(`entry ${m.entry} / ${s.entry}`);
    if (Number(s.share0) !== m.share || s.share0 !== m.share0) diff.push(`share0 ${m.share0} / ${s.share0}`);
    if (diff.length) bad(`${key}: the function / the study: ${diff.join("; ")}`);
  }
  for (const [key, s] of study) if (!mine.has(key)) bad(`${key}: a fade row of the study (${s.zside} ${s.side} at ${s.entry}, share0 ${s.share0}) the function does not give`);
  console.log(
    `bars: ${tot.bars} chart bars, ${tot.inRange} closing in range (short ${tot.short}, zoneless ${tot.zoneless}, judged ${tot.judged}); Z and Zp read again bit for bit at ${tot.zRead}`,
  );
  console.log(
    `entries: the function ${mine.size} mailed (top SELL ${tot.top}, bottom BUY ${tot.bottom}) and ${tot.notMailed} not mailed, ${tot.signals} signals; the study's fade rows ${study.size}; compared field by field (zside, side, entry, share0) ${compared}`,
  );
  if (mine.size === 0 && study.size === 0) bad("no entry on either side: nothing was compared");
};

if (import.meta.main) {
  console.log(`== the shipped function (fadeCloseEntryAt at ${FADE_SHARE}, ridePaidAt) against the study's ${OUT}; tf ${TF}, mode ${MODE}, loadFrom ${iso(LOAD_FROM)} start ${iso(START)} end ${iso(END)}`);
  const diffs: string[] = [];
  await check((msg) => diffs.push(msg));
  if (diffs.length) {
    console.log(`${diffs.length} differences; the first ${Math.min(SHOW, diffs.length)}:`);
    for (const d of diffs.slice(0, SHOW)) console.log(`  ${d}`);
    console.log("PROD CHECK FAILED");
    Deno.exit(1);
  }
  console.log("PROD CHECK OK: THE FUNCTION GIVES THE STUDY'S ENTRIES");
}
