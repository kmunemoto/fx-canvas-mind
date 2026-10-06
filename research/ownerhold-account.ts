// #205 (docs §8.102 口座): Rakuten's 25x account of the owner, minute by
// minute over the five pairs' 1-minute bars. 10,000 units an email; margin
// 4% of the larger of a pair's buys and sells (MAX); orders taken while the
// effective margin covers them; the loss-cut at 50%; the margin call at the NY
// close τ (mid), its pending limits cancelled, the shortfall paid in at the
// notice (τ + 35 min) up to 1,000,000 yen in all, cured by deposits and by
// the margin the positions held at τ free as they close, else everything
// closed at the next trading day's 09:00 UTC. Dollar pairs' profits stay
// dollars, valued at USD/JPY's mid whenever the account is valued.
//
// The same engine with `unlimited` is the path where every email is taken
// (no refusal, cancellation, loss-cut or call): the 取引ごとの見方, its M and
// the terms of E*.
//
// Every read of a bar goes through rd(), which in the cut mode rewrites what
// the engine's clock has not reached yet (先読みの確かめ).

import { MINUTE } from "./lib.ts";
import { lowerBound, upperBound } from "./money-data.ts";
import type { NyClose } from "./money-trades.ts";
import { MAINT, type M1, PAIRS, isUsdPair, unitOf } from "./ownerhold-data.ts";
import { type Fill, maintOf } from "./ownerhold-trades.ts";

export const UNITS = 10_000;
export const MARGIN_RATE = 0.04;
export const LC_LEVEL = 0.5;
export const NOTICE = 35 * MINUTE;

// a night's swap for one position of 10,000 units, in the pair's quote
// currency (yen, or dollars on a dollar pair), at τ with the pair's mid then
export type SwapFn = (pair: string, dir: 1 | -1, tau: number, mid: number) => number;

export interface AccountOpts {
  // the start (yen); the cap on what is ever put in (start + deposits)
  start: number;
  cap: number;
  unlimited: boolean;
  // how the loss-cut is judged: each minute's closes, the worst of each minute, every 5 minutes' closes
  lc: "close" | "worst" | "m5";
  // Rakuten's stop: not judged (main), or judged like any minute
  skipMaint: boolean;
  fill: Fill;
  swap: SwapFn | null;
  // supplementary: that night's swap in before the call is judged
  swapBeforeCall: boolean;
  cancelOnCall: boolean;
  // when the shortfall goes in: at the notice (main), at τ, at 08:59 before the deadline, or only when it all fits
  deposit: "notice" | "tau" | "m0859" | "noPartial";
  // how an order is taken: the effective margin (main), or §8.99's (MAX with the order, pending limits by MAX too)
  accept: "main" | "s899";
  // dollar profits kept in dollars (main), or turned to yen at the exit (§8.99)
  usd: "live" | "fixed";
  // supplementary: after each loss-cut, paid back up to the start (within the cap)
  redeposit: boolean;
  // for E*: count the pending limits' margin (main) or not
  pendingMargin: boolean;
  // the cut mode (先読みの確かめ): reads past the clock are moved by this many pips (0: off)
  poisonPips: number;
  // a planted error (確かめ A 仕込んだ誤り), "" for none
  plant: string;
}

export const MAIN_OPTS: AccountOpts = {
  start: 300_000,
  cap: 1_000_000,
  unlimited: false,
  lc: "close",
  skipMaint: true,
  fill: "touch",
  swap: null,
  swapBeforeCall: false,
  cancelOnCall: true,
  deposit: "notice",
  accept: "main",
  usd: "live",
  redeposit: false,
  pendingMargin: true,
  poisonPips: 0,
  plant: "",
};

export interface OrderIn {
  // the email's index (its row in the signal list) and pair
  sig: number;
  pi: number;
  dir: 1 | -1;
  E: number;
  tp: number;
  // when the order would go, before the stop moves it
  P: number;
}

// what became of an email in the account
export type Fate = "tp" | "lc" | "deadline" | "held" | "unfilled" | "cancelCall" | "cancelLc" | "refusedMargin" | "refusedCall" | "none";

export interface TradeRec {
  sig: number;
  pi: number;
  dir: 1 | -1;
  market: boolean;
  t0: number;
  fill: number;
  fillGap: boolean;
  // out: its minute's open, the price, how, and the profit in the pair's quote currency and in yen
  x: number;
  exit: number;
  how: "tp" | "lc" | "deadline" | "held";
  tpGap: boolean;
  quote: number;
  yen: number;
  swapQuote: number;
}

