// What was measured of the MACD fade on 1-hour bars (research/macdfade1h-prod-spec.md section 4.5), the one place the
// pairs' emails and the app's notes take it from, and the measured paragraph built from it, ja and en, word for word as
// section 4.5 writes it.
//
// THE NUMBERS are the study's real TF=1h run (research/macdfade15-spec.md "Result of the real 1-hour run": Actions run
// 44099401423 on 53f7003; GMO's real 1-hour and 1-minute files; the Python written apart agreed with every row and
// number). Its summary.json (sha256 60edab22302e5fe755c70b38f87b8b28fa27389ccc1bb10c1a0c0c88c448a9e2) is in the
// repository as research/ledger/macdfade1h-summary.json (section 4.5 route 1: run 44108923903 printed it as one base64
// line). The values below were written out from that file by a script (JS's own String(n), as stored: unrounded), not
// copied by hand; src/test/macd-fade.test.ts reads the file and pins every one of them to it. Measured as the owner
// holds (CLAUDE.md): in at the bar's close, take profit 10 pips, no stop, every email taken, open trades valued at the
// last minute loaded.
//
// 〔chance〕 is not in summary.json: the study prints fade − base and fade − flow (all) beside the same gaps on ten
// driftless walks (null.json, sha256 below; research/macdfade15-spec.md "Result of the real 1-hour run": fade − base
// +0.06 pips a trade, walks −4.10..+0.83; fade − flow +5.34, walks −5.42..+5.81). The walks' ranges are held here as
// printed (2 decimals); the sentence is section 4.5's "both inside" one, and only that one is written: a gap outside
// stops the build (the spec does not write that sentence).
//
// THE PARAGRAPH (section 4.5): the mail's (fadeMeasuredLine: one pair) and the notes' (fadeMeasuredNotes: the five
// pairs, 「このメールの決まりで」 → 「メールの決まりで」 and the other changes 4.5 lists, and no others). Written as 4.5
// says: 〔from〕 / 〔to〕 in UTC (ja 「2024年1月1日 0:00（UTC）」, en "1 January 2024, 00:00 UTC"); a mean to 2 decimals
// with its sign, a sum and the worst to 1 with their sign, the largest loss on the way to 1 (the study's print); a
// minus as toFixed writes it ("-0.26"); thousands separators by one rule for ja and en (1,490; 2,243.6; -9,820.9);
// durations in minutes under 2 hours, hours under 2 days, days beyond, to the nearest whole unit, 「約」 / "about"
// before one that was rounded. The 〔open〕 = 0 and 〔tp〕 = 0 variants are 4.5's; 〔trades〕 = 0 stops the build.
//
// Pure: no clock, no I/O.

import { pairJa } from "./pair-names.ts";

export type FadeLang = "ja" | "en";

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

// where FADE_MEASURED comes from
export const FADE_MEASURED_SOURCE = {
  run: 44099401423,
  commit: "53f7003",
  // the same study run again, which printed summary.json whole (section 4.5 route 1)
  rerun: 44108923903,
  ledger: "research/ledger/macdfade1h-summary.json",
  summarySha256: "60edab22302e5fe755c70b38f87b8b28fa27389ccc1bb10c1a0c0c88c448a9e2",
} as const;

