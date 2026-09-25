import { Activity } from "lucide-react";
import type { BounceStat, TfChart } from "@/lib/types";
import { useT } from "@/lib/i18n";

interface Props {
  charts: TfChart[];
}

// #99: which conditions price bounced on, per timeframe, counted by the
// server over the window the chart shows. A table of counts with the
// interval beside every rate, and the conditions in force on the newest
// bars marked — the same numbers the analyst was shown, so what the model
// cites can be checked against what was counted.
//
// Nothing here is the model's: every row is a count of what the closed bars
// did. The footnote says how the count was made, because "70%" without
// "of ten, at 1.5R, mid prices, this window" is not a number a trader can
// use.
const pct = (v: number | null): number => (v === null ? 0 : Math.round(v * 100));

const worthARow = (s: BounceStat): boolean =>
  s.n > 0 || s.ambiguous > 0 || s.expired > 0 || s.open > 0 || s.untradable > 0;

const BounceConditions = ({ charts }: Props) => {
  const t = useT();
  const intervals = t.control.intervals as Record<string, string>;
  const tfLabel = (tf: string) => intervals[tf] ?? t.chart.tf(tf);
  const rules = t.bounce.rules as Record<string, { BUY: string; SELL: string }>;
  const ruleName = (rule: string, side: "BUY" | "SELL") => rules[rule]?.[side] ?? rule;
  const rr = charts.find((c) => c.rr !== undefined)?.rr ?? 1.5;
  const breakeven = Math.round((1 / (1 + rr)) * 100);

  if (charts.length === 0) return null;

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3" data-testid="bounce-conditions">
      <div className="flex items-center gap-2 text-primary">
        <Activity className="h-4 w-4" />
        <h3 className="text-sm font-semibold">{t.bounce.title}</h3>
      </div>

      {charts.map((c) => {
        const rows = c.ok
          ? c.stats.filter(worthARow).sort((a, b) => b.n - a.n || (b.rate ?? 0) - (a.rate ?? 0))
          : [];
        const inForce = new Set(c.recent.map((r) => `${r.rule}:${r.side}`));
        return (
          <div key={c.tf} className="space-y-1" data-testid={`bounce-tf-${c.tf}`}>
            <p className="text-xs font-semibold text-foreground">{tfLabel(c.tf)}</p>
            {!c.ok ? (
              <p className="text-[11px] text-muted-foreground">{t.bounce.pending(c.reason ?? "—")}</p>
            ) : rows.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{t.bounce.none}</p>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-[10px] text-muted-foreground">
                    <th className="text-left font-normal pb-0.5">{t.bounce.columns.condition}</th>
                    <th className="text-right font-normal pb-0.5">{t.bounce.columns.record}</th>
                    <th className="text-right font-normal pb-0.5">{t.bounce.columns.rate}</th>
                    <th className="text-right font-normal pb-0.5">{t.bounce.columns.now}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const now = inForce.has(`${s.rule}:${s.side}`);
                    // Bold when the interval's floor clears break-even on a
                    // count worth reading; everything else is just a count
                    const strong = s.n >= 5 && s.lo !== null && s.lo * 100 >= breakeven;
                    const extras = [
                      s.ambiguous > 0 ? t.bounce.extra.ambiguous(s.ambiguous) : "",
                      s.expired > 0 ? t.bounce.extra.expired(s.expired) : "",
                      s.open > 0 ? t.bounce.extra.open(s.open) : "",
                      s.untradable > 0 ? t.bounce.extra.untradable(s.untradable) : "",
                    ].filter((e) => e !== "");
                    return (
                      <tr
                        key={`${s.rule}-${s.side}`}
                        className={now ? "bg-primary/10" : ""}
                        data-testid={`bounce-row-${c.tf}-${s.rule}-${s.side}`}
                      >
                        <td className="py-0.5 pr-2">
                          <span className={`font-mono font-semibold ${s.side === "BUY" ? "text-success" : "text-destructive"}`}>{s.side}</span>
                          {" "}
                          <span className="text-foreground">{ruleName(s.rule, s.side)}</span>
                        </td>
                        <td className="py-0.5 text-right font-mono whitespace-nowrap">
                          {t.bounce.record(s.wins, s.losses)}
                          {extras.length > 0 && (
                            <span className="block text-[9px] text-muted-foreground">{extras.join(" · ")}</span>
                          )}
                        </td>
                        <td className={`py-0.5 text-right font-mono whitespace-nowrap ${strong ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                          {s.rate === null ? t.bounce.noRate : t.bounce.rate(pct(s.rate), pct(s.lo), pct(s.hi))}
                        </td>
                        <td className="py-0.5 text-right">
                          {now && (
                            <span className="px-1 py-0.5 rounded border border-primary/40 bg-primary/10 text-[9px] text-primary" data-testid="bounce-now">
                              {t.bounce.now}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {c.ok && (
              <p className="text-[9px] text-muted-foreground">
                {t.bounce.method(c.bars, c.rr ?? rr, c.horizon ?? 48)}
              </p>
            )}
          </div>
        );
      })}

      <p className="text-[9px] text-muted-foreground">{t.bounce.breakeven(breakeven)}</p>
    </div>
  );
};

export default BounceConditions;
