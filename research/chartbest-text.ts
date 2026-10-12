// #318 (docs §8.113 21): the sentences, decided before any number (○ filled from the numbers). Pure.
//
// Numbers (21 数字の書き方, §8.107 8): points and % one decimal, pips two, yen whole; a sign on differences,
// hits and pips, none on win rates; the exact binary value rounded half up (toFixed); an all-zero result is
// "+0.0" ("+0.00" for pips) whatever its sign; negatives with U+2212 (SQ-32). The unfixed words are SQ-33's.
// Every sentence has an id (s1.summary, s1.none, s2.item.<id>, s2.final, always.s1, always.s2, …).

import { type Group, MARK_LINE, SPEC, SUSPECT } from "./chartbest-const.ts";
import type { BlindRow, Row } from "./chartbest-rows.ts";
import type { Stage1, Stage2, Stage2Item } from "./chartbest-select.ts";
import { type Est, type WinPl, gt0, lt0 } from "./chartbest-stats.ts";
import { FEW } from "./chartbest-const.ts";

import { fmt, signed } from "./chartbest-fmt.ts";
export { fmt, signed };
// a win rate in a sentence: 「数が少ない」 under 30 resolved (9)
const winOf = (w: WinPl): string => (w.resolved < FEW ? "数が少ない" : fmt.pct(w.wRes));
const range = (lo: number | null, hi: number | null) => `${fmt.pts(lo)}〜${fmt.pts(hi)}`;
export const NAME = (src: string): string => (src === "ultra5" ? "ULTRA 5分足" : src === "macdx5" ? "MACD の山・谷" : src);
export const HOW: Record<Group, string> = { chart: "同じペア・同じ向き・同じ時間帯", cal: "同じペア・同じ向き" };
export const CAL_HEAD = "これはチャートの形を読むやり方ではなく、時刻や暦の効果です。";
// 13's conditions by their own formulas (SQ-33)
export const SUSPECT_NAMES: Record<string, string> = {
  delta: "|Δ| ≧ 10ポイント",
  a: "|そろえない a| ≧ 10ポイント",
  w2: "W2（決着の中）≧ 80%",
  w1: "W1（決着の中）≧ 90%",
  pl1: "PL1 ≧ +1.00 pips",
  pl2: "PL2 ≧ +3.00 pips",
  zeroHundred: "勝率が0%か100%",
  lateGap: "|Δ − Δ_late| ≧ 5ポイント",
};
const suspectNames = (xs: string[]) => xs.map((x) => SUSPECT_NAMES[x] ?? x).join("・");
const CHECKED = "〈調べたこと〉";
const RESULT = "〈結果〉";

// 「（差 ○ポイント、95%の幅 ○〜○、○回。鏡との差 a ○ポイント、95%の幅 ○〜○。利確10が先 ○%・1回あたり ○ pips（未決着 ○回）、
// 損切り13・利確4の勝率 ○%・1回あたり ○ pips（未決着 ○回））」 — the parenthesis of stage 1's chosen items and of 一部 / 悪い / 言えない
const numbers = (r: Row, widthWord: "95%の幅" | "直していない95%の幅" | "幅", aWord: "95%の幅" | "幅"): string =>
  `差 ${fmt.pts(r.delta.est)}ポイント、${widthWord} ${range(r.delta.lo, r.delta.hi)}、${r.delta.N}回。鏡との差 a ${fmt.pts(r.a.est)}ポイント、${aWord} ${range(r.a.lo, r.a.hi)}。` +
  `利確10が先 ${winOf(r.w10)}・1回あたり ${fmt.pips(r.w10.pl)} pips（未決着 ${r.w10.open}回）、損切り13・利確4の勝率 ${winOf(r.w4)}・1回あたり ${fmt.pips(r.w4.pl)} pips（未決着 ${r.w4.open}回）`;

// ---- stage 1 ----------------------------------------------------------------------------------------------------

