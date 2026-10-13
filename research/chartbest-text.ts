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

// ---- 〈オーナーの持ち方の文〉 (21; §8.102 書く文 through SQ-08 and SQ-H1) ----------------------------------------------
//
// One sentence per source and account: the head of 21 (the second-half account, the full account of an item, the
// full account of an email), §8.102's ① → ② → ③ in the branch the numbers fall in, its 添える文, then 9's L sentence
// with the per-trade view's win rates. Every free part follows SQ-08 / SQ-H1 (spec-questions.md): the rows' order and
// names, dates "YYYY-MM-DD HH:MM UTC" oldest first (at most 10, then 「、ほか ○件」), the capped calls' endings, yen
// with thousands separators (a sign on P/L), the owner's way's % with two decimals; "メール" → "合図" for an item.
// No (b) sentence for an item (21). The second-half account's ② is 21's own form (numbers only, SQ-H1).

export const ROWS4 = ["main", "mainSwap", "worst", "worstSwap"] as const;
export type Row4 = (typeof ROWS4)[number];
// the account's emails by what became of them (counts; n all of the account's emails)
export interface Placed {
  n: number;
  entered: number;
  unfilled: number;
  cancelCall: number;
  cancelLc: number;
  refusedMargin: number;
  refusedCall: number;
}
export interface HoldRowFacts {
  // the loss-cut events, the calls ended by the deadline's close-out, the calls with U left after the notice's deposit
  lcs: number;
  deadlines: number;
  capped: number;
  lcAt: number[];
  deadlineAt: number[];
  // a capped call: its τ, U after the notice's deposit (yen), how it ended (settle, lc, deadline, deposit, open)
  cappedCalls: Array<{ tau: number; short: number; end: string }>;
  A: number;
  B: number;
  S: number;
  // the money put in by END (the start and the deposits)
  inTotal: number;
  placed: Placed;
}
export interface HoldFacts {
  src: string;
  account: "full" | "h2";
  email: boolean;
  timedOut: boolean;
  rows: Record<Row4, HoldRowFacts>;
  // the full account's main row by the emails' halves (T < SPLIT, T ≥ SPLIT); null for the second-half account
  placedHalves: [Placed, Placed] | null;
  // M (the all-emails view): full M1, M2 (none and the main swap); h2 M_h (none, swap)
  m: { none: [number, number]; swap: [number, number] };
  mh: [number, number] | null;
  third: { main: number | null; L: number | null; plain: number | null; n: number };
  // the main row: its win rate, endings, per trade, loss-cut events, E*
  win: { rate: number | null; tp: number; lc: number; deadline: number; held: number; pips: number | null; yen: number | null; lcEvents: number; estar: number | null };
  opposite: { rate: number | null; tp: number; lc: number; deadline: number; held: number; pips: number | null; yen: number | null; lcs: number; deadlines: number; capped: number; S: number };
  // the per-trade view (every email alone), this account's signals, and its opposite
  perTrade: { rate: number | null; tp: number; held: number; pips: number | null; yen: number | null; oppRate: number | null; oppPips: number | null; oppYen: number | null };
  // 21 いつも添える文's range: the five-pair rows (full: the whole period, the first and the second half; h2: its own)
  perTradeParts: Array<{ rate: number | null; pips: number | null; oppRate: number | null; oppPips: number | null }>;
  verdict: { one: boolean; twoAccounts: boolean; twoM: boolean; three: boolean };
}

