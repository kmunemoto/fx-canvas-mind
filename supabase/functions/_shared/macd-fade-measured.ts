// What was measured of the MACD fade, one run per chart (research/macdfade15min-prod-spec.md section 4.5, built on v40's
// form, research/macdfade1h-prod-spec.md 4.5), the one place the pairs' emails and the app's notes take it from, and the
// measured paragraph built from it, ja and en, word for word as section 4.5 writes it.
//
// v41, per pair (the owner, 2026-11-19: each pair's email on the timeframe of its higher win rate; research/
// macdfade15min-prod-spec.md section 1): USD/JPY and AUD/USD are mailed on 15-minute bars, EUR/JPY, AUD/JPY and EUR/USD
// on 1-hour bars (signal-alerts indicators.ts MACDH_INTERVAL_OF; FADE_MAILED_ON below says the same, and
// src/test/macd-fade.test.ts holds the two together). Each pair's mail reads the run of its own chart only (the
// signal's interval is passed in as `tf`); nothing of the other chart's run appears in it. The two runs, never mixed:
//   "15min"  the study's TF=15min re-run on GMO's files read afresh (research/macdfade15-spec.md "Result of the re-run on
//            GMO's files read afresh": Actions run 44535888012 on main 9ca2054); its summary.json is in the repository
//            as research/ledger/macdfade15-summary.json. It replaces the first 15-minute run, 44077464383, which read
//            three GMO 1-minute day files of 2025-06-20 cut short.
//   "1h"     the study's TF=1h re-run on whole GMO files (research/macdfade15-spec.md "Result of the 1-hour re-run on
//            whole GMO files": Actions run 44555599946, commit e4b16c7); its summary.json is in the repository as
//            research/ledger/macdfade1h-whole-summary.json. It replaces v40's run 44099401423
//            (research/ledger/macdfade1h-summary.json, which read the same three short files: the same fade and flow,
//            another baseline; it stays as the record of v40's numbers).
// Both copies were decoded from their job's one base64 line (section 4.5 route 1). The values below were written out
// from them by a script (JS's own String(n), as stored: unrounded), not copied by hand; src/test/macd-fade.test.ts
// reads each file and pins every value of its run to it. Measured as the owner holds (CLAUDE.md): in at the bar's
// close, take profit 10 pips, no stop, every signal taken, open trades valued at the last minute loaded.
//
// 〔chance〕 is not in summary.json: the study prints fade − base and fade − flow (all) beside the same gaps on ten
// driftless walks (null.json, sha256 below). The walks' ranges are held here as printed (2 decimals). On 15-minute
// bars fade − base is below its range and fade − flow inside it (research/macdfade15-spec.md: −0.91 against
// −0.80..+2.24, −0.78 against −2.25..+5.70); on 1-hour bars both are inside (+0.05 against −4.10..+0.83, +5.34 against
// −5.42..+5.81). Section 4.5 writes a sentence for each of these two cases; any other case stops the build. The case
// is chosen from the unrounded gaps.
//
// THE PARAGRAPH (section 4.5): the mail's (fadeMeasuredLine: one pair, on its own chart) and the notes' (fadeMeasuredNotes:
// the five pairs of one chart, with the changes 4.5's "The notes' version" lists, and no others). Written as 4.5 says:
// the bar's word from the run's chart (「15分足」 / "15-minute", 「1時間足」 / "1-hour"; any other chart stops the build);
// 〔mailedOn〕 right after the first sentence (which pairs' mails are judged on this chart, from FADE_MAILED_ON; the
// others' on the other chart; every number of the paragraph measured on this one); 〔from〕 / 〔to〕 in UTC (ja
// 「2024年1月1日 0:00（UTC）」, en "1 January 2024, 00:00 UTC"); a mean to 2 decimals with its sign, a sum and the worst
// to 1 with their sign, the largest loss on the way to 1 (the study's print); a minus as toFixed writes it ("-0.26");
// thousands separators by one rule for ja and en (1,490; 2,243.6; -9,820.9); durations in minutes under 2 hours, hours
// under 2 days, days beyond, to the nearest whole unit, 「約」 / "about" before one that was rounded; after the pair's
// sentence (the notes': the five pairs' means), the per-pair chance sentence. The 〔open〕 = 0 and 〔tp〕 = 0 variants
// are v40's (4.5: as research/macdfade1h-prod-spec.md 4.5); 〔trades〕 = 0 stops the build.
//
// It imports nothing from the signal-alerts function (its indicators.ts imports this module, and the notes are built
// while it loads: an import back would read indicators.ts's constants before they are set). Pure: no clock, no I/O.

