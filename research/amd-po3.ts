// #385 (docs §8.128): this app's AMD Po3 port over a directory of cases
// (research/amd-po3-cases.py), written in the shape of research/amd-po3-spec.md
// for research/amd-po3-compare.py, and how often the email's judgment (the W
// closed bars ending at a bar) agrees with the chart's (one run over all):
//   deno run -A research/amd-po3.ts run IN_DIR OUT_DIR
//   deno run -A research/amd-po3.ts agree IN_DIR 600
import { amdPo3, type AmdDist } from "../supabase/functions/_shared/amd-po3.ts";

const [mode, inDir, arg] = Deno.args;
const cases = [...Deno.readDirSync(inDir)].map((e) => e.name).filter((x) => x.endsWith(".json")).sort();
const read = (f: string) => {
  const c = JSON.parse(Deno.readTextFileSync(`${inDir}/${f}`));
  return { c, bars: c.bars.map(([t, o, h, l, cl]: number[]) => ({ t, o, h, l, c: cl })) };
};
if (mode === "run") {
  for (const f of cases) {
    const { c, bars } = read(f);
    const { live: _live, ...out } = amdPo3(bars, { mintick: c.mintick, theme: c.theme, tf: c.tf, confirmed: c.confirmed });
    Deno.writeTextFileSync(`${arg}/${f}`, JSON.stringify(out));
  }
} else if (mode === "agree") {
  const W = Number(arg);
  let both = 0, chartOnly = 0, mailOnly = 0, diffLevels = 0, windows = 0;
  for (const f of cases) {
    const { c, bars } = read(f);
    const full = new Map<number, AmdDist>();
    for (const e of amdPo3(bars, { mintick: c.mintick }).events) if (e.type === "DIST") full.set(e.bar, e);
    for (let b = W - 1; b < bars.length; b++) {
      windows++;
      const d = amdPo3(bars.slice(b - W + 1, b + 1), { mintick: c.mintick }).events.find((e): e is AmdDist => e.type === "DIST" && e.bar === W - 1);
      const g = full.get(b);
      if (d && g) {
        both++;
        if (d.entry !== g.entry || d.stop !== g.stop || d.target !== g.target || d.dir !== g.dir) diffLevels++;
      } else if (d) mailOnly++;
      else if (g) chartOnly++;
    }
  }
  console.log(JSON.stringify({ W, cases: cases.length, windows, both, chartOnly, mailOnly, diffLevels }));
}