export interface CallRec {
  tau: number;
  deadline: number;
  D: number;
  cancelled: number;
  deposits: number;
  credits: number;
  // U after the deposit of the notice (or τ / 08:59 in their rows): > 0 when the cap stopped it
  uAfterDeposit: number | null;
  end: "deposit" | "settle" | "lc" | "deadline" | "open";
  endAt: number;
}

export interface EstarTerm {
  value: number;
  kind: "order" | "close" | "lc" | "loss";
  at: number;
}

export interface AccountOut {
  fates: Fate[];
  trades: TradeRec[];
  calls: CallRec[];
  lcs: Array<{ at: number; naBefore: number; naAfter: number; closed: number; cancelled: number }>;
  deposits: Array<{ at: number; amount: number; total: number; why: "call" | "redeposit" }>;
  // the net assets (yen) at the split and END, and what was put in by then
  naSplit: number;
  inSplit: number;
  naEnd: number;
  inEnd: number;
  // the largest fall of (net assets − money put in), at minute closes
  maxDrawdown: number;
  maxHeld: number;
  maxHeldMargin: number;
  maxPending: number;
  // the all-accepted path only: E* and its four terms' largest values
  estar: EstarTerm | null;
  estarBy: Record<string, EstarTerm>;
  // the all-accepted path: the profit (net assets − start) at the split and at END
  mSplit: number;
  mEnd: number;
  // reads the cut mode rewrote (each one a look ahead)
  poisoned: number;
  swapNights: number;
  orders: number;
}

interface Pos {
  sig: number;
  dir: 1 | -1;
  E: number;
  tp: number;
  fill: number;
  fillGap: boolean;
  market: boolean;
  t0: number;
  // the minute it entered (TP judged only after it)
  s0: number;
  heldCall: number;
  swapQuote: number;
}
interface Pend {
  sig: number;
  dir: 1 | -1;
  E: number;
  tp: number;
  seq: number;
}

// a binary heap on a key
class Heap<T> {
  private a: T[] = [];
  constructor(private less: (x: T, y: T) => boolean) {}
  get size() {
    return this.a.length;
  }
  peek(): T | undefined {
    return this.a[0];
  }
  push(x: T) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
  drain(): T[] {
    const out = this.a;
    this.a = [];
    return out;
  }
  items(): readonly T[] {
    return this.a;
  }
}

export interface Market {
  books: M1[];
  // Rakuten's NY closes over the run, with each one's deadline
  closes: NyClose[];
  split: number;
  end: number;
  // where the run starts (the first order of (b)'s, or the restart's): nothing before is valued
  from: number;
}