import { pairJa } from "./pair-names.ts";

export type FadeLang = "ja" | "en";
// the charts a run of record is held for (section 4.5: one run per chart)
export type FadeTf = "15min" | "1h";
export const FADE_TFS: readonly FadeTf[] = ["15min", "1h"];

// the values the paragraph is built from (a summary.json's, plus the docs section and the walks' ranges); null where
// the study writes null (no open trade: the open trades' fields; no tp trade: the tp times)
export interface FadeMeasured {
  // summary.json meta: the chart, the share, the take profit, the entries' closes in [from, to)
  tf: string;
  share: number;
  tp: number;
  from: string;
  to: string;
  // dirs.fade.all
  fade: {
    trades: number;
    tp: number;
    open: number;
    pipsMean: number | null;
    maeMedian: number | null;
    maeMax: number | null;
    tpMinutesMedian: number | null;
    tpMinutesP90: number | null;
    tpMinutesMax: number | null;
    openPipsSum: number | null;
    openPipsWorst: number | null;
    openMinutesMax: number | null;
  };
  // dirs.flow.all.pipsMean, base.all.pipsMean
  flowMean: number | null;
  baseMean: number | null;
  // summary.json pairs[] in its order (the pairs' order): dirs.fade.<pair>.pipsMean, base.<pair>.pipsMean,
  // pairs[].notMailed
  pairs: ReadonlyArray<{ pair: string; mean: number | null; baseMean: number | null; notMailed: number }>;
  // the sum of pairs[].notMailed
  notMailed: number;
  // the docs §8 section that records the run
  sec: string;
  // 〔chance〕: the ten driftless walks' ranges of fade − base and fade − flow (all, pips a trade), as printed
  chance: { nullSha256: string; fadeMinusBase: { lo: number; hi: number }; fadeMinusFlow: { lo: number; hi: number } };
}

// where each run of FADE_MEASURED comes from (section 4.5's table): the run, its commit, the run it replaces and why,
// the ledger copy and its sha256 and size (the 15-minute one also the sha256 without its `,\n  "tf": "15min"` bytes,
// which 53f7003 added: the form .github/workflows/macdfade15.yml holds the run to)
export const FADE_MEASURED_SOURCE = {
  "15min": {
    run: 44535888012,
    commit: "9ca2054",
    replaces: 44077464383,
    replacedWhy: "three GMO 1-minute day files of 2025-06-20 kept cut short",
    ledger: "research/ledger/macdfade15-summary.json",
    summarySha256: "eacb7815d7779be716b24e559c0aea139e6455910abcf4b1ec59ab4d8c5eb188",
    summaryBytes: 16817,
    summarySha256WithoutTf: "74a4a230a291d68a8e8169ea293a5428f46863ffc0ed86804522f4f509cc888b",
  },
  "1h": {
    run: 44555599946,
    commit: "e4b16c7",
    replaces: 44099401423,
    replacedWhy: "v40's run (research/ledger/macdfade1h-summary.json, sha256 60edab22…): the same three GMO 1-minute day files of 2025-06-20 kept cut short",
    ledger: "research/ledger/macdfade1h-whole-summary.json",
    summarySha256: "d59b64c6212e594f0b3b4a89bb1683a6a5f98652208cafb59f6420bb352c833b",
    summaryBytes: 16648,
  },
} as const;

