// #318 (docs §8.113 20 (h), (i)): the checks' registry (checks.json), the count reconciliation, the
// printer (print.txt: only the items of PRINT_ITEMS) and the log — the one place that writes to stdout.
// A check is { ok, n, detail?, skipped? }: n the number of failures (or of things compared, for a pass).
// 20 (i): the log carries the checks' names and verdicts, the read lines and sha256s only (and, in made-up
// modes, MADEUP lines); any other line is refused and fails print.items.

import { ITEM_TABLE, MEASURES, holdPrintKeys } from "./chartbest-const.ts";

export interface Check {
  ok: boolean;
  n: number;
  detail?: unknown;
  skipped?: string;
}

// the log's line shapes (20 (i)); a line of any other shape is refused
const LOG_SHAPES: RegExp[] = [
  /^MODE [a-z0-9-]+( [A-Za-z0-9_.:,=/-]+)*$/,
  /^ok {3}[A-Za-z0-9_.:-]+( n=\d+)?$/,
  /^FAIL [A-Za-z0-9_.:-]+ n=\d+$/,
  /^SKIP [A-Za-z0-9_.:-]+ \([^\n]*\)$/,
  /^read [A-Z]{3}\/[A-Z]{3} (5min|1min) files=\d+ failed=\d+ oneSide=\d+ crossed=\d+ dup=\d+ ohlc=\d+ closure=\d+ band=\d+ nan=\d+$/,
  /^sha256 [A-Za-z0-9_./-]+ [0-9a-f]{64}$/,
  /^MADEUP [A-Za-z0-9_.:-]+ [^\n]*$/,
  /^EXIT \d$/,
];

let madeUp = true;
let refused = 0;
const refusedLines: string[] = [];
// the plant "printToLog" writes a number to the log; the log refuses it and print.items fails
export const Log = {
  setMadeUp(v: boolean) {
    madeUp = v;
  },
  raw(line: string) {
    const ok = LOG_SHAPES.some((r) => r.test(line)) && (madeUp || !line.startsWith("MADEUP "));
    if (!ok) {
      refused++;
      if (refusedLines.length < 5) refusedLines.push(line.slice(0, 60));
      return;
    }
    console.log(line);
  },
  mode(name: string, rest = "") {
    Log.raw(`MODE ${name}${rest ? ` ${rest}` : ""}`);
  },
  ok(name: string, n?: number) {
    Log.raw(`ok   ${name}${n === undefined ? "" : ` n=${n}`}`);
  },
  fail(name: string, n: number) {
    Log.raw(`FAIL ${name} n=${n}`);
  },
  skip(name: string, why: string) {
    Log.raw(`SKIP ${name} (${why})`);
  },
  sha(path: string, hex: string) {
    Log.raw(`sha256 ${path} ${hex}`);
  },
  madeup(key: string, v: string | number) {
    Log.raw(`MADEUP ${key} ${v}`);
  },
  refused: () => ({ n: refused, lines: [...refusedLines] }),
  // a crash's message and stack: to stderr, never stdout
  crash(text: string) {
    console.error(text);
  },
  // a JSON listing a mode prints for the workflow to read (plants-list): stdout, whole
  json(v: unknown) {
    console.log(JSON.stringify(v));
  },
};

export class Checks {
  private m = new Map<string, Check>();
  constructor(private quiet = false) {}
  set(name: string, c: Check) {
    this.m.set(name, c);
    if (this.quiet) return;
    if (c.skipped !== undefined) Log.skip(name, c.skipped);
    else if (c.ok) Log.ok(name, c.n);
    else Log.fail(name, c.n);
  }
  // a check from a count of failures among `of` things compared
  count(name: string, bad: number, of: number, detail?: unknown) {
    this.set(name, { ok: bad === 0, n: bad === 0 ? of : bad, ...(detail === undefined ? {} : { detail }) });
  }
  skip(name: string, why: string) {
    this.set(name, { ok: true, n: 0, skipped: why });
  }
  get(name: string): Check | undefined {
    return this.m.get(name);
  }
  names(): string[] {
    return [...this.m.keys()];
  }
  failed(): string[] {
    return [...this.m.entries()].filter(([, c]) => !c.ok).map(([k]) => k).sort();
  }
  skipped(): string[] {
    return [...this.m.entries()].filter(([, c]) => c.skipped !== undefined).map(([k]) => k).sort();
  }
  ok(): boolean {
    return this.failed().length === 0;
  }
  json(head: Record<string, unknown>): string {
    const checks: Record<string, Check> = {};
    for (const k of [...this.m.keys()].sort()) checks[k] = this.m.get(k)!;
    return JSON.stringify({ ...head, checks, failed: this.failed(), skipped: this.skipped() }, null, 1);
  }
}

