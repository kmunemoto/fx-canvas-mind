// #385: a seeded walk for the AMD Po3 tests — quiet stretches (ranges form),
// wild ones, and wicks that break a range and come back — on USD/JPY's
// 0.001 grid. research/amd-po3-golden.ts writes it out for the independent
// Python port (research/amd-po3-check.py), whose answer is
// src/test/amd-po3-golden.json.
export const AMD_M15 = 15 * 60_000;
export const AMD_T0 = Date.parse("2026-06-01T00:00:00Z");
export const amdStamp = (i: number) => new Date(AMD_T0 + i * AMD_M15).toISOString().slice(0, 19).replace("T", " ");

export const amdWalk = (n: number, seed = 7) => {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  // about a unit normal (six uniforms)
  const gauss = () => {
    let u = 0;
    for (let k = 0; k < 6; k++) u += rnd();
    return (u - 3) * Math.SQRT2;
  };
  let x = 150_000;
  let left = 0;
  let sigma = 30;
  const out: Array<{ datetime: string; open: number; high: number; low: number; close: number }> = [];
  for (let i = 0; i < n; i++) {
    if (left-- <= 0) {
      const quiet = rnd() < 0.55;
      sigma = (quiet ? 1.5 + rnd() * 3.5 : 6 + rnd() * 19) * 14;
      left = quiet ? 25 + Math.floor(rnd() * 115) : 10 + Math.floor(rnd() * 80);
    }
    const o = x;
    const c = o + Math.round(gauss() * sigma);
    let h = Math.max(o, c) + Math.round(Math.abs(gauss()) * sigma * 0.7);
    let l = Math.min(o, c) - Math.round(Math.abs(gauss()) * sigma * 0.7);
    const r = rnd();
    if (r < 0.035) h += Math.round((2 + 4 * rnd()) * sigma);
    else if (r < 0.07) l -= Math.round((2 + 4 * rnd()) * sigma);
    x = c;
    out.push({ datetime: amdStamp(i), open: o / 1000, high: h / 1000, low: l / 1000, close: c / 1000 });
  }
  return out;
};