export const FADE_MEASURED: Readonly<Record<FadeTf, FadeMeasured>> = {
  "15min": {
    // written out by a script from research/ledger/macdfade15-summary.json (16817 bytes, sha256
    // eacb7815d7779be716b24e559c0aea139e6455910abcf4b1ec59ab4d8c5eb188), unrounded as stored
    tf: "15min",
    share: 0.96,
    tp: 10,
    from: "2024-01-01T00:00:00Z",
    to: "2026-11-10T21:00:00Z",
    fade: {
      trades: 6006,
      tp: 5926,
      open: 80,
      pipsMean: 2.410173160173158,
      maeMedian: 11.9,
      maeMax: 2975.8,
      tpMinutesMedian: 143,
      tpMinutesP90: 5681,
      tpMinutesMax: 784561,
      openPipsSum: -44784.49999999998,
      openPipsWorst: -1913.4,
      openMinutesMax: 959205,
    },
    flowMean: 3.1935730935730926,
    baseMean: 3.3164202489249752,
    pairs: [
      { pair: "USD/JPY", mean: 2.671487263763353, baseMean: 5.690599321629803, notMailed: 1 },
      { pair: "EUR/JPY", mean: 1.287203389830509, baseMean: 3.4066914550899026, notMailed: 0 },
      { pair: "AUD/JPY", mean: -0.8158783783783784, baseMean: -0.2981451258107079, notMailed: 1 },
      { pair: "EUR/USD", mean: 3.8550374687760183, baseMean: 2.6006308275265066, notMailed: 0 },
      { pair: "AUD/USD", mean: 4.935866013071895, baseMean: 5.182324766189319, notMailed: 1 },
    ],
    notMailed: 3,
    // section 4.5's 〔sec〕: the docs/OPERATIONS.md section of the release (8.156, the next after §8.155; if another
    // takes it first, the next free one, written at the release), the same on both charts
    sec: "8.156",
    // research/macdfade15-spec.md "Result of the re-run on GMO's files read afresh" (the job's printed lines; null.json is not in the repository)
    chance: {
      nullSha256: "a0d390456ebc5ce5747bc88623dc756440165b55e19a2689c44041c7c1d6791e",
      fadeMinusBase: { lo: -0.80, hi: 2.24 },
      fadeMinusFlow: { lo: -2.25, hi: 5.70 },
    },
  },
  "1h": {
    // written out by a script from research/ledger/macdfade1h-whole-summary.json (16648 bytes, sha256
    // d59b64c6212e594f0b3b4a89bb1683a6a5f98652208cafb59f6420bb352c833b), unrounded as stored
    tf: "1h",
    share: 0.96,
    tp: 10,
    from: "2024-01-01T00:00:00Z",
    to: "2026-11-10T21:00:00Z",
    fade: {
      trades: 1490,
      tp: 1468,
      open: 22,
      pipsMean: 3.261140939597316,
      maeMedian: 10.7,
      maeMax: 2243.6,
      tpMinutesMedian: 140,
      tpMinutesP90: 4489,
      tpMinutesMax: 687037,
      openPipsSum: -9820.900000000003,
      openPipsWorst: -1733.2,
      openMinutesMax: 888900,
    },
    flowMean: -2.080939597315436,
    baseMean: 3.2069648671807958,
    pairs: [
      { pair: "USD/JPY", mean: -0.2594890510948906, baseMean: 5.744715795487004, notMailed: 2 },
      { pair: "EUR/JPY", mean: 4.3036666666666665, baseMean: 3.276229648671806, notMailed: 0 },
      { pair: "AUD/JPY", mean: 4.438541666666666, baseMean: -0.7516938017709219, notMailed: 2 },
      { pair: "EUR/USD", mean: 3.1104430379746835, baseMean: 2.610322764924308, notMailed: 3 },
      { pair: "AUD/USD", mean: 4.4163461538461535, baseMean: 5.155249928591839, notMailed: 4 },
    ],
    notMailed: 11,
    // section 4.5's 〔sec〕: the docs/OPERATIONS.md section of the release (8.156, the next after §8.155; if another
    // takes it first, the next free one, written at the release), the same on both charts
    sec: "8.156",
    // research/macdfade15-spec.md "Result of the 1-hour re-run on whole GMO files" (the job's printed lines; the generator's walks, as v40's run's; null.json is not in the repository)
    chance: {
      nullSha256: "3d285440123d50ac776228092b1a2560db12ff1d114b97bbec676350175b9b96",
      fadeMinusBase: { lo: -4.10, hi: 0.83 },
      fadeMinusFlow: { lo: -5.42, hi: 5.81 },
    },
  },
};

// 〔mailedOn〕 (section 4.5): the pairs whose mails are judged on each chart, in this order, the same as the function's
// map (indicators.ts MACDH_INTERVAL_OF; src/test/macd-fade.test.ts pins the two together, and that no pair is in both)
export const FADE_MAILED_ON: Readonly<Record<FadeTf, readonly string[]>> = {
  "15min": ["USD/JPY", "AUD/USD"],
  "1h": ["EUR/JPY", "AUD/JPY", "EUR/USD"],
};

