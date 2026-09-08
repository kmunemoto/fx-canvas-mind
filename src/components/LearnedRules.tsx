import { useState } from "react";
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react";
import type { Rulebook } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import { formatJst } from "@/lib/candleTime";
import { CURRENT_CONTRACT } from "@/lib/outcomeStats";
import Disclosure from "./Disclosure";

interface Props {
  rulebook: Rulebook | null;
}

const PREVIEW = 5;
// A rule with this much evidence or less is shown as under review, as it is
// in the prompt (see supabase/functions/analyze/rules.ts)
const VERIFYING = 2;

// The rules the analyzer has learned from its own record: written by the
// post-mortem of every settled plan, consolidated, and put in front of the
// model on every new analysis. Shown so the learning is visible, not
// claimed.
//
// Two things this panel must not misrepresent. The record behind a rule is
// every account's, not the reader's — the evidence count beside a rule counts
// plans this reader will not find in their own history. And a rule written
// for a previous entry contract is still stored but is NOT in the prompt, so
// showing it in the same list as the live ones would claim an influence it
// does not have.
const LearnedRules = ({ rulebook }: Props) => {
  const { t, locale } = useLocale();
  const s = t.rules;
  const [showAll, setShowAll] = useState(false);

  const all = Array.isArray(rulebook?.rules) ? rulebook.rules : [];
  // Same test as the prompt's: analyze/rules.ts `inForce`
  const rules = all.filter((r) => (r.contract ?? null) === CURRENT_CONTRACT);
  const heldBack = all.length - rules.length;
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

      <p className="text-[10px] text-muted-foreground">{s.sharedNote}</p>

      {heldBack > 0 && (
        <p className="text-[10px] text-warning" data-testid="rules-held-back">
          {s.heldBack(heldBack)}
        </p>
      )}

      {rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">{heldBack > 0 ? s.noneInForce : s.empty}</p>
      ) : (
        <>
          <ol className="space-y-1.5">
            {visible.map((r, i) => (
              <li key={r.id} className="flex items-start gap-2 text-xs">
                <span className="font-mono text-muted-foreground shrink-0 w-5 text-right">{i + 1}.</span>
                {/* The badges go UNDER the text, never beside it. As a flex
                    row with two shrink-0 badges the rule text was squeezed to
                    a third of a 390px screen — a few characters per line — on
                    the owner's phone. */}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-foreground">
                    {r.kind && (
                      <span className={`mr-1 px-1 py-px rounded text-[10px] font-semibold ${
                        r.kind === "constraint" ? "bg-warning/15 text-warning" : "bg-primary/10 text-primary"
                      }`}>
                        {s.kind[r.kind]}
                      </span>
                    )}
                    {r.scope && <span className="text-muted-foreground mr-1">[{r.scope}]</span>}
                    {text(r)}
                  </p>
                  <div className="flex flex-wrap gap-1" data-testid="rule-badges">
                    {r.evidence_contracts?.some((c) => c !== CURRENT_CONTRACT) && (
                      <span
                        className="px-1.5 py-0.5 rounded border border-warning/30 text-warning text-[10px]"
                        title={s.priorEvidenceNote}
                        data-testid="prior-evidence"
                      >
                        {s.priorEvidence}
                      </span>
                    )}
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${
                        r.support <= VERIFYING ? "border-warning/40 text-warning" : "border-border text-muted-foreground"
                      }`}
                      title={s.supportNote}
                    >
                      {r.support <= VERIFYING ? s.verifyingSupport(r.support) : s.support(r.support)}
                    </span>
                  </div>
                </div>
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
          {/* The editor's summary is stored prose written by the model for
              itself: it names internal identifiers and can assert something
              the current version no longer holds. It was the first paragraph
              under the rules. It is kept verbatim — it is stored data — but
              behind a fold, with a caption saying whose voice it is. */}
          {summary && (
            <Disclosure title={s.editorNote} testId="editor-note">
              <p className="text-[10px] text-muted-foreground mb-1">{s.editorNoteCaption}</p>
              <p className="text-xs text-muted-foreground whitespace-pre-wrap">{summary}</p>
            </Disclosure>
          )}
          <p className="text-[10px] text-muted-foreground">{s.note}</p>
          <p className="text-[10px] text-muted-foreground">{s.supportNote} {s.cadence}</p>
        </>
      )}
    </div>
  );
};

export default LearnedRules;
