// Local test bench of morning-check v9: plays production's MACD ride over the synthetic bars with the SHARED code
// (supabase/functions/_shared/macd-ride.ts), and writes (1) the rows production would have left (rides, state rows, mails) as SQL,
// (2) the lines the morning check should answer for each GMO day, worked out here from those rows with rideCloseStep.
//   deno run -A sim.ts OUTDIR
import { macd } from "../../../supabase/functions/_shared/macd.ts";
import { zoneAt } from "../../../supabase/functions/_shared/macd-level.ts";
import {
  atShare,
  rideLineAt,
  rideCatchUp,
  rideCloseStep,
  rideEntryAt,
  rideStateOf,
  rideTouch,
  rideZoneSideOf,
  shareOf,
  type RideBar,
  type RideEntry,
  type RideRow,
  type RideState,
} from "../../../supabase/functions/_shared/macd-ride.ts";

const dir = Deno.args[0];
const HOUR = 3_600_000;
const LIVE = Date.UTC(2026, 10, 12, 7); // 2026-11-12 07:00 UTC, the first bar v39 judged
const RULE = "macdx_12_26_9_w600_1h_ride90to96of120";
const src = JSON.parse(Deno.readTextFileSync(`${dir}/bars.json`)) as Record<string, { pair: string; d: number; gold?: boolean; bars: (string | number)[][]; ticks?: Record<string, number[]> }>;

const iso = (ms: number) => new Date(ms).toISOString();
// the sweep's weekend window, on an instant: Friday from 21:00, Saturday, Sunday before 22:00 (UTC)
const weekend = (ms: number) => {
  const t = new Date(ms);
  const dw = t.getUTCDay();
  const h = t.getUTCHours();
  return (dw === 5 && h >= 21) || dw === 6 || (dw === 0 && h < 22);
};

interface Ride extends RideRow {
  pair: string;
  entryClosedAt: number;
  entryPrice: number;
  entryMid: number;
  share0: number;
  createdAt: number;
  reachedAt: number | null;
  seenPrice: number | null;
  late: boolean | null;
  share1: number | null;
}
interface Mail {
  pair: string;
  side: string;
  kind: "in" | "at" | "out";
  barTime: number;
  closedAt: number;
  entry: number;
  sentAt: number;
}
const sql: string[] = [];
const expect: Record<string, unknown>[] = [];
const perBar: Record<string, unknown>[] = [];
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: number | null) => (v === null ? "null" : `'${JSON.stringify(v)}'::float8`);
const ts = (ms: number | null) => (ms === null ? "null" : `'${iso(ms)}'::timestamptz`);