export interface TextCtx {
  m1: { chart: number; cal: number };
  // the floor-passing items' H1 rows and their first reason when not eligible
  rows: Row[];
  kTotal: number;
}
const notEligibleCounts = (s1: Stage1, rows: Row[], g: Group, group: (id: string) => Group) => {
  const c = { suspicious: 0, noT: 0, nonPositive: 0 };
  for (const r of rows) {
    if (group(r.src) !== g) continue;
    const why = s1.notEligible[r.src];
    if (why) c[why]++;
  }
  return c;
};
export const stage1Text = (s1: Stage1, ctx: TextCtx, group: (id: string) => Group): Array<[string, string]> => {
  const M1 = ctx.m1.chart + ctx.m1.cal;
  const byId = new Map(ctx.rows.map((r) => [r.src, r]));
  if (s1.kTotal === 0) {
    const c = { suspicious: 0, noT: 0, nonPositive: 0 };
    for (const g of ["chart", "cal"] as const) {
      const x = notEligibleCounts(s1, ctx.rows, g, group);
      c.suspicious += x.suspicious;
      c.noT += x.noT;
      c.nonPositive += x.nonPositive;
    }
    const sus = c.suspicious > 0 ? `疑う合図に当たった項目は、測り方の誤りを調べ（${CHECKED}）、誤りが見つからなくても、決まりのとおり選んでいません。` : "";
    return [["s1.none", `前半では、後半で確かめる項目を選べませんでした（床を通った${M1}項目のうち、疑う合図に当たった ${c.suspicious}個、差や幅が出せない ${c.noT}個、差が0以下 ${c.nonPositive}個。1つの項目は、この順で最初に当たった理由だけに数える）。${sus}後半は開けません。どのやり方も、目をつぶって入った場合より当たるとは言えません。今のメールは変えません。オーナーの持ち方（指値・利確10・損切りなし）では、新しいやり方は1つも測っていません（後半へ進めた項目だけで測る決まりのため）。`]];
  }
  const part = (g: Group): string => {
    const ids = s1.chosen[g];
    const label = g === "chart" ? "チャートの形" : "時刻と暦";
    if (!ids.length) {
      const x = notEligibleCounts(s1, ctx.rows, g, group);
      return `${label}からは、選べる項目がありませんでした（疑う合図 ${x.suspicious}個、差や幅が出せない ${x.noT}個、差が0以下 ${x.nonPositive}個）`;
    }
    return ids.map((id) => `${NAME(id)}（${numbers(byId.get(id)!, "95%の幅", "95%の幅")}）`).join("、");
  };
  const chartPart = s1.chosen.chart.length ? `チャートの形から${part("chart")}。` : `${part("chart")}。`;
  const calPart = s1.chosen.cal.length ? `時刻と暦からは${part("cal")}を選びました（チャートの形を読むやり方ではなく、時刻や暦の効果です）。` : `${part("cal")}。`;
  const lp = s1.lbPositive;
  const text =
    `前半（2024年1月〜2025年5月、GMO の5分足、5ペア）で、床を通った${M1}項目（チャートの形 ${ctx.m1.chart}・時刻と暦 ${ctx.m1.cal}）の当たりを測りました。` +
    `鏡との差 a は、合図の向きの勝率（利確10が損切り13より先）が、向きをコインで決めた場合より何ポイント高いかです。` +
    `差（当たり）は、合図の a から、目をつぶって入った場合の a を引いた値です（目をつぶって入る所は、チャートの形では同じペア・同じ向き・同じ時間帯、時刻と暦では同じペア・同じ向きで、時間帯はそろえていません）。` +
    `幅の下の端が高い順に、後半で1回だけ確かめる${s1.kTotal}個を選びました: ${chartPart}${calPart}` +
    `${M1}個から良いものを選んだので、前半の数字は良く見えやすく、まだ何も言えません。` +
    `前半で幅の下の端が0を超えたのは、チャートの形で ${lp.chart.items}項目（重なりの組で ${lp.chart.groups}組）、時刻と暦で ${lp.cal.items}項目（${lp.cal.groups}組）でした（kama-A・kama-B は1つと数えています）。` +
    `同じ組の項目は似た所で合図を出すので、一緒に0を超えやすく、項目の数ほどの別々の証拠ではありません。` +
    `合図の時刻を週ごとまるごとずらした『でたらめな入り』でも、チャートの形では、0を超える数が ${s1.shift95.items.p95 ?? "—"}項目（${s1.shift95.groups.p95 ?? "—"}組）くらいまでは出ます（95%点）。` +
    `一番の下の端も ${fmt.pts(s1.chanceLb)}ポイントくらいになります。`;
  return [["s1.summary", text]];
};