export const HOLD_ROW_NAME: Record<Row4, string> = {
  main: "主の行（スワップ無し・1分足の終値）",
  mainSwap: "スワップ込み・1分足の終値",
  worst: "スワップ無し・一番悪い値",
  worstSwap: "スワップ込み・一番悪い値",
};
const HOLD_MAIN = "主の行（1分足の終値・スワップ無し）";
export const HOLD_HEAD = {
  h2: "選ぶのに使っていない後半（2025年5月19日〜）だけで、30万円から始めた口座では、",
  fullItem: "選ぶのに使った前半を含む全期間（良く見えやすい）では、",
  fullEmail: "全期間では、",
} as const;
const pctH = (x: number | null): string => (x === null ? "—" : `${(100 * x).toFixed(SPEC.holdPctDigits)}%`);
const shareH = (k: number, n: number): string => pctH(n ? k / n : null);
const yenS = (x: number | null): string => (x === null ? "— 円" : `${fmt.yen(x)} 円`);
const yenU = (x: number | null): string => (x === null ? "— 円" : `${fmt.yen(x, false)} 円`);
const isoMin = (t: number): string => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const listTen = (xs: string[]): string => (xs.length > 10 ? `${xs.slice(0, 10).join("、")}、ほか ${xs.length - 10}件` : xs.join("、"));
const datesOf = (ts: readonly number[]): string => listTen([...ts].sort((a, b) => a - b).map(isoMin));
const ENDING: Record<string, string> = { settle: "決済の充当で解消", deadline: "期限の決済", lc: "ロスカット", deposit: "入金で解消", open: "END の時点で未解消" };
const countEnds = (cs: ReadonlyArray<{ end: string }>, end: string) => cs.filter((c) => c.end === end).length;
// SQ-08: 「決済の充当で解消 ○・期限の決済 ○・ロスカット ○」 (SQ-H1: then 入金で解消 / END の時点で未解消 when there are any)
const endingsOf = (cs: ReadonlyArray<{ end: string }>): string => {
  const parts = ["settle", "deadline", "lc"].map((e) => `${ENDING[e]} ${countEnds(cs, e)}`);
  for (const e of ["deposit", "open"]) if (countEnds(cs, e)) parts.push(`${ENDING[e]} ${countEnds(cs, e)}`);
  return parts.join("・");
};
// 置けた: §8.102「置けた割合 __%（うち、入った・置いたが入らなかった・追証で取り消された・ロスカットで取り消された）」 (SQ-H1, SPEC.holdPlacedShare)
const placedOf = (p: Placed): number => (SPEC.holdPlacedShare === "entered" ? p.entered : p.entered + p.unfilled + p.cancelCall + p.cancelLc);
const mailOf = (f: HoldFacts): string => (f.email ? "メール" : "合図");
const dataOf = (f: HoldFacts): string => (f.account === "h2" ? "後半（2025-05-19〜2026-10-10）のデータ" : "2024〜2026年のデータ");
const rowFailsOne = (r: HoldRowFacts): boolean => r.lcs > 0 || r.deadlines > 0 || r.capped > 0;
const rowFailsTwo = (f: HoldFacts, r: HoldRowFacts): boolean => (f.account === "full" ? r.A <= 0 || r.B <= 0 : r.S <= 0);
// a row's three counts, and (detail) the dates and the capped calls' endings
const rowDetail = (r: HoldRowFacts): string => {
  const parts: string[] = [];
  if (r.lcs) parts.push(`ロスカットの日時 ${datesOf(r.lcAt)}`);
  if (r.deadlines) parts.push(`期限の決済の日時 ${datesOf(r.deadlineAt)}`);
  if (r.capped) parts.push(`入金し切れなかった追証の日時 ${datesOf(r.cappedCalls.map((c) => c.tau))}、終わり方 ${endingsOf(r.cappedCalls)}`);
  return parts.length ? `（${parts.join("。")}）` : "";
};
const rowCounts = (r: HoldRowFacts): string => `ロスカット ${r.lcs}回・期限の決済 ${r.deadlines}回・上限で入金し切れなかった追証 ${r.capped}回`;
// the caveats of a failing row (§8.102 書く文 ①)
const caveatOf = (rows: readonly Row4[]): string => {
  const parts: string[] = [];
  if (rows.some((k) => k === "worst" || k === "worstSwap")) parts.push("両建ての買いと売りが同時に一番悪い値にいる、実際には起きない形も含む");
  if (rows.some((k) => k === "mainSwap" || k === "worstSwap")) parts.push("スワップは目安で、取り分は仮の値");
  return parts.length ? `（${parts.join("。")}）` : "";
};