// the part of a summary.json (research/macdfade15.ts summaryOf) the paragraph reads
export interface FadeSummary {
  meta: { start: string; end: string; share: number; tp: number; tf?: string };
  pairs: ReadonlyArray<{ pair: string; notMailed: number }>;
  dirs: { fade: Record<string, FadeSummaryGroup>; flow: Record<string, FadeSummaryGroup> };
  base: Record<string, FadeSummaryGroup>;
}
interface FadeSummaryGroup {
  trades: number;
  tp: number;
  open: number;
  pipsMean: number | null;
  maeMedian: number | null;
  maeMax: number | null;
  tpMinutesMedian: number | null;
  tpMinutesP90: number | null;
  tpMinutesMax: number | null;
  openPipsSum: number | null;
  openPipsWorst: number | null;
  openMinutesMax: number | null;
}

// a summary.json's values as FadeMeasured (the same fields FADE_MEASURED holds; sec and chance given). A summary
// with no meta.tf is the 15-minute study's before 53f7003 added it.
export const fadeMeasuredFromSummary = (s: FadeSummary, rest: Pick<FadeMeasured, "sec" | "chance">): FadeMeasured => {
  const f = s.dirs.fade.all;
  return {
    tf: s.meta.tf ?? "15min",
    share: s.meta.share,
    tp: s.meta.tp,
    from: s.meta.start,
    to: s.meta.end,
    fade: {
      trades: f.trades,
      tp: f.tp,
      open: f.open,
      pipsMean: f.pipsMean,
      maeMedian: f.maeMedian,
      maeMax: f.maeMax,
      tpMinutesMedian: f.tpMinutesMedian,
      tpMinutesP90: f.tpMinutesP90,
      tpMinutesMax: f.tpMinutesMax,
      openPipsSum: f.openPipsSum,
      openPipsWorst: f.openPipsWorst,
      openMinutesMax: f.openMinutesMax,
    },
    flowMean: s.dirs.flow.all.pipsMean,
    baseMean: s.base.all.pipsMean,
    pairs: s.pairs.map((p) => ({ pair: p.pair, mean: s.dirs.fade[p.pair].pipsMean, baseMean: s.base[p.pair].pipsMean, notMailed: p.notMailed })),
    notMailed: s.pairs.reduce((x, p) => x + p.notMailed, 0),
    sec: rest.sec,
    chance: rest.chance,
  };
};

// ---- formatting (section 4.5) ------------------------------------------------------------------------------------

// thousands separators in the whole part, one rule for ja and en: "-9820.9" → "-9,820.9"
const grouped = (s: string): string => {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf(".");
  const whole = dot < 0 ? body : body.slice(0, dot);
  const frac = dot < 0 ? "" : body.slice(dot);
  return `${neg ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac}`;
};
// to dp decimals as toFixed writes it (a minus "-"), grouped
const fixed = (v: number, dp: number): string => grouped(v.toFixed(dp));
// with its sign: "+3.26", "-0.26"
const signed = (v: number, dp: number): string => {
  const s = fixed(v, dp);
  return s.startsWith("-") ? s : `+${s}`;
};
const count = (v: number): string => grouped(String(v));

// minutes under 2 hours, hours under 2 days, days beyond, to the nearest whole unit; 「約」 / "about" before one that
// was rounded
const duration = (minutes: number, lang: FadeLang): string => {
  const [per, ja, en] = minutes < 120 ? [1, "分", "minute"] : minutes < 2 * 24 * 60 ? [60, "時間", "hour"] : [24 * 60, "日", "day"];
  const v = Math.round(minutes / per);
  const about = v * per !== minutes;
  return lang === "ja" ? `${about ? "約" : ""}${count(v)}${ja}` : `${about ? "about " : ""}${count(v)} ${en}${v === 1 ? "" : "s"}`;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// "2024-01-01T00:00:00Z" as 「2024年1月1日 0:00（UTC）」 / "1 January 2024, 00:00 UTC" (the minutes always written)
const utcOf = (iso: string, lang: FadeLang): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) throw new Error(`the measured paragraph: "${iso}" is not a time`);
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return lang === "ja"
    ? `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${d.getUTCHours()}:${mm}（UTC）`
    : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, "0")}:${mm} UTC`;
};

const need = (v: number | null, what: string): number => {
  if (v === null || !Number.isFinite(v)) throw new Error(`the measured paragraph: ${what} is ${v} (cannot be built)`);
  return v;
};

// own keys only: a chart is a run's when FADE_MEASURED holds it
const hasRun = (tf: string): tf is FadeTf => Object.prototype.hasOwnProperty.call(FADE_MEASURED, tf);
const runOf = (tf: string): FadeMeasured | undefined => (hasRun(tf) ? FADE_MEASURED[tf] : undefined);

// the bar's word (section 4.5), from the run's chart: any other chart stops the build
const barWord = (tf: string, lang: FadeLang): string => {
  if (tf === "15min") return lang === "ja" ? "15分足" : "15-minute";
  if (tf === "1h") return lang === "ja" ? "1時間足" : "1-hour";
  throw new Error(`the measured paragraph: the run's chart is "${tf}", not 15min or 1h`);
};
const otherTf = (tf: FadeTf): FadeTf => (tf === "15min" ? "1h" : "15min");