// ---- stage 2 ----------------------------------------------------------------------------------------------------

export interface S2Ctx {
  kTotal: number;
  m1: number;
  rows: Map<string, Row>;
  // the emails' H2 rows (their W/PL do not depend on the layer)
  ultra: Row;
  macd: Row;
  // the owner's way's sentence of each item (none: not built, or a run without it)
  hold: Map<string, string>;
}
const minusText = (r: Row): string => {
  const neg: string[] = [];
  if (lt0(r.w4.pl)) neg.push("損切り13・利確4");
  if (lt0(r.w10.pl)) neg.push("利確10");
  return neg.length ? `当たりは0より上でも、${neg.join("と")}の1回あたりの損益はマイナスです。` : "";
};
const emailText = (x: Stage2Item, k: number): string => {
  if (gt0(x.dULb) && gt0(x.dMLb)) {
    return `今のメール2つ（ULTRA 5分足・MACD の山・谷）と比べても、当たりが高いと言えます（差 ${fmt.pts(x.dU.est)}・${fmt.pts(x.dM.est)}ポイント、${k}個を確かめた分を直した下の端 ${fmt.pts(x.dULb)}・${fmt.pts(x.dMLb)}）。この差も、確かめの基準を通った項目についてだけ書くので、今のメールとの本当の差は、これより小さい見込みです。`;
  }
  if (gt0(x.dU.est) && gt0(x.dM.est)) {
    return `今のメール2つより点では高いですが、今のメールより当たると言えるほどの差ではありません（差 ${fmt.pts(x.dU.est)}・${fmt.pts(x.dM.est)}ポイント、直していない95%の幅 ${range(x.dU.lo, x.dU.hi)}・${range(x.dM.lo, x.dM.hi)}）。`;
  }
  const le: string[] = [];
  const ds: string[] = [];
  if (!gt0(x.dU.est)) {
    le.push("ULTRA 5分足");
    ds.push(fmt.pts(x.dU.est));
  }
  if (!gt0(x.dM.est)) {
    le.push("MACD の山・谷");
    ds.push(fmt.pts(x.dM.est));
  }
  return `今のメール（${le.join("・")}）より当たりが高くありませんでした（差 ${ds.join("・")}ポイント）。`;
};
const reasonText = (x: Stage2Item, r: Row, which: Array<"c2" | "c3" | "c4" | "c5">): string => {
  const out: string[] = [];
  for (const c of which) {
    if (c === "c2" && x.c2 === false) out.push(`買いか売りの片方で、当たりが0以下だった（買い ${fmt.pts(r.byDir.BUY.est)}・売り ${fmt.pts(r.byDir.SELL.est)}ポイント）`);
    if (c === "c3" && x.c3 === false) out.push(`当たりが0より上のペアが、${x.c3q}ペアのうち ${x.c3pos}ペアだけだった`);
    if (c === "c4" && !x.c4) out.push(`5分遅れて入ると、当たりが0より大きいとは言えなかった（${fmt.pts(r.late.est)}ポイント、幅 ${range(r.late.lo, r.late.hi)}）`);
    if (c === "c5" && !x.c5) out.push(`疑う合図（${suspectNames(r.suspicious)}）に当たった`);
  }
  return out.join("、");
};
const simLbText = (x: Stage2Item, k: number): string =>
  gt0(x.simLb) ? `${k}個を同時に直した、より厳しい下の端は ${fmt.pts(x.simLb)}ポイントです。` : `${k}個を同時に直す、より厳しいやり方では、下の端は0を下回ります（${fmt.pts(x.simLb)}ポイント）。`;

