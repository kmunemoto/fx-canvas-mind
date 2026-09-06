import { useState } from "react";
import type { AnalysisRecord, PerformanceGroup, PerformanceStats } from "@/lib/types";
import { ChevronDown, ChevronUp, Clock, TrendingUp } from "lucide-react";
import { useLocale } from "@/lib/i18n";
import {
  NO_RULEBOOK,
  TARGET_CLUSTERS,
  byConfidence,
  byMode,
  byRulebookVersion,
  LEGACY_CONTRACT,
  byTimeframe,
  causeCounts,
  isRejected,
  isPreview,
  isShadow,
  shadowTally,
  tally,
  type OutcomeTally,
  headlineScope,
  serverTally,
} from "@/lib/outcomeStats";
import { formatJst } from "@/lib/candleTime";
import OutcomeDetail from "./OutcomeDetail";

interface Props {
  records: AnalysisRecord[];
  // The record over every row, from public.performance_stats(). Optional: an
  // RPC outage falls back to what can be computed from the rows on screen,
  // and the scope label says which of the two is being shown.
  stats?: PerformanceStats | null;
}

const signalColor = (s: string) =>
  s === "BUY" ? "text-success" : s === "SELL" ? "text-destructive" : "text-warning";

const OUTCOME_CLASS: Record<string, string> = {
  win: "bg-success/15 text-success border-success/40",
  loss: "bg-destructive/15 text-destructive border-destructive/40",
  pending: "bg-secondary text-muted-foreground border-border",
  expired: "bg-secondary text-muted-foreground border-border",
  skipped: "bg-secondary text-muted-foreground border-border",
  untriggered: "bg-warning/15 text-warning border-warning/40",
  // Not styled like expired/skipped: an unread record is not a decided one
  ambiguous: "bg-warning/15 text-warning border-warning/40",
  rejected: "bg-warning/15 text-warning border-warning/40",
};

type Breakdown = "timeframe" | "mode" | "confidence" | "rulebook";

