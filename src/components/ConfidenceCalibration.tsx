import { Ruler } from "lucide-react";
import { useLocale } from "@/lib/i18n";
import {
  aucEstablishesNothing,
  calibrationRoom,
  CONFIDENCE_MIN_N,
  type CalibrationBandRow,
  type CalibrationValueRow,
  type ConfidenceCalibration,
} from "@/lib/outcomeStats";

interface Props {
  // public.confidence_calibration(), already read into shape. Null when the
  // RPC could not be reached or answered with something else.
  calibration: ConfidenceCalibration | null;
}

// WHETHER CONFIDENCE COULD BE CORRECTED AT ALL.
//
// #68 asks for confidence to be corrected against the record. This panel is
// what runs before that: a correction is a MAPPING from the stated number to
// the observed win rate, and a mapping needs the stated number to move. It
// applies no correction and never will — every number here is
// public.confidence_calibration()'s answer drawn as it arrived.
//
// FOUR THINGS, IN THIS ORDER, AND NONE OF THEM OPTIONAL:
//   1. the range the number actually takes. The gauge beside every result
//      draws confidence/100 of a ring, which implies a 0..100 scale; the
//      record has used a narrow slice of it and that has to be said first,
//      before any percentage is on screen to be believed.
//   2. the per-value table, each row carrying its own n. A rate over one
//      settled trade printed the same size as a rate over a hundred is the
//      single most misleading thing this panel could do, so the n is in its
//      own column, with a bar, and again in words on any thin row.
//   3. the discrimination number as a SENTENCE about what it means, with its
//      interval, its tie share, that the interval is an approximation, and
//      that 0.5 lies inside it so nothing is established in either direction.
//   4. the gate: what is required, what is here, that nothing is applied, and
//      that the threshold was written after the data was seen.
//
// Every number, every bound and every threshold of the MEASUREMENT comes from
// the payload, because a sentence stating a measurement as a constant outlives
// its data and then contradicts the table under it (#83). The one constant
// here is the gauge's own 0..100 scale, which is a fact about
// ConfidenceGauge.tsx and is not reported by this RPC.
const ConfidenceCalibration = ({ calibration }: Props) => {
  const { t } = useLocale();
  const c = t.calibration;

  // No object at all: the RPC failed, or this client is deployed ahead of the
  // migration. Nothing is drawn — an instrument with no reading is not a
  // reading of zero.
  if (!calibration) return null;

  const { span, byValue, byBand, discrimination: d, gate } = calibration;
  const traded = span.traded;
  const room = calibrationRoom(traded);
  // The floor a band is judged against. The server's own, so the screen and
  // the gate cannot disagree about what "thin" means — falling back to the
  // shared constant only when the payload carried no gate, because a missing
  // gate must not silently delete every thin warning on the table.
  const minN = gate.minNPerBand ?? CONFIDENCE_MIN_N;

  // A number, or the placeholder. Never 0: a field that could not be read is
  // not a measurement of zero.
  const show = (v: number | null): string => (v === null ? c.unknown : String(v));
  const readable = (...vs: Array<number | null>): boolean => vs.every((v) => v !== null);

  // The widest settled count in ONE table, so its bars are to that table's own
  // scale. The values and the bands count the same settled trades in different
  // groupings, and a bar drawn against the other table's widest row would show
  // a band as wider than the whole it came from.
  const widest = (rs: CalibrationValueRow[]): number =>
    rs.reduce<number>((m, r) => Math.max(m, r.settled ?? 0), 0);
  const valueScale = widest(byValue);
  const bandScale = widest(byBand);

  // One row of either table. The n is a column of its own and a bar, because
  // the percentage next to it is the thing a reader will otherwise carry away.
  const row = (
    id: string,
    label: string,
    r: CalibrationValueRow,
    thin: string | null,
    scale: number,
  ) => (
    <div
      key={id}
      className="rounded-lg border border-border/60 bg-background/30 p-2 space-y-1"
      data-testid={id}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] font-semibold text-foreground w-12 shrink-0">{label}</span>
        {/* The denominator, prominent and never further away than this. The
            win/loss split only when BOTH halves were readable: a "0 wins,
            0 losses" assembled out of two fields the payload never sent is a
            claim about the record, not a gap in it. */}
        <span className="font-mono text-[11px] text-foreground" data-testid={`${id}-n`}>
          {r.settled === null
            ? c.unknown
            : r.wins !== null && r.losses !== null
              ? c.valueN(r.settled, r.wins, r.losses)
              : String(r.settled)}
        </span>
        <span
          className={`ml-auto font-mono text-sm font-bold ${r.winRate === null ? "text-muted-foreground" : "text-foreground"}`}
          data-testid={`${id}-rate`}
        >
          {/* A rate whose denominator could not be read is withheld, not
              printed bare. "63%" with no n beside it is exactly the reading
              this panel exists to prevent. */}
          {r.winRate === null || r.wins === null || r.settled === null
            ? c.unknown
            : c.valueRate(r.winRate, r.wins, r.settled)}
        </span>
      </div>
      {/* How much of the table this row actually is. Six rows of percentages
          all look equally solid until the counts are drawn to scale. */}
      {r.settled !== null && scale > 0 && (
        <div className="h-1 rounded-full bg-border/60 overflow-hidden" aria-hidden="true">
          <div
            className="h-full bg-primary/60"
            style={{ width: `${Math.max(2, Math.min(100, Math.round((r.settled * 100) / scale)))}%` }}
          />
        </div>
      )}
      <p className="text-[10px] font-mono text-muted-foreground">
        {r.ci ? c.ciPercent(r.ci[0], r.ci[1]) : c.unknown}
      </p>
      {thin && (
        <p className="text-[10px] text-warning" data-testid={`${id}-thin`}>{thin}</p>
      )}
    </div>
  );

  const bandRow = (b: CalibrationBandRow, i: number) =>
    row(
      `calibration-band-${b.bandLo ?? i}`,
      readable(b.bandLo, b.bandHi) ? c.bandLabel(b.bandLo as number, b.bandHi as number) : c.unknown,
      b,
      // The band's own thin flag, which is what the gate is counting.
      b.belowMinN && minN !== null ? c.bandThin(minN) : null,
      bandScale,
    );

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3" data-testid="confidence-calibration">
      <div className="flex items-center gap-2 text-primary">
        <Ruler className="h-4 w-4" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{c.title}</h3>
        {calibration.contract && (
          <span className="text-[10px] text-muted-foreground font-mono ml-auto">
            {c.contract(calibration.contract)}
          </span>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">{c.subtitle}</p>

      {/* 1. THE RANGE. First, and before any percentage is on screen: every
          rate below is a rate over a number that barely moves. */}
      <div className="space-y-1" data-testid="calibration-range">
        <p className="text-[11px] font-semibold text-foreground">{c.rangeTitle}</p>
        {readable(traded.lo, traded.hi, traded.n) ? (
          <p className="text-[11px] text-warning leading-relaxed" data-testid="calibration-traded">
            {c.tradedRange(traded.lo as number, traded.hi as number, traded.n as number)}
            {readable(traded.distinctValues) && room !== null
              ? ` ${c.tradedShape(traded.distinctValues as number, room)}`
              : ""}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground" data-testid="calibration-traded">{c.rangeUnknown}</p>
        )}
        {readable(span.all.lo, span.all.hi, span.all.n, span.all.distinctValues) && (
          <p className="text-[10px] font-mono text-muted-foreground" data-testid="calibration-span-all">
            {c.allRange(
              span.all.lo as number,
              span.all.hi as number,
              span.all.n as number,
              span.all.distinctValues as number,
            )}
          </p>
        )}
        {readable(span.wait.lo, span.wait.hi, span.wait.n, span.wait.distinctValues) && (
          <p className="text-[10px] font-mono text-muted-foreground" data-testid="calibration-span-wait">
            {c.waitRange(
              span.wait.lo as number,
              span.wait.hi as number,
              span.wait.n as number,
              span.wait.distinctValues as number,
            )}
          </p>
        )}
        {/* The gauge implies a scale this record has never used. Said here
            rather than on the gauge, which is not this change's to alter. */}
        <p className="text-[10px] text-muted-foreground leading-relaxed" data-testid="calibration-gauge-note">
          {c.gaugeNote}
        </p>
        {room !== null && (
          <p className="text-[10px] text-muted-foreground leading-relaxed" data-testid="calibration-room">
            {c.roomFact(room)}
          </p>
        )}
        {/* The verdict, only when the span provably cannot host the bands the
            gate asks for. Rendering it unconditionally would print "no mapping
            to fit" over a table that shows a wide, well-populated span. */}
        {room !== null && gate.needBands !== null && room < gate.needBands * 5 && (
          <p className="text-[10px] text-warning leading-relaxed" data-testid="calibration-room-narrow">
            {c.roomNarrow(gate.needBands * 5)}
          </p>
        )}
      </div>

      {/* 2. EVERY VALUE THE MODEL ACTUALLY STATED, each with its own n. */}
      <div className="space-y-1" data-testid="calibration-values">
        <p className="text-[11px] font-semibold text-foreground">{c.valuesTitle}</p>
        <p className="text-[10px] text-muted-foreground leading-relaxed">{c.valuesNote}</p>
        <div className="flex items-baseline gap-2 px-2 text-[10px] text-muted-foreground">
          <span className="w-12 shrink-0">{c.colConfidence}</span>
          <span>{c.colN}</span>
          <span className="ml-auto">{c.colRate}</span>
        </div>
        {byValue.length === 0 ? (
          <p className="text-[11px] text-muted-foreground" data-testid="calibration-no-values">{c.noValues}</p>
        ) : (
          byValue.map((r, i) =>
            row(
              `calibration-value-${r.confidence ?? i}`,
              show(r.confidence),
              r,
              // Thin against the SAME floor the gate uses. On today's data
              // that is every row, which is the finding — not a reason to
              // stop saying it.
              r.settled !== null && minN !== null && r.settled < minN ? c.valueThin(r.settled) : null,
              valueScale,
            ),
          )
        )}
        {byBand.length > 0 && (
          <div className="space-y-1 pt-1" data-testid="calibration-bands">
            <p className="text-[10px] text-muted-foreground">{c.bandsTitle}</p>
            {byBand.map(bandRow)}
          </div>
        )}
      </div>

      {/* 3. DISCRIMINATION, as a sentence about what it means. The number on
          its own is unreadable, and read wrongly it is worse than absent. */}
      <div className="space-y-1" data-testid="calibration-discrimination">
        <p className="text-[11px] font-semibold text-foreground">{c.discTitle}</p>
        {d.auc === null ? (
          <p className="text-[11px] text-muted-foreground" data-testid="calibration-disc-none">{c.discNone}</p>
        ) : (
          <>
            <p className="text-[11px] text-foreground leading-relaxed" data-testid="calibration-disc-meaning">
              {c.discMeaning(d.auc)}
            </p>
            <p className="text-[10px] font-mono text-muted-foreground" data-testid="calibration-disc-ci">
              {d.ci ? c.discCi(d.ci[0], d.ci[1]) : c.unknown}
              {d.tieShare !== null ? ` · ${c.discTies(d.tieShare)}` : ""}
            </p>
            {readable(d.totalPairs, d.nWin, d.nLoss) && (
              <p className="text-[10px] font-mono text-muted-foreground" data-testid="calibration-disc-pairs">
                {c.discPairs(d.totalPairs as number, d.nWin as number, d.nLoss as number)}
              </p>
            )}
            {/* The approximation travels with the interval. On a line of its
                own somewhere else it gets quoted without the caveat. */}
            {d.ciApproximate && (
              <p className="text-[10px] text-warning leading-relaxed" data-testid="calibration-disc-approximate">
                {c.discApproximate}
              </p>
            )}
            {/* Three cases, not two. With no interval read, saying "the
                interval contains 0.5" would describe a measurement that is
                not there — which is the same class of error as reporting an
                unreadable number as 0. */}
            <p
              className={`text-[10px] leading-relaxed ${aucEstablishesNothing(d) ? "text-warning" : "text-muted-foreground"}`}
              data-testid={
                d.ci === null
                  ? "calibration-disc-no-interval"
                  : aucEstablishesNothing(d)
                    ? "calibration-disc-nothing"
                    : "calibration-disc-established"
              }
            >
              {d.ci === null ? c.discNoInterval : aucEstablishesNothing(d) ? c.discNothing : c.discEstablished}
            </p>
          </>
        )}
      </div>

      {/* 4. THE GATE. What is required, what is here, that nothing is applied,
          and when the threshold was written. */}
      <div className="space-y-1" data-testid="calibration-gate">
        <p className="text-[11px] font-semibold text-foreground">{c.gateTitle}</p>
        <p
          className={`text-[11px] leading-relaxed ${gate.applies ? "text-warning" : "text-foreground"}`}
          data-testid="calibration-gate-applies"
        >
          {gate.applies ? c.gateApplied : c.gateNotApplied}
        </p>
        {readable(gate.needBands, gate.minNPerBand, gate.needSettled) && (
          <p className="text-[10px] text-muted-foreground leading-relaxed" data-testid="calibration-gate-need">
            {c.gateNeed(gate.needBands as number, gate.minNPerBand as number, gate.needSettled as number)}
          </p>
        )}
        {readable(gate.haveBands, gate.haveSettled) && (
          <p className="text-[10px] font-mono text-muted-foreground" data-testid="calibration-gate-have">
            {c.gateHave(gate.haveBands as number, gate.haveSettled as number)}
          </p>
        )}
        <p
          className={`text-[10px] ${gate.met ? "text-muted-foreground" : "text-warning"}`}
          data-testid="calibration-gate-met"
        >
          {gate.met ? c.gateMet : c.gateUnmet}
        </p>
        {/* Not a preregistration, and never to be filed beside one. */}
        <p
          className={`text-[10px] leading-relaxed ${gate.preregistered ? "text-muted-foreground" : "text-warning"}`}
          data-testid="calibration-gate-preregistration"
        >
          {gate.preregistered ? c.gatePreregistered : c.gateAfterTheFact}
        </p>
      </div>
    </div>
  );
};

export default ConfidenceCalibration;