export const itemText = (x: Stage2Item, s2: Stage2, c: S2Ctx): string => {
  const r = c.rows.get(x.src)!;
  const name = NAME(x.src);
  const how = HOW[x.group];
  const k = c.kTotal;
  const hold = c.hold.get(x.src) ?? "";
  const head = x.group === "cal" ? CAL_HEAD : "";
  const mde = fmt.pts(x.mde);
  const cont = (() => {
    const A = s2.promote[x.group];
    if (A === x.src) return "これからの足で、明らかに悪くなっていないかを1回だけ確かめてから（段3）、メールに足すかを決めてもらいます。";
    return `これからの確かめには進めません（このまとまりで段3に進めるのは${A ? NAME(A) : "無し"}です。これは前もって決めた選び方によるもので、${A ? NAME(A) : "無し"}の方が当たるという意味ではありません）。`;
  })();
  let text: string;
  if (x.judgment === "confirmed") {
    const late = fmt.pts(r.late.est);
    text =
      `選ぶのに使っていない後半（2025年5月19日〜2026年10月、GMO の5分足）で、${name}の判断は、目をつぶって入った場合（${how}）より、向きの当たりが ${fmt.pts(r.delta.est)}ポイント高く（直していない95%の幅 ${range(r.delta.lo, r.delta.hi)}、${r.delta.N}回）、${k}個を確かめた分を直しても、0より大きいと言えます。` +
      `鏡との差 a（合図の向きの勝率〈利確10が損切り13より先〉が、向きをコインで決めた場合より何ポイント高いか）は ${fmt.pts(r.a.est)}ポイント（95%の幅 ${range(r.a.lo, r.a.hi)}）です。` +
      `差は、この a から、目をつぶって入った場合（${how}）の a を引いた値です。後半は選ぶのに使っていないので、前半で選んだことによる上ぶれはありません。` +
      `ただし、この文は確かめの基準を通った時だけ書くので、${fmt.pts(r.delta.est)}ポイントという差は、本当の差より大きめに出やすいです。` +
      `この数で、8割の確かさで見分けられる最小の差は ${mde}ポイントです。出た差が小さいほど（とくに、この最小の差より小さい時は）、大きめに出ている分が大きい見込みです。` +
      simLbText(x, k) +
      `メールと同じ出口（損切り13・利確4）では、後半の勝率（決着の中）${winOf(r.w4)}・1回あたり ${fmt.pips(r.w4.pl)} pips（未決着 ${r.w4.open}回を含む）。` +
      `同じ所に目をつぶって入った場合は ${fmt.pct(r.blindW1)}・${fmt.pips(r.blindPl1)} pips、今の ULTRA 5分足は ${winOf(c.ultra.w4)}・${fmt.pips(c.ultra.w4.pl)} pips、MACD の山・谷は ${winOf(c.macd.w4)}・${fmt.pips(c.macd.w4.pl)} pips です（どれも後半、同じ数え方。今のメールの数字は、前に値段を見た期間のものです）。` +
      `勝率の違いには、入る時間帯やスプレッドの違いも入るので、当たりの比べには上の差を使います。` +
      `利確10が先は、決着の中で ${winOf(r.w10)}・1回あたり ${fmt.pips(r.w10.pl)} pips（未決着 ${r.w10.open}回）です。` +
      emailText(x, k) +
      `5分遅れて入った場合の差は ${late}ポイントでした。` +
      minusText(r) + hold + `まだ決定ではありません。` + cont;
  } else if (x.judgment === "partial") {
    const nums = numbers(r, "直していない95%の幅", "幅");
    if (x.form === "i") {
      text = `後半で、${name}は、目をつぶって入った場合（${how}）より当たりが高いと、確かめた分を直しても言えました（${nums}）。` +
        `この差は、基準を通った時だけ書くので、大きめに出やすいです（この数で見分けられる最小の差は ${mde}ポイント）。` +
        minusText(r) + `しかし、${reasonText(x, r, ["c2", "c3"])}ので、決めた条件を満たしません。` + hold +
        `メールは変えません。それでも使うかは、オーナーが決めてください（その場合は、決めた条件ではなく、結果を見て決めたことになります）。`;
    } else if (x.form === "ro") {
      const onlyC5 = x.c2 !== false && x.c3 !== false && x.c4;
      const big = onlyC5 && x.passMin !== null && x.passMin >= MARK_LINE ? "この数では、Holm を通る差は、疑う合図の線より大きくなります。" : "";
      text = `後半で、${name}の数字は、疑う合図（${suspectNames(r.suspicious)}）に当たりました（${nums}）。` + minusText(r) +
        `CLAUDE.md の決まりのとおり、まず測り方の誤りを疑い、${CHECKED}を調べました。〈誤りは見つかりませんでした／〈見つかった誤り〉が見つかり、直してやり直しました〉。` +
        `誤りが見つからなくても、この数字から『当たる』とは言いません。` + big + hold +
        `決めた条件（${reasonText(x, r, ["c2", "c3", "c4", "c5"])}）を満たさないので、メールは変えません。`;
    } else {
      const other = reasonText(x, r, ["c2", "c3"]);
      text = `後半で、${name}は、合図の足の終値で入ると、目をつぶって入った場合（${how}）より当たりが高く出ました（${nums}）。` +
        `この差は、基準を通った時だけ書くので、大きめに出やすいです（この数で見分けられる最小の差は ${mde}ポイント）。` + minusText(r) +
        `しかし、5分遅れて入ると、当たりが0より大きいとは言えませんでした（${fmt.pts(r.late.est)}ポイント、95%の幅 ${range(r.late.lo, r.late.hi)}）。` +
        `終値の一時的なぶれ（気配の跳ね返り）で、見かけだけ当たっている疑いがあります。メールが届く約1分後に入った場合は、測っていません。` +
        (other ? `また、${other}。` : "") + hold + `決めた条件を満たさないので、メールは変えません。`;
    }
  } else if (x.judgment === "bad") {
    text = `後半で、${name}の判断は、目をつぶって入った場合（${how}）より当たりが低い結果でした（${numbers(r, "幅", "幅")}）。`;
    if (!x.c5) text += `この数字は疑う合図（${suspectNames(r.suspicious)}）に当たりました。${CHECKED}を調べ、${RESULT}。`;
    text += hold;
  } else {
    const noT = r.delta.t === null;
    text = noT
      ? `後半で、${name}が、目をつぶって入った場合（${how}）より当たるとも、当たらないとも言えませんでした（差と幅は出せませんでした）。差が無いという意味ではありません。`
      : `後半で、${name}が、目をつぶって入った場合（${how}）より当たるとも、当たらないとも言えませんでした（${numbers(r, "幅", "幅")}）。差が無いという意味ではありません。この数では、${mde}ポイントより小さい差は、8割の確かさでは見分けられません。`;
    if (!noT && x.mde !== null && x.mde >= MARK_LINE) text += `この ${mde}ポイントは、疑う合図の線（10ポイント）より大きいので、この数では、疑う合図に当たらずに確かめられる差はほとんどありませんでした。`;
    if (!x.c5) text += `この数字は疑う合図（${suspectNames(r.suspicious)}）に当たりました。${CHECKED}を調べ、${RESULT}。`;
    text += hold;
  }
  return head + text;
};

