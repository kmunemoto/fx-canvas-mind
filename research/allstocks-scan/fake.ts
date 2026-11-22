// Made-up Yahoo-shaped 15-minute answers for the scan's tests (a seeded random walk; no Yahoo answer is used or
// stored). Shared by judge_test.ts and scan_test.ts.

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// weekdays from `from` to `to` (YYYY-MM-DD, inclusive)
export const weekdays = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 24 * HOUR) {
    const d = new Date(t);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

// the bar opens (UTC ms) of one made-up regular session, as Yahoo's 15m answer stamps them
export const usOpens = (day: string): number[] => {
  const off = day < "2026-11-01" ? 4 : 5; // New York's summer time ended 2026-11-01
  const start = Date.parse(`${day}T09:30:00Z`) + off * HOUR;
  return Array.from({ length: 26 }, (_, k) => start + k * 15 * MIN);
};
export const jpOpens = (day: string): number[] => {
  const base = Date.parse(`${day}T00:00:00Z`); // 9:00 JST
  const am = Array.from({ length: 10 }, (_, k) => base + k * 15 * MIN); // 9:00 ... 11:15
  const lunch = [base + 150 * MIN]; // 11:30, the morning close's bar
  const pm = Array.from({ length: 12 }, (_, k) => base + 210 * MIN + k * 15 * MIN); // 12:30 ... 15:15
  return [...am, ...lunch, ...pm];
};

// A Yahoo-shaped 15m answer of made-up prices for `sym` over `days`, ending with the closing point (volume 0) as Yahoo
// sends it; `bump` changes the closes from bar index `from` on (for the no-look-ahead check)
export const fakeAnswer = (sym: string, days: string[], seed: number, bump?: { from: number; by: number }) => {
  const jp = sym.endsWith(".T");
  const r = rng(seed);
  const ts: number[] = [];
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
  let p = jp ? 2000 : 100;
  let i = 0;
  for (const day of days) {
    for (const t of jp ? jpOpens(day) : usOpens(day)) {
      const open = p;
      p = Math.max(1, p * (1 + (r() - 0.5) * 0.01));
      const close = bump && i >= bump.from ? p * bump.by : p;
      ts.push(t / 1000);
      o.push(open); c.push(close); h.push(Math.max(open, close) * 1.001); l.push(Math.min(open, close) * 0.999); v.push(1000);
      i++;
    }
  }
  const last = days[days.length - 1];
  const opens = jp ? jpOpens(last) : usOpens(last);
  const sessionStart = opens[0];
  const sessionEnd = opens[opens.length - 1] + 15 * MIN;
  // Yahoo's closing point: the session's close, volume 0 (joined to the last bar by parseYahooChart)
  ts.push(sessionEnd / 1000);
  o.push(c[c.length - 1]); h.push(c[c.length - 1]); l.push(c[c.length - 1]); c.push(c[c.length - 1]); v.push(0);
  return {
    chart: {
      result: [{
        meta: {
          regularMarketTime: sessionEnd / 1000,
          gmtoffset: jp ? 32400 : -18000,
          currentTradingPeriod: { regular: { start: sessionStart / 1000, end: sessionEnd / 1000 } },
        },
        timestamp: ts,
        indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] },
      }],
    },
  };
};
