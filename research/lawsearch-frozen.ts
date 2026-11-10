// 法則探し (docs §8.136; C4g, the lead's G3, from the C4g designer "harden"): the program's rule constants frozen,
// deep, in every realm. Until C4g SEEDS, HOLE_MIN_SLOTS, S_OF_F, REASONS, PLANTS and the other object constants were
// plain writable objects (C4f's review: `SEEDS.cut = 1` succeeded at run time), so main-run code could change what a
// check reads (SEEDS.cut picks the cut's signal targets). This module is imported right after lawsearch-lockdown.ts by
// every entry point (lawsearch.ts, lawsearch-par-worker.ts, lawsearch-follow-worker.ts), so it runs before any module
// that holds main-run code: only lib.ts, lawsearch-const.ts, lawsearch-rules.ts and quotes.ts (with what it imports)
// are evaluated before it, and they hold constants only. Every object or function value exported by
// lawsearch-const.ts and lawsearch-rules.ts, and quotes.ts' GMO_SYMBOLS and GMO_INTERVALS (the retrace's file names),
// is frozen with everything reachable from it through own data properties. A write then throws (TypeError: exit 1).
// lawsearch-const.ts itself is not edited (its sha256 constants are part of R_law). Arrays and plain objects only are
// frozen here, no built-in prototype, so no V8 fast path is lost.
import * as CONST from "./lawsearch-const.ts";
import * as RULES from "./lawsearch-rules.ts";
import { GMO_INTERVALS, GMO_SYMBOLS } from "../supabase/functions/track-outcomes/quotes.ts";

const freezeDeep = (root: unknown): number => {
  let n = 0;
  const stack = [root];
  while (stack.length > 0) {
    const x = stack.pop();
    if (x === null || (typeof x !== "object" && typeof x !== "function") || Object.isFrozen(x)) continue;
    Object.freeze(x);
    n++;
    for (const k of Reflect.ownKeys(x as object)) {
      const d = Object.getOwnPropertyDescriptor(x as object, k)!;
      if ("value" in d) stack.push(d.value);
    }
  }
  return n;
};
let n = 0;
for (const v of [...Object.values(CONST), ...Object.values(RULES), GMO_SYMBOLS, GMO_INTERVALS]) n += freezeDeep(v);
// how many objects were frozen (stderr only)
export const FROZEN_CONSTANTS = n;
