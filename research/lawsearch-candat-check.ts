// 法則探し (docs §8.136, research/lawsearch-spec.md 5, 15): a CI check of the speed-up "free" (C4b). The checks cut,
// poison and presence (lawsearch-checks.ts decisionOf) call candidatesAt (lawsearch-events.ts), which gives
// candidatesOf's rows at one bar alone. That is exact only while spec 5's per-bar body passes no state from one bar to
// the next and ⑤ and the warm-up read only the bar's own rows (the argument is at candidatesAt). This program checks
// it on one run's universe, so that a later change that breaks it is caught: for every trial of spec 19 step 3, every
// pair, and two option sets (the run's own: answerKnowing for an O run; and the plant noRisingEdge, which changes ②),
// candidatesAt at every bar i of the series (and at −1 and n) must give exactly the rows candidatesOf gives at bar i:
// the same count, and per row the same bar, direction, status and warm-up flag, in the same order. The bars are asked
// in a scrambled order (a fixed stride through them), not one after the other, so that state kept between calls (a
// module-level variable, say) cannot imitate candidatesOf's pass over the bars in order. Exit 0 when every bar is the
// same, 1 when one differs (or on an error).
// It reads <run>/manifest.json, <run>/gmo and the ledger, and writes nothing.
// Usage: deno run --sloppy-imports --no-config --allow-read=. research/lawsearch-candat-check.ts <run>

import { END, PAIRS, S0 } from "./lawsearch-const.ts";
import { TRIAL_STEP3 } from "./lawsearch-rules.ts";
import { loadUniverse } from "./lawsearch-bars.ts";
import { parseCandidates } from "./lawsearch-items.ts";
import { candidatesAt, candidatesOf } from "./lawsearch-events.ts";
import type { CandOpts } from "./lawsearch-events.ts";
import { indsOf } from "./lawsearch-stage0.ts";
import type { Candidates } from "./lawsearch-types.ts";

async function main(): Promise<number> {
  const run = Deno.args[0];
  if (run === undefined || run === "") {
    console.log("usage: lawsearch-candat-check.ts <run folder>");
    return 1;
  }
  const manifest = JSON.parse(await Deno.readTextFile(`${run}/manifest.json`));
  const answerKnowing = manifest?.spec?.group === "O";
  const all = parseCandidates(JSON.parse(await Deno.readTextFile("research/ledger/lawsearch-candidates.json")));
  const trials = TRIAL_STEP3.map((id) => {
    const t = all.find((x) => x.id === id);
    if (!t) throw new Error(`lawsearch-candat-check: ${id} is not in the ledger`);
    return t;
  });
  const sets: Array<{ name: string; o: CandOpts & { plant: string } }> = [
    { name: answerKnowing ? "run (answerKnowing)" : "run", o: { plant: "", answerKnowing } },
    { name: "noRisingEdge", o: { plant: "noRisingEdge", answerKnowing } },
  ];
  let bad = 0;
  let bars = 0;
  let rows = 0;
  for (const { name, o } of sets) {
    const u = await loadUniverse({ dir: `${run}/gmo`, fetch: false }, S0, END, { purpose: "syn0", band: "syn", plant: o.plant });
    const inds = { m15: indsOf(u.m15, o.plant), h1: indsOf(u.h1, o.plant) };
    for (const t of trials) {
      let tBars = 0;
      let tRows = 0;
      let tBad = 0;
      for (let pi = 0; pi < PAIRS.length; pi++) {
        const ind = inds[t.tf][pi];
        const n = ind.series.n;
        const full: Candidates = candidatesOf(t, ind, o);
        // the rows of candidatesOf at bar i are [start[i + 1], start[i + 2]) (they are in bar order)
        const start = new Int32Array(n + 3);
        for (let r = 0, i = -1; i <= n + 1; i++) {
          while (r < full.n && full.i[r] < i) r++;
          start[i + 1] = r;
        }
        // the bars −1 … n in the order (j × stride) mod (n + 2) − 1, j = 0 … n + 1 (stride coprime with n + 2)
        const m = n + 2;
        let stride = 7919;
        const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
        while (gcd(stride, m) !== 1) stride++;
        let met = 0;
        for (let j = 0; j < m; j++) {
          const i = ((j * stride) % m) - 1;
          const at = candidatesAt(t, ind, i, o);
          let lo = start[i + 1];
          const want = start[i + 2] - lo;
          let same = at.n === want && at.trial === full.trial && at.tf === full.tf && at.pi === full.pi;
          for (let q = 0; same && q < want; q++, lo++) {
            same = at.i[q] === full.i[lo] && at.d[q] === full.d[lo] && at.status[q] === full.status[lo] && at.warmOk[q] === full.warmOk[lo];
          }
          tBars++;
          tRows += want;
          met += want;
          if (!same) {
            tBad++;
            if (tBad <= 5) console.log(`DIFF ${t.id} ${name} ${PAIRS[pi]} bar ${i}: candidatesAt ${at.n} rows, candidatesOf ${want} rows at that bar`);
          }
        }
        // every row of candidatesOf belongs to a bar in [0, n)
        if (met !== full.n) {
          tBad++;
          console.log(`DIFF ${t.id} ${name} ${PAIRS[pi]}: ${full.n - met} rows of candidatesOf were not met bar by bar`);
        }
      }
      console.log(`${t.id} ${name}: ${tBars} bars, ${tRows} rows, ${tBad === 0 ? "the same at every bar" : `${tBad} bars differ`}`);
      bad += tBad;
      bars += tBars;
      rows += tRows;
    }
  }
  console.log(`${bad === 0 ? "PASS" : "FAIL"}: candidatesAt against candidatesOf on ${run}: ${bars} bars, ${rows} rows, ${bad} differ`);
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) Deno.exit(await main());
