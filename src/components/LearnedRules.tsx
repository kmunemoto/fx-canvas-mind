import { useState } from "react";
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react";
import type { Rulebook } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import { formatJst } from "@/lib/candleTime";

interface Props {
  rulebook: Rulebook | null;
}

const PREVIEW = 5;

// The rules the analyzer has learned from its own record: written by the
// post-mortem of every settled plan, consolidated, and put in front of the
// model on every new analysis. Shown so the learning is visible, not
// claimed.
const LearnedRules = ({ rulebook }: Props) => {
  const { t, locale } = useLocale();
  const s = t.rules;
  const [showAll, setShowAll] = useState(false);

  const rules = Array.isArray(rulebook?.rules) ? rulebook.rules : [];
  const text = (r: { text_ja: string; text_en: string }) => (locale === "ja" ? r.text_ja || r.text_en : r.text_en || r.text_ja);
  const summary = rulebook?.summary ? (locale === "ja" ? rulebook.summary.ja : rulebook.summary.en) : "";
  const visible = showAll ? rules : rules.slice(0, PREVIEW);

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-2" data-testid="learned-rules">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-primary">
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{s.title}</h3>
          {rulebook && rulebook.version > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {s.version(rulebook.version)}
              {rulebook.updated_at ? ` · ${s.updated(formatJst(rulebook.updated_at, t.intlLocale))}` : ""}
            </span>
          )}
        </div>
      </div>

      {rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">{s.empty}</p>
      ) : (
        <>
          {summary && <p className="text-xs text-muted-foreground">{summary}</p>}
          <ol className="space-y-1.5">
            {visible.map((r, i) => (
              <li key={r.id} className="flex items-start gap-2 text-xs">
                <span className="font-mono text-muted-foreground shrink-0 w-5 text-right">{i + 1}.</span>
                <span className="flex-1 text-foreground">
                  {r.scope && <span className="text-muted-foreground mr-1">[{r.scope}]</span>}
                  {text(r)}
                </span>
                <span className="shrink-0 px-1.5 py-0.5 rounded border border-border text-[10px] text-muted-foreground font-mono">
                  {s.support(r.support)}
                </span>
              </li>
            ))}
          </ol>
          {rules.length > PREVIEW && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              {showAll ? <ChevronUp className="h-3 w-3" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
              {showAll ? s.showLess : s.showAll(rules.length)}
            </button>
          )}
          <p className="text-[10px] text-muted-foreground">{s.note}</p>
        </>
      )}
    </div>
  );
};

export default LearnedRules;
