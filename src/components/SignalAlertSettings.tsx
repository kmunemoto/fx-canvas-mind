import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bell, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { useLocale } from "@/lib/i18n";
import { priceDecimals } from "@/lib/candleTime";
import {
  ALERT_RULES,
  AlertRequestError,
  callSignalAlerts,
  isFollowing,
  type AlertRow,
  type AlertRule,
  type AlertSettings,
  type RecordSummary,
} from "@/lib/signalAlerts";

interface Props {
  // Injected by tests; the app uses the real function
  call?: (body: Record<string, unknown>) => Promise<AlertSettings>;
}

const fmtR = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
// Below this many settled signals the numbers are read as noise (a 95%
// interval on a win rate near 35% is still about ±17 points at 30)
const ENOUGH = 30;

// "09-25 19:15" in Japan time, which is how the rest of the app writes times
const jst = (iso: string) => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms + 9 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
};

// #105: which charts email the RSI + Parabolic SAR signal, and what was sent.
// The server decides who may follow a chart (Pro and the admins) and holds the
// only copy of the choice; this card asks it and shows the answer.
const SignalAlertSettings = ({ call = callSignalAlerts }: Props) => {
  const { t, locale } = useLocale();
  const a = t.alerts;
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // #112: which rule's grid and record are on screen
  const [rule, setRule] = useState<AlertRule>("rsi_sar");

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setSettings(await call({ action: "status" }));
    } catch {
      setLoadError(true);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (pair: string, interval: string, on: boolean) => {
    const key = `${rule}|${pair}|${interval}`;
    setBusy(key);
    try {
      setSettings(await call({ action: "set", pair, interval, on, rule, lang: locale }));
    } catch {
      toast.error(a.saveFailed);
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy("test");
    try {
      const next = await call({ action: "test", lang: locale });
      setSettings(next);
      if (next.test === "sent") toast.success(a.testSent);
      else if (next.test === "not_configured") toast.warning(a.testNotConfigured);
      else toast.error(a.testFailed);
    } catch (err) {
      toast.error(err instanceof AlertRequestError && err.code === "test_cooldown" ? a.testCooldown : a.testFailed);
    } finally {
      setBusy(null);
    }
  };

  const rowLabel = (r: AlertRow) => {
    if (r.kind === "test") return a.testRow;
    const tf = r.interval ? a.intervals[r.interval] ?? r.interval : "";
    return `${r.pair ?? ""} ${tf} ${r.side ? a.sides[r.side] : ""}`.trim() + (a.ruleTag[r.rule] ?? "");
  };
  const statusLabel = (r: AlertRow) =>
    r.status === "skipped" && r.skipReason ? a.skipReasons[r.skipReason] ?? a.status.skipped : a.status[r.status];
  const resultLabel = (r: AlertRow) => {
    if (r.kind !== "signal" || !r.result) return null;
    const o = r.result.outcome;
    if (o === null) return { text: a.pendingResult, cls: "text-muted-foreground" };
    const text = r.result.r === null ? a.outcome[o] : `${a.outcome[o]} ${fmtR(r.result.r)}`;
    return { text, cls: o === "win" ? "text-success" : o === "expired" || o === "no_data" ? "text-muted-foreground" : "text-destructive" };
  };
  const summaryBlock = (label: string, sm: RecordSummary, testid: string) => (
    <div className="space-y-0.5" data-testid={testid}>
      <p className="text-[11px] text-foreground">{label}</p>
      {sm.n === 0 ? (
        <p className="text-[11px] text-muted-foreground">{a.record.none}</p>
      ) : (
        <>
          <p className="text-[11px] font-mono">{a.record.line(sm.n, sm.wins, sm.losses, sm.expired)}</p>
          {sm.winRate !== null && sm.meanR !== null && (
            <p className={`text-[11px] font-mono ${sm.meanR >= 0 ? "text-success" : "text-destructive"}`}>
              {a.record.stats(pct(sm.winRate), fmtR(sm.meanR))}
              {sm.ciR !== null && a.record.ci(sm.ciR.toFixed(2) + "R")}
            </p>
          )}
        </>
      )}
      {sm.open > 0 && <p className="text-[10px] text-muted-foreground">{a.record.open(sm.open)}</p>}
    </div>
  );
  const statusClass = (r: AlertRow) =>
    r.status === "sent" ? "text-success" : r.status === "failed" ? "text-destructive" : "text-muted-foreground";

  return (
    <div className="p-4 rounded-lg bg-secondary border border-border space-y-3" data-testid="signal-alerts">
      <div className="flex items-center gap-2">
        <Bell className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">{a.title}</h3>
      </div>

      {!settings ? (
        loadError ? (
          <p className="text-xs text-destructive" data-testid="signal-alerts-error">{a.loadFailed}</p>
        ) : (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {a.loading}
          </p>
        )
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{settings.email ? a.intro(settings.email) : a.introNoEmail}</p>
          {!settings.allowed && (
            <p className="text-xs text-warning" data-testid="signal-alerts-pro-only">{a.proOnly}</p>
          )}
          {!settings.emailConfigured && (
            <p className="text-xs text-warning flex items-start gap-1.5" data-testid="signal-alerts-not-configured">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{a.notConfigured}</span>
            </p>
          )}

          <div className="flex items-center gap-1" role="tablist" aria-label={a.ruleTabsLabel} data-testid="signal-alerts-rules">
            {ALERT_RULES.map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={rule === k}
                onClick={() => setRule(k)}
                data-testid={`signal-alerts-rule-${k}`}
                className={`px-2 py-0.5 rounded border text-[11px] ${
                  rule === k ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"
                }`}
              >
                {a.ruleTabs[k]}
              </button>
            ))}
          </div>
          {rule === "gainz" && <p className="text-[11px] text-muted-foreground" data-testid="signal-alerts-gainz-intro">{a.gainzIntro}</p>}

          <table className="w-full text-xs" data-testid="signal-alerts-grid">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-normal py-1">{a.pairHeader}</th>
                {settings.intervals.map((iv) => (
                  <th key={iv} className="font-normal py-1 text-center">{a.intervals[iv] ?? iv}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {settings.pairs.map((pair) => (
                <tr key={pair} className="border-t border-border/50">
                  <td className="py-1 font-mono text-foreground">{pair}</td>
                  {settings.intervals.map((iv) => {
                    const on = isFollowing(settings, pair, iv, rule);
                    // A lapsed plan can still untick, never tick
                    const disabled = busy !== null || (!on && !settings.allowed);
                    return (
                      <td key={iv} className="py-1 text-center">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={disabled}
                          onChange={() => void toggle(pair, iv, !on)}
                          aria-label={`${pair} ${a.intervals[iv] ?? iv} ${a.ruleTabs[rule]}`}
                          data-testid={rule === "gainz" ? `signal-alert-gainz-${pair}-${iv}` : `signal-alert-${pair}-${iv}`}
                          className="h-4 w-4 accent-primary disabled:opacity-40"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="space-y-1 text-[11px] text-muted-foreground list-disc pl-4" data-testid="signal-alerts-notes">
            {(rule === "gainz" ? a.gainzNotes : a.notes).map((n) => <li key={n}>{n}</li>)}
          </ul>

          <button
            onClick={() => void sendTest()}
            disabled={busy !== null || !settings.allowed}
            className="w-full px-3 py-2 rounded-lg border border-border text-xs font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            data-testid="signal-alerts-test"
          >
            {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
            {a.test}
          </button>

          {(() => {
            // #112: the record of the rule on screen
            const perf = settings.performance;
            const record = perf ? (rule === "gainz" ? perf.gainz : perf) : null;
            if (!record) return null;
            return (
              <div className="space-y-1.5 pt-1 border-t border-border/60" data-testid="signal-alerts-record">
                <p className="text-[11px] font-semibold text-foreground">{a.record.titleFor(a.ruleTabs[rule])}</p>
                {summaryBlock(a.record.mine, record.mine, "signal-alerts-record-mine")}
                {summaryBlock(a.record.all, record.all, "signal-alerts-record-all")}
                {record.backtest && (
                  <p className="text-[10px] text-muted-foreground">
                    {a.record.backtest(
                      record.backtest.period,
                      pct(record.backtest.winRate),
                      fmtR(record.backtest.meanR),
                      pct(record.backtest.breakeven),
                    )}
                  </p>
                )}
                {record.all.n < ENOUGH && (
                  <p className="text-[10px] text-warning" data-testid="signal-alerts-record-small">{a.record.small}</p>
                )}
                <p className="text-[10px] text-muted-foreground">{rule === "gainz" ? a.record.rNoteGainz : a.record.rNote}</p>
                <p className="text-[10px] text-muted-foreground">{a.record.method}</p>
              </div>
            );
          })()}

          <div className="space-y-1 pt-1 border-t border-border/60" data-testid="signal-alerts-recent">
            <p className="text-[11px] text-muted-foreground">{a.recentTitle}</p>
            {settings.alerts.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{a.none}</p>
            ) : (
              settings.alerts.slice(0, 10).map((r) => {
                const d = r.pair ? priceDecimals(r.pair) : 3;
                const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(d));
                return (
                  <div key={r.id} className="text-[11px] py-0.5" data-testid="signal-alert-row">
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <span className="font-mono text-muted-foreground">{jst(r.closedAt ?? r.createdAt)}</span>
                      <span className={r.side === "BUY" ? "text-success" : r.side === "SELL" ? "text-destructive" : "text-foreground"}>
                        {rowLabel(r)}
                      </span>
                    </div>
                    <p className={statusClass(r)}>{statusLabel(r)}</p>
                    {(() => {
                      const res = resultLabel(r);
                      return res ? <p className={`font-mono ${res.cls}`} data-testid="signal-alert-result">{res.text}</p> : null;
                    })()}
                    {r.kind === "signal" && r.entry !== null && (
                      <p className="font-mono text-muted-foreground">{a.plan(fmt(r.entry), fmt(r.stop), fmt(r.target))}</p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default SignalAlertSettings;