const signedR = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}R`);

const parseBand = (key: string): [number, number | null] => {
  if (key.endsWith("+")) return [Number(key.slice(0, -1)), null];
  const [lo, hi] = key.split("-").map(Number);
  return [lo, Number.isFinite(hi) ? hi : null];
};

// Signal history backed by the analyses table. Wins and losses are judged
// server-side against actual price data, not self-reported; each row opens
// into the plan-vs-actual evidence behind its badge and, once settled, the
// post-mortem. Plans the entry gate refused are tracked in the shadows and
// shown under the WAIT row they became, not as rows of their own.
const AnalysisHistory = ({ records, stats = null }: Props) => {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown>("timeframe");

  const all = Array.isArray(records) ? records : [];
  const safe = all.filter((r) => !isShadow(r));
  if (safe.length === 0) return null;

  const shadows = new Map<string, AnalysisRecord>();
  for (const r of all) {
    if (isShadow(r) && typeof r.shadow_of === "string") shadows.set(r.shadow_of, r);
  }

  // Two populations, and they must never be confused: the statistics are the
  // whole record, the list below is the last 40 rows. Before this the two were
  // the same forty rows, which is why `clusters` could never reach its target
  // of 50 and the P&L total could FALL after a winning trade.
  const scope = stats ? headlineScope(stats) : null;
  const overall = scope ? serverTally("all", scope.group) : tally("all", safe);
  const serverGroups = (map: Record<string, PerformanceGroup> | undefined): OutcomeTally[] =>
    Object.entries(map ?? {}).map(([k, g]) => serverTally(k, g));
  // What the win rate is now taken over: an expiry is a call that did not
  // work out, not a call that never happened
  const closed = overall.wins + overall.losses + overall.expired;
  const gate = stats?.shadow ?? shadowTally(all);
  const causes = causeCounts(safe);
  // The same four breakdowns, over the whole record when the server answered.
  // Splitting forty rows four ways gave cells of two or three and coloured
  // their win rates with full confidence.
  const groups: OutcomeTally[] = stats
    ? serverGroups(
        breakdown === "timeframe"
          ? stats.by_timeframe
          : breakdown === "mode"
            ? stats.by_mode
            : breakdown === "rulebook"
              ? stats.by_rulebook_version
              : stats.by_confidence,
      )
    : breakdown === "timeframe"
      ? byTimeframe(safe)
      : breakdown === "mode"
        ? byMode(safe)
        : breakdown === "rulebook"
          ? byRulebookVersion(safe)
          : byConfidence(safe);

  const groupLabel = (key: string) => {
    if (breakdown === "timeframe") return key;
    if (breakdown === "mode") return t.history.modes[key as keyof typeof t.history.modes] ?? key;
    if (breakdown === "rulebook") {
      // Composite key: "<contract>|<version>". The legacy contract is labelled
      // so the two eras are never read as one series of rulebook versions.
      const [contract, version] = key.split("|");
      const label = version === NO_RULEBOOK ? t.history.stats.rulebookNone : version;
      return contract === LEGACY_CONTRACT ? t.history.stats.legacyContract(label) : label;
    }
    if (key === "unknown") return t.history.stats.unknownBand;
    const [lo, hi] = parseBand(key);
    return t.history.stats.confidenceBand(lo, hi);
  };

  const breakdowns: Array<{ id: Breakdown; label: string }> = [
    { id: "timeframe", label: t.history.stats.byTimeframe },
    { id: "mode", label: t.history.stats.byMode },
    { id: "confidence", label: t.history.stats.byConfidence },
    { id: "rulebook", label: t.history.stats.byRulebook },
  ];
  const activeLabel = breakdowns.find((b) => b.id === breakdown)?.label ?? "";
  const causeLabel = (c: string) => (c in t.history.postmortem.causes ? t.history.postmortem.causes[c as keyof typeof t.history.postmortem.causes] : c);

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary">
          <Clock className="h-4 w-4" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{t.history.title}</h3>
          <span className="text-[10px] text-muted-foreground">{t.history.scope(safe.length)}</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {overall.fillRate !== null && (
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{t.history.fillRate}</span>
              <span className={`font-mono font-bold ${overall.fillRate >= 50 ? "text-foreground" : "text-warning"}`}>
                {overall.fillRate}%
              </span>
            </div>
          )}
          {overall.winRate !== null && (
            <div className="flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              <span className="text-muted-foreground">{t.history.winRate}</span>
              <span
                data-testid="win-rate"
                className={`font-mono font-bold ${overall.winRate >= 50 ? "text-success" : "text-destructive"}`}
              >
                {overall.winRate}%
              </span>
              <span className="text-muted-foreground font-mono">({overall.wins}/{closed})</span>
            </div>
          )}
        </div>
      </div>

      {/* Which population the numbers above are taken over. The list below is
          the last 40 rows and says so separately; one label covering both
          would be a new lie replacing the old one. */}
      <p className="text-[10px] text-muted-foreground" data-testid="stats-scope">
        {scope
          ? scope.contract
            ? t.history.statsScopeContract(overall.calls, scope.contract)
            : t.history.statsScope(overall.calls)
          : t.history.statsFallback(safe.length)}
        {stats && stats.other_contract_rows > 0 && !scope?.contract
          ? ` · ${t.history.otherContractRows(stats.other_contract_rows)}`
          : ""}
      </p>

      <p className="text-[10px] text-muted-foreground">{t.history.autoNote}</p>

      {overall.contracts.length > 1 && (
        <p className="text-[10px] text-warning" data-testid="mixed-contracts">
          {t.history.stats.mixedContracts}
        </p>
      )}

      {/* Where every call went. Closing one way to avoid a verdict just moves
          the pressure elsewhere, so the share that produced one is published
          rather than any single escape hatch being watched. */}
      {overall.calls > 0 && overall.verdictRate !== null && (
        <p className="text-[10px] font-mono" data-testid="verdict-strip">
          <span className="text-muted-foreground">{t.history.stats.verdictRate}</span>{" "}
          <span className={overall.verdictRate >= 70 ? "text-foreground" : "text-warning"}>
            {overall.verdictRate}%
          </span>
          <span className="text-muted-foreground">
            {" "}({overall.wins + overall.losses}/{overall.calls})
            {" · "}{t.history.stats.leakLine(
              overall.waitRate ?? 0,
              overall.untriggeredRate ?? 0,
              overall.expiredRate ?? 0,
            )}
            {overall.incoherent > 0 ? ` · ${t.history.stats.incoherentLine(overall.incoherent)}` : ""}
          </span>
        </p>
      )}

      {/* Standing aside is the one call that costs nothing to make, so the
          share of them the market went on to refute is published next to the
          verdict rate rather than left in the row detail. */}
      {overall.waitsJudged > 0 && (
        <p className="text-[10px] font-mono" data-testid="wait-strip">
          <span className={overall.waitsMissed > 0 ? "text-warning" : "text-muted-foreground"}>
            {t.history.wait.summary(overall.waitsJudged, overall.waitsMissed, overall.waitMissRate ?? 0)}
          </span>
        </p>
      )}

      {/* what the win rate rests on: a rate off two trades is not a rate */}
      {closed > 0 && (
        <p className="text-[10px] text-muted-foreground font-mono" data-testid="record-strip">
          {overall.clusters < TARGET_CLUSTERS
            ? t.history.stats.measuring(overall.clusters, TARGET_CLUSTERS)
            : t.history.stats.clusters(overall.clusters)}
          {overall.winRateCi ? ` · ${t.history.stats.ci(overall.winRateCi[0], overall.winRateCi[1])}` : ""}
          {overall.expectancy !== null ? ` · ${t.history.stats.expectancyLine(signedR(overall.expectancy), signedR(overall.sumR))}` : ""}
        </p>
      )}

      {/* the gate's own record */}
      {overall.rejected > 0 && (
        <p className="text-[10px] text-muted-foreground" data-testid="gate-note">
          {t.history.gate.note(overall.rejected)}
          {gate.total > 0 ? ` ${t.history.gate.shadowNote(gate)}` : ""}
        </p>
      )}

      {/* breakdown of the record by timeframe / mode / confidence */}
      {overall.total > 0 && (
        <div className="rounded-lg border border-border/60 bg-background/30 p-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{t.history.stats.title}</span>
            <div className="flex gap-1">
              {breakdowns.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={breakdown === b.id}
                  onClick={() => setBreakdown(b.id)}
                  className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                    breakdown === b.id
                      ? "bg-primary/15 text-primary border-primary/40"
                      : "text-muted-foreground border-transparent hover:border-border"
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          {closed === 0 ? (
            <p className="text-[10px] text-muted-foreground">{t.history.stats.noClosed}</p>
          ) : (
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-muted-foreground text-[10px]">
                  <th className="text-left font-normal py-0.5">{activeLabel}</th>
                  <th className="text-right font-normal">{t.history.stats.record}</th>
                  <th className="text-right font-normal">{t.history.winRate}</th>
                  <th className="text-right font-normal">{t.history.stats.untriggered}</th>
                  <th className="text-right font-normal">{t.history.outcomes.ambiguous}</th>
                  <th className="text-right font-normal">{t.history.stats.other}</th>
                  <th className="text-right font-normal">{t.history.stats.open}</th>
                  <th className="text-right font-normal">{t.history.stats.rColumn}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key} className="border-t border-border/40">
                    <td className="py-0.5 text-foreground">{groupLabel(g.key)}</td>
                    <td className="text-right">
                      <span className="text-success">{g.wins}</span>
                      <span className="text-muted-foreground">–</span>
                      <span className="text-destructive">{g.losses}</span>
                    </td>
                    <td className={`text-right font-bold ${g.winRate === null ? "text-muted-foreground" : g.winRate >= 50 ? "text-success" : "text-destructive"}`}>
                      {g.winRate === null ? "—" : `${g.winRate}%`}
                    </td>
                    <td className="text-right text-warning">{g.untriggered}</td>
                    <td className="text-right text-warning">{g.ambiguous}</td>
                    <td className="text-right text-muted-foreground">{g.expired}</td>
                    <td className="text-right text-muted-foreground">{g.open}</td>
                    <td className={`text-right ${g.sumR === null ? "text-muted-foreground" : g.sumR >= 0 ? "text-success" : "text-destructive"}`}>
                      {signedR(g.sumR)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {causes.length > 0 && (
            <p className="text-[10px] text-muted-foreground" data-testid="cause-breakdown">
              <span className="font-semibold">{t.history.postmortem.causeBreakdown}: </span>
              {causes.map((c) => `${causeLabel(c.cause)} ×${c.count}`).join(" · ")}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground">{t.history.winRateNote} · {t.history.stats.frictionNote}</p>
        </div>
      )}

      <div className="space-y-1">
        {safe.map((r) => {
          const rejected = isRejected(r);
          // A weekend read stays in the list — the user asked to keep it — but
          // it must never be mistaken for a call the analyst made when it
          // could act. The badge says so on the row itself, not only in the
          // detail nobody opens.
          const preview = isPreview(r);
          const badgeKey = rejected ? "rejected" : r.outcome;
          const badgeCls = OUTCOME_CLASS[badgeKey] ?? OUTCOME_CLASS.pending;
          const badgeLabel = rejected
            ? t.history.outcomes.rejected
            : t.history.outcomes[r.outcome] ?? t.history.outcomes.pending;
          const diagnosed = r.postmortem?.status === "done";
          const waitMissed = r.wait_check?.verdict === "missed";
          const isOpen = expanded === r.id;
          const panelId = `outcome-${r.id}`;
          return (
            <div key={r.id} className="border-b border-border/50 last:border-0">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setExpanded(isOpen ? null : r.id)}
                className="w-full flex items-center gap-2 text-xs py-1.5 text-left hover:bg-secondary/40 rounded px-1 -mx-1 transition-colors"
              >
                <span className="font-mono text-muted-foreground shrink-0">{formatJst(r.created_at, t.intlLocale)}</span>
                <span className="text-muted-foreground truncate">{r.pair} {r.interval}</span>
                <span className={`font-bold font-mono ml-auto shrink-0 ${signalColor(r.signal)}`}>
                  {r.signal}{r.confidence !== null ? ` ${r.confidence}%` : ""}
                </span>
                {diagnosed && r.postmortem?.cause && (
                  <span className="hidden sm:inline shrink-0 text-[10px] text-muted-foreground truncate max-w-[10rem]">
                    {causeLabel(r.postmortem.cause)}
                  </span>
                )}
                {preview && (
                  <span
                    className="shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-semibold bg-primary/10 text-primary border-primary/40"
                    data-testid="preview-badge"
                  >
                    {t.history.preview.badge}
                  </span>
                )}
                {waitMissed && (
                  <span className="shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-semibold bg-warning/15 text-warning border-warning/40">
                    {t.history.wait.badge}
                  </span>
                )}
                <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${badgeCls}`}>
                  {badgeLabel}
                </span>
                {isOpen
                  ? <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden="true" />
                  : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden="true" />}
                <span className="sr-only">{isOpen ? t.history.detail.collapse : t.history.detail.expand}</span>
              </button>
              {isOpen && (
                <div id={panelId}>
                  <OutcomeDetail record={r} shadow={shadows.get(r.id) ?? null} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AnalysisHistory;
