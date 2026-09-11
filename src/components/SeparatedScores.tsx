import { Split } from "lucide-react";
import { useLocale } from "@/lib/i18n";
import { formatJst } from "@/lib/candleTime";
import {
  separatedBasis,
  separatedHeadline,
  separatedUndecided,
  type SeparatedScore,
  type SeparatedScores as SeparatedScoresData,
} from "@/lib/outcomeStats";

interface Props {
  // public.separated_scores(), already read into shape. Null when the RPC
  // could not be reached or answered with something else.
  scores: SeparatedScoresData | null;
}

// DIRECTION, TIMING and PLACEMENT, kept apart.
//
// The panel draws public.separated_scores() and nothing else. There is
// deliberately no client-side fallback that recomputes the three from the rows
// on screen: the record's win rate has one because tally() and
// performance_stats agree on one definition, and there is no second
// implementation of these three to agree with. No answer is rendered as "no
// answer", which is the honest shape of "this server cannot tell me".
//
// SHAPE RULES, taken from the honest-metrics panel (#25) and kept identical:
//   * no rate is ever printed without its own n beside it;
//   * every rate carries its Wilson 95% interval;
//   * rows that could NOT be scored are shown, not dropped (#38);
//   * a thin n is labelled as thin rather than withheld — hiding the number
//     would hide how little there is.
//
// AND ONE MORE, which is why this panel is not just three numbers: the three
// scores have three DIFFERENT denominators (measured 2026-09-10: 33, 26 and
// 24 over the same 36 graded trades), so they are laid out as three rows each
// carrying its own n rather than as one row of three percentages.
const SeparatedScores = ({ scores }: Props) => {
  const { t } = useLocale();
  const s = t.scores;

  // No object at all: the RPC failed, or this client is deployed ahead of the
  // migration. Say so instead of drawing zeroes.
  if (!scores) {
    return (
      <div className="glass rounded-xl border border-border p-4 space-y-2" data-testid="separated-scores">
        <div className="flex items-center gap-2 text-primary">
          <Split className="h-4 w-4" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{s.title}</h3>
        </div>
        <p className="text-[11px] text-muted-foreground" data-testid="separated-none">{s.none}</p>
      </div>
    );
  }

  const headline = separatedHeadline(scores);
  const block = headline?.block ?? null;
  const pop = scores.population;
  const th = scores.thresholds;
  // What the record actually is, measured from the population object rather
  // than asserted from a sentence that goes stale (see s.narrow).
  const shape = separatedBasis(pop);
  const undecided = separatedUndecided(block);
  const span = pop.firstCallAt && pop.lastCallAt
    ? s.span(formatJst(pop.firstCallAt, t.intlLocale), formatJst(pop.lastCallAt, t.intlLocale))
    : null;

  // What the numbers rest on, ABOVE the numbers. One pair, one direction, two
  // weeks: a reader who sees three confident percentages first and the basis
  // afterwards has already formed the belief the basis was supposed to temper.
  const basis = (
    <div className="space-y-1" data-testid="separated-basis">
      <p className="text-[10px] text-muted-foreground">
        {s.basis(pop.calls, pop.pairs.length > 0 ? pop.pairs.join(" / ") : s.noPair)}
        {span ? ` · ${span}` : ""}
      </p>
      {pop.signals.length > 0 && (
        <p className="text-[10px] text-muted-foreground font-mono">
          {s.basisSignals(pop.signals.map((x) => `${x.signal} ${x.count}`).join(" · "))}
        </p>
      )}
      <p className="text-[10px] text-muted-foreground font-mono">
        {s.basisTrades(pop.trades, pop.diagnosedTrades, pop.undiagnosedTrades)}
        {/* The trades the scores were REALLY taken over. Without this the line
            above states one population and the denominators below belong to
            another, and the difference — rows on an older entry contract —
            leaves the screen with nothing accounting for it. */}
        {block ? ` · ${s.basisGraded(block.gradedTrades)}` : ""}
      </p>
      {scores.otherContractRows > 0 && (
        <p className="text-[10px] text-warning" data-testid="separated-other-contract">
          {s.otherContract(scores.otherContractRows, scores.otherContracts.join(" / "))}
        </p>
      )}
      <p className="text-[10px] text-warning" data-testid="separated-narrow">
        {s.narrow(shape.pairs, shape.days, shape.topSignal, shape.topShare)}
      </p>
      {undecided && (
        <p className="text-[10px] text-warning" data-testid="separated-undecided">{s.undecided}</p>
      )}
      {headline?.contract && (
        <p className="text-[10px] text-warning" data-testid="separated-contract">
          {s.contractNote(headline.contract)}
        </p>
      )}
    </div>
  );

  // One score. The rate, then its own denominator, then its own interval, then
  // its own unscored count — in that order every time, so the eye cannot carry
  // a denominator from one row to the next.
  const row = (
    id: string,
    label: string,
    hint: string,
    score: SeparatedScore,
    extra?: string,
  ) => (
    <div className="rounded-lg border border-border/60 bg-background/30 p-2 space-y-1" data-testid={`score-${id}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-foreground">{label}</span>
        <span
          className={`ml-auto font-mono font-bold text-sm ${score.rate === null ? "text-muted-foreground" : "text-foreground"}`}
          data-testid={`score-${id}-rate`}
        >
          {score.rate === null ? "—" : `${score.rate}%`}
        </span>
        {/* The n, always, and never further away than this. */}
        <span className="font-mono text-[10px] text-muted-foreground" data-testid={`score-${id}-n`}>
          {s.n(score.hits, score.n)}
        </span>
      </div>
      <p className="text-[10px] font-mono text-muted-foreground">
        {score.ci ? s.ci(score.ci[0], score.ci[1]) : s.noRate}
        {score.unscored > 0 ? ` · ${s.unscored(score.unscored)}` : ""}
        {extra ? ` · ${extra}` : ""}
      </p>
      {score.n > 0 && score.belowMinN && (
        <p className="text-[10px] text-warning" data-testid={`score-${id}-thin`}>{s.thin}</p>
      )}
      {/* What this score may NOT claim, on the score itself. A caveat that
          lives only in the doc is a caveat nobody reads. */}
      <p className="text-[10px] text-muted-foreground leading-relaxed">{hint}</p>
    </div>
  );

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3" data-testid="separated-scores">
      <div className="flex items-center gap-2 text-primary">
        <Split className="h-4 w-4" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{s.title}</h3>
        {scores.definitionVersion !== null && (
          <span className="text-[10px] text-muted-foreground font-mono ml-auto">
            {s.definition(scores.definitionVersion)}
          </span>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">{s.subtitle}</p>

      {basis}

      {!block || block.gradedTrades === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="separated-empty">{s.empty}</p>
      ) : (
        <>
          {/* Said once, before the three rows, and again after them. The one
              misreading this panel invites is "these three add up". */}
          <p className="text-[10px] text-warning" data-testid="separated-denominators">{s.denominators}</p>

          {row(
            "direction",
            s.direction.label,
            s.direction.hint(th.directionDeadR),
            block.direction,
            [
              block.direction.ranPastStop > 0 ? s.ranPast(block.direction.ranPastStop) : "",
              block.direction.neverCame > 0 ? s.neverCame(block.direction.neverCame) : "",
              // Zero today. Rendered the moment it is not, because those rows
              // sit in the denominator and can only ever be misses.
              block.direction.wrongPartial > 0 ? s.wrongPartial(block.direction.wrongPartial) : "",
            ].filter(Boolean).join(" · ") || undefined,
          )}

          {row("timing", s.timing.label, s.timing.hint(th.earlyAdverseR), block.timing)}

          {/* The deeper excursion, on its own line with its own n. Merging it
              into the row above would put two windows and two denominators
              under one percentage. */}
          <div className="rounded-lg border border-border/60 bg-background/30 p-2 space-y-1" data-testid="score-deep-mae">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] text-foreground">{s.deepMae.label}</span>
              <span className="ml-auto font-mono font-bold text-sm text-foreground">
                {block.timing.deepMae.rate === null ? "—" : `${block.timing.deepMae.rate}%`}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground" data-testid="score-deep-mae-n">
                {s.n(block.timing.deepMae.hits, block.timing.deepMae.n)}
              </span>
            </div>
            <p className="text-[10px] font-mono text-muted-foreground">
              {block.timing.deepMae.ci ? s.ci(block.timing.deepMae.ci[0], block.timing.deepMae.ci[1]) : s.noRate}
              {block.timing.deepMae.unscored > 0 ? ` · ${s.unscored(block.timing.deepMae.unscored)}` : ""}
            </p>
            {/* The same thin-n rule as every other row. This block used to be
                the one that never got it, which is exactly the row where a
                reader is least equipped to notice. */}
            {block.timing.deepMae.n > 0 && block.timing.deepMae.belowMinN && (
              <p className="text-[10px] text-warning" data-testid="score-deep-mae-thin">{s.thin}</p>
            )}
            <p className="text-[10px] text-muted-foreground leading-relaxed">{s.deepMae.hint(th.luckyMaeR)}</p>
          </div>

          {row(
            "placement",
            s.placement.label,
            s.placement.hint,
            block.placement,
            [
              // How much of this rate is "did not lose" rather than a stop
              // anything examined. On today's data that is 10 of 13 hits, and
              // it belongs beside the rate, not in a comment.
              block.placement.stopUntested > 0 ? s.stopUntested(block.placement.stopUntested) : "",
              block.placement.stopBad > 0 ? s.stopBad(block.placement.stopBad) : "",
              block.placement.targetBad > 0 ? s.targetBad(block.placement.targetBad) : "",
            ].filter(Boolean).join(" · ") || undefined,
          )}

          <p className="text-[10px] text-warning leading-relaxed" data-testid="separated-caveat">
            {s.notADecomposition}
          </p>

          {/* The cause taxonomy, which was already separated on the lessons
              table. Read, not re-derived. */}
          {block.causes.total > 0 && (
            <div className="space-y-1" data-testid="separated-causes">
              <p className="text-[10px] text-muted-foreground">
                <span className="font-semibold">{s.causesLabel}: </span>
                {s.causeSplit(
                  block.causes.direction,
                  block.causes.timing,
                  block.causes.placement,
                  block.causes.neither,
                )}
              </p>
              {/* Its own n, and how much of it is WAITs — which are in this
                  histogram and in none of the three scores above. Three rates
                  over 36 trades and a count over 65 lessons under one heading,
                  with no denominator on the second, is the error this whole
                  panel exists to refuse. */}
              <p className="text-[10px] text-warning" data-testid="separated-causes-n">
                {s.causesTotal(block.causes.total, block.causes.waits)}
              </p>
              <p className="text-[10px] text-muted-foreground">{s.causeStraddle}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default SeparatedScores;
