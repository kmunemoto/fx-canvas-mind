import "@testing-library/jest-dom";
import { afterEach } from "vitest";
import { resetChartPrefsCache } from "@/lib/chartPrefs";

// #141: the charts keep what was chosen on them (the pair and timeframe
// too), so each test starts from an empty browser rather than the last one's
afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
  resetChartPrefsCache();
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// framer-motion's whileInView asks for an IntersectionObserver, which jsdom
// does not implement. Every element is reported as already on screen, so
// scroll-triggered sections render in tests exactly as they do to a reader
// who has scrolled to them.
class NoopIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];
  constructor(private readonly cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ isIntersecting: true, target, intersectionRatio: 1 } as IntersectionObserverEntry],
      this,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}
window.IntersectionObserver = NoopIntersectionObserver as unknown as typeof IntersectionObserver;
globalThis.IntersectionObserver = window.IntersectionObserver;