export const FADE_MEASURED: FadeMeasured = {
  // written out by a script from research/ledger/macdfade1h-summary.json (16630 bytes, sha256
  // 60edab22302e5fe755c70b38f87b8b28fa27389ccc1bb10c1a0c0c88c448a9e2), unrounded as stored
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
  baseMean: 3.201605378704711,
  pairs: [
    { pair: "USD/JPY", mean: -0.2594890510948906, baseMean: 5.739117377874385, notMailed: 2 },
    { pair: "EUR/JPY", mean: 4.3036666666666665, baseMean: 3.276229648671806, notMailed: 0 },
    { pair: "AUD/JPY", mean: 4.438541666666666, baseMean: -0.7658391488388046, notMailed: 2 },
    { pair: "EUR/USD", mean: 3.1104430379746835, baseMean: 2.600600617778287, notMailed: 3 },
    { pair: "AUD/USD", mean: 4.4163461538461535, baseMean: 5.155249928591839, notMailed: 4 },
  ],
  notMailed: 11,
  // section 4.5's 〔sec〕: the next section of docs/OPERATIONS.md (written at the release)
  sec: "8.155",
  // research/macdfade15-spec.md "Result of the real 1-hour run" (the job's printed lines; null.json is not in the
  // repository)
  chance: {
    nullSha256: "3d285440123d50ac776228092b1a2560db12ff1d114b97bbec676350175b9b96",
    fadeMinusBase: { lo: -4.10, hi: 0.83 },
    fadeMinusFlow: { lo: -5.42, hi: 5.81 },
  },
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

// a summary.json's values as FadeMeasured (the same fields FADE_MEASURED holds; sec and chance given)
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

// 〔baseWhat〕 (section 4.5); the notes' version says 「メールが判定する」 / "the email judges" (no 「このメール」)
const baseWhatOf = (lang: FadeLang, mail: boolean): string =>
  lang === "ja"
    ? `${mail ? "この" : ""}メールが判定する1時間足ごとの最初の1分に（買いと売りを1回ずつ）`
    : `at the first minute of every 1-hour bar ${mail ? "this" : "the"} email judges (a BUY and a SELL)`;

// 〔chance〕 (section 4.5): both gaps inside the walks' ranges. A gap outside: the sentence for it is not written in
// the spec, so the build stops.
const CHANCE_INSIDE = {
  ja: "合図なしとの差も、逆向きとの差も、値動きに傾きのない作り物の値段10本で同じように測った差の幅の中でした（偶然で出る幅の中なので、どちらより良いとも言えません。作り物の値段は GMO のものではなく、10本で分かるのは幅だけで、確かめ〈検定〉ではありません）。",
  en: "The differences from no signal and from the other way were both within the range of the same differences measured on ten made-up price walks with no trend (a range chance alone gives, so it is not shown to do better than either; the walks' prices are not GMO's, and ten walks give a range, not a test).",
} as const;

const chanceOf = (m: FadeMeasured, lang: FadeLang): string => {
  const mean = need(m.fade.pipsMean, "dirs.fade.all.pipsMean");
  const gb = mean - need(m.baseMean, "base.all.pipsMean");
  const gf = mean - need(m.flowMean, "dirs.flow.all.pipsMean");
  const inside = (g: number, r: { lo: number; hi: number }) => g >= r.lo && g <= r.hi;
  if (!inside(gb, m.chance.fadeMinusBase) || !inside(gf, m.chance.fadeMinusFlow)) {
    throw new Error(`the measured paragraph: fade − base ${gb}, fade − flow ${gf}: not both inside the walks' ranges; section 4.5 writes no sentence for that`);
  }
  return CHANCE_INSIDE[lang];
};

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

// the paragraph: `pair` a pair's mail (its 〔pair〕 sentence), null the notes' (the five pairs' sentence, and 「この
// メール」 / "this email" made as 4.5's notes' version lists)
const paragraphOf = (lang: FadeLang, pair: string | null, m: FadeMeasured): string => {
  const f = m.fade;
  if (!(f.trades > 0)) throw new Error("the measured paragraph: no fade trade (a run with no fade trade is not used)");
  if (m.tf !== "1h") throw new Error(`the measured paragraph: the run's chart is "${m.tf}", not 1h`);
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
      `測った数字（5ペア、${from}以後、${to}より前に確定した1時間足、スプレッド込み、docs §${m.sec}）。`,
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
      "足の終値で入るので指値ではなく、入らなかった注文はありません（メールした合図はすべて入ったとして数えました）。",
      `損切りをしないので、+${TP} pips に届く割合は作りの上で高く出ます。`,
      `同じ合図で逆向き（上で買い・下で売り）に入ると1回あたり${flowMean} pips、合図なしで${baseWhatOf("ja", mail)}入ると${baseMean} pips でした（合図なしは、同じ持ち方〈+${TP} pips で利確・損切りなし〉ですが、足の終値ではなく1時間足の最初の1分に入ったもので、同じ入りではありません）。`,
      chance,
      pairSentence,
      `平均がマイナスだったペア: ${negPairs}。`,
      `ほかに${count(m.notMailed)}回、週末の止まっている時間に確定した足に合図がありましたが、${kono}メールでは判定しないので、上の数字に入れていません。`,
    ].join("");
  }
  const thisE = mail ? "this" : "the";
  const pairSentence = row
    ? `On ${row.pair} alone the mean was ${signed(meansOf(row).mean, 2)} pips (with no signal, ${signed(meansOf(row).baseMean, 2)} pips).`
    : `The mean a trade by pair: ${m.pairs.map((p, i) => `${p.pair} ${signed(meansOf(p).mean, 2)} pips (${i === 0 ? "with no signal, " : ""}${signed(meansOf(p).baseMean, 2)} pips)`).join(", ")}.`;
  return [
    `Measured (five pairs, 1-hour bars that closed from ${from} up to, not including, ${to}, spread paid, docs §${m.sec}).`,
    `It re-reads GMO's past bars; times ${thisE} email's reads failed and the like are not in it (how often: not measured).`,
    `Entered by ${thisE} email's rule at the bar's close and held with a take profit of +${TP} pips and no stop (the owner's way of holding; ${thisE} email states no take-profit price): ${count(f.trades)} signals, of which ${count(f.tp)} reached +${TP} pips.`,
    open
      ? `${count(f.open)} had not reached it by ${to}; their unrealised result was ${open.sum} pips in all (a minus is a loss), the worst ${open.worst} pips, the longest held ${open.longest} (not followed after that).`
      : `None was still short of it by ${to}.`,
    open ? `The mean was ${mean} pips a trade (those not reached counted at their unrealised result then).` : `The mean was ${mean} pips a trade.`,
    `The largest loss on the way: median ${maeMedian} pips, largest ${maeMax} pips.`,
    tpTimes ? `Time to +${TP} pips: median ${tpTimes.median}, longer than ${tpTimes.p90} one time in ten, longest ${tpTimes.max}.` : `None reached +${TP} pips.`,
    "The entry is at the bar's close, not a limit order, so no order went unfilled (every signal emailed is counted as entered).",
    `With no stop, the share reaching +${TP} pips comes out high by construction.`,
    `Entering the other way on the same signals (a BUY at the top, a SELL at the bottom) gave ${flowMean} pips a trade, and entering with no signal ${baseWhatOf("en", mail)} gave ${baseMean} pips (held the same way, +${TP} pips and no stop, but entered at the 1-hour bar's first minute, not at its close, so not the same entry).`,
    chance,
    pairSentence,
    `Pairs whose mean was below zero: ${negPairs}.`,
    `Besides these, ${count(m.notMailed)} signals fell on bars that closed in the weekend pause; ${thisE} email does not judge those bars, so they are not in the numbers above.`,
  ].join(" ");
};

// The measured paragraph of a pair's email (section 4.3 item 9): `pair` one of the five pairs measured (gold and the
// shares have no numbers: their mails say so instead)
export const fadeMeasuredLine = (lang: FadeLang, pair: string, m: FadeMeasured = FADE_MEASURED): string => paragraphOf(lang, pair, m);

// The notes' version (section 5, macdxNotes): one paragraph for the five pairs and gold
export const fadeMeasuredNotes = (lang: FadeLang, m: FadeMeasured = FADE_MEASURED): string => paragraphOf(lang, null, m);

// the notes' paragraph as built from FADE_MEASURED, for the app's i18n texts to be pinned to (src/lib/i18n ja / en
// macdxNotes)
export const FADE_MEASURED_NOTES: Readonly<Record<FadeLang, string>> = {
  ja: fadeMeasuredNotes("ja"),
  en: fadeMeasuredNotes("en"),
};