export const stage2Text = (s2: Stage2, c: S2Ctx): Array<[string, string]> => {
  const out: Array<[string, string]> = s2.items.map((x) => [`s2.item.${x.src}`, itemText(x, s2, c)]);
  const conf = s2.items.filter((x) => x.judgment === "confirmed");
  if (!conf.length) {
    out.push(["s2.final", `アプリにない44のやり方（59項目。床を通ったのは${c.m1}項目）を測り、前半で選んだ${c.kTotal}個を後半で確かめましたが、目をつぶって入った場合より当たると言える項目はありませんでした。この測り方では、どれが一番正確とは言えません。今のメール（ULTRA 5分足・MACD の山・谷）は変えません。`]);
    return out;
  }
  const per = (g: Group): string => {
    const ids = conf.filter((x) => x.group === g).map((x) => x.src);
    if (ids.length === 0) return "確かめられた項目どうしの順位は、確かめていません。";
    if (ids.length === 1) return `${NAME(ids[0])}は、目をつぶって入った場合より当たると確かめられましたが、ほかのやり方より正確かは確かめていません（後半で確かめたのは${c.kTotal}個だけで、ほかの${c.m1 - c.kTotal}項目は後半を計算していません）。`;
    const A = s2.promote[g]!;
    const ds = s2.dAB.filter((d) => d.A === A);
    const better = ds.filter((d) => lt0(d.est.hi));
    if (better.length) {
      // the numbers are D_AB = Δ_A − Δ_B as 14 defines it (negative here), as the plan's hand example writes them
      return better.map((d) => `後半で確かめられたチャートの形の項目の中では、${NAME(d.B)}の方が${NAME(A)}より当たると言えます（差 ${fmt.pts(d.est.est)}ポイント、直していない95%の幅 ${range(d.est.lo, d.est.hi)}）。${NAME(A)}を段3に進めるのは、前もって決めた選び方（直した下の端）によるもので、${NAME(A)}の方が当たるという意味ではありません。`).join("");
    }
    if (ds.length && ds.every((d) => gt0(d.est.lo))) {
      return `後半で確かめられたチャートの形の項目の中では、${NAME(A)}の方が${ds.map((d) => NAME(d.B)).join("・")}より当たると言えます（差 ${ds.map((d) => fmt.pts(d.est.est)).join("・")}ポイント、直していない95%の幅の下の端 ${ds.map((d) => fmt.pts(d.est.lo)).join("・")}）。`;
    }
    return `後半で確かめられたチャートの形の項目の中で、どれが一番当たるかは、この数では決められません（${ds.map((d) => `${NAME(A)}と${NAME(d.B)}の差 ${fmt.pts(d.est.est)}ポイント、幅 ${range(d.est.lo, d.est.hi)}`).join("、")}）。`;
  };
  out.push(["s2.final", `アプリにない44のやり方（59項目）のうち、前半で選び、後半で確かめても当たると言えたのは${conf.map((x) => NAME(x.src)).join("、")}でした。` +
    `段3（これからの足での確かめ）に進めるのは、前もって決めた選び方（確かめた分を直した幅の下の端が一番高いもの）で、チャートの形では${s2.promote.chart ? NAME(s2.promote.chart) : "無し"}、時刻と暦では${s2.promote.cal ? NAME(s2.promote.cal) : "無し"}です。` +
    per("chart") + per("cal") + `チャートの形の項目と、時刻と暦の項目は、測り方が違うので比べていません。`]);
  return out;
};