// 20 (i): the items print.txt may hold (a key matches one of these), and nothing else
// (a key ending ".lo" or "Lo" is an interval of 15: the points and counts added by the review — W (すべての中), the
// unresolved / amb counts, the shift summary, Δ by direction and pair — never end so)
// gates-05: the sentences and the owner's way are listed key by key (a source is one of the 59 items or an email; the
// owner's way's keys are chartbest-const.ts holdPrintKeys, its 1〜8), not by a wildcard
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SRC_RE = `(?:${[...ITEM_TABLE.map((r) => r.id), ...MEASURES].map(esc).join("|")})`;
const holdKeysRe = (account: "full" | "h2"): RegExp => new RegExp(`^hold\\.${SRC_RE}\\.${account}\\.(?:${["done", ...holdPrintKeys(account)].map(esc).join("|")})$`);
export const PRINT_ITEMS: RegExp[] = [
  /^run\.(set|seed|period|flip|plant|full)$/,
  /^s0\.[A-Za-z0-9-]+\.(H1|H2)\.(counted|weeks|r1|r2|r3|r4|both|noBlind|perWeek|wideShare|warmDate|missingDays|shifted|late)$/,
  /^s0\.[A-Za-z0-9-]+\.(H1|H2)\.[A-Z]{3}_[A-Z]{3}\.(BUY|SELL)$/,
  /^s0\.[A-Za-z0-9-]+\.warmDate\.[A-Z]{3}_[A-Z]{3}$/,
  /^s0\.[A-Za-z0-9-]+\.(floor|group|g|df|passMin|size|marks|n26)$/,
  /^s0\.(M1|Wh)\.[A-Za-z0-9]+$/,
  /^s[12]\.[A-Za-z0-9-]+\.(H1|H2)\.(chart|cal)\.(delta|lo|hi|lb|se|df|t|nE|counted|a|aLo|aHi|late|lateLo|lateHi|w1|pl1|w2|pl2|w1All|w2All|w1Lo|w1Hi|pl1Lo|pl1Hi|w2Lo|w2Hi|pl2Lo|pl2Hi|dU|dULo|dUHi|dM|dMLo|dMHi|open4|open10|amb4|amb10|dropped|lateExcluded|blindW1|blindPl1|shiftMean|shiftQ025|shiftQ975|shiftRank|shiftDropped|shiftSeasonCross|suspicious)$/,
  /^s2\.[A-Za-z0-9-]+\.(H1|H2)\.(chart|cal)\.(dirBUY|dirSELL|nonOverlap)$/,
  /^s2\.[A-Za-z0-9-]+\.(H1|H2)\.(chart|cal)\.pair\.[A-Z]{3}_[A-Z]{3}$/,
  /^s[12]\.blind\.(H1|H2)\.(BUY|SELL)\.(a|w1|pl1|w2|pl2|w1All|w2All|open4|open10|amb4|amb10|suspicious)$/,
  /^s[12]\.blind\.(H1|H2)\.[A-Z]{3}_[A-Z]{3}\.(BUY|SELL)\.(a|aLo|aHi|w1|w1Lo|w1Hi|pl1|pl1Lo|pl1Hi|w2|w2Lo|w2Hi|pl2|pl2Lo|pl2Hi|w1All|w2All|open4|open10|amb4|amb10)$/,
  /^s1\.(chosen|kTotal|lbPositive|shift95|chanceLb|intervalsSeen)(\.[A-Za-z0-9-]+){0,2}$/,
  /^s2\.[A-Za-z0-9-]+\.(p|holm|c1|c2|c3|c4|c5|judgment|form|mde|simLb|dU|dM|dULb|dMLb)$/,
  /^s2\.(promote|intervalsSeen)(\.[A-Za-z0-9-]+)?$/,
  /^s2\.dAB\.[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.(est|lo|hi)$/,
  new RegExp(`^text\\.(?:s1\\.(?:none|summary)|s2\\.(?:item\\.${SRC_RE}|final)|always\\.s[12])$`),
  holdKeysRe("full"),
  holdKeysRe("h2"),
  new RegExp(`^hold\\.text\\.(?:hold\\.${SRC_RE}\\.(?:h2|full)|always\\.s2\\.hold)$`),
];

export class Printer {
  private lines: Array<[string, string]> = [];
  private bad: string[] = [];
  line(key: string, value: string | number) {
    if (!PRINT_ITEMS.some((r) => r.test(key))) this.bad.push(key);
    const v = String(value).replace(/[\t\n]/g, " ");
    this.lines.push([key, v]);
  }
  // 15: the 95% intervals printed under a prefix (a key ending ".lo" or "…Lo" opens one)
  intervals(prefix: string): number {
    return this.lines.filter(([k]) => k.startsWith(prefix) && (k.endsWith(".lo") || k.endsWith("Lo"))).length;
  }
  // print.items: every line's key is in PRINT_ITEMS, and the log refused nothing
  check(): Check {
    const r = Log.refused();
    const n = this.bad.length + r.n;
    return n === 0 ? { ok: true, n: this.lines.length } : { ok: false, n, detail: { keys: this.bad.slice(0, 5), logLines: r.n } };
  }
  text(): string {
    return this.lines.map(([k, v]) => `${k}\t${v}`).join("\n") + (this.lines.length ? "\n" : "");
  }
}
