import { useLocale } from "@/lib/i18n";
import { formatJst } from "@/lib/candleTime";
import type { AnalysisReuse } from "@/lib/types";

// AN ANSWER THAT WAS NOT DRAWN NOW.
//
// The screen must never present a stored answer as a fresh one
// (docs/OPERATIONS.md §2.4). So this says three things and gives the reader a
// way past it: when the answer was made, why asking again would not help
// (same input means the analyst only re-rolls its own noise — 10 of 48 on
// replay), and that the clock is the one thing that differs.
//
// Its own component rather than JSX inside the page: a banner buried in
// Index.tsx could only be pinned by grepping the source for a testid, which
// stays green if the block becomes unreachable. Here it renders in a test.
const ReuseBanner = ({ reused, busy, onForceFresh }: {
  reused: AnalysisReuse;
  busy: boolean;
  onForceFresh: () => void;
}) => {
  const { t } = useLocale();
  return (
    <div
      className="rounded-xl border border-border bg-secondary/40 p-3 text-[12px] leading-relaxed text-foreground"
      data-testid="reuse-banner"
    >
      <p className="font-semibold">{t.reuse.title}</p>
      <p className="mt-1 text-muted-foreground" data-testid="reuse-analyzed-at">
        {t.reuse.analyzedAt(formatJst(reused.analyzed_at, t.intlLocale))}
      </p>
      <p className="mt-1 text-muted-foreground">{t.reuse.body}</p>
      {/* Only what actually happened. The refund is a best-effort RPC that
          clears its own guard before running, so a failure is permanent and
          the counter stays down — saying "no credit was used" there would
          contradict the number beside it. Null means none was consumed at
          all (admin), which is neither claim. */}
      {reused.credit_refunded === true && (
        <p className="mt-1 text-muted-foreground" data-testid="reuse-credit">{t.reuse.creditReturned}</p>
      )}
      {reused.credit_refunded === false && (
        <p className="mt-1 text-warning" data-testid="reuse-credit">{t.reuse.creditNotReturned}</p>
      )}
      <p className="mt-1 text-muted-foreground">{t.reuse.clockNote}</p>
      <button
        type="button"
        onClick={onForceFresh}
        disabled={busy}
        className="mt-2 px-3 py-1.5 rounded-lg border border-border text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors disabled:opacity-60"
        data-testid="force-fresh"
      >
        {t.reuse.forceButton}
      </button>
    </div>
  );
};

export default ReuseBanner;
