import { describe, it, expect } from "vitest";
import {
  MAX_PRUNE_RETRIES,
  NEWS_DOMAINS,
  dropInaccessibleDomains,
  isInaccessibleDomainError,
  parseInaccessibleDomains,
  planDomainRecovery,
} from "../../supabase/functions/analyze/websearch";

// The exact 400 body the Messages API returned in production when the
// allowlist still contained two sites that block Anthropic's crawler.
const REAL_ERROR =
  "The following domains are not accessible to our user agent: ['marketwatch.com', 'reuters.com']. " +
  "Read more: https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler";

describe("parseInaccessibleDomains", () => {
  it("extracts the domains from the real API error", () => {
    expect(parseInaccessibleDomains(REAL_ERROR)).toEqual(["marketwatch.com", "reuters.com"]);
  });

  it("does not mistake the support link's host for a blocked domain", () => {
    expect(parseInaccessibleDomains(REAL_ERROR)).not.toContain("support.anthropic.com");
  });

  it("handles a single domain and double quotes", () => {
    expect(
      parseInaccessibleDomains('The following domain is not accessible to our user agent: ["reuters.com"].'),
    ).toEqual(["reuters.com"]);
  });

  it("handles an unquoted, unbracketed list", () => {
    expect(
      parseInaccessibleDomains("The following domains are not accessible to our user agent: a.com, b.co.jp"),
    ).toEqual(["a.com", "b.co.jp"]);
  });

  it("normalizes scheme, www and path", () => {
    expect(
      parseInaccessibleDomains("domains are not accessible to our user agent: ['WWW.Reuters.com/markets/']"),
    ).toEqual(["reuters.com"]);
  });

  it("returns nothing for unrelated errors, so they still fail the request", () => {
    for (const msg of [
      "rate_limit_error: number of request tokens has exceeded your per-minute rate limit",
      "credit balance is too low",
      "",
    ]) {
      expect(parseInaccessibleDomains(msg)).toEqual([]);
      expect(isInaccessibleDomainError(msg)).toBe(false);
    }
  });
});

describe("dropInaccessibleDomains", () => {
  it("removes exactly the rejected sites and keeps the rest in order", () => {
    const allowed = ["reuters.com", "bloomberg.com", "cnbc.com", "marketwatch.com"];
    expect(dropInaccessibleDomains(allowed, ["marketwatch.com", "reuters.com"]))
      .toEqual(["bloomberg.com", "cnbc.com"]);
  });

  it("matches across subdomain forms in both directions", () => {
    expect(dropInaccessibleDomains(["reuters.com"], ["www.reuters.com"])).toEqual([]);
    expect(dropInaccessibleDomains(["news.reuters.com"], ["reuters.com"])).toEqual([]);
  });

  it("leaves the list untouched when nothing matches — the caller uses the\n     unchanged length as its stop condition", () => {
    const allowed = ["bloomberg.com", "cnbc.com"];
    const out = dropInaccessibleDomains(allowed, ["example.com"]);
    expect(out).toEqual(allowed);
    expect(out).not.toBe(allowed); // still a copy, never the caller's array
  });

  it("returns a copy when there is nothing to drop", () => {
    const allowed = ["bloomberg.com"];
    expect(dropInaccessibleDomains(allowed, [])).toEqual(allowed);
    expect(dropInaccessibleDomains(allowed, [])).not.toBe(allowed);
  });

  it("can empty the list, which is the signal to give up web search", () => {
    expect(dropInaccessibleDomains(["reuters.com"], ["reuters.com"])).toEqual([]);
  });
});

describe("NEWS_DOMAINS", () => {
  it("no longer ships the two sites the API rejected", () => {
    expect(NEWS_DOMAINS).not.toContain("reuters.com");
    expect(NEWS_DOMAINS).not.toContain("marketwatch.com");
  });

  it("still covers central banks and FX-specific sources", () => {
    for (const d of ["boj.or.jp", "federalreserve.gov", "ecb.europa.eu", "fxstreet.com"]) {
      expect(NEWS_DOMAINS).toContain(d);
    }
  });

  it("is within the API's 1-64 entry limit and free of duplicates", () => {
    expect(NEWS_DOMAINS.length).toBeGreaterThan(0);
    expect(NEWS_DOMAINS.length).toBeLessThanOrEqual(64);
    expect(new Set(NEWS_DOMAINS).size).toBe(NEWS_DOMAINS.length);
  });
});

describe("parseInaccessibleDomains — shapes the API does not use today", () => {
  // These are not the message format seen in production. They are covered
  // because this whole module exists to survive that format changing, so it
  // must not fail worse than "give up on search" when it does.
  it("survives entries that carry a scheme inside the bracketed list", () => {
    expect(
      parseInaccessibleDomains(
        "The following domains are not accessible to our user agent: " +
          "['https://cnbc.com', 'https://investing.com']. Read more: https://support.anthropic.com/x",
      ),
    ).toEqual(["cnbc.com", "investing.com"]);
  });

  it("does not swallow the list when a scheme precedes the closing bracket", () => {
    const out = parseInaccessibleDomains(
      "domains are not accessible to our user agent: ['https://reuters.com']",
    );
    expect(out).toEqual(["reuters.com"]);
  });

  it("cuts the trailing help sentence on the unbracketed path", () => {
    expect(
      parseInaccessibleDomains(
        "The following domains are not accessible to our user agent: reuters.com, cnbc.com. " +
          "Read more: https://support.anthropic.com/en/articles/8896518-x",
      ),
    ).toEqual(["reuters.com", "cnbc.com"]);
  });

  it("returns in reasonable time on a long adversarial message", () => {
    const hostile = "domains are not accessible to our user agent: [" + "'a-".repeat(20000) + "]";
    const started = performance.now();
    parseInaccessibleDomains(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("planDomainRecovery", () => {
  const ALL = ["a.com", "b.com", "c.com"];

  it("retries with the pruned list while it is still making progress", () => {
    expect(planDomainRecovery(ALL, ["a.com"], 0)).toEqual({
      action: "retry",
      domains: ["b.com", "c.com"],
    });
  });

  it("gives up rather than re-sending an identical request", () => {
    // Nothing matched, so the list is unchanged — retrying would burn an
    // attempt and change nothing.
    expect(planDomainRecovery(ALL, ["unmatched.example"], 0).action).toBe("disable");
  });

  it("gives up when pruning would empty the allowlist", () => {
    // An empty allowed_domains would let the model search the entire web.
    expect(planDomainRecovery(["a.com"], ["a.com"], 0).action).toBe("disable");
  });

  it("stops pruning once the retry budget is spent, leaving attempts for the fallback", () => {
    expect(planDomainRecovery(ALL, ["a.com"], MAX_PRUNE_RETRIES - 1).action).toBe("retry");
    expect(planDomainRecovery(ALL, ["a.com"], MAX_PRUNE_RETRIES).action).toBe("disable");
  });

  it("terminates: repeated application always reaches disable", () => {
    let domains = [...NEWS_DOMAINS];
    let retries = 0;
    for (let i = 0; i < 50; i++) {
      // Worst case the API names one site at a time, the shape the reviewers
      // argued cannot happen — the loop must still converge.
      const plan = planDomainRecovery(domains, domains.slice(0, 1), retries);
      if (plan.action === "disable") {
        expect(retries).toBeLessThanOrEqual(MAX_PRUNE_RETRIES);
        return;
      }
      domains = plan.domains;
      retries++;
    }
    throw new Error("planDomainRecovery never reached disable");
  });
});