// ①
const holdOneText = (f: HoldFacts): string => {
  const d = dataOf(f);
  const main = f.rows.main;
  if (f.verdict.one) return `30万円の口座で、${d}では、ロスカットも、追証の期限の決済も、上限で入金し切れなかった追証も0回で、入れたお金の合計は ${yenU(main.inTotal)}だった（4つの行すべて）。`;
  if (main.lcs > 0 || main.deadlines > 0) return `この持ち方では、${d}で口座が守れなかった。` + ROWS4.map((k) => `${HOLD_ROW_NAME[k]}: ${rowCounts(f.rows[k])}${rowDetail(f.rows[k])}`).join("。") + "。";
  if (main.capped > 0) {
    const cs = [...main.cappedCalls].sort((a, b) => a.tau - b.tau);
    const list = listTen(cs.map((c) => `${isoMin(c.tau)}・不足 ${yenU(c.short)}・${ENDING[c.end] ?? c.end}`));
    const settled = countEnds(cs, "settle");
    const others = cs.filter((c) => c.end !== "settle");
    const how = others.length === 0 ? "決済の充当で期限の前に解消した" : `決済の充当で期限の前に解消したのは ${settled}回だった（ほかは ${listTen(["deadline", "lc", "deposit", "open"].filter((e) => countEnds(others, e)).map((e) => `${ENDING[e]} ${countEnds(others, e)}`))}）`;
    return `${HOLD_MAIN}では、ロスカットも期限の決済も0回だった。ただ、オーナーの決まり（追証は入金で解消・入れるのは合計100万円まで）では、入金で解消し切れない追証が ${main.capped} 回あった（${list}）。その間は新しい${mailOf(f)}を受けず、${how}。決めた持ち方のままで口座を守れたとは言えない。` +
      ROWS4.map((k) => `${HOLD_ROW_NAME[k]}: ${rowCounts(f.rows[k])}`).join("。") + "。";
  }
  const bad = ROWS4.filter((k) => k !== "main" && rowFailsOne(f.rows[k]));
  return `${HOLD_MAIN}では、ロスカット・期限の決済・上限で入金し切れなかった追証は、どれも0回。` +
    bad.map((k) => `${HOLD_ROW_NAME[k]}では、${rowCounts(f.rows[k])}${rowDetail(f.rows[k])}`).join("。") + `。口座が守れたとは言えない${caveatOf(bad)}。`;
};

// ② (the full account: §8.102's halves; the second-half account: 21's form)
const holdTwoText = (f: HoldFacts): string => {
  const r = f.rows;
  const mail = mailOf(f);
  if (f.account === "h2") {
    const [mn, ms] = f.mh!;
    return `口座の損益は ${ROWS4.map((k) => yenS(r[k].S)).join("・")}（入金を引いた額。4つの行それぞれ）、後半の合図すべてを数えた損益 M_h は ${yenS(mn)}・${yenS(ms)}（スワップ無し・主のスワップ込み）。`;
  }
  const main = r.main;
  const [M1, M2] = f.m.none;
  const [M1s, M2s] = f.m.swap;
  const mText = `すべての${mail}を数えると、前半 ${yenS(M1)}・後半 ${yenS(M2)}（主のスワップ込みは前半 ${yenS(M1s)}・後半 ${yenS(M2s)}）。`;
  if (f.verdict.twoAccounts && f.verdict.twoM) {
    return `前半・後半とも、口座は増えた（前半 ${yenS(main.A)}・後半 ${yenS(main.B)}・全期間 ${yenS(main.S)}。入金を引いた額。4つの行すべて）。すべての${mail}を数えても、前半・後半とも0より上だった（前半 ${yenS(M1)}・後半 ${yenS(M2)}。主のスワップ込みは前半 ${yenS(M1s)}・後半 ${yenS(M2s)}）。`;
  }
  const halves = (x: HoldRowFacts) => [...(x.A <= 0 ? [["前半", x.A] as const] : []), ...(x.B <= 0 ? [["後半", x.B] as const] : [])];
  if (main.A <= 0 || main.B <= 0) {
    const hs = halves(main);
    return `この持ち方では、${hs.map(([h]) => h).join("・")}の口座は増えなかった（${hs.map(([h, v]) => `${h} ${yenS(v)}`).join("・")}、全期間では ${yenS(main.S)}）。` +
      ROWS4.map((k) => `${HOLD_ROW_NAME[k]}: 前半 ${yenS(r[k].A)}・後半 ${yenS(r[k].B)}・全期間 ${yenS(r[k].S)}`).join("。") + "。" + mText;
  }
  const bad = ROWS4.filter((k) => k !== "main" && (r[k].A <= 0 || r[k].B <= 0));
  if (bad.length) {
    return `${HOLD_MAIN}では、前半 ${yenS(main.A)}・後半 ${yenS(main.B)}・全期間 ${yenS(main.S)}。` +
      bad.map((k) => `${HOLD_ROW_NAME[k]}では${halves(r[k]).map(([h, v]) => `${h} ${yenS(v)}`).join("・")}（全期間 ${yenS(r[k].S)}）`).join("。") + `。口座が増えたとは言えない${caveatOf(bad)}。` + mText;
  }
  // the account's four rows grew; the all-emails view did not
  const p = main.placed;
  const placed = shareH(placedOf(p), p.n);
  const mHalves = [...(M1 <= 0 || M1s <= 0 ? [["前半", M1, M1s] as const] : []), ...(M2 <= 0 || M2s <= 0 ? [["後半", M2, M2s] as const] : [])];
  const mv = mHalves.map(([h, x, y]) => `${h}は ${yenS(Math.min(x, y))}で0以下だった（スワップ無し ${yenS(x)}・主のスワップ込み ${yenS(y)}）`).join("。");
  return `口座は前半・後半とも増えた（置けた割合 ${placed}）。すべての${mail}を数えると、${mv}。` +
    `口座の道筋では、置けなかった${mail} ${p.refusedMargin + p.refusedCall} 件（有効証拠金 ${p.refusedMargin}・追証の間 ${p.refusedCall}）、追証で取り消された指値 ${p.cancelCall} 件、ロスカットで取り消された指値 ${p.cancelLc} 件を取らず、ロスカット・期限で ${f.win.lc + f.win.deadline} 件を途中で決済した。` +
    `すべての${mail}の見方では、これらも最後まで数えた。この持ち方で増えるとは言えない。`;
};

