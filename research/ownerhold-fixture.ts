// #205 (docs §8.102 確かめ A 手の例): small markets built bar by bar, USD/JPY
// alone, with what must come out worked out by hand beside each. Both
// programs (ownerhold.ts and ownerhold-check.py) run them; each planted
// error must change something in one of them or in the synthetic walk.
//
// The mid is a line through the knots below (a knot repeated at one time is a
// jump: the bar opening there opens at the later value); a bar's open is the
// mid at its start, its close the mid just before its end, its high and low the
// largest and smallest of those and of any knot inside the minute; the bid and ask are the mid ∓ 0.001 (0.2 pips). Bars
// exist in GMO's week (ownerhold-data synthOpen) outside the `shut` spans.

import { MINUTE } from "./lib.ts";
import { type M1, PAIRS, type Sig, synthOpen } from "./ownerhold-data.ts";
import type { AccountOut } from "./ownerhold-account.ts";

const at = (s: string) => Date.parse(s.endsWith("Z") ? s : `${s}Z`);
const HALF = 0.001;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const empty = (pair: string): M1 => {
  const z = new Float64Array(0);
  return { pair, n: 0, t: z, bo: z, bh: z, bl: z, bc: z, ao: z, ah: z, al: z, ac: z };
};

// USD/JPY's bars from `from` to `to` along the knots
const usdJpy = (knots: Array<[string, number]>, from: string, to: string, shut: Array<[string, string]> = []): M1 => {
  const ks = knots.map(([t, v]) => [at(t), v] as [number, number]);
  // the mid at time t, from the right (after a jump) or the left (before it)
  const midAt = (t: number, right: boolean) => {
    if (t <= ks[0][0]) return ks[0][1];
    if (t >= ks[ks.length - 1][0]) return ks[ks.length - 1][1];
    for (let i = 0; i + 1 < ks.length; i++) {
      const [ta, va] = ks[i];
      const [tb, vb] = ks[i + 1];
      if (t === ta && (right ? i + 1 >= ks.length || ks[i + 1][0] !== ta : true)) {
        // at a knot: the left value is the first knot at that time, the right the last
        if (!right) return va;
        let j = i;
        while (j + 1 < ks.length && ks[j + 1][0] === ta) j++;
        return ks[j][1];
      }
      if (t > ta && t < tb) return va + ((vb - va) * (t - ta)) / (tb - ta);
      if (t === tb && !right) return vb;
    }
    return ks[ks.length - 1][1];
  };
  const shutMs = shut.map(([a, b]) => [at(a), at(b)]);
  const rows: number[][] = [];
  for (let t = at(from); t + MINUTE <= at(to); t += MINUTE) {
    if (!synthOpen(t) || shutMs.some(([a, b]) => t >= a && t < b)) continue;
    const o = r3(midAt(t, true));
    const c = r3(midAt(t + MINUTE, false));
    // knots inside the minute reach its high and low
    const inside = ks.filter(([kt]) => kt > t && kt < t + MINUTE).map(([, v]) => r3(v));
    rows.push([t, o, Math.max(o, c, ...inside), Math.min(o, c, ...inside), c]);
  }
  const n = rows.length;
  const f = (k: number, d: number) => Float64Array.from(rows.map((x) => r3(x[k] + d)));
  return { pair: "USD/JPY", n, t: Float64Array.from(rows.map((x) => x[0])), bo: f(1, -HALF), bh: f(2, -HALF), bl: f(3, -HALF), bc: f(4, -HALF), ao: f(1, HALF), ah: f(2, HALF), al: f(3, HALF), ac: f(4, HALF) };
};

// an email on USD/JPY: its 15-minute bar closing at T, entry E (TP2 = E ± 10 pips)
const email = (T: string, side: "BUY" | "SELL", E: number): Sig => {
  const dir = side === "BUY" ? 1 : -1;
  return { pair: "USD/JPY", pi: 0, side, dir, open: at(T) - 15 * MINUTE, T: at(T), E, tp: E + dir * 10 * 0.01, late: false, base: at(T), bidC: E, askC: E };
};

export interface Fixture {
  name: string;
  // what it shows (§8.102 確かめ A 手の例)
  what: string;
  ctx: { start: number; end: number; split: number; startYen: number; cap: number };
  m1s: M1[];
  sigs: Sig[];
  // what must come out (failures listed; empty when as worked out)
  check: (rows: Record<string, AccountOut>, unl: Record<string, AccountOut>) => string[];
}

