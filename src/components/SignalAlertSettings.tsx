import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bell, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { useLocale } from "@/lib/i18n";
import { priceDecimals } from "@/lib/candleTime";
import {
  AlertRequestError,
  callSignalAlerts,
  isFollowing,
  type AlertRow,
  type AlertSettings,
} from "@/lib/signalAlerts";

interface Props {
  // Injected by tests; the app uses the real function
  call?: (body: Record<string, unknown>) => Promise<AlertSettings>;
}

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
    const key = `${pair}|${interval}`;
    setBusy(key);
    try {
      setSettings(await call({ action: "set", pair, interval, on, lang: locale }));
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
    return `${r.pair ?? ""} ${tf} ${r.side ? a.sides[r.side] : ""}`.trim();
  };
  const statusLabel = (r: AlertRow) =>
    r.status === "skipped" && r.skipReason ? a.skipReasons[r.skipReason] ?? a.status.skipped : a.status[r.status];
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
                    const on = isFollowing(settings, pair, iv);
                    // A lapsed plan can still untick, never tick
                    const disabled = busy !== null || (!on && !settings.allowed);
                    return (
                      <td key={iv} className="py-1 text-center">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={disabled}
                          onChange={() => void toggle(pair, iv, !on)}
                          aria-label={`${pair} ${a.intervals[iv] ?? iv}`}
                          data-testid={`signal-alert-${pair}-${iv}`}
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
            {a.notes.map((n) => <li key={n}>{n}</li>)}
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