// The account. `orders` sorted by P, then Rakuten's pair order, BUY first.
export const runAccount = (mk: Market, orders: OrderIn[], o: AccountOpts): AccountOut => {
  const np = mk.books.length;
  const usdjpy = mk.books.findIndex((m) => m.pair === "USD/JPY");
  if (usdjpy < 0) throw new Error("USD/JPY's bars are needed to value the dollar pairs");
  const units = mk.books.map((m) => unitOf(m.pair));
  const usd = mk.books.map((m) => isUsdPair(m.pair));
  const taus = Float64Array.from(mk.closes.map((c) => c.tau));
  const out: AccountOut = { fates: orders.map(() => "none" as Fate), trades: [], calls: [], lcs: [], deposits: [], naSplit: NaN, inSplit: NaN, naEnd: NaN, inEnd: NaN, maxDrawdown: 0, maxHeld: 0, maxHeldMargin: 0, maxPending: 0, estar: null, estarBy: {}, mSplit: NaN, mEnd: NaN, poisoned: 0, swapNights: 0, orders: orders.length };
  const fateIdx = new Map<number, number>();
  orders.forEach((x, k) => fateIdx.set(x.sig, k));
  const setFate = (sig: number, f: Fate) => (out.fates[fateIdx.get(sig)!] = f);

  // ---- the clock and the reads -------------------------------------------------------------
  // the next bar of each pair, and the last one ended (the price rule)
  const next = new Int32Array(np);
  const lastK = new Int32Array(np).fill(-1);
  for (let p = 0; p < np; p++) next[p] = lowerBound(mk.books[p].t, mk.from - MINUTE * 0);
  // the minute being judged and how much of it may be read ("open": its open only)
  let clockS = -Infinity;
  let clockPart: "open" | "full" = "full";
  const poison = (p: number) => o.poisonPips * units[p];
  const rd = (p: number, xs: Float64Array, k: number, isOpen: boolean): number => {
    const m = mk.books[p];
    const t = m.t[k];
    const ok = t < clockS || (t === clockS && (clockPart === "full" || isOpen));
    if (ok || o.poisonPips === 0) return xs[k];
    out.poisoned++;
    return xs[k] + poison(p);
  };
  const bid = (p: number) => rd(p, mk.books[p].bc, lastK[p], false);
  const ask = (p: number) => rd(p, mk.books[p].ac, lastK[p], false);
  const midOf = (p: number) => (lastK[p] < 0 ? NaN : (bid(p) + ask(p)) / 2);
  const usdJpy = () => midOf(usdjpy);
  const has = (p: number) => lastK[p] >= 0;

  // ---- the account's state ------------------------------------------------------------------
  let yen = o.unlimited ? 0 : o.start;
  let dollars = 0;
  let moneyIn = o.unlimited ? 0 : o.start;
  let seq = 0;
  // positions: by pair and side, TP heaps (BUY: lowest TP first; SELL: highest first)
  const posB = mk.books.map(() => new Heap<Pos>((x, y) => x.tp < y.tp));
  const posS = mk.books.map(() => new Heap<Pos>((x, y) => x.tp > y.tp));
  // the pair's buys and sells: how many and the sum of their prices
  const nB = new Float64Array(np);
  const nS = new Float64Array(np);
  const sumB = new Float64Array(np);
  const sumS = new Float64Array(np);
  // pending limits: BUY highest E first (filled when the ask low comes down to it), SELL lowest first
  const pendB = mk.books.map(() => new Heap<Pend>((x, y) => x.E > y.E || (x.E === y.E && x.seq < y.seq)));
  const pendS = mk.books.map(() => new Heap<Pend>((x, y) => x.E < y.E || (x.E === y.E && x.seq < y.seq)));
  const pendCountB = new Float64Array(np);
  const pendCountS = new Float64Array(np);
  const pendSumE = new Float64Array(np);
  // entered this minute: into the heaps after this minute's TPs
  let fresh: Array<{ p: number; pos: Pos }> = [];

  // the margin call
  interface Call {
    rec: CallRec;
    U: number;
    nBt: Float64Array;
    nSt: Float64Array;
    unitMargin: Float64Array;
    deposited: boolean;
    id: number;
  }
  let call: Call | null = null;
  let callId = 0;

  const toYen = (p: number, quote: number) => (usd[p] ? quote * usdJpy() : quote);
  const unitMarginOf = (p: number, mid: number) => UNITS * mid * MARGIN_RATE * (usd[p] ? usdJpy() : 1);
  // the required margin (MAX of buys and sells) at the mids
  const required = () => {
    let r = 0;
    for (let p = 0; p < np; p++) if (nB[p] || nS[p]) r += Math.max(nB[p], nS[p]) * unitMarginOf(p, midOf(p));
    return r;
  };
  // the pending limits' margin: each at its own E
  const pendingMargin = () => {
    let r = 0;
    for (let p = 0; p < np; p++) if (pendSumE[p]) r += UNITS * pendSumE[p] * MARGIN_RATE * (usd[p] ? usdJpy() : 1);
    return r;
  };
  // positions valued: at the exit side's last closes ("exit"), at the mids ("mid"), or at given prices
  const unrealized = (how: "exit" | "mid", worst: Float64Array | null = null) => {
    let r = 0;
    for (let p = 0; p < np; p++) {
      if (!nB[p] && !nS[p]) continue;
      const b = worst ? worst[2 * p] : how === "mid" ? midOf(p) : bid(p);
      const a = worst ? worst[2 * p + 1] : how === "mid" ? midOf(p) : ask(p);
      const q = UNITS * (nB[p] * b - sumB[p] + sumS[p] - nS[p] * a);
      r += toYen(p, q);
    }
    return r;
  };
  const cash = () => yen + dollars * usdJpy();
  const netAssets = (how: "exit" | "mid", worst: Float64Array | null = null) => cash() + unrealized(how, worst);
  const held = () => {
    let n = 0;
    for (let p = 0; p < np; p++) n += nB[p] + nS[p];
    return n;
  };
  const pendingCount = () => {
    let n = 0;
    for (let p = 0; p < np; p++) n += pendCountB[p] + pendCountS[p];
    return n;
  };

  // ---- E* (the all-accepted path) ----------------------------------------------------------
  const term = (kind: EstarTerm["kind"], value: number, at: number) => {
    const t: EstarTerm = { kind, value, at };
    const cur = out.estarBy[kind];
    if (!cur || value > cur.value) out.estarBy[kind] = t;
    if (!out.estar || value > out.estar.value) out.estar = t;
  };

  // ---- opening and closing ------------------------------------------------------------------
  // `defer`: entered inside a minute (its TP judged from the next minute on); not: at a P without a bar
  const open = (p: number, x: { sig: number; dir: 1 | -1; E: number; tp: number }, price: number, gap: boolean, market: boolean, t0: number, s0: number, defer: boolean) => {
    const pos: Pos = { sig: x.sig, dir: x.dir, E: x.E, tp: x.tp, fill: price, fillGap: gap, market, t0, s0, heldCall: -1, swapQuote: 0 };
    if (x.dir === 1) {
      nB[p]++;
      sumB[p] += price;
    } else {
      nS[p]++;
      sumS[p] += price;
    }
    // planted: a position's TP judged in the minute it entered
    if (defer && o.plant !== "tpInFillBar") fresh.push({ p, pos });
    else (x.dir === 1 ? posB : posS)[p].push(pos);
    setFate(x.sig, "held");
  };
  const credit = (p: number, pos: Pos) => {
    if (!call || pos.heldCall !== call.id) return;
    const before = Math.max(call.nBt[p], call.nSt[p]);
    if (pos.dir === 1) call.nBt[p]--;
    else call.nSt[p]--;
    const freed = (before - Math.max(call.nBt[p], call.nSt[p])) * call.unitMargin[p];
    call.rec.credits += freed;
    // planted: deposits and credits each against D, not added together
    if (o.plant === "noCreditSum") call.U = Math.min(call.rec.D - call.rec.deposits, call.rec.D - call.rec.credits);
    else call.U -= freed;
  };
  const close = (p: number, pos: Pos, price: number, at: number, how: TradeRec["how"], gap: boolean) => {
    if (pos.dir === 1) {
      nB[p]--;
      sumB[p] -= pos.fill;
    } else {
      nS[p]--;
      sumS[p] -= pos.fill;
    }
    if (nB[p] === 0) sumB[p] = 0;
    if (nS[p] === 0) sumS[p] = 0;
    const quote = UNITS * pos.dir * (price - pos.fill);
    let y: number;
    if (!usd[p]) {
      yen += quote;
      y = quote;
    } else if (o.usd === "live") {
      dollars += quote;
      y = quote * usdJpy();
    } else {
      y = quote * usdJpy();
      yen += y;
    }
    out.trades.push({ sig: pos.sig, pi: p, dir: pos.dir, market: pos.market, t0: pos.t0, fill: pos.fill, fillGap: pos.fillGap, x: at, exit: price, how, tpGap: gap, quote, yen: y, swapQuote: pos.swapQuote });
    setFate(pos.sig, how);
    credit(p, pos);
  };
  const allPositions = (p: number): Pos[] => [...posB[p].items(), ...posS[p].items(), ...fresh.filter((f) => f.p === p).map((f) => f.pos)];
  const closeAll = (prices: (p: number, pos: Pos) => number, at: number, how: "lc" | "deadline") => {
    let n = 0;
    for (let p = 0; p < np; p++) {
      const ps = allPositions(p).sort((u, v) => u.t0 - v.t0 || u.sig - v.sig);
      posB[p].drain();
      posS[p].drain();
      for (const pos of ps) {
        close(p, pos, prices(p, pos), at, how, false);
        n++;
      }
    }
    fresh = [];
    return n;
  };
  const cancelAll = (fate: Fate) => {
    let n = 0;
    for (let p = 0; p < np; p++) {
      for (const h of [pendB[p], pendS[p]]) {
        for (const x of h.drain()) {
          setFate(x.sig, fate);
          n++;
        }
      }
      pendCountB[p] = pendCountS[p] = pendSumE[p] = 0;
    }
    return n;
  };
  const deposit = (amount: number, at: number, why: "call" | "redeposit") => {
    if (!(amount > 0)) return 0;
    yen += amount;
    moneyIn += amount;
    out.deposits.push({ at, amount, total: moneyIn, why });
    return amount;
  };
  const endCall = (how: CallRec["end"], at: number) => {
    if (!call) return;
    call.rec.end = how;
    call.rec.endAt = at;
    call = null;
  };
  const callDeposit = (at: number, all: boolean) => {
    if (!call || call.deposited) return;
    call.deposited = true;
    const room = o.plant === "overCap" ? Infinity : Math.max(0, o.cap - moneyIn);
    if (call.U > 0) {
      const want = o.plant === "deposit0859Full" && o.deposit === "m0859" ? call.rec.D : call.U;
      const amt = all ? (want <= room ? want : 0) : Math.min(want, room);
      deposit(amt, at, "call");
      call.rec.deposits += amt;
      if (o.plant === "noCreditSum") call.U = Math.min(call.rec.D - call.rec.deposits, call.rec.D - call.rec.credits);
      else call.U -= amt;
    }
    call.rec.uAfterDeposit = call.U;
    // planted: still refusing orders after the deposit cured it, until the deadline
    if (call.U <= 0 && o.plant !== "callBlockAfterDeposit") endCall("deposit", at);
  };

  // ---- an order ------------------------------------------------------------------------------
  let lastNyPoint = "";
  const take = (x: OrderIn, s: number, k0: number | null) => {
    const p = x.pi;
    const m = mk.books[p];
    if (!o.unlimited) {
      if (call) {
        setFate(x.sig, "refusedCall");
        return;
      }
    }
    if (!has(p) && k0 === null) return;
    // the order's own margin at E, and the account at P's prices (the bars ended by P)
    const om = UNITS * x.E * MARGIN_RATE * (usd[p] ? usdJpy() : 1);
    const na = netAssets("exit");
    const req = required();
    const pm = o.pendingMargin ? pendingMargin() : 0;
    if (o.unlimited) {
      term("order", req + pm + om - na, s);
      term("loss", -na, s);
    }
    else if (o.accept === "main") {
      if (na - (req + pm) < om) {
        setFate(x.sig, "refusedMargin");
        return;
      }
    } else {
      // §8.99: MAX with this order and the pending limits counted as positions
      let r = 0;
      for (let q = 0; q < np; q++) {
        const b = nB[q] + pendCountB[q] + (q === p && x.dir === 1 ? 1 : 0);
        const sl = nS[q] + pendCountS[q] + (q === p && x.dir === -1 ? 1 : 0);
        if (b || sl) r += Math.max(b, sl) * unitMarginOf(q, midOf(q));
      }
      if (r > na) {
        setFate(x.sig, "refusedMargin");
        return;
      }
    }
    // already better at P: at the market (P's open, or the last close ended by P)
    const buy = x.dir === 1;
    let now: number;
    if (k0 !== null) now = buy ? rd(p, m.ao, k0, true) : rd(p, m.bo, k0, true);
    else now = buy ? ask(p) : bid(p);
    if (buy ? now <= x.E : now >= x.E) {
      open(p, x, now, false, true, k0 !== null ? m.t[k0] : s, s, k0 !== null);
    } else {
      const pd: Pend = { sig: x.sig, dir: x.dir, E: x.E, tp: x.tp, seq: seq++ };
      (buy ? pendB : pendS)[p].push(pd);
      if (buy) pendCountB[p]++;
      else pendCountS[p]++;
      pendSumE[p] += x.E;
      setFate(x.sig, "unfilled");
    }
  };

  // ---- the events ------------------------------------------------------------------------------
  // [time, rank, what]: ranks at one time — the swap and the deposits first, then orders without a
  // bar at P, then the NY close (orders up to τ come before it), then the split's and END's records
  type Ev = { t: number; rank: number; kind: "swap" | "notice" | "m0859" | "order" | "ny" | "split" | "end"; ny?: NyClose; order?: OrderIn };
  const evs: Ev[] = [];
  // the first minute of any pair at or after a time
  const allT: number[] = [];
  for (const m of mk.books) for (let k = 0; k < m.n; k++) allT.push(m.t[k]);
  allT.sort((a, b) => a - b);
  const firstBarFrom = (ms: number) => {
    const k = lowerBound(allT, ms);
    return k < allT.length ? allT[k] : Infinity;
  };
  for (const c of mk.closes) {
    if (c.tau < mk.from || c.tau > mk.end) continue;
    // planted: a Friday's close taken after the week's first bar
    const shift = o.plant === "fridayNyMonday" && new Date(c.tau).getUTCDay() === 5 ? Math.max(0, firstBarFrom(c.tau) + MINUTE - c.tau) : 0;
    evs.push({ t: c.tau + shift, rank: 3, kind: "ny", ny: c });
    if (o.swap && c.tau + MAINT <= mk.end) evs.push({ t: c.tau + MAINT + shift + (o.plant === "swapAfterOrder" ? MINUTE : 0), rank: 0, kind: "swap", ny: c });
    if (!o.unlimited && o.deposit !== "tau" && o.deposit !== "m0859" && c.tau + NOTICE <= mk.end) evs.push({ t: c.tau + NOTICE + shift, rank: 1, kind: "notice", ny: c });
    if (!o.unlimited && o.deposit === "m0859" && c.deadline - MINUTE <= mk.end) evs.push({ t: c.deadline - MINUTE, rank: 1, kind: "m0859", ny: c });
  }
  // the orders: P past the stop where it is kept; one with a bar at P is taken in that minute (②)
  const at = new Map<number, OrderIn[]>();
  for (const x of orders) {
    let P = x.P;
    if (o.skipMaint) {
      const tau = maintOf(taus, P);
      if (tau !== null) P = tau + MAINT;
    }
    if (P < mk.from || P >= mk.end) continue;
    const m = mk.books[x.pi];
    const k = lowerBound(m.t, P);
    if (k < m.n && m.t[k] === P) {
      const l = at.get(P) ?? [];
      l.push(x);
      at.set(P, l);
    } else {
      // planted: an order without a bar at P taken after the NY close that falls on the same price point
      let t = P;
      let rank = 2;
      if (o.plant === "noBarOrderAfterNy") {
        const j = lowerBound(taus, P);
        if (j < taus.length && firstBarFrom(P) > taus[j]) {
          t = taus[j];
          rank = 4;
        }
      }
      evs.push({ t, rank, kind: "order", order: x });
    }
  }
  evs.push({ t: mk.split, rank: 9, kind: "split" });
  evs.push({ t: mk.end, rank: 10, kind: "end" });
  const orderRank = (x: OrderIn) => x.pi * 2 + (x.dir === 1 ? 0 : 1);
  evs.sort((a, b) => a.t - b.t || a.rank - b.rank || (a.order && b.order ? a.order.P - b.order.P || orderRank(a.order) - orderRank(b.order) : 0));
  for (const l of at.values()) l.sort((a, b) => orderRank(a) - orderRank(b));

  // each NY close's mids (the night's swap is at that day's mid, §8.102 スワップ)
  const tauMids = new Map<number, Float64Array>();
  // the night's swap for the positions held at τ (entered before it)
  const addSwap = (c: NyClose) => {
    if (!o.swap) return;
    const mids = tauMids.get(c.tau);
    for (let p = 0; p < np; p++) {
      if (!has(p)) continue;
      const mid = mids ? mids[p] : midOf(p);
      for (const pos of allPositions(p)) {
        if (!(pos.t0 < c.tau)) continue;
        const q0 = o.swap(mk.books[p].pair, pos.dir, c.tau, mid);
        // planted: the sells' swap the other way round
        const q = o.plant === "swapSellSign" && pos.dir === -1 ? -q0 : q0;
        pos.swapQuote += q;
        out.swapNights++;
        if (!usd[p]) yen += q;
        else if (o.usd === "live") dollars += q;
        else yen += q * usdJpy();
      }
    }
  };

  const nyClose = (c: NyClose) => {
    const mids = new Float64Array(np);
    for (let p = 0; p < np; p++) mids[p] = has(p) ? midOf(p) : NaN;
    tauMids.set(c.tau, mids);
    // the price point: the last bar ended by τ of every pair (two closes on one point are judged once)
    const point = Array.from(lastK).join(",");
    const samePoint = point === lastNyPoint;
    lastNyPoint = point;
    if (o.unlimited) {
      term("close", required() - (netAssets("mid") - 0), c.tau);
      term("loss", -netAssets("exit"), c.tau);
      return;
    }
    if (o.swapBeforeCall) addSwap(c);
    if (call || samePoint) return;
    const req = required();
    const na = netAssets("mid");
    if (!(req > 0) || na >= req) return;
    const D = req - na;
    callId++;
    const rec: CallRec = { tau: c.tau, deadline: c.deadline, D, cancelled: 0, deposits: 0, credits: 0, uAfterDeposit: null, end: "open", endAt: NaN };
    out.calls.push(rec);
    const nBt = Float64Array.from(nB);
    const nSt = Float64Array.from(nS);
    const unitMargin = new Float64Array(np);
    for (let p = 0; p < np; p++) if (has(p)) unitMargin[p] = unitMarginOf(p, midOf(p));
    call = { rec, U: D, nBt, nSt, unitMargin, deposited: false, id: callId };
    for (let p = 0; p < np; p++) for (const pos of allPositions(p)) pos.heldCall = callId;
    if (o.cancelOnCall) rec.cancelled = cancelAll("cancelCall");
    if (o.deposit === "tau") callDeposit(c.tau, false);
  };

  // ---- the minutes ---------------------------------------------------------------------------
  let peak = -Infinity;
  let noticeLate: number | null = null;
  const worst = new Float64Array(2 * np);
  const runEvent = (e: Ev) => {
    clockS = e.t;
    clockPart = "full";
    switch (e.kind) {
      case "ny":
        nyClose(e.ny!);
        break;
      case "swap":
        if (!(o.swapBeforeCall && !o.unlimited)) addSwap(e.ny!);
        break;
      case "notice":
        if (call && call.rec.tau === e.ny!.tau) {
          if (o.plant === "depositAfterDeadline") noticeLate = e.ny!.tau;
          else callDeposit(e.t, o.deposit === "noPartial");
        }
        break;
      case "m0859":
        if (call && call.rec.tau === e.ny!.tau) callDeposit(e.t, false);
        else if (o.plant === "deposit0859WhenCured") {
          // planted: paid in at 08:59 though already cured
          const rec = out.calls.find((c) => c.tau === e.ny!.tau && c.end === "settle");
          if (rec) deposit(Math.min(rec.D, Math.max(0, o.cap - moneyIn)), e.t, "call");
        }
        break;
      case "order":
        take(e.order!, e.t, null);
        break;
      case "split":
        out.naSplit = netAssets("exit");
        out.inSplit = moneyIn;
        if (o.unlimited) out.mSplit = out.naSplit;
        break;
      case "end":
        out.naEnd = netAssets("exit");
        out.inEnd = moneyIn;
        if (o.unlimited) out.mEnd = out.naEnd;
        break;
    }
  };
  // the minutes of all pairs, in time order
  const minutes: number[] = [];
  {
    const set = new Set<number>();
    for (const m of mk.books) for (let k = lowerBound(m.t, mk.from); k < m.n && m.t[k] < mk.end; k++) set.add(m.t[k]);
    minutes.push(...set);
    minutes.sort((a, b) => a - b);
  }
  let ei = 0;
  for (const s of minutes) {
    while (ei < evs.length && evs[ei].t <= s) runEvent(evs[ei++]);
    const g = s + MINUTE;
    const inMaint = maintOf(taus, s) !== null;
    const judged = !(o.skipMaint && inMaint);
    // the pairs with a bar at s
    const kAt = new Int32Array(np).fill(-1);
    for (let p = 0; p < np; p++) {
      const m = mk.books[p];
      if (next[p] < m.n && m.t[next[p]] === s) kAt[p] = next[p];
    }
    clockS = s;
    clockPart = "open";
    // ① the deadline of a call not cured: everything out at the minute's opens
    if (!o.unlimited && call && s >= call.rec.deadline) {
      if (call.U > 0) {
        closeAll((p, pos) => (kAt[p] >= 0 ? (pos.dir === 1 ? rd(p, mk.books[p].bo, kAt[p], true) : rd(p, mk.books[p].ao, kAt[p], true)) : pos.dir === 1 ? bid(p) : ask(p)), s, "deadline");
        endCall("deadline", s);
      } else endCall(call.rec.deposits > 0 ? "deposit" : "settle", s);
    }
    // planted: the notice's deposit made in the first minute after it, after the deadline's step
    if (noticeLate !== null) {
      if (call && call.rec.tau === noticeLate) callDeposit(s, o.deposit === "noPartial");
      noticeLate = null;
    }
    // ② the orders of this minute
    if (judged) for (const x of at.get(s) ?? []) take(x, s, kAt[x.pi]);
    clockPart = "full";
    if (judged) {
      // ③ the pending limits reached
      for (let p = 0; p < np; p++) {
        const k = kAt[p];
        if (k < 0) continue;
        const m = mk.books[p];
        const th = o.fill === "through" ? 0.1 * units[p] : 0;
        const al = rd(p, m.al, k, false);
        const bh = rd(p, m.bh, k, false);
        const ao = rd(p, m.ao, k, true);
        const bo = rd(p, m.bo, k, true);
        const filled: Pend[] = [];
        while (pendB[p].size && al <= pendB[p].peek()!.E - th) filled.push(pendB[p].pop()!);
        while (pendS[p].size && bh >= pendS[p].peek()!.E + th) filled.push(pendS[p].pop()!);
        filled.sort((u, v) => u.seq - v.seq);
        for (const x of filled) {
          if (x.dir === 1) pendCountB[p]--;
          else pendCountS[p]--;
          pendSumE[p] -= x.E;
          const openPx = x.dir === 1 ? ao : bo;
          const better = o.fill !== "exact" && (x.dir === 1 ? openPx < x.E : openPx > x.E);
          open(p, x, better ? openPx : x.E, better, false, s, s, true);
        }
        if (pendCountB[p] === 0 && pendCountS[p] === 0) pendSumE[p] = 0;
      }
      // ④ TPs, positions entered before this minute
      for (let p = 0; p < np; p++) {
        const k = kAt[p];
        if (k < 0) continue;
        const m = mk.books[p];
        const bh = rd(p, m.bh, k, false);
        const al = rd(p, m.al, k, false);
        const bo = rd(p, m.bo, k, true);
        const ao = rd(p, m.ao, k, true);
        const outs: Array<{ pos: Pos; px: number; gap: boolean }> = [];
        while (posB[p].size && bh >= posB[p].peek()!.tp) {
          const pos = posB[p].pop()!;
          const gap = o.fill !== "exact" && bo > pos.tp;
          outs.push({ pos, px: gap ? bo : pos.tp, gap });
        }
        while (posS[p].size && al <= posS[p].peek()!.tp) {
          const pos = posS[p].pop()!;
          const gap = o.fill !== "exact" && ao < pos.tp;
          outs.push({ pos, px: gap ? ao : pos.tp, gap });
        }
        outs.sort((u, v) => u.pos.t0 - v.pos.t0 || u.pos.sig - v.pos.sig);
        for (const x of outs) close(p, x.pos, x.px, s, "tp", x.gap);
      }
    }
    // the entered positions join the heaps
    for (const f of fresh) (f.pos.dir === 1 ? posB : posS)[f.p].push(f.pos);
    fresh = [];
    // the minute's bars are now ended: the price rule moves on
    for (let p = 0; p < np; p++) {
      if (kAt[p] >= 0) {
        lastK[p] = kAt[p];
        next[p] = kAt[p] + 1;
      }
    }
    clockS = g;
    clockPart = "full";
    // ⑤ the loss-cut, and a call cured by the margin freed
    const lcMinute = (judged || (o.unlimited && o.plant === "estarMaint")) && (o.lc !== "m5" || g % (5 * MINUTE) === 0);
    if (lcMinute) {
      let w: Float64Array | null = null;
      if (o.plant === "lcNextBar") {
        // planted: judged on each pair's next bar's close
        for (let p = 0; p < np; p++) {
          if (!has(p)) continue;
          const k = lastK[p] + 1 < mk.books[p].n ? lastK[p] + 1 : lastK[p];
          worst[2 * p] = rd(p, mk.books[p].bc, k, false);
          worst[2 * p + 1] = rd(p, mk.books[p].ac, k, false);
        }
        w = worst;
      }
      if (o.lc === "worst") {
        for (let p = 0; p < np; p++) {
          if (!has(p)) continue;
          const k = kAt[p];
          worst[2 * p] = k >= 0 ? rd(p, mk.books[p].bl, k, false) : bid(p);
          worst[2 * p + 1] = k >= 0 ? rd(p, mk.books[p].ah, k, false) : ask(p);
        }
        w = worst;
      }
      const req = required();
      const na = netAssets("exit", w);
      if (o.unlimited) {
        term("lc", LC_LEVEL * req - na, g);
        term("loss", -na, g);
      } else if (req > 0 && na < LC_LEVEL * req) {
        const naBefore = na;
        const n = closeAll((p, pos) => (w ? (pos.dir === 1 ? w[2 * p] : w[2 * p + 1]) : pos.dir === 1 ? bid(p) : ask(p)), s, "lc");
        const c = cancelAll("cancelLc");
        out.lcs.push({ at: g, naBefore, naAfter: netAssets("exit"), closed: n, cancelled: c });
        if (call) endCall("lc", g);
        if (o.redeposit) deposit(Math.min(Math.max(0, o.start - netAssets("exit")), Math.max(0, o.cap - moneyIn)), g, "redeposit");
      }
    }
    if (!o.unlimited && call && call.U <= 0 && o.plant !== "blockAfterCure" && o.plant !== "callBlockAfterDeposit") endCall("settle", g);
    // ⑥ the record
    const hn = held();
    if (hn > out.maxHeld) {
      out.maxHeld = hn;
      out.maxHeldMargin = required();
    }
    const pn = pendingCount();
    if (pn > out.maxPending) out.maxPending = pn;
    if (!o.unlimited) {
      const v = netAssets("exit") - moneyIn;
      if (v > peak) peak = v;
      if (peak - v > out.maxDrawdown) out.maxDrawdown = peak - v;
    }
  }
  while (ei < evs.length) runEvent(evs[ei++]);
  // still held at END: the exit side's last close
  clockS = mk.end;
  for (let p = 0; p < np; p++) {
    for (const pos of allPositions(p)) {
      const price = pos.dir === 1 ? bid(p) : ask(p);
      const quote = UNITS * pos.dir * (price - pos.fill);
      out.trades.push({ sig: pos.sig, pi: p, dir: pos.dir, market: pos.market, t0: pos.t0, fill: pos.fill, fillGap: pos.fillGap, x: NaN, exit: price, how: "held", tpGap: false, quote, yen: toYen(p, quote), swapQuote: pos.swapQuote });
    }
  }
  if (call) {
    (call as Call).rec.end = "open";
    (call as Call).rec.endAt = NaN;
  }
  return out;
};

export const pairIndex = (pair: string) => (PAIRS as readonly string[]).indexOf(pair);