const near = (a: number | null | undefined, b: number, what: string, out: string[], tol = 1e-6) => {
  if (a === null || a === undefined || !(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)))) out.push(`${what}: ${a} (worked out: ${b})`);
};
const eq = <T>(a: T, b: T, what: string, out: string[]) => {
  if (a !== b) out.push(`${what}: ${a} (worked out: ${b})`);
};
const books = (u: M1) => [u, ...PAIRS.slice(1).map(empty)];
const ctxOf = (start: string, split: string, end: string, startYen: number, cap = 1_000_000) => ({ start: at(start), split: at(split), end: at(end), startYen, cap });
// the email's index in the fixture's list (signals are kept in P order, BUY first)
const fateOf = (a: AccountOut, k: number) => a.fates[k];

// a margin per position at mid x (10,000 × x × 4%), and the value of buys at 150.001 etc.
const um = (x: number) => 400 * x;

export const FIXTURES: Fixture[] = [];

// ---- 1. the cap: part paid in, the rest cured by a TP of a position held at τ; then an email taken ----
{
  // six buys at 150.001 (Monday's first hours), one at 146.001 (10:02); the mid 140.000 at τ (21:55)
  const knots: Array<[string, number]> = [["2024-01-07T22:00", 150], ["2024-01-08T01:45", 150], ["2024-01-08T10:00", 146], ["2024-01-08T10:10", 146], ["2024-01-08T21:50", 140], ["2024-01-08T22:35", 140], ["2024-01-09T03:00", 146.2], ["2024-01-09T12:00", 146.2]];
  const sigs = [...["00:15", "00:30", "00:45", "01:00", "01:15", "01:30"].map((h) => email(`2024-01-08T${h}`, "BUY", 150.01)), email("2024-01-08T10:00", "BUY", 146.01), email("2024-01-09T06:00", "BUY", 146.21)];
  // at τ: NA (mid) = 900,000 + 10,000 × (6 × (140 − 150.001) + (140 − 146.001)) = 239,930; required = 7 × um(140) = 392,000
  const D = 7 * um(140) - (900_000 + 10_000 * (6 * (140 - 150.001) + (140 - 146.001)));
  FIXTURES.push({
    name: "capPartialSettle",
    what: "上限の手前で一部だけ入金（90万円入れて D 152,070円、10万円を入金、U 52,070円）。τ に持っていた建玉の利確（1本 56,000円の充当）で期限の前に解消し、その後のメールを受け付ける",
    ctx: ctxOf("2024-01-08T00:00", "2024-01-08T12:00", "2024-01-09T12:00", 900_000),
    m1s: books(usdJpy(knots, "2024-01-07T22:00", "2024-01-09T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const a = rows.main;
      eq(a.calls.length, 1, "calls", out);
      near(a.calls[0]?.D, D, "D", out);
      near(D, 152_070, "D by hand", out);
      eq(a.deposits.length, 1, "deposits", out);
      near(a.deposits[0]?.amount, 100_000, "the notice's deposit", out);
      eq(a.deposits[0]?.at, at("2024-01-08T22:30"), "deposited at τ + 35 min", out);
      near(a.calls[0]?.uAfterDeposit, D - 100_000, "U after it", out);
      near(a.calls[0]?.credits, um(140), "the TP's credit", out);
      eq(a.calls[0]?.end, "settle", "how it ended", out);
      for (let k = 0; k < 6; k++) eq(fateOf(a, k), "held", `email ${k}`, out);
      eq(fateOf(a, 6), "tp", "email 6 (146.001)", out);
      eq(fateOf(a, 7), "held", "email 7 (after the cure)", out);
      eq(a.lcs.length, 0, "loss-cuts", out);
      return out;
    },
  });
}

// ---- 2. nothing can go in (1,000,000 already): two TPs' credits cure it ----
{
  const knots: Array<[string, number]> = [["2024-01-14T22:00", 150], ["2024-01-15T01:45", 150], ["2024-01-15T10:00", 146], ["2024-01-15T10:10", 146], ["2024-01-15T14:00", 145], ["2024-01-15T14:10", 145], ["2024-01-15T21:50", 141], ["2024-01-15T22:35", 141], ["2024-01-16T01:00", 145.2], ["2024-01-16T01:30", 145.2], ["2024-01-16T03:00", 146.2], ["2024-01-16T12:00", 146.2]];
  const sigs = [...["00:15", "00:30", "00:45", "01:00", "01:15", "01:30"].map((h) => email(`2024-01-15T${h}`, "BUY", 150.01)), email("2024-01-15T10:00", "BUY", 146.01), email("2024-01-15T14:00", "BUY", 145.01)];
  const D = 8 * um(141) - (1_000_000 + 10_000 * (6 * (141 - 150.001) + (141 - 146.001) + (141 - 145.001)));
  FIXTURES.push({
    name: "capZeroTwoTps",
    what: "入れたお金がすでに100万円で入金0円（D 81,280円）。利確2回の充当（56,400円ずつ）の合計で U が0以下になって解消する",
    ctx: ctxOf("2024-01-15T00:00", "2024-01-15T12:00", "2024-01-16T12:00", 1_000_000),
    m1s: books(usdJpy(knots, "2024-01-14T22:00", "2024-01-16T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const a = rows.main;
      eq(a.calls.length, 1, "calls", out);
      near(D, 81_280, "D by hand", out);
      near(a.calls[0]?.D, D, "D", out);
      eq(a.deposits.length, 0, "deposits", out);
      near(a.calls[0]?.uAfterDeposit, D, "U after the notice", out);
      near(a.calls[0]?.credits, 2 * um(141), "two TPs' credits", out);
      eq(a.calls[0]?.end, "settle", "how it ended", out);
      eq(fateOf(a, 6), "tp", "email 6", out);
      eq(fateOf(a, 7), "tp", "email 7", out);
      return out;
    },
  });
}

// ---- 3. not cured; a loss-cut before the deadline ends it ----
{
  const hours = ["00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45", "02:00", "02:15", "02:30"];
  const knots: Array<[string, number]> = [["2024-01-21T22:00", 150], ["2024-01-22T02:45", 150], ["2024-01-22T21:50", 145], ["2024-01-22T22:35", 145], ["2024-01-23T02:00", 142.5], ["2024-01-23T12:00", 142.5]];
  const sigs = hours.map((h) => email(`2024-01-22T${h}`, "BUY", 150.01));
  // the loss-cut: 1,000,000 + 100,000 × (x − 0.001 − 150.001) < 0.5 × 10 × um(x) ⇔ x < 142.8592
  FIXTURES.push({
    name: "lcBeforeDeadline",
    what: "入金できない追証（D 80,100円）が、期限の前のロスカットで終わる",
    ctx: ctxOf("2024-01-22T00:00", "2024-01-22T12:00", "2024-01-23T12:00", 1_000_000),
    m1s: books(usdJpy(knots, "2024-01-21T22:00", "2024-01-23T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const a = rows.main;
      eq(a.calls.length, 1, "calls", out);
      near(a.calls[0]?.D, 10 * um(145) - (1_000_000 + 100_000 * (145 - 150.001)), "D", out);
      eq(a.calls[0]?.end, "lc", "how it ended", out);
      eq(a.lcs.length, 1, "loss-cuts", out);
      for (let k = 0; k < 10; k++) eq(fateOf(a, k), "lc", `email ${k}`, out);
      return out;
    },
  });
}

// ---- 4a. a TP between the stop's end and the notice lowers U, and the deposit with it; an email after ----
{
  const knots: Array<[string, number]> = [["2024-01-28T22:00", 150], ["2024-01-29T01:45", 150], ["2024-01-29T10:00", 146], ["2024-01-29T10:10", 146], ["2024-01-29T21:50", 140], ["2024-01-29T22:10", 140], ["2024-01-29T22:20", 146.2], ["2024-01-30T12:00", 146.2]];
  const sigs = [...["00:15", "00:30", "00:45", "01:00", "01:15", "01:30"].map((h) => email(`2024-01-29T${h}`, "BUY", 150.01)), email("2024-01-29T10:00", "BUY", 146.01), email("2024-01-30T03:00", "BUY", 146.21)];
  const D = 7 * um(140) - (900_000 + 10_000 * (6 * (140 - 150.001) + (140 - 146.001)));
  FIXTURES.push({
    name: "noticeTp",
    what: "判定から知らせの時刻までの間（止まる時間の後）の利確で U が減り、知らせの時刻の入金が減る（96,070円）。入金で解消した後のメールを受け付ける",
    ctx: ctxOf("2024-01-29T00:00", "2024-01-29T12:00", "2024-01-30T12:00", 900_000),
    m1s: books(usdJpy(knots, "2024-01-28T22:00", "2024-01-30T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const a = rows.main;
      eq(a.calls.length, 1, "calls", out);
      near(a.calls[0]?.D, D, "D", out);
      near(a.calls[0]?.credits, um(140), "the TP's credit", out);
      near(a.deposits[0]?.amount, D - um(140), "the notice's deposit", out);
      eq(a.deposits[0]?.at, at("2024-01-29T22:30"), "deposited at the notice", out);
      eq(a.calls[0]?.end, "deposit", "how it ended", out);
      eq(fateOf(a, 6), "tp", "email 6", out);
      eq(fateOf(a, 7), "held", "email 7 (taken after the cure)", out);
      return out;
    },
  });
}

// ---- 4b. a loss-cut between the stop's end and the notice: no deposit ----
{
  const hours = ["00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45", "02:00", "02:15", "02:30"];
  const knots: Array<[string, number]> = [["2024-02-04T22:00", 150], ["2024-02-05T02:45", 150], ["2024-02-05T21:50", 145], ["2024-02-05T22:10", 145], ["2024-02-05T22:20", 143], ["2024-02-06T12:00", 143]];
  const sigs = hours.map((h) => email(`2024-02-05T${h}`, "BUY", 150.01));
  // 900,000 in: the loss-cut below 143.8796; with 100,000 more (paid at τ) below 142.8592, not reached
  FIXTURES.push({
    name: "noticeLc",
    what: "判定から知らせの時刻までの間のロスカットで追証が終わり、入金しない（τ に入金していれば、ロスカットは起きない）",
    ctx: ctxOf("2024-02-05T00:00", "2024-02-05T12:00", "2024-02-06T12:00", 900_000),
    m1s: books(usdJpy(knots, "2024-02-04T22:00", "2024-02-06T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const a = rows.main;
      eq(a.calls.length, 1, "calls", out);
      eq(a.calls[0]?.end, "lc", "how it ended", out);
      eq(a.deposits.length, 0, "deposits", out);
      eq(a.lcs.length, 1, "loss-cuts", out);
      return out;
    },
  });
}

// ---- 5a. the 08:59 row: cured by a TP before 08:59, nothing paid in ----
{
  const knots: Array<[string, number]> = [["2024-02-11T22:00", 150], ["2024-02-12T01:45", 150], ["2024-02-12T10:00", 146], ["2024-02-12T10:10", 146], ["2024-02-12T14:00", 145], ["2024-02-12T14:10", 145], ["2024-02-12T21:50", 142], ["2024-02-12T22:35", 142], ["2024-02-13T01:00", 145.2], ["2024-02-13T12:00", 145.2]];
  const sigs = [...["00:15", "00:30", "00:45", "01:00", "01:15", "01:30"].map((h) => email(`2024-02-12T${h}`, "BUY", 150.01)), email("2024-02-12T10:00", "BUY", 146.01), email("2024-02-12T14:00", "BUY", 145.01)];
  const D = 8 * um(142) - (950_000 + 10_000 * (6 * (142 - 150.001) + (142 - 146.001) + (142 - 145.001)));
  FIXTURES.push({
    name: "m0859Cured",
    what: "期限の前に入金する補足の行で、利確（56,800円の充当）で 08:59 の前に解消し（D 54,480円）、入金しない。主の行では知らせの時刻に5万円（枠）を入金し、残りを利確で解消する",
    ctx: ctxOf("2024-02-12T00:00", "2024-02-12T12:00", "2024-02-13T12:00", 950_000),
    m1s: books(usdJpy(knots, "2024-02-11T22:00", "2024-02-13T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      near(D, 54_480, "D by hand", out);
      const a = rows.dep0859;
      eq(a.calls.length, 1, "calls (08:59 row)", out);
      near(a.calls[0]?.D, D, "D", out);
      eq(a.deposits.length, 0, "deposits (08:59 row)", out);
      eq(a.calls[0]?.end, "settle", "how it ended (08:59 row)", out);
      const m = rows.main;
      near(m.deposits[0]?.amount, 50_000, "the main row's notice deposit (the cap's room)", out);
      eq(m.calls[0]?.end, "settle", "how it ended (main)", out);
      return out;
    },
  });
}

// ---- 5b. the 08:59 row: part cured by a TP, the rest (U, not D) paid at 08:59 ----
{
  const knots: Array<[string, number]> = [["2024-02-18T22:00", 150], ["2024-02-19T01:45", 150], ["2024-02-19T10:00", 146], ["2024-02-19T10:10", 146], ["2024-02-19T21:50", 140], ["2024-02-19T22:35", 140], ["2024-02-20T03:00", 146.2], ["2024-02-20T12:00", 146.2]];
  const sigs = [...["00:15", "00:30", "00:45", "01:00", "01:15", "01:30"].map((h) => email(`2024-02-19T${h}`, "BUY", 150.01)), email("2024-02-19T10:00", "BUY", 146.01)];
  const D = 7 * um(140) - (900_000 + 10_000 * (6 * (140 - 150.001) + (140 - 146.001)));
  FIXTURES.push({
    name: "m0859Part",
    what: "期限の前に入金する補足の行で、08:59 の前の利確1回（56,000円）で一部だけ充当され、08:59 に U（96,070円）だけを入金して解消する",
    ctx: ctxOf("2024-02-19T00:00", "2024-02-19T12:00", "2024-02-20T12:00", 900_000),
    m1s: books(usdJpy(knots, "2024-02-18T22:00", "2024-02-20T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const a = rows.dep0859;
      eq(a.calls.length, 1, "calls", out);
      near(a.calls[0]?.credits, um(140), "the TP's credit", out);
      near(a.deposits[0]?.amount, D - um(140), "the 08:59 deposit", out);
      eq(a.deposits[0]?.at, at("2024-02-20T08:59"), "deposited at 08:59", out);
      eq(a.calls[0]?.end, "deposit", "how it ended", out);
      return out;
    },
  });
}

// ---- 6. Christmas: the 12/24 call, no bars on 12/25, the notice's deposit cures it, no deadline close ----
{
  const knots: Array<[string, number]> = [["2024-12-22T22:00", 150], ["2024-12-23T01:00", 150], ["2024-12-24T20:00", 145.5], ["2024-12-26T12:00", 145.5]];
  const sigs = ["00:15", "00:30", "00:45"].map((h) => email(`2024-12-23T${h}`, "BUY", 150.01));
  const D = 3 * um(145.5) - (300_000 + 30_000 * (145.5 - 150.001));
  FIXTURES.push({
    name: "christmas",
    what: "12/24 の NY の引けの追証（GMO の足が 12/24 21:00 UTC から 12/25 22:00 UTC まで無い）で、知らせの時刻の入金で解消し、期限の全決済にならない。12/25 の引けは同じ値段の点なので判定しない",
    ctx: ctxOf("2024-12-23T00:00", "2024-12-24T00:00", "2024-12-26T12:00", 300_000),
    m1s: books(usdJpy(knots, "2024-12-22T22:00", "2024-12-26T12:00", [["2024-12-24T21:00", "2024-12-25T22:00"]])),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const a = rows.main;
      near(D, 9_630, "D by hand", out);
      eq(a.calls.length, 1, "calls", out);
      near(a.calls[0]?.D, D, "D", out);
      near(a.deposits[0]?.amount, D, "the notice's deposit", out);
      eq(a.deposits[0]?.at, at("2024-12-24T22:30"), "deposited at the notice", out);
      eq(a.calls[0]?.end, "deposit", "how it ended", out);
      for (let k = 0; k < 3; k++) eq(fateOf(a, k), "held", `email ${k}`, out);
      return out;
    },
  });
}

// ---- 7. a Friday's call cancels a limit; Monday opens past it (not filled) ----
{
  const knots: Array<[string, number]> = [["2024-01-10T22:00", 150], ["2024-01-11T01:00", 150], ["2024-01-12T20:00", 144], ["2024-01-14T22:00", 144], ["2024-01-14T22:00", 142.9], ["2024-01-15T12:00", 142.9]];
  // three buys at 150.001 and a buy limit at 143.000 (Thursday), the mid 144.000 at Friday's close
  const sigs = [...["00:15", "00:30", "00:45"].map((h) => email(`2024-01-11T${h}`, "BUY", 150.01)), email("2024-01-11T01:00", "BUY", 143)];
  const D = 3 * um(144) - (320_000 + 30_000 * (144 - 150.001));
  FIXTURES.push({
    name: "fridayCall",
    what: "金曜の NY の引けの追証（D 32,830円）で置いている指値を取り消し、週明けの窓（142.9 で始まる）でその指値が約定しない",
    ctx: ctxOf("2024-01-11T00:00", "2024-01-12T00:00", "2024-01-15T12:00", 320_000),
    m1s: books(usdJpy(knots, "2024-01-10T22:00", "2024-01-15T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const a = rows.main;
      near(D, 32_830, "D by hand", out);
      eq(a.calls.length, 1, "calls", out);
      eq(a.calls[0]?.tau, at("2024-01-12T21:55"), "Friday's τ", out);
      near(a.calls[0]?.D, D, "D", out);
      eq(a.calls[0]?.cancelled, 1, "limits cancelled", out);
      eq(fateOf(a, 3), "cancelCall", "the limit", out);
      near(a.deposits[0]?.amount, D, "the notice's deposit", out);
      eq(a.calls[0]?.end, "deposit", "how it ended", out);
      return out;
    },
  });
}

// ---- 8. a US-summer Friday: the 20:00 UTC signal's P has no bar; taken (refused) before that night's close ----
{
  const knots: Array<[string, number]> = [["2024-06-05T21:00", 150], ["2024-06-06T01:00", 150], ["2024-06-07T19:00", 144], ["2024-06-10T12:00", 144]];
  const sigs = [...["00:15", "00:30", "00:45"].map((h) => email(`2024-06-06T${h}`, "BUY", 150.01)), email("2024-06-07T20:00", "BUY", 143)];
  const D = 3 * um(144) - (320_000 + 30_000 * (144 - 150.001));
  FIXTURES.push({
    name: "summerFriday",
    what: "米国の夏の金曜 20:00 UTC の合図で P（20:02）に足が無い。その注文は引けの前に、有効証拠金で断られる（§8.102 の受け付けでは、同じ値段のまま受け付けた注文の後に追証は出ない。引けの後に回すと、追証の間として断る）。その夜（20:55）に追証",
    ctx: ctxOf("2024-06-06T00:00", "2024-06-07T00:00", "2024-06-10T12:00", 320_000),
    m1s: books(usdJpy(knots, "2024-06-05T21:00", "2024-06-10T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const a = rows.main;
      eq(fateOf(a, 3), "refusedMargin", "the 20:00 signal's order", out);
      eq(a.calls.length, 1, "calls", out);
      eq(a.calls[0]?.tau, at("2024-06-07T20:55"), "the summer Friday's τ", out);
      near(a.calls[0]?.D, D, "D", out);
      return out;
    },
  });
}

// ---- 9. a sell held over a Friday close gets that night's swap; its TP on Monday's first bar (a gap) ----
{
  const knots: Array<[string, number]> = [["2024-01-18T22:00", 150], ["2024-01-19T20:59", 150], ["2024-01-21T22:00", 150], ["2024-01-21T22:00", 149.5], ["2024-01-22T12:00", 149.5]];
  const sigs = [email("2024-01-19T10:00", "SELL", 149.99)];
  // a night: (−1 × (5.25 − 0.1) − 0.5) ÷ 100 × 10,000 × 150 × 1 ÷ 365
  const night = ((-1 * (5.25 - 0.1) - 0.5) / 100) * 10_000 * 150 / 365;
  FIXTURES.push({
    name: "fridaySwap",
    what: "金曜の引けをまたいだ売りに、その夜のスワップ（−232.19円）が付き、週明けの最初の足（窓）で利確する",
    ctx: ctxOf("2024-01-19T00:00", "2024-01-19T12:00", "2024-01-22T12:00", 300_000),
    m1s: books(usdJpy(knots, "2024-01-18T22:00", "2024-01-22T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const t = rows.mainSwap.trades[0];
      near(t?.swapQuote, night, "the Friday night's swap", out);
      eq(t?.swapYen, Math.floor(night), "credited in yen (rounded down: −233)", out);
      eq(t?.how, "tp", "out at TP", out);
      eq(t?.x, at("2024-01-21T22:00"), "on Monday's first bar", out);
      near(t?.exit, 149.501, "at its open (the ask)", out);
      eq(t?.tpGap, true, "a better open taken", out);
      return out;
    },
  });
}

// ---- 10. an email in Rakuten's stop, its order at τ + 15 min: that night's swap tips the margin ----
{
  const knots: Array<[string, number]> = [["2024-01-21T22:00", 150], ["2024-01-26T12:00", 150]];
  const five = ["00:15", "00:30", "00:45", "01:00", "01:15"].map((h) => email(`2024-01-22T${h}`, "BUY", 150.01));
  const sigs = [...five, email("2024-01-24T22:00", "BUY", 150.01)];
  // a buy's night: (5.25 − 0.1 − 0.5) ÷ 100 × 10,000 × 150 ÷ 365; Monday's and Tuesday's one day, Wednesday's three
  const night = ((5.25 - 0.1 - 0.5) / 100) * 10_000 * 150 / 365;
  const om = 400 * 150.01;
  // before Wednesday's swap the effective margin is the order's margin less 1,000 yen; after it (5 × 573 yen), more.
  // Each position's night is credited rounded down to the yen (Rakuten's page)
  const start = om - 1_000 + 5 * 60_000 + 5 * 20 - 5 * 2 * Math.floor(night);
  FIXTURES.push({
    name: "stopOrderSwap",
    what: "楽天が止まる時間の合図（T 22:00、P は 22:10 に動く）。余力ぎりぎりで、その夜（水曜、3日分）のスワップを入れてから受け付けるので受け付ける（スワップ無しの行では断る）",
    ctx: ctxOf("2024-01-22T00:00", "2024-01-23T00:00", "2024-01-26T12:00", start),
    m1s: books(usdJpy(knots, "2024-01-21T22:00", "2024-01-26T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      eq(fateOf(rows.mainSwap, 5), "held", "the stop's email (swap row)", out);
      eq(fateOf(rows.main, 5), "refusedMargin", "the stop's email (no swap)", out);
      return out;
    },
  });
}

// ---- 11. E*: the deepest close falls inside Rakuten's stop (not counted on the main rows) ----
{
  const knots: Array<[string, number]> = [["2024-01-28T22:00", 150], ["2024-01-29T22:00", 150], ["2024-01-29T22:01", 140], ["2024-01-29T22:02", 150], ["2024-01-30T12:00", 150]];
  const sigs = ["00:15", "00:30", "00:45"].map((h) => email(`2024-01-29T${h}`, "BUY", 150.01));
  FIXTURES.push({
    name: "estarStop",
    what: "E* の③（ロスカットの項）の一番大きい値が、楽天が止まる時間の足（22:00 の足の終値 140.000）に来る道筋。主の行では数えない",
    ctx: ctxOf("2024-01-29T00:00", "2024-01-29T12:00", "2024-01-30T12:00", 300_000),
    m1s: books(usdJpy(knots, "2024-01-28T22:00", "2024-01-30T12:00")),
    sigs,
    check: (_rows, unl) => {
      const out: string[] = [];
      // counted, the stop's bar would give 0.5 × 3 × um(140) + 30,000 × (150.001 − 139.999) = 384,060
      const e = unl.main.estar?.value ?? NaN;
      if (!(e < 200_000)) out.push(`E* ${e}: the stop's close counted`);
      return out;
    },
  });
}

// ---- 12. a limit filled in a bar that also reaches its TP: the TP is not taken in that bar ----
{
  // the 10:00 bar opens at 150.000, dips to 149.900 (the limit at 149.950 fills) and reaches 150.060 (the TP 150.050)
  const knots: Array<[string, number]> = [["2024-02-25T22:00", 150], ["2024-02-26T10:00", 150], ["2024-02-26T10:00:20", 149.9], ["2024-02-26T10:00:40", 150.06], ["2024-02-26T10:01", 150.0], ["2024-02-26T11:00", 150.0], ["2024-02-26T11:30", 150.2], ["2024-02-26T12:00", 150.2]];
  const sigs = [email("2024-02-26T09:45", "BUY", 149.95)];
  FIXTURES.push({
    name: "tpInFillBar",
    what: "指値が入った1分足（10:00）の中で利確の値段（150.050）にも届くが、その足では利確を数えず、後の足（11:00 台）で利確する",
    ctx: ctxOf("2024-02-26T00:00", "2024-02-26T06:00", "2024-02-26T12:00", 300_000),
    m1s: books(usdJpy(knots, "2024-02-25T22:00", "2024-02-26T12:00")),
    sigs,
    check: (rows) => {
      const out: string[] = [];
      const t = rows.main.trades[0];
      eq(t?.t0, at("2024-02-26T10:00"), "filled in the 10:00 bar", out);
      near(t?.fill, 149.95, "at E", out);
      if (!(t && t.x > at("2024-02-26T10:00"))) out.push(`TP taken in the fill bar: ${t?.x}`);
      return out;
    },
  });
}

// ---- 13. E*: the period starts on a day without bars (2024-01-01): that night's close comes before any bar ----
{
  // the first bars at 22:00 UTC, after Monday's close (21:55); a buy at 150.001 (00:17), the mid 149.000 at Tuesday's close
  const knots: Array<[string, number]> = [["2024-01-01T22:00", 150], ["2024-01-02T01:00", 150], ["2024-01-02T20:00", 149], ["2024-01-03T12:00", 149]];
  const sigs = [email("2024-01-02T00:15", "BUY", 150.01)];
  // Tuesday's close: required um(149) − P/L (mid) 10,000 × (149 − 150.001) = 59,600 + 10,010; the order's term 400 × 150.01 = 60,004
  const E = um(149) + 10_000 * (150.001 - 149);
  FIXTURES.push({
    name: "estarBeforeBars",
    what: "期間の始まり（2024-01-01、元日）の NY の引け（21:55）が、どのペアの足よりも前に来る。その引けの項は 0（建玉もドルも無い）で、E* は火曜の引けの項 69,610円",
    ctx: ctxOf("2024-01-01T00:00", "2024-01-02T00:00", "2024-01-03T12:00", 300_000),
    m1s: books(usdJpy(knots, "2024-01-01T22:00", "2024-01-03T12:00")),
    sigs,
    check: (_rows, unl) => {
      const out: string[] = [];
      near(E, 69_610, "E* by hand", out);
      for (const row of ["main", "mainSwap"]) {
        const e = unl[row].estar;
        near(e?.value, E, `${row}: E*`, out);
        eq(e?.kind, "close", `${row}: set by`, out);
        eq(e?.at, at("2024-01-02T21:55"), `${row}: at Tuesday's close`, out);
        for (const [k, t] of Object.entries(unl[row].estarBy)) if (!Number.isFinite(t.value)) out.push(`${row}: the ${k} term ${t.value}`);
      }
      return out;
    },
  });
}

// ---- 14. E*: Christmas's two closes on one price point; the swap paid between is not judged at the second ----
{
  // a sell at 149.999 (12/23 00:17); the mid 154.000 from 12/24 20:00; no bars from 12/24 21:00 to 12/25 22:00
  const knots: Array<[string, number]> = [["2024-12-22T22:00", 150], ["2024-12-23T01:00", 150], ["2024-12-24T20:00", 154], ["2024-12-26T12:00", 154]];
  const sigs = [email("2024-12-23T00:15", "SELL", 149.99)];
  // a sell's night at the close's mid: (−1 × (5.25 − 0.1) − 0.5) ÷ 100 × 10,000 × mid ÷ 365, paid rounded up (floor);
  // Monday's mid 151.946 (the line from 150 at 01:00 to 154 at 20:00 the next day, at 21:55)
  const monday = Math.floor(((-1 * (5.25 - 0.1) - 0.5) / 100) * 10_000 * 151.946 / 365 + 1e-9);
  // 12/24's close: required um(154) − P/L (mid) 10,000 × (149.999 − 154); the swap row less Monday's night too.
  // 12/25's close is on the same price point (judged once): its term, larger by 12/24's night, is not counted
  const E = um(154) + 10_000 * (154 - 149.999);
  FIXTURES.push({
    name: "estarSamePoint",
    what: "12/24 と 12/25 の NY の引けが同じ値段の点（12/25 は GMO の足が無い）。間のスワップ（売りの支払い）で 12/25 の引けの項の方が大きいが、口座はそこを判定しないので、E* はスワップ込みの行でも 12/24 の引けの項",
    ctx: ctxOf("2024-12-23T00:00", "2024-12-24T00:00", "2024-12-26T12:00", 300_000),
    m1s: books(usdJpy(knots, "2024-12-22T22:00", "2024-12-26T12:00", [["2024-12-24T21:00", "2024-12-25T22:00"]])),
    sigs,
    check: (_rows, unl) => {
      const out: string[] = [];
      eq(monday, -236, "Monday's night by hand", out);
      near(E, 101_610, "E* by hand (no swap)", out);
      for (const [row, value] of [["main", E], ["mainSwap", E - monday], ["worst", E], ["worstSwap", E - monday]] as const) {
        const e = unl[row].estar;
        near(e?.value, value, `${row}: E*`, out);
        eq(e?.kind, "close", `${row}: set by`, out);
        eq(e?.at, at("2024-12-24T21:55"), `${row}: at 12/24's close`, out);
      }
      return out;
    },
  });
}
