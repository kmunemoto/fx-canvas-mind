// 法則探し (docs §8.136, research/lawsearch-spec.md 14.2 裏返し; research/lawsearch-design.md 10 FLIP): the comparison of
// a synthetic run with its flipped twin, from the TS dumps of both (lawsearch-dump.md). Read only.
//
//   deno run --allow-read=. research/lawsearch-flip.ts <run> <flipped run>
//
// It checks, for every blind/<tf>_<half>.csv that both runs wrote:
//   * the same bars (pair, i, T) in both tables;
//   * PL exact: the flipped run's buy PL = the original's sell PL, and the flipped sell PL = the original's buy PL
//     (mirroring maps Bid' = 2S − Ask and Ask' = 2S − Bid exactly, so the raw points mirror exactly);
//   * h: the flipped buy h = the original's sell h. The mid is rounded from (Bid + Ask) ÷ 2, which is a half tick on
//     an odd spread; mirrored, each of the two mids of m can round the other way, so m′ = m_sell + e with |e| ≤ 2
//     points (design 11 O-2). An h difference at |m_sell| ≤ 2 is counted as O-2 (the owner reads 14.2's
//     "ぴったり同じ"); |m′ − m_sell| > 2 or an h difference at |m_sell| > 2 is a failure.
// and, for every signals/<trial>.csv of E04, E26 and S01: the rows (pair, i, d, reason) of the flipped run against the
// original's with d reversed; the difference (rows in one and not the other, both ways) ÷ the original's rows must be
// ≤ 0.1%. B06 is not symmetric (log returns of mirrored prices): its difference is printed, not judged.
//
// Exit: 0 every judged comparison passed (O-2 differences are counted, not failures); 3 a failure; 1 a crash.

type Row = Record<string, string>;

const readCsv = async (path: string): Promise<Row[] | null> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const f = l.split(",");
    const r: Row = {};
    head.forEach((h, k) => (r[h] = f[k] ?? ""));
    return r;
  });
};

export interface FlipBlind {
  file: string;
  bars: number;
  barsOnlyOne: number;
  plDiff: number;
  hDiff: number;
  hDiffByAbsM: Record<string, number>;
  mOutOfRange: number;
  examples: string[];
}

export function compareBlind(file: string, a: Row[], b: Row[]): FlipBlind {
  const key = (r: Row) => `${r.pair}|${r.i}|${r.T}|${r.d}`;
  const A = new Map(a.map((r) => [key(r), r]));
  const B = new Map(b.map((r) => [key(r), r]));
  const out: FlipBlind = { file, bars: 0, barsOnlyOne: 0, plDiff: 0, hDiff: 0, hDiffByAbsM: {}, mOutOfRange: 0, examples: [] };
  const seen = new Set<string>();
  for (const r of [...a, ...b]) {
    const bar = `${r.pair}|${r.i}|${r.T}`;
    if (seen.has(bar)) continue;
    seen.add(bar);
    const aBuy = A.get(`${bar}|1`);
    const aSell = A.get(`${bar}|-1`);
    const bBuy = B.get(`${bar}|1`);
    const bSell = B.get(`${bar}|-1`);
    if (!aBuy || !aSell || !bBuy || !bSell) {
      out.barsOnlyOne++;
      if (out.examples.length < 8) out.examples.push(`${file} ${bar}: in one run only`);
      continue;
    }
    out.bars++;
    // the flipped buy is the original sell, and the flipped sell the original buy
    for (const [f, o] of [[bBuy, aSell], [bSell, aBuy]] as const) {
      if (f.pl !== o.pl) {
        out.plDiff++;
        if (out.examples.length < 8) out.examples.push(`${file} ${bar} d=${f.d}: pl ${f.pl}, original d=${o.d} pl ${o.pl}`);
      }
      const e = Number(f.m) - Number(o.m);
      if (Math.abs(e) > 2) {
        out.mOutOfRange++;
        if (out.examples.length < 8) out.examples.push(`${file} ${bar} d=${f.d}: m ${f.m}, original d=${o.d} m ${o.m} (more than 2 points apart)`);
      }
    }
    if (bBuy.h !== aSell.h) {
      const am = String(Math.abs(Number(aSell.m)));
      out.hDiff++;
      out.hDiffByAbsM[am] = (out.hDiffByAbsM[am] ?? 0) + 1;
      if (Math.abs(Number(aSell.m)) > 2 && out.examples.length < 8) out.examples.push(`${file} ${bar}: flipped buy h ${bBuy.h}, original sell h ${aSell.h} at |m| ${am}`);
    }
  }
  return out;
}

export interface FlipSignals {
  trial: string;
  rows: number;
  rowsFlipped: number;
  onlyOriginal: number;
  onlyFlipped: number;
  share: number;
  judged: boolean;
  examples: string[];
}