// "USD/JPY and AUD/USD", "EUR/JPY, AUD/JPY and EUR/USD" (no count word)
const andList = (xs: readonly string[]): string => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// 〔mailedOn〕 (section 4.5), the same in the mail and the notes: FADE_MAILED_ON[tf] in its order, then the run's other
// pairs in the run's order (`pairJa` in ja, the codes in en). A pair of FADE_MAILED_ON[tf] that the run does not
// hold, or an empty list on either side, cannot be written: the build stops.
const mailedOnOf = (m: FadeMeasured, tf: FadeTf, lang: FadeLang): string => {
  const on = FADE_MAILED_ON[tf];
  const runPairs = m.pairs.map((p) => p.pair);
  for (const p of on) if (!runPairs.includes(p)) throw new Error(`the measured paragraph: ${p}, mailed on ${tf}, is not among the run's pairs`);
  const others = runPairs.filter((p) => !on.includes(p));
  if (on.length === 0 || others.length === 0) throw new Error(`the measured paragraph: 〔mailedOn〕 of ${tf} has an empty list`);
  const here = barWord(tf, lang);
  const there = barWord(otherTf(tf), lang);
  return lang === "ja"
    ? `この5ペアのうち、メールを${here}で判定するのは${on.map((p) => pairJa(p)).join("・")}です。${others.map((p) => pairJa(p)).join("・")}のメールは${there}で判定し、そのメールには${there}で測った数字を載せています（この段落の数字は、どのペアの分も、すべて${here}で測ったものです）。`
    : `Of these five pairs, the email is judged on ${here} bars for ${andList(on)}. The emails of ${andList(others)} are judged on ${there} bars and carry the numbers measured on ${there} bars (every number in this paragraph, for every pair, was measured on ${here} bars).`;
};

// 〔baseWhat〕 (section 4.5), from the run's chart; the same in the mail and the notes (it holds no 「このメール」)
const baseWhatOf = (lang: FadeLang, bar: string): string =>
  lang === "ja"
    ? `5ペアの${bar}ごとの最初の1分に（週末の止まっている時間に確定した足を除く。買いと売りを1回ずつ）`
    : `at the first minute of every ${bar} bar of the five pairs (bars that closed in the weekend pause left out; a BUY and a SELL)`;

// 〔chance〕 (section 4.5): both gaps inside the walks' ranges (the 1-hour run's; v40's sentence), or fade − base below
// its range with fade − flow inside (the 15-minute run's). Any other case: section 4.5 writes no sentence for it, so
// the build stops.
const CHANCE_INSIDE = {
  ja: "合図なしとの差も、逆向きとの差も、値動きに傾きのない作り物の値段10本で同じように測った差の幅の中でした（偶然で出る幅の中なので、どちらより良いとも言えません。作り物の値段は GMO のものではなく、10本で分かるのは幅だけで、確かめ〈検定〉ではありません）。",
  en: "The differences from no signal and from the other way were both within the range of the same differences measured on ten made-up price walks with no trend (a range chance alone gives, so it is not shown to do better than either; the walks' prices are not GMO's, and ten walks give a range, not a test).",
} as const;
const chanceBaseBelow = (lang: FadeLang, gb: string, bLo: string, bHi: string, gf: string, fLo: string, fHi: string): string =>
  lang === "ja"
    ? `合図なしとの差（この決まり − 合図なし）は1回あたり${gb} pips で、合図なしで入った時より低くありました。値動きに傾きのない作り物の値段10本で同じように測った差は${bLo}〜${bHi} pips で、この差はその幅より下（合図なしより悪い側）でした。逆向きとの差は${gf} pips で、10本の幅（${fLo}〜${fHi} pips）の中でした（偶然で出る幅の中なので、逆向きより良いとも悪いとも言えません）。10本の幅の外には偶然だけでも11回に約2回は出るので、幅の外に出たことも確かめ〈検定〉ではありません（作り物の値段は GMO のものではありません）。`
    : `The difference from no signal (this rule less no signal) was ${gb} pips a trade: lower than entering with no signal. The same difference measured on ten made-up price walks with no trend ranged from ${bLo} to ${bHi} pips, and this one was below that range (on the side of doing worse than no signal). The difference from the other way was ${gf} pips, within the walks' range (${fLo} to ${fHi} pips; a range chance alone gives, so it is not shown to do better or worse than the other way). Chance alone puts a gap outside ten walks' range about 2 times in 11, so being outside it is not a test either (the walks' prices are not GMO's).`;

