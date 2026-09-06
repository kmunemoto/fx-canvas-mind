import { BookOpen } from "lucide-react";
import type { RuleFit, RuleFitVerdict, Rulebook } from "@/lib/types";
import { useLocale } from "@/lib/i18n";

interface Props {
  ruleFit: RuleFit | null;
  rulebook: Rulebook | null;
}

const VERDICT_CLASS: Record<RuleFitVerdict, string> = {
  match: "bg-primary/10 text-primary border-primary/40",
  off: "bg-muted text-muted-foreground border-border",
  unknown: "bg-warning/10 text-warning border-warning/40",
};

// Which learned rules this analysis was given, and how today's market compared
// with the plans each one was drawn from.
//
// The whole point of this panel is the SECOND half. The rules panel elsewhere
// says what the analyzer has learned; this says which of it bore on this
// decision, and — where it did not — which measurements said so. Without that
// a reader sees a rule quoted under their result and reasonably assumes it
// applied.
//
// Two things it must not misrepresent, both inherited from how the verdicts
// are made:
//   - The verdict is a MEASUREMENT the server made against the rule's own
//     citations, not a claim the rule makes about itself. Said in the note at
//     the bottom, in the same words the prompt uses.
//   - "Cannot compare" is not a quiet "no". It means the evidence behind that
//     rule was too thin, too broad, or too old to answer, and it is shown as
//     its own state rather than folded in with "does not apply".
const RuleFitPanel = ({ ruleFit, rulebook }: Props) => {
  const { t, locale } = useLocale();
  const s = t.ruleFit;
  if (!ruleFit || ruleFit.shown.length === 0) return null;

  const byId = new Map((rulebook?.rules ?? []).map((r) => [r.id, r]));
  const textOf = (id: string) => {
    const r = byId.get(id);
    if (!r) return null;
    return locale === "ja" ? r.text_ja || r.text_en : r.text_en || r.text_ja;
  };
  const matched = ruleFit.shown.filter((id) => ruleFit.rules[id]?.fit === "match").length;

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-2" data-testid="rule-fit">
      <div className="flex items-center gap-2 text-primary">
        <BookOpen className="h-4 w-4" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{s.title}</h3>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {s.summary(matched, ruleFit.shown.length)}
        {ruleFit.held_back > 0 ? ` ${s.heldBack(ruleFit.held_back)}` : ""}
      </p>

      <ul className="space-y-2 pt-1">
        {ruleFit.shown.map((id) => {
          const fit = ruleFit.rules[id];
          const verdict: RuleFitVerdict = fit?.fit ?? "unknown";
          const body = textOf(id);
          return (
            <li key={id} className="text-xs space-y-1 border-t border-border/50 pt-2 first:border-0 first:pt-0">
              <div className="flex items-start gap-2">
                <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${VERDICT_CLASS[verdict]}`}>
                  {s.verdicts[verdict]}
                </span>
                <span className="text-muted-foreground leading-relaxed">
                  {body ?? s.ruleGone(id)}
                </span>
              </div>
              {/* Why it did not apply, in the axes that were actually measured
                  — "different situation" on its own is a verdict without its
                  evidence, which is the thing this project keeps refusing. */}
              {verdict === "off" && fit.missed.length > 0 && (
                <p className="text-[10px] text-muted-foreground pl-1">
                  {s.missed(fit.missed.map((a) => s.axes[a as keyof typeof s.axes] ?? a))}
                </p>
              )}
              {fit && fit.cited > 0 && (
                <p className="text-[10px] text-muted-foreground pl-1">
                  {s.evidence(fit.cases, fit.cited)}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-[10px] text-muted-foreground pt-1 border-t border-border/50" data-testid="rule-fit-note">
        {s.note}
      </p>
    </div>
  );
};

export default RuleFitPanel;