export function compareSignals(trial: string, a: Row[], b: Row[]): FlipSignals {
  const ka = new Set(a.map((r) => `${r.pair}|${r.i}|${r.d}|${r.reason}`));
  // the flipped run's rows with the direction reversed
  const kb = new Set(b.map((r) => `${r.pair}|${r.i}|${-Number(r.d)}|${r.reason}`));
  const examples: string[] = [];
  let onlyA = 0;
  let onlyB = 0;
  for (const k of ka) {
    if (kb.has(k)) continue;
    onlyA++;
    if (examples.length < 5) examples.push(`${trial}: original ${k}, no flipped twin`);
  }
  for (const k of kb) {
    if (ka.has(k)) continue;
    onlyB++;
    if (examples.length < 10) examples.push(`${trial}: flipped (d reversed) ${k}, no original twin`);
  }
  const judged = !/\.B\d\d$/.test(trial);
  return { trial, rows: a.length, rowsFlipped: b.length, onlyOriginal: onlyA, onlyFlipped: onlyB, share: a.length > 0 ? (onlyA + onlyB) / a.length : onlyB > 0 ? 1 : 0, judged, examples };
}

export async function flipCompare(run: string, flipped: string): Promise<{ lines: string[]; passed: boolean }> {
  const lines: string[] = [];
  let passed = true;
  for (const [dir, want] of [[run, false], [flipped, true]] as const) {
    const m = JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`));
    if (m.spec.flip !== want) throw new Error(`${dir}: manifest flip ${m.spec.flip}, expected ${want}`);
  }
  const ma = JSON.parse(await Deno.readTextFile(`${run}/manifest.json`)).spec;
  const mb = JSON.parse(await Deno.readTextFile(`${flipped}/manifest.json`)).spec;
  if (ma.group !== mb.group || ma.seed !== mb.seed) throw new Error(`the runs are ${ma.group} ${ma.seed} and ${mb.group} ${mb.seed}`);
  lines.push(`FLIP ${ma.group} ${ma.seed}: ${run} vs ${flipped}`);
  for (const tf of ["m15", "h1"]) {
    for (const half of ["first", "second"]) {
      const f = `blind/${tf}_${half}.csv`;
      const a = await readCsv(`${run}/ts/${f}`);
      const b = await readCsv(`${flipped}/ts/${f}`);
      if (!a || !b) {
        lines.push(`BLIND ${f}: not in both runs (original ${a ? "yes" : "no"}, flipped ${b ? "yes" : "no"}; the second half is written only when stage 2 runs)`);
        continue;
      }
      const c = compareBlind(f, a, b);
      const ok = c.barsOnlyOne === 0 && c.plDiff === 0 && c.mOutOfRange === 0 && Object.entries(c.hDiffByAbsM).every(([m]) => Number(m) <= 2);
      if (!ok) passed = false;
      lines.push(`BLIND ${f}: bars ${c.bars}, in one run only ${c.barsOnlyOne}, pl differences ${c.plDiff}, |m′ − m| > 2: ${c.mOutOfRange}, h differences ${c.hDiff} (by |m| of the original sell: ${JSON.stringify(c.hDiffByAbsM)}; O-2 when |m| ≤ 2) ${ok ? "PASS" : "FAIL"}`);
      for (const x of c.examples) lines.push(`  ${x}`);
    }
  }
  const names = new Set<string>();
  for await (const e of Deno.readDir(`${run}/ts/signals`)) names.add(e.name);
  for (const name of [...names].sort()) {
    const trial = name.replace(/\.csv$/, "");
    if (!/\.(E04|E26|S01|B06)/.test(trial)) continue;
    const a = await readCsv(`${run}/ts/signals/${name}`);
    const b = await readCsv(`${flipped}/ts/signals/${name}`);
    if (!a || !b) {
      lines.push(`SIGNALS ${trial}: missing in the flipped run`);
      passed = false;
      continue;
    }
    const c = compareSignals(trial, a, b);
    const ok = !c.judged || c.share <= 0.001;
    if (!ok) passed = false;
    lines.push(`SIGNALS ${trial}: original ${c.rows}, flipped ${c.rowsFlipped}, only original ${c.onlyOriginal}, only flipped ${c.onlyFlipped}, difference ${(100 * c.share).toFixed(4)}% ${c.judged ? (ok ? "PASS (≤ 0.1%)" : "FAIL (> 0.1%)") : "(B06: not symmetric, printed only)"}`);
    for (const x of c.examples.slice(0, 4)) lines.push(`  ${x}`);
  }
  lines.push(passed ? "RESULT pass" : "RESULT fail");
  return { lines, passed };
}

if (import.meta.main) {
  const [run, flipped] = Deno.args;
  if (!run || !flipped) {
    console.log("usage: lawsearch-flip.ts <run> <flipped run>");
    Deno.exit(2);
  }
  try {
    const { lines, passed } = await flipCompare(run, flipped);
    for (const l of lines) console.log(l);
    Deno.exit(passed ? 0 : 3);
  } catch (e) {
    console.error(e);
    Deno.exit(1);
  }
}
