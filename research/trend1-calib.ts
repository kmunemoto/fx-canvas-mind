// #250 (docs §8.106 段1の作り 8): the walks' summaries (research/trend1.ts MODE=syn, each SEED's summary.json under
// CALIB_DIR) against the conditions fixed before they ran. Exit 1 when one is not met.
//
//   none   20 walks for each candidate (§8.106 11 「効果なし20通り（候補ごと）」: ① 101..120, ② 121..140, ③ 141..160,
//          ④ 161..180), each candidate counted on its own 20 only: of the 80 H2 intervals of δ W2 the share p
//          without 0, p + 1.96 √(p(1 − p) / 80) at most 10%; adopted (§8.106 8, the candidate as if chosen) 4 or fewer
//   on     seeds 201..210: ①'s H2 δ W2 over 0 in 8 or more
//   back   seeds 301..310: ①'s H2 δ W2 under 0 in 8 or more
//   drift  seeds 401..404: ①'s H2 interval holding 0 in 3 or more (the raw kept − left out by side shown)
//   answer seeds 101..104 with the answer-knowing 1-hour label: ①'s H2 δ W2 over 30 points in all 4

interface Per {
  cand: string;
  d: number;
  lo: number;
  hi: number;
  t: number;
  line: number;
  adopt: boolean;
  sentence: string;
  rawBuy: { kept: number; out: number };
  rawSell: { kept: number; out: number };
}
interface Summary {
  seed: number;
  answer: boolean;
  failed: string[];
  H2: Per[];
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
export const NONE_OF = [range(101, 120), range(121, 140), range(141, 160), range(161, 180)];
export const GROUPS = {
  none: range(101, 180),
  on: range(201, 210),
  back: range(301, 310),
  drift: range(401, 404),
  answer: range(101, 104),
};

export const calib = async (dir: string) => {
  const read = async (name: string): Promise<Summary | null> => {
    try {
      return JSON.parse(await Deno.readTextFile(`${dir}/${name}/summary.json`));
    } catch {
      return null;
    }
  };
  const out: string[] = [];
  const say = (s: string) => {
    out.push(s);
    console.log(s);
  };
  const fails: string[] = [];
  const need = async (group: keyof typeof GROUPS) => {
    const got: Summary[] = [];
    for (const s of GROUPS[group]) {
      const x = await read(group === "answer" ? `answer${s}` : `w${s}`);
      if (!x) fails.push(`${group} seed ${s}: no summary`);
      else if (x.failed.length) fails.push(`${group} seed ${s}: checks failed (${x.failed.join(", ")})`);
      else got.push(x);
    }
    return got;
  };
  const f = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(2)}` : "-");

  const none = await need("none");
  // each candidate on its own 20 walks
  const per = none.flatMap((x) => x.H2.filter((_, c) => NONE_OF[c].includes(x.seed)));
  NONE_OF.forEach((seeds, c) => {
    const mine = none.filter((x) => seeds.includes(x.seed)).map((x) => x.H2[c]);
    say(`  candidate ${c + 1}: ${mine.length} walks, intervals without 0 ${mine.filter((q) => q.lo > 0 || q.hi < 0).length}, adopted ${mine.filter((q) => q.adopt).length}`);
  });
  const clear = per.filter((p) => p.lo > 0 || p.hi < 0).length;
  const p = per.length ? clear / per.length : NaN;
  const upper = p + 1.96 * Math.sqrt((p * (1 - p)) / per.length);
  const adopted = per.filter((x) => x.adopt).length;
  say(`none: ${per.length} intervals (want 80), without 0 ${clear} (${f(p)}%), the share's upper end ${f(upper)}% (want 10% or less); adopted ${adopted} (want 4 or fewer)`);
  for (const x of none) {
    const c = NONE_OF.findIndex((s) => s.includes(x.seed));
    const q = x.H2[c];
    say(`  seed ${x.seed} (candidate ${c + 1}): ${q.cand} ${f(q.d)} [${f(q.lo)}, ${f(q.hi)}] t ${q.t.toFixed(2)} line ${q.line.toFixed(2)} ${q.sentence}`);
  }
  if (!(per.length === 80 && upper <= 0.1 && adopted <= 4)) fails.push("none");

  for (const [g, want] of [["on", 1], ["back", -1]] as const) {
    const xs = await need(g);
    const right = xs.filter((x) => (want > 0 ? x.H2[0].d > 0 : x.H2[0].d < 0)).length;
    say(`${g}: ①'s H2 δ W2 ${want > 0 ? "over" : "under"} 0 in ${right} of ${xs.length} (want 8 or more of 10): ${xs.map((x) => f(x.H2[0].d)).join(", ")}`);
    if (!(xs.length === 10 && right >= 8)) fails.push(g);
  }
  const drift = await need("drift");
  const holds = drift.filter((x) => x.H2[0].lo <= 0 && x.H2[0].hi >= 0).length;
  say(`drift: ①'s H2 interval holding 0 in ${holds} of ${drift.length} (want 3 or more of 4)`);
  for (const x of drift) say(`  seed ${x.seed}: ① ${f(x.H2[0].d)} [${f(x.H2[0].lo)}, ${f(x.H2[0].hi)}]; raw W2 kept − left out BUY ${f(x.H2[0].rawBuy.kept - x.H2[0].rawBuy.out)}, SELL ${f(x.H2[0].rawSell.kept - x.H2[0].rawSell.out)}`);
  if (!(drift.length === 4 && holds >= 3)) fails.push("drift");
  const ans = await need("answer");
  const big = ans.filter((x) => x.answer && x.H2[0].d > 0.3).length;
  say(`answer: ①'s H2 δ W2 over 30 points in ${big} of ${ans.length} (want all 4): ${ans.map((x) => f(x.H2[0].d)).join(", ")}`);
  if (!(ans.length === 4 && big === 4)) fails.push("answer");

  say(fails.length ? `NOT met: ${fails.join("; ")}` : "every condition met");
  await Deno.writeTextFile(`${dir}/calib.txt`, out.join("\n") + "\n");
  if (fails.length) Deno.exit(1);
};