// ③
const holdThreeText = (f: HoldFacts): string => {
  const t = f.third;
  const mail = mailOf(f);
  if (f.verdict.three) {
    let s = `P から1日後の時点で、ペアと向きごとの平均をそろえた数字（主の数字 ${fmt.pips(t.main)} pips、区間の下の端 ${fmt.pips(t.L)} pips）では、合図の向きは逆向きより良かった。利確まで持った全体での比べではない。` +
      `${mail}ごとの単純な d の平均は ${fmt.pips(t.plain)} pips（${t.n} 件）。`;
    if (t.plain === null || t.plain <= 0) s += `すべての${mail}をそのまま平均すると ${fmt.pips(t.plain)} pips で、合図の向きは逆向きより良くなかった。主の数字が除くのは、ペアごとに期間を通して一定のトレンドの分だけ。`;
    return s;
  }
  let s = "P から1日後の時点で取引ごとに比べると、合図の向きが逆向きより良いとは言えない。";
  if (f.verdict.twoAccounts && f.verdict.twoM) s += "口座が増えた分を、合図の力とは言えない（損切りなし・利確だけという持ち方の作りで増えた分と、区別できない）。";
  const o = f.opposite;
  return s + `逆向きの取引だけで回した同じ口座では、勝率 ${pctH(o.rate)}（利確 ${o.tp}・ロスカット ${o.lc}・期限の決済 ${o.deadline}・END でまだ持っている ${o.held}）、1回あたり ${fmt.pips(o.pips)} pips・${yenS(o.yen)}、` +
    `ロスカット ${o.lcs} 回・期限の決済 ${o.deadlines} 回・上限で入金し切れなかった追証 ${o.capped} 回、口座の損益 S ${yenS(o.S)}。`;
};

// 添える文
const placedText = (p: Placed, mail: string): string =>
  `置けた割合 ${shareH(placedOf(p), p.n)}（うち、入った ${shareH(p.entered, p.n)}・置いたが入らなかった ${shareH(p.unfilled, p.n)}・追証で取り消された ${shareH(p.cancelCall, p.n)}・ロスカットで取り消された ${shareH(p.cancelLc, p.n)}。どれも全${mail}に対する割合）`;
const holdAddText = (f: HoldFacts): string => {
  const mail = mailOf(f);
  const r = f.rows;
  let s = `30万円の口座で、${placedText(r.main.placed, mail)}。`;
  if (f.placedHalves) s += `前半は${placedText(f.placedHalves[0], mail)}、後半は${placedText(f.placedHalves[1], mail)}。`;
  s += `入れたお金の合計 ${yenU(r.main.inTotal)}。`;
  for (const k of ROWS4) if (k !== "main" && (rowFailsOne(r[k]) || rowFailsTwo(f, r[k]))) s += `${HOLD_ROW_NAME[k]}では、${placedText(r[k].placed, mail)}、入れたお金の合計 ${yenU(r[k].inTotal)}。`;
  const w = f.win;
  s += `勝率 ${pctH(w.rate)}（利確 ${w.tp}・ロスカット ${w.lc}・期限の決済 ${w.deadline}・END でまだ持っている ${w.held}。1回あたり ${fmt.pips(w.pips)} pips・${yenS(w.yen)}、ロスカット ${w.lcEvents} 回、E* ${yenU(w.estar)}。` +
    `逆向きの取引だけの同じ口座では ${pctH(f.opposite.rate)}）。損切りが無いので、作りの上で高く出る。この持ち方がうまくいく証拠ではない。`;
  const both = f.verdict.one && f.verdict.twoAccounts && f.verdict.twoM;
  if (both) s += `これは${dataOf(f)}での結果で、これからも口座が増えるとは言えない。`;
  if (f.email) {
    if (!both) s += "(b) の結果で、この判断は変わらない（(b) では口座の①②を見ない）。";
    s += "(b) のこれからのメールで比べるのは、取引ごとの P から1日後の1回あたりが、過去の見込みの範囲に入るかだけ。範囲に入っても、勝てるとも、口座の①②を確かめたとも言えない。";
  }
  return s;
};