const chanceOf = (m: FadeMeasured, lang: FadeLang): string => {
  const mean = need(m.fade.pipsMean, "dirs.fade.all.pipsMean");
  const gb = mean - need(m.baseMean, "base.all.pipsMean");
  const gf = mean - need(m.flowMean, "dirs.flow.all.pipsMean");
  const b = m.chance.fadeMinusBase;
  const fl = m.chance.fadeMinusFlow;
  const inside = (g: number, r: { lo: number; hi: number }) => g >= r.lo && g <= r.hi;
  if (inside(gb, b) && inside(gf, fl)) return CHANCE_INSIDE[lang];
  if (gb < b.lo && inside(gf, fl)) return chanceBaseBelow(lang, signed(gb, 2), signed(b.lo, 2), signed(b.hi, 2), signed(gf, 2), signed(fl.lo, 2), signed(fl.hi, 2));
  throw new Error(`the measured paragraph: fade − base ${gb}, fade − flow ${gf}: neither both inside the walks' ranges nor the base below and the flow inside; section 4.5 writes no sentence for that`);
};

// the per-pair chance sentence (section 4.5), right after the pair's sentence (the notes': the five pairs' means)
const PAIR_CHANCE = {
  ja: "ペアごとの合図なしとの差は、偶然で出る差より大きいとは示せていません（値動きに傾きのない作り物の値段10本の幅の外には、偶然だけでも11回に約2回は出ます）。",
  en: "Each pair's difference from no signal has not been shown to be larger than chance gives (chance alone puts a gap outside the range of ten made-up price walks with no trend about 2 times in 11).",
} as const;

// the five pairs' (or one pair's) means, checked
const meansOf = (p: FadeMeasured["pairs"][number]) => ({ mean: need(p.mean, `dirs.fade["${p.pair}"].pipsMean`), baseMean: need(p.baseMean, `base["${p.pair}"].pipsMean`) });

// 〔negPairs〕: every pair whose fade mean is below zero, in the pairs' order, with its mean; none: 「ありません」 / "none"
const negPairsOf = (m: FadeMeasured, lang: FadeLang): string => {
  const neg = m.pairs.filter((p) => meansOf(p).mean < 0);
  if (neg.length === 0) return lang === "ja" ? "ありません" : "none";
  return lang === "ja"
    ? neg.map((p) => `${pairJa(p.pair)}（${signed(meansOf(p).mean, 2)} pips）`).join("・")
    : neg.map((p) => `${p.pair} (${signed(meansOf(p).mean, 2)} pips)`).join(", ");
};

