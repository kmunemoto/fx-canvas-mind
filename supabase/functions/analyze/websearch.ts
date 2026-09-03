// Web-search configuration and failure recovery for the analyze function.
// Deno-free on purpose: src/test/websearch.test.ts imports this file directly,
// so it must stay pure TypeScript with no Deno, Node, or DOM APIs.

// Sources we are willing to let influence a trade signal. Search results enter
// the model's context and the model's output is a trade plan, so this is an
// allowlist rather than an open web search.
//
// It is a starting point, not a guarantee. The Messages API rejects the entire
// request when any listed site blocks Anthropic's crawler, and which sites do
// that changes without notice — `dropInaccessibleDomains` prunes the list at
// runtime from what the API reports, so a newly-blocking site degrades the run
// instead of breaking it.
export const NEWS_DOMAINS: string[] = [
  "bloomberg.com", "cnbc.com", "investing.com", "fxstreet.com",
  "dailyfx.com", "forexfactory.com", "tradingeconomics.com",
  "nikkei.com", "boj.or.jp", "federalreserve.gov",
  "ecb.europa.eu", "mof.go.jp",
];

// The API answers an uncrawlable allowlist with a 400 whose message reads
//   The following domains are not accessible to our user agent:
//   ['marketwatch.com', 'reuters.com']. Read more: https://support.anthropic.com/...
const SIGNATURE = /domains?\s+(?:is|are)\s+not\s+accessible\s+to\s+our\s+user\s+agent/i;

const DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

// "https://WWW.Reuters.com/markets/" -> "reuters.com"
const normalizeDomain = (value: string): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return DOMAIN_SHAPE.test(cleaned) ? cleaned : null;
};

export const isInaccessibleDomainError = (message: string): boolean =>
  typeof message === "string" && SIGNATURE.test(message);

// Pulls the domain names the API named. Returns [] for any other error, so the
// caller can tell "retry without these" apart from a genuine failure.
export const parseInaccessibleDomains = (message: string): string[] => {
  if (!isInaccessibleDomainError(message)) return [];

  const tail = message.slice(message.search(SIGNATURE));
  const bracketed = tail.match(/\[([^\]]*)\]/);

  // The message ends with "Read more: https://support.anthropic.com/..." and
  // that hostname is not a blocked domain. Inside a bracketed list the bracket
  // already excludes it; outside one, cut the sentence off. Stripping URLs
  // before locating the bracket would eat a closing bracket that happens to
  // follow a scheme-qualified entry such as ['https://reuters.com'].
  const scope = bracketed ? bracketed[1] : tail.replace(/\bread more\b[\s\S]*$/i, " ");

  const quoted = [...scope.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const candidates = quoted.length > 0 ? quoted : scope.split(/[\s,]+/);

  const out: string[] = [];
  for (const candidate of candidates) {
    const domain = normalizeDomain(candidate);
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out;
};

// Same site, or one is a subdomain of the other — the API may name
// "www.reuters.com" for an allowlist entry of "reuters.com".
const sameSite = (a: string, b: string): boolean =>
  a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

// Returns a NEW array with every entry the API rejected removed. The caller
// must treat an unchanged length as "no progress" and stop retrying, otherwise
// a domain we cannot match would spin the request loop forever.
export const dropInaccessibleDomains = (allowed: string[], blocked: string[]): string[] => {
  if (!Array.isArray(allowed) || !Array.isArray(blocked) || blocked.length === 0) {
    return Array.isArray(allowed) ? [...allowed] : [];
  }

  const rejected = blocked.map(normalizeDomain).filter((d): d is string => d !== null);
  if (rejected.length === 0) return [...allowed];

  return allowed.filter((entry) => {
    const domain = normalizeDomain(entry);
    if (!domain) return true;
    return !rejected.some((bad) => sameSite(domain, bad));
  });
};

// A domain-pruning retry and a pause_turn continuation share one attempt
// budget in the caller, so pruning is capped: the technical-only fallback must
// always have an attempt left to run in.
export const MAX_PRUNE_RETRIES = 2;

export interface DomainRecoveryPlan {
  action: "retry" | "disable";
  domains: string[];
}

// Decides what to do with an "inaccessible domains" rejection. Retrying is
// allowed only when the allowlist actually shrank — an unchanged list means we
// could not match what the API named, and re-sending the identical request
// would burn the budget and starve the fallback. Kept separate from the
// request loop so this rule is directly testable.
export const planDomainRecovery = (
  current: string[],
  blocked: string[],
  pruneRetries: number,
): DomainRecoveryPlan => {
  const remaining = dropInaccessibleDomains(current, blocked);
  const progressed = remaining.length > 0 && remaining.length < current.length;

  return progressed && pruneRetries < MAX_PRUNE_RETRIES
    ? { action: "retry", domains: remaining }
    : { action: "disable", domains: [] };
};