// 9's L sentence, with the per-trade view's win rates and their endings (§8.102 勝率の書き方)
const holdLText = (f: HoldFacts): string => {
  const pt = f.perTrade;
  const t = f.third;
  let s = `取引ごとの見方では、勝率 ${pctH(pt.rate)}（利確 ${pt.tp}・END でまだ持っている ${pt.held}。1回あたり ${fmt.pips(pt.pips)} pips・${yenS(pt.yen)}）、逆向きでは ${pctH(pt.oppRate)}（1回あたり ${fmt.pips(pt.oppPips)} pips・${yenS(pt.oppYen)}）。`;
  if (t.L !== null && t.L > 0) {
    const diff = pt.rate !== null && pt.oppRate !== null ? signed(100 * (pt.rate - pt.oppRate), SPEC.holdPctDigits) : "—";
    s += `勝率の高さは、逆向きでも ${pctH(pt.oppRate)} になる作り（損切りなし・利確10・END まで持つ）で出ている。合図の向きと逆向きの差は、P から1日後の比べで主の数字 ${fmt.pips(t.main)} pips・下の端 ${fmt.pips(t.L)} pips で、勝率の差（${diff}ポイント）を合図の力の大きさとは読まない。`;
  } else {
    s += `この高い勝率は、損切りなし・利確10・END まで持つ作りで高く出ている。合図の力による分があるとは言えない（逆向きでも ${pctH(pt.oppRate)}。P から1日後の比べは、主の数字 ${fmt.pips(t.main)} pips、下の端 ${fmt.pips(t.L)} pips）。`;
  }
  return s + "損切りが無いので、作りの上で高く出る。この持ち方がうまくいく証拠ではない。";
};

export const holdHeadOf = (account: "full" | "h2", email: boolean): string => (account === "h2" ? HOLD_HEAD.h2 : email ? HOLD_HEAD.fullEmail : HOLD_HEAD.fullItem);
// one account's sentence (9「出せなかった」 when the budget ran out before it)
export const holdText = (f: Pick<HoldFacts, "src" | "account" | "email" | "timedOut"> & Partial<HoldFacts>): string => {
  const head = holdHeadOf(f.account, f.email);
  if (f.timedOut) return `${head}${NAME(f.src)}のオーナーの持ち方は出せなかった（計算が Actions の1 job の時間に収まらなかった）。`;
  const g = f as HoldFacts;
  return head + holdOneText(g) + holdTwoText(g) + holdThreeText(g) + holdAddText(g) + holdLText(g);
};
// 21 いつも添える文 (段2でオーナーの持ち方の数字を並べる時): the ranges over the K_total items and the two emails
const rangeOf = (xs: Array<number | null>, f: (x: number) => string): string => {
  const ys = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return ys.length ? `${f(Math.min(...ys))}〜${f(Math.max(...ys))}` : "—";
};
export const holdRangeText = (fs: ReadonlyArray<Pick<HoldFacts, "timedOut" | "account"> & Partial<HoldFacts>>): string | null => {
  const done = fs.filter((f) => !f.timedOut) as HoldFacts[];
  if (!done.length) return null;
  const parts = done.filter((f) => f.account === "full").flatMap((f) => f.perTradeParts);
  const pct = (x: number) => pctH(x);
  const pips = (x: number) => fmt.pips(x);
  return `この報告の、損切りなしの持ち方の勝率は、取引ごとの見方で ${rangeOf(parts.map((p) => p.rate), pct)}（1回あたり ${rangeOf(parts.map((p) => p.pips), pips)} pips。逆向きでは ${rangeOf(parts.map((p) => p.oppRate), pct)}・${rangeOf(parts.map((p) => p.oppPips), pips)} pips）、` +
    `口座では ${rangeOf(done.map((f) => f.win.rate), pct)}（1回あたり ${rangeOf(done.map((f) => f.win.pips), pips)} pips）です。END でまだ持っている取引・最大の逆行・持った期間・ロスカットと期限の決済の回数・入金の合計は、項目ごとに下に並べます。`;
};