// the paragraph of the run of chart `tf`: `pair` a pair's mail (its 〔pair〕 sentence), null the notes' (the five
// pairs' sentence, and 「このメール」 / "this email" made as 4.5's notes' version lists). It refuses a chart with no run,
// a run that is not that chart's, and a pair the run did not measure.
const paragraphOf = (lang: FadeLang, pair: string | null, tf: string, m: FadeMeasured | undefined): string => {
  if (!hasRun(tf)) throw new Error(`the measured paragraph: no run is held for the chart "${tf}"`);
  if (m === undefined) throw new Error(`the measured paragraph: no run is held for the chart "${tf}"`);
  if (m.tf !== tf) throw new Error(`the measured paragraph: the run's chart is "${m.tf}", not "${tf}"`);
  const bar = barWord(m.tf, lang);
  const f = m.fade;
  if (!(f.trades > 0)) throw new Error("the measured paragraph: no fade trade (a run with no fade trade is not used)");
  if (f.tp + f.open !== f.trades) throw new Error(`the measured paragraph: tp ${f.tp} + open ${f.open} is not trades ${f.trades}`);
  const mail = pair !== null;
  const row = mail ? m.pairs.find((p) => p.pair === pair) : undefined;
  if (mail && row === undefined) throw new Error(`the measured paragraph: ${pair} is not among the pairs measured`);
  const TP = count(m.tp);
  const mean = signed(need(f.pipsMean, "dirs.fade.all.pipsMean"), 2);
  const maeMedian = fixed(need(f.maeMedian, "dirs.fade.all.maeMedian"), 1);
  const maeMax = fixed(need(f.maeMax, "dirs.fade.all.maeMax"), 1);
  const flowMean = signed(need(m.flowMean, "dirs.flow.all.pipsMean"), 2);
  const baseMean = signed(need(m.baseMean, "base.all.pipsMean"), 2);
  const chance = chanceOf(m, lang);
  const mailedOn = mailedOnOf(m, tf, lang);
  const negPairs = negPairsOf(m, lang);
  const from = utcOf(m.from, lang);
  const to = utcOf(m.to, lang);
  const open = f.open > 0
    ? {
      sum: signed(need(f.openPipsSum, "dirs.fade.all.openPipsSum"), 1),
      worst: signed(need(f.openPipsWorst, "dirs.fade.all.openPipsWorst"), 1),
      longest: duration(need(f.openMinutesMax, "dirs.fade.all.openMinutesMax"), lang),
    }
    : null;
  const tpTimes = f.tp > 0
    ? {
      median: duration(need(f.tpMinutesMedian, "dirs.fade.all.tpMinutesMedian"), lang),
      p90: duration(need(f.tpMinutesP90, "dirs.fade.all.tpMinutesP90"), lang),
      max: duration(need(f.tpMinutesMax, "dirs.fade.all.tpMinutesMax"), lang),
    }
    : null;
  if (lang === "ja") {
    const kono = mail ? "この" : "";
    const pairSentence = row
      ? `${pairJa(row.pair)}だけでは平均${signed(meansOf(row).mean, 2)} pips（合図なしでは${signed(meansOf(row).baseMean, 2)} pips）です。`
      : `ペアごとの1回あたりの平均は、${m.pairs.map((p, i) => `${pairJa(p.pair)}${signed(meansOf(p).mean, 2)} pips（${i === 0 ? "合図なしでは" : ""}${signed(meansOf(p).baseMean, 2)} pips）`).join("・")}でした。`;
    return [
      `測った数字（5ペア、${from}以後、${to}より前に確定した${bar}、スプレッド込み、docs §${m.sec}）。`,
      mailedOn,
      "過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。",
      `${kono}メールの決まりで足の終値で入り、+${TP} pips で利確・損切りなしで持ったとして測りました（オーナーの持ち方です。メールには利確の値段を書いていません）: 合図は${count(f.trades)}回、うち${count(f.tp)}回が+${TP} pips に届きました。`,
      open
        ? `${count(f.open)}回は${to}の時点でまだ届いておらず、その含み損益は合わせて${open.sum} pips（マイナスが損）、いちばん悪いもので${open.worst} pips、いちばん長いもので${open.longest}持ったままでした（その後は追っていません）。`
        : `${to}の時点でまだ届いていないものはありませんでした。`,
      open ? `1回あたり平均${mean} pips（届いていないものは、その時の含み損益で数えました）。` : `1回あたり平均${mean} pips。`,
      `途中の含み損は中央値${maeMedian} pips、最大${maeMax} pips。`,
      tpTimes
        ? `+${TP} pips に届くまでの時間は中央値${tpTimes.median}、10回に1回は${tpTimes.p90}より長く、いちばん長いもので${tpTimes.max}でした。`
        : `+${TP} pips に届いたものはありませんでした。`,
      "足の終値で入るので指値ではなく、入らなかった注文はありません（週末の止まっている時間に確定した足のもの〈下〉を除き、この決まりの合図は、そのペアのメールをこの時間足で判定するかどうかに関わらず、すべて入ったとして数えました）。",
      `損切りをしないので、+${TP} pips に届く割合は作りの上で高く出ます。`,
      `同じ合図で逆向き（上で買い・下で売り）に入ると1回あたり${flowMean} pips、合図なしで${baseWhatOf("ja", bar)}入ると${baseMean} pips でした（合図なしは、同じ持ち方〈+${TP} pips で利確・損切りなし〉ですが、足の終値ではなく${bar}の最初の1分に入ったもので、同じ入りではありません）。`,
      chance,
      pairSentence,
      PAIR_CHANCE.ja,
      `平均がマイナスだったペア: ${negPairs}。`,
      `ほかに${count(m.notMailed)}回、週末の止まっている時間に確定した足に合図がありましたが、その足はどのペアのメールでも判定しないので、上の数字に入れていません。`,
    ].join("");
  }
  const thisE = mail ? "this" : "the";
  const pairSentence = row
    ? `On ${row.pair} alone the mean was ${signed(meansOf(row).mean, 2)} pips (with no signal, ${signed(meansOf(row).baseMean, 2)} pips).`
    : `The mean a trade by pair: ${m.pairs.map((p, i) => `${p.pair} ${signed(meansOf(p).mean, 2)} pips (${i === 0 ? "with no signal, " : ""}${signed(meansOf(p).baseMean, 2)} pips)`).join(", ")}.`;
  return [
    `Measured (five pairs, ${bar} bars that closed from ${from} up to, not including, ${to}, spread paid, docs §${m.sec}).`,
    mailedOn,
    `The measurement re-reads GMO's past bars; times ${thisE} email's reads failed and the like are not in it (how often: not measured).`,
    `Entered by ${thisE} email's rule at the bar's close and held with a take profit of +${TP} pips and no stop (the owner's way of holding; ${thisE} email states no take-profit price): ${count(f.trades)} signals, of which ${count(f.tp)} reached +${TP} pips.`,
    open
      ? `${count(f.open)} had not reached it by ${to}; their unrealised result was ${open.sum} pips in all (a minus is a loss), the worst ${open.worst} pips, the longest held ${open.longest} (not followed after that).`
      : `None was still short of it by ${to}.`,
    open ? `The mean was ${mean} pips a trade (those not reached counted at their unrealised result then).` : `The mean was ${mean} pips a trade.`,
    `The largest loss on the way: median ${maeMedian} pips, largest ${maeMax} pips.`,
    tpTimes ? `Time to +${TP} pips: median ${tpTimes.median}, longer than ${tpTimes.p90} one time in ten, longest ${tpTimes.max}.` : `None reached +${TP} pips.`,
    "The entry is at the bar's close, not a limit order, so no order went unfilled (every signal of this rule, but those on bars that closed in the weekend pause (below), is counted as entered, whether or not that pair's email is judged on this timeframe).",
    `With no stop, the share reaching +${TP} pips comes out high by construction.`,
    `Entering the other way on the same signals (a BUY at the top, a SELL at the bottom) gave ${flowMean} pips a trade, and entering with no signal ${baseWhatOf("en", bar)} gave ${baseMean} pips (held the same way, +${TP} pips and no stop, but entered at the ${bar} bar's first minute, not at its close, so not the same entry).`,
    chance,
    pairSentence,
    PAIR_CHANCE.en,
    `Pairs whose mean was below zero: ${negPairs}.`,
    `Besides these, ${count(m.notMailed)} signals fell on bars that closed in the weekend pause; no pair's email judges those bars, so they are not in the numbers above.`,
  ].join(" ");
};

