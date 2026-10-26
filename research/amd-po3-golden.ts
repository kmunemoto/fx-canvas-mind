// #385 (docs §8.128): writes the test walk (src/test/amd-po3-walk.ts) as the
// input of the independent Python port, research/amd-po3-check.py:
//   deno run -A research/amd-po3-golden.ts OUT_DIR
// then  python3 research/amd-po3-check.py OUT_DIR/walk.json OUT_DIR/py.json
// gives src/test/amd-po3-golden.json (the test compares this app's port to it).
import { amdWalk } from "../src/test/amd-po3-walk.ts";

const [dir] = Deno.args;
const bars = amdWalk(1600);
Deno.writeTextFileSync(
  `${dir}/walk.json`,
  JSON.stringify({ mintick: 0.001, theme: "dark", tf: "15", confirmed: bars.length - 1, bars: bars.map((b, i) => [i, b.open, b.high, b.low, b.close]) }),
);