// ---- いつも添える文 (SQ-17) ----------------------------------------------------------------------------------------

export interface AlwaysRow {
  name: string;
  half: "前半" | "後半";
  w4: WinPl;
  w10: WinPl;
}
export const alwaysRowsOf = (rows: Row[], emails: Row[], blind: BlindRow[], half: "前半" | "後半"): AlwaysRow[] => [
  ...rows.map((r) => ({ name: NAME(r.src), half, w4: r.w4, w10: r.w10 })),
  ...emails.map((r) => ({ name: NAME(r.src), half, w4: r.w4, w10: r.w10 })),
  ...blind.filter((b) => b.key === "BUY" || b.key === "SELL").map((b) => ({ name: b.key === "BUY" ? "ブラインドの買い" : "ブラインドの売り", half, w4: b.w4, w10: b.w10 })),
];
export const alwaysText = (id: string, xs: AlwaysRow[], holdRange: string | null): [string, string] => {
  const best = (tp: "w4" | "w10") => {
    let b: AlwaysRow | null = null;
    for (const x of xs) {
      const w = x[tp];
      if (w.resolved < FEW || w.wRes === null) continue;
      if (!b || w.wRes > b[tp].wRes!) b = x;
    }
    return b;
  };
  const b4 = best("w4");
  const b10 = best("w10");
  const one = (b: AlwaysRow | null, tp: "w4" | "w10") => (b ? `${fmt.pct(b[tp].wRes)}（${b.name}・${b.half}、決着の中、1回あたり ${fmt.pips(b[tp].pl)} pips）` : "—（決着が30回以上の行がありません）");
  return [id, `損切り13の出口で、決着が30回以上の行（床を通った項目と物差し、その段で出した半分）のうち、一番高い勝率は、利確4で ${one(b4, "w4")}、利確10で ${one(b10, "w10")}でした。` +
    `損切り13・利確10で損益ゼロに要る勝率は約57%、利確4なら約76%です（どちらもスプレッドを引く前）。でたらめに入っても、ほぼこの割合になるので、やり方による差は小さく出ます。` +
    `損切りなしの持ち方の勝率は、負けが確定しないので、作りの上で高く出ます。` + (holdRange ?? "")];
};

export const lbOf = (e: Est) => e.lb;
export const SUSPECT_LINES = SUSPECT;