// The measured paragraph of a pair's email (section 4.3 item 9): `pair` one of the five pairs measured (gold and the
// shares have no numbers: their mails say so instead), `tf` the chart the signal was judged on (the signal's
// interval: renderFadeMail passes it, so the numbers and the bar's word are always that chart's). It throws if `tf`
// has no run, if the run is not `tf`'s, or if `pair` is not among the run's pairs.
export const fadeMeasuredLine = (lang: FadeLang, pair: string, tf: string, m: FadeMeasured | undefined = runOf(tf)): string => paragraphOf(lang, pair, tf, m);

// The notes' version (section 5, macdxNotes [7] and [8]): one paragraph per chart, for that chart's five pairs
export const fadeMeasuredNotes = (lang: FadeLang, tf: string, m: FadeMeasured | undefined = runOf(tf)): string => paragraphOf(lang, null, tf, m);

// the notes' paragraphs as built from FADE_MEASURED, one per chart, for the app's i18n texts to be pinned to
// (src/lib/i18n ja / en macdxNotes [7] the 15-minute run's, [8] the 1-hour run's). Both are built while the module
// loads: a run that cannot be written stops it (and the tests).
export const FADE_MEASURED_NOTES: Readonly<Record<FadeTf, Readonly<Record<FadeLang, string>>>> = {
  "15min": { ja: fadeMeasuredNotes("ja", "15min"), en: fadeMeasuredNotes("en", "15min") },
  "1h": { ja: fadeMeasuredNotes("ja", "1h"), en: fadeMeasuredNotes("en", "1h") },
};
