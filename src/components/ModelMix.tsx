import { Fingerprint } from "lucide-react";
import { useLocale } from "@/lib/i18n";
import { settledModels, type ModelMix, type ModelMixEntry } from "@/lib/outcomeStats";

interface Props {
  // public.model_mix(), already read into shape. Null when the RPC could not
  // be reached or answered with something else.
  mix: ModelMix | null;
}

// WHO WROTE THE RECORD, BESIDE THE RECORD.
//
// The win rate next to this panel is keyed on the entry contract and the
// rulebook version. It is NOT keyed on which analyst answered, so the day a
// second one starts answering, two track records pool into one number that
// belongs to neither — and no column left on the row can pull them apart
// again. This panel's only job is to make that visible in the same glance as
// the number it would otherwise corrupt.
//
// FOUR STATES, AND THE SECOND ONE IS THE POINT:
//   * one analyst, nothing unrecorded — a single line of information, in the
//     ordinary colour. This is the normal state and reading it as an alarm
//     would teach the reader to skip the line on the day it is one.
//   * pooled — the record is a blend. Said first, said plainly, and followed
//     by the per-model settled counts so the split is visible rather than
//     merely asserted.
//   * rows with no model recorded — reported as MISSING, never as a default.
//     Those rows predate the column and can never be stamped, so guessing at
//     them would invent a fact out of a gap. The count is rendered in its own
//     sentence and never as a row in the model list, because a number sitting
//     in that list is read as an analyst. And when any of those rows SETTLED,
//     the one-analyst headline is withdrawn: a win rate taken over trades
//     nobody is named for is not that model's, however few they are.
//   * nothing readable — an object came back and nothing could be read out of
//     it. Drawn as "could not be read", never as "nothing has settled yet".
//     The normalizer keeps unreadable apart from zero all the way down; this
//     is the last place that distinction can be thrown away.
//
// One number is computed here and it is named: `blended`, below. Every other
// count is public.model_mix()'s answer drawn as it arrived, for the same
// reason the panels beside it draw the server's numbers: two implementations
// of one number is how one number becomes two.
const ModelMix = ({ mix }: Props) => {
  const { t } = useLocale();
  const m = t.modelMix;

  // No object at all: the RPC failed, or this client is deployed ahead of the
  // migration. Nothing is drawn — an instrument with no reading is not a
  // reading of "one analyst".
  if (!mix) return null;

  const settled = settledModels(mix);
  const unrecorded = mix.unrecorded !== null && mix.unrecorded > 0 ? mix.unrecorded : null;
  const unrecordedSettled =
    mix.unrecordedSettled !== null && mix.unrecordedSettled > 0 ? mix.unrecordedSettled : null;
  // The single-analyst line needs BOTH a name and a settled count; anything
  // less cannot state who wrote the record, and half of that claim is worse
  // than none of it.
  const named = !mix.pooled && settled.length === 1 ? settled[0] : null;
  // "alone" is a claim about the whole settled population, not about the named
  // model's own count. One settled trade with no recorded author and the claim
  // is false — so the exclusive line is reserved for the case where there is
  // provably nothing else in the denominator.
  const one = named !== null && unrecordedSettled === null ? named : null;
  const namedPlusGap = named !== null && unrecordedSettled !== null ? named : null;
  // How many analysts are in the blend. `pooled` is true only when at least
  // two have settled trades, so the larger of the two readings is taken and
  // never less than two: "a blend of 1" would contradict the very flag that
  // put the sentence on screen. This is the ONE computed number on the panel,
  // and it can exceed the rows drawn below when the server reported a tally
  // it did not itemise.
  const blended = Math.max(settled.length, mix.modelsWithSettled ?? 0, 2);
  // Nothing has been analysed at all, as distinct from "analysed but nothing
  // has settled", which is distinct again from "nothing could be read". All
  // three are drawn, and none of them share a sentence.
  const noCalls = mix.calls === 0 && mix.models.length === 0;
  const unreadable = mix.calls === null && mix.models.length === 0 && unrecorded === null &&
    unrecordedSettled === null;

  // A model's share of the record. The settled count leads because that is the
  // number feeding the win rate; the call count is context and is dropped
  // rather than invented when the payload did not carry it.
  const share = (e: ModelMixEntry): string =>
    e.settled === null
      ? m.unknown
      : e.calls === null
        ? m.rowSettledOnly(e.settled)
        : m.row(e.settled, e.calls);

  return (
    <div className="glass rounded-xl border border-border p-3 space-y-2" data-testid="model-mix">
      <div className="flex items-center gap-2 text-primary">
        <Fingerprint className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <h3 className="text-xs font-semibold">{m.title}</h3>
        {mix.contract && (
          <span className="text-[10px] text-muted-foreground font-mono ml-auto">
            {m.contract(mix.contract)}
          </span>
        )}
      </div>

      {mix.pooled ? (
        <>
          <p className="text-[11px] font-semibold text-warning leading-relaxed" data-testid="model-mix-pooled">
            {m.pooled(blended)}
          </p>
          {/* Promise the split only when the split will actually draw. */}
          <p className="text-[10px] text-muted-foreground leading-relaxed" data-testid="model-mix-pooled-note">
            {mix.models.length > 0 ? m.pooledNote : m.pooledNoSplit}
          </p>
        </>
      ) : one ? (
        <p className="text-[11px] text-foreground leading-relaxed" data-testid="model-mix-single">
          {m.single(one.model, one.settled as number)}
        </p>
      ) : namedPlusGap ? (
        <p className="text-[11px] font-semibold text-warning leading-relaxed" data-testid="model-mix-single-gap">
          {m.singlePlusGap(namedPlusGap.model, namedPlusGap.settled as number, unrecordedSettled as number)}
        </p>
      ) : unreadable ? (
        <p className="text-[11px] text-muted-foreground leading-relaxed" data-testid="model-mix-unreadable">
          {m.notReadable}
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground leading-relaxed" data-testid="model-mix-none">
          {noCalls ? m.noCalls : m.none}
        </p>
      )}

      {/* The split, drawn only when there is one. On a single-analyst record
          the sentence above already names the model and its settled count, and
          a one-row table under it would be the same fact twice. */}
      {mix.pooled && mix.models.length > 0 && (
        <div className="space-y-1" data-testid="model-mix-models">
          {mix.models.map((e, i) => (
            <div
              key={`${i}-${e.model}`}
              className="flex items-baseline gap-2 rounded-lg border border-border/60 bg-background/30 px-2 py-1"
              data-testid={`model-mix-row-${e.model}`}
            >
              {/* The identifier as the server stored it. Data, not a label
                  this app is free to prettify. */}
              <span className="font-mono text-[11px] text-foreground break-all">{e.model}</span>
              <span
                className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
                data-testid={`model-mix-row-${e.model}-n`}
              >
                {share(e)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Rows nobody stamped. Its own sentence, outside the model list, and
          phrased as an absence: these rows cannot be attributed to anyone now
          or ever, and a count that drifts into the list above becomes an
          analyst nobody ran. */}
      {(unrecorded !== null || unrecordedSettled !== null) && (
        <p className="text-[10px] text-warning leading-relaxed" data-testid="model-mix-unrecorded">
          {unrecorded !== null
            ? `${m.unrecorded(unrecorded)}${
                unrecordedSettled !== null ? ` ${m.unrecordedSettled(unrecordedSettled)}` : ""
              }`
            : m.unrecordedSettledOnly(unrecordedSettled as number)}{" "}
          {m.unrecordedNote}
        </p>
      )}

      {/* Which population all of the above was taken over. */}
      {mix.calls !== null && mix.calls > 0 && (
        <p className="text-[10px] font-mono text-muted-foreground" data-testid="model-mix-scope">
          {m.scope(mix.calls)}
        </p>
      )}
    </div>
  );
};

export default ModelMix;
