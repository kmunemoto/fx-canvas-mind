// #318 (docs §8.113 置8): the thresholds of three items, from made-up series
// only (no price data): vr (C26: z*'s 2.5% and 97.5% points), hurst (C27: H's
// 2.5% and 97.5% points) and linreg (C20: |r|'s 80% point). Each item has its
// own stream: vr seed 9001, hurst 9002, linreg 9003.
//
// The stream: mulberry32 as research/gmo.ts (x is the 32-bit output),
// u = (x + 0.5) / 2^32, and Box–Muller as research/ownerhold-data.ts's gauss:
// u1 then u2, r = sqrt(-2 ln u1), first r cos(2π u2), then r sin(2π u2).
// The stream is cut in order into windows: vr 1,008 increments a window
// (10,000 windows), hurst 256 (20,000), linreg 100 (20,000; y_j is the running
// sum of the window's values from its first one).
// A point is the floor(q × (n − 1))-th of the sorted values (money-stats.ts's
// quantile); the table writes it rounded to 3 decimals (四捨五入, half away
// from zero; none of the values sits on a tie).
// research/chartbest-thresholds-check.py recomputes the same with numpy.
//
//   deno run research/chartbest-thresholds.ts   (or: node --experimental-strip-types)

const mulberry = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
};

const normals = (seed: number) => {
  const next = mulberry(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u1 = (next() + 0.5) / 4294967296;
    const u2 = (next() + 0.5) / 4294967296;
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
};

const point = (sorted: Float64Array, q: number) => sorted[Math.floor(q * (sorted.length - 1))];
const round3 = (v: number) => {
  const s = Math.sign(v) * Math.floor(Math.abs(v) * 1000 + 0.5) / 1000;
  return Number(s.toFixed(3));
};

// C26 steps 2-4: N = 1,008 increments, q = 12 (Lo–MacKinlay, overlapping,
// debiased, heteroskedasticity-robust; the same as arch's VarianceRatio)
const zstar = (a: Float64Array) => {
  const N = a.length;
  const q = 12;
  let mu = 0;
  for (let k = 0; k < N; k++) mu += a[k];
  mu /= N;
  const e = new Float64Array(N);
  let SS = 0;
  for (let k = 0; k < N; k++) {
    e[k] = a[k] - mu;
    SS += e[k] * e[k];
  }
  const sa2 = SS / (N - 1);
  const Z = new Float64Array(N + 1);
  for (let k = 1; k <= N; k++) Z[k] = Z[k - 1] + a[k - 1];
  const m = 12 * 997 * (1 - 12 / 1008);
  let sc = 0;
  for (let k = q; k <= N; k++) {
    const d = Z[k] - Z[k - q] - q * mu;
    sc += d * d;
  }
  sc /= m;
  const VR = sc / sa2;
  let theta = 0;
  for (let j = 1; j < q; j++) {
    let s = 0;
    for (let k = j + 1; k <= N; k++) s += (e[k - 1] * e[k - 1]) * (e[k - j - 1] * e[k - j - 1]);
    const delta = (N * s) / (SS * SS);
    const w = (2 * (q - j)) / q;
    theta += w * w * delta;
  }
  return (Math.sqrt(N) * (VR - 1)) / Math.sqrt(theta);
};

// C27 steps 1-3: W = 256, n = 8 … 256, the slope of ln A(n) on ln n
const hurstH = (rho: Float64Array) => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of [8, 16, 32, 64, 128, 256]) {
    let sum = 0;
    let count = 0;
    for (let s0 = 0; s0 < 256; s0 += n) {
      let m = 0;
      for (let j = 0; j < n; j++) m += rho[s0 + j];
      m /= n;
      let Y = 0;
      let hi = -Infinity;
      let lo = Infinity;
      let ss = 0;
      for (let j = 0; j < n; j++) {
        const d = rho[s0 + j] - m;
        Y += d;
        if (Y > hi) hi = Y;
        if (Y < lo) lo = Y;
        ss += d * d;
      }
      sum += (hi - lo) / Math.sqrt(ss / n);
      count++;
    }
    xs.push(Math.log(n));
    ys.push(Math.log(sum / count));
  }
  let xb = 0;
  let yb = 0;
  for (let i = 0; i < 6; i++) {
    xb += xs[i];
    yb += ys[i];
  }
  xb /= 6;
  yb /= 6;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < 6; i++) {
    sxy += (xs[i] - xb) * (ys[i] - yb);
    sxx += (xs[i] - xb) * (xs[i] - xb);
  }
  return sxy / sxx;
};

// C20: N = 100, x_j = j, r of y on x
const corr = (y: Float64Array) => {
  let yb = 0;
  for (let j = 0; j < 100; j++) yb += y[j];
  yb /= 100;
  let sxy = 0;
  let syy = 0;
  for (let j = 0; j < 100; j++) {
    const dy = y[j] - yb;
    sxy += (j - 49.5) * dy;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(83325 * syy);
};

const vr = (() => {
  const g = normals(9001);
  const v = new Float64Array(10000);
  const a = new Float64Array(1008);
  for (let w = 0; w < 10000; w++) {
    for (let k = 0; k < 1008; k++) a[k] = g();
    v[w] = zstar(a);
  }
  const s = Float64Array.from(v).sort();
  return { windows: 10000, lo: point(s, 0.025), hi: point(s, 0.975), median: point(s, 0.5) };
})();

const hurst = (() => {
  const g = normals(9002);
  const v = new Float64Array(20000);
  const r = new Float64Array(256);
  for (let w = 0; w < 20000; w++) {
    for (let k = 0; k < 256; k++) r[k] = g();
    v[w] = hurstH(r);
  }
  const s = Float64Array.from(v).sort();
  return { windows: 20000, lo: point(s, 0.025), hi: point(s, 0.975), median: point(s, 0.5) };
})();

const linreg = (() => {
  const g = normals(9003);
  const v = new Float64Array(20000);
  const y = new Float64Array(100);
  for (let w = 0; w < 20000; w++) {
    let c = 0;
    for (let j = 0; j < 100; j++) {
      c += g();
      y[j] = c;
    }
    v[w] = Math.abs(corr(y));
  }
  const s = Float64Array.from(v).sort();
  return { windows: 20000, absQ80: point(s, 0.8), median: point(s, 0.5) };
})();

const first = normals(9001);
console.log(JSON.stringify({
  firstNormals9001: [first(), first(), first(), first()],
  vr: { ...vr, table: [round3(vr.lo), round3(vr.hi)] },
  hurst: { ...hurst, table: [round3(hurst.lo), round3(hurst.hi)] },
  linreg: { ...linreg, table: round3(linreg.absQ80) },
}, null, 1));