for (const [symbol, { pair, d, gold, bars: raw, ticks }] of Object.entries(src)) {
  const r = (v: number) => Number(v.toFixed(d));
  // a bar as production reads it: high / low / close as the chart draws them; what a ride pays and leaves at there (a pair: ask / bid as given; gold: the close);
  // mHigh / mLow / mClose = what the minute's check reads of the bar (a pair: the same bar; gold: the hour's recorded minutes, null with none)
  const bars = raw.map((b) => {
    if (gold) {
      const [t, , h, l, c] = b.map(Number);
      const k = ticks?.[String(t)] ?? null;
      return { t, high: r(h), low: r(l), close: r(c), bidClose: r(c), askClose: r(c), mHigh: k ? r(k[0]) : null, mLow: k ? r(k[1]) : null, mClose: k ? r(k[2]) : null };
    }
    const [t, , bh, bl, bc, , ah, al, ac] = b.map(Number);
    return { t, high: r((bh + ah) / 2), low: r((bl + al) / 2), close: r((bc + ac) / 2), bidClose: bc, askClose: ac, mHigh: r((bh + ah) / 2), mLow: r((bl + al) / 2), mClose: null as number | null };
  });
  const closes = bars.map((b) => b.close);
  const rides: Ride[] = [];
  const mails: Mail[] = [];
  const states = new Map<number, RideState>();
  const entries = new Map<number, RideEntry>();
  const nearOf = new Map<number, { near: boolean; top: boolean | null; bottom: boolean | null }>();
  let minutesOnly = 0;
  const reach = (ride: Ride, bar: number, at: number, price: number, late: boolean, share: number) => {
    ride.status = "reached";
    ride.reachedBar = bar;
    ride.reachedAt = at;
    ride.seenPrice = price;
    ride.late = late;
    ride.share1 = share;
    mails.push({ pair, side: ride.side, kind: "out", barTime: ride.entryBar, closedAt: at, entry: ride.entryPrice, sentAt: at + 2_500 });
  };
  for (let j = 600; j < bars.length; j++) {
    const b = bars[j];
    const upTo = closes.slice(0, j + 1);
    const entry = rideEntryAt(upTo);
    if (entry) entries.set(b.t, entry);
    const st = rideStateOf(closes.slice(0, j));
    const tt = st ? rideTouch(st, "top", b.high, b.low) !== null || (b.mHigh !== null && b.mLow !== null && rideTouch(st, "top", b.mHigh, b.mLow) !== null) : null;
    const tb = st ? rideTouch(st, "bottom", b.high, b.low) !== null || (b.mHigh !== null && b.mLow !== null && rideTouch(st, "bottom", b.mHigh, b.mLow) !== null) : null;
    // near_edge, worked out here on its own: the close's decision with the bar's close two ticks lower and higher (the bar before as it is), and the touch with the
    // high / low two ticks lower and higher
    const tick = 10 ** -d;
    const zp = zoneAt(macd(upTo.slice(-600)), 598);
    const clsAt = (c: number): string | null => {
      if (!st || !zp) return null;
      const z = rideLineAt(st, c);
      if (atShare(z, "top", 0.9) && !atShare(zp, "top", 0.9)) return atShare(z, "top", 0.96) ? "BUY@" : "BUY";
      if (atShare(z, "bottom", 0.9) && !atShare(zp, "bottom", 0.9)) return atShare(z, "bottom", 0.96) ? "SELL@" : "SELL";
      return null;
    };
    const cls = entry ? entry.side + (entry.already ? "@" : "") : null;
    const moved = (v: number, k: number) => Number((v + k * tick).toFixed(d));
    const near = clsAt(moved(b.close, -2)) !== cls || clsAt(moved(b.close, 2)) !== cls;
    const nearT = (zs: "top" | "bottom") => {
      if (!st) return null;
      const one = (v: number | null) => v !== null && (rideTouch(st, zs, moved(v, -2), moved(v, -2)) !== null) !== (rideTouch(st, zs, moved(v, 2), moved(v, 2)) !== null);
      return one(zs === "top" ? b.high : b.low) || (gold ? one(zs === "top" ? b.mHigh : b.mLow) : false);
    };
    if (clsAt(b.close) !== cls) throw new Error(`the line rebuilt from the state disagrees with the entry at ${symbol} ${b.t}`);
    nearOf.set(b.t, { near, top: nearT("top"), bottom: nearT("bottom") });
    perBar.push({ symbol, t: b.t, cls, tt, tb, st, high: b.high, low: b.low, close: b.close, near });
    if (b.t < LIVE) continue;
    // B: the minutes of bar j (not in the weekend window), with the state kept at the close before
    const kept = states.get(b.t) ?? null;
    if (kept && !weekend(b.t) && b.mHigh !== null && b.mLow !== null) {
      for (const ride of rides.filter((x) => x.status === "open" && x.entryBar < b.t)) {
        const touch = rideTouch(kept, rideZoneSideOf(ride.side), b.mHigh, b.mLow);
        if (touch) {
          reach(ride, b.t, b.t + 17 * 60_000, b.mClose ?? (ride.side === "BUY" ? b.bidClose : b.askClose), false, touch.share);
          // (gold) seen by the recorded minutes alone: the stored bar's own high / low does not touch
          if (gold && rideTouch(kept, rideZoneSideOf(ride.side), b.high, b.low) === null) minutesOnly++;
        }
      }
    }
    // A: the close of bar j
    const ct = b.t + HOUR;
    if (weekend(ct)) continue;
    const state = rideStateOf(upTo);
    if (state) states.set(ct, state);
    const rb: RideBar[] = bars.slice(Math.max(0, j + 1 - 700), j + 1).map((x) => ({ t: x.t, high: x.high, low: x.low, close: x.close }));
    for (const ride of rides.filter((x) => x.status === "open")) {
      const c = rideCatchUp(rb, rideZoneSideOf(ride.side), ride.entryBar);
      if (c) reach(ride, c.bar, ct + 4_000, ride.side === "BUY" ? b.bidClose : b.askClose, true, c.share);
    }
    const step = rideCloseStep(entry, b.t, rides);
    if (!entry) continue;
    if (step.step === "at") mails.push({ pair, side: entry.side, kind: "at", barTime: b.t, closedAt: ct, entry: b.close, sentAt: ct + 3_300 });
    if (step.step === "in") {
      const paid = entry.side === "BUY" ? b.askClose : b.bidClose;
      rides.push({
        pair, side: entry.side, entryBar: b.t, status: "open", reachedBar: null, entryClosedAt: ct, entryPrice: paid, entryMid: b.close,
        share0: shareOf(entry.z, entry.zside), createdAt: ct + 3_000, reachedAt: null, seenPrice: null, late: null, share1: null,
      });
      mails.push({ pair, side: entry.side, kind: "in", barTime: b.t, closedAt: ct, entry: paid, sentAt: ct + 3_800 });
    }
  }
  // the rows
  for (const x of rides) {
    sql.push(`insert into public.macd_rides (pair, side, entry_bar, entry_closed_at, entry_price, entry_mid, share0, status, reached_at, reached_bar, seen_price, late, share1, created_at) values (${q(pair)}, ${q(x.side)}, ${ts(x.entryBar)}, ${ts(x.entryClosedAt)}, ${num(x.entryPrice)}, ${num(x.entryMid)}, ${num(x.share0)}, ${q(x.status)}, ${ts(x.reachedAt)}, ${ts(x.reachedBar)}, ${num(x.seenPrice)}, ${x.late === null ? "null" : x.late}, ${num(x.share1)}, ${ts(x.createdAt)});`);
  }
  for (const [t, s] of states) {
    sql.push(`insert into public.macd_ride_state (pair, bar_time, e12, e26, sig, top119, bottom119, last_bar) values (${q(pair)}, ${ts(t)}, ${num(s.e12)}, ${num(s.e26)}, ${num(s.sig)}, ${num(s.top119)}, ${num(s.bottom119)}, ${ts(t - HOUR)});`);
  }
  for (const m of mails) {
    sql.push(`insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, created_at, sent_at) values ('signal', ${q(pair)}, '1h', ${ts(m.barTime)}, ${ts(m.closedAt)}, ${q(m.side)}, ${num(m.entry)}, ${q(`${RULE}_${m.kind}_v9`)}, 'sent', ${ts(m.sentAt - 900)}, ${ts(m.sentAt)});`);
  }
  sql.push(`insert into public.signal_alert_subscriptions (pair, interval, rule) values (${q(pair)}, '1h', 'macdx');`);
  // what the morning check should say, from the rows as they stand at the end (as the statement reads them)
  const mailAt = (kind: string, t: number, side: string) => mails.some((m) => m.kind === kind && m.barTime === t && m.side === side);
  for (const b of bars.slice(600)) {
    const entry = entries.get(b.t);
    if (!entry) continue;
    const others = rides.filter((x) => !(x.entryBar === b.t && x.side === entry.side));
    const step = rideCloseStep(entry, b.t, others).step!;
    const kind = step === "in" || step === "skip" ? "in" : "at";
    const reasons = [weekend(b.t + HOUR) ? "weekend_window" : null, b.t < LIVE ? "before_go_live" : null].filter(Boolean).join(";");
    const verdict = step === "skip" || step === "quiet" ? step : mailAt(kind, b.t, entry.side) ? "ok" : reasons ? "not_mailable" : "missing";
    expect.push({ pair, bar: b.t, side: entry.side, kind, verdict, step, reasons, near: nearOf.get(b.t)?.near ?? null });
  }
  for (const x of rides) {
    if (x.status === "reached") expect.push({ pair, bar: x.reachedBar, side: x.side, kind: "out", verdict: "ok", entryBar: x.entryBar, late: x.late, seenAt: x.reachedAt,
      near: nearOf.get(x.reachedBar!)?.[x.side === "BUY" ? "top" : "bottom"] ?? null });
    else expect.push({ pair, bar: null, side: x.side, kind: "open", verdict: "open", entryBar: x.entryBar });
  }
  console.log(pair, "rides", rides.length, "reached", rides.filter((x) => x.status === "reached").length, "late", rides.filter((x) => x.late).length,
    "mails in/at/out", ["in", "at", "out"].map((k) => mails.filter((m) => m.kind === k).length).join("/"), "states", states.size, "entries", entries.size,
    ...(gold ? ["by the minutes alone", minutesOnly] : []));
}
Deno.writeTextFileSync(`${dir}/rows.sql`, sql.join("\n") + "\n");
Deno.writeTextFileSync(`${dir}/expect.json`, JSON.stringify(expect));
Deno.writeTextFileSync(`${dir}/perbar.json`, JSON.stringify(perBar));
