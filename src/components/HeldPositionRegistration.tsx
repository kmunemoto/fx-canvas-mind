import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import { normalizePosition, registerErrorOf } from "@/lib/positions";
import { formatJst } from "@/lib/candleTime";
import type { Position } from "@/lib/types";

// "I already hold this." (#92)
//
// The other registration path — EntryRegistration — means "I entered on THIS
// plan": it takes only a fill price and time, and the server copies the plan's
// stop and targets onto the row. That is why it refuses a fill from before the
// plan was written: attaching the plan's levels to a position taken on some
// other basis would record a stop the reader never placed, and then divide
// their open P/L by a risk they never took.
//
// A position the reader already held needs the opposite shape: THEY supply the
// levels, and the row points at no plan at all. Different meaning, different
// RPC (register_held_position), different component. Folding a branch into the
// other form would leave one screen where it is no longer readable which set
// of levels a row was registered with.

interface Props {
  // Seeds the form; the reader can change both.
  defaultPair: string;
  defaultInterval: string;
  onRegistered: (position: Position) => void;
}

const inputCls = "w-full rounded-md border border-border bg-background px-2 py-1 text-sm font-mono";
const INTERVALS = ["1min", "15min", "1h", "4h", "1day"] as const;

// A datetime-local value carries no zone and is read in the BROWSER's; every
// time this app shows is JST. Rather than explain that, show what will be
// recorded. Same reasoning as EntryRegistration's TimePreview.
const TimePreview = ({ value }: { value: string }) => {
  const { t } = useLocale();
  if (value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return (
    <span className="block text-[10px] text-muted-foreground" data-testid="own-time-preview">
      {t.position.timePreview(formatJst(ms, t.intlLocale))}
    </span>
  );
};

export const HeldPositionRegistration = ({ defaultPair, defaultInterval, onRegistered }: Props) => {
  const { t } = useLocale();
  const p = t.position;
  const o = p.own;
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pair, setPair] = useState(defaultPair);
  const [interval, setInterval] = useState(defaultInterval);
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");
  const [price, setPrice] = useState("");
  const [stop, setStop] = useState("");
  const [tp1, setTp1] = useState("");
  const [tp2, setTp2] = useState("");
  const [tp3, setTp3] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A blank optional field is ABSENT, not zero. Returning undefined keeps it
  // out of the params object entirely, so the server applies its own default
  // rather than being told the reader chose nothing.
  const optional = (v: string): number | null | undefined => {
    if (v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const required = (v: string) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const entry = required(price);
    const sl = required(stop);
    const t1 = required(tp1);
    if (entry === null) return setError(p.registerErrors.entry_price_must_be_positive);
    if (sl === null) return setError(p.registerErrors.stop_loss_must_be_positive);
    if (t1 === null) return setError(p.registerErrors.take_profit_1_must_be_positive);

    // Name the field that is actually wrong. This reported the TAKE PROFIT 1
    // error for an unreadable TP2 or TP3, pointing the reader at a box that
    // was fine — the same defect shape as the entry gate's missing switch
    // cases, one field over.
    const t2 = optional(tp2);
    if (t2 === null) return setError(p.registerErrors.targets_out_of_order);
    const t3 = optional(tp3);
    if (t3 === null) return setError(p.registerErrors.targets_out_of_order);

    const params: Record<string, unknown> = {
      p_pair: pair.trim().toUpperCase(),
      p_interval: interval,
      p_direction: direction,
      p_entry_price: entry,
      p_stop_loss: sl,
      p_take_profit_1: t1,
    };
    if (t2 !== undefined) params.p_take_profit_2 = t2;
    if (t3 !== undefined) params.p_take_profit_3 = t3;
    if (time.trim() !== "") {
      const ms = Date.parse(time);
      if (!Number.isFinite(ms)) return setError(p.registerErrors.time_unreadable);
      params.p_opened_at = new Date(ms).toISOString();
    }

    setBusy(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc("register_held_position", params);
      if (rpcError) {
        setError(p.registerErrors[registerErrorOf(rpcError.message)]);
        return;
      }
      const row = data && typeof data === "object" ? data as { position?: unknown } : null;
      const position = normalizePosition(row?.position);
      if (!position) {
        setError(p.registerErrors.generic);
        return;
      }
      toast({ title: o.registered });
      setOpen(false);
      onRegistered(position);
    } catch {
      setError(p.registerErrors.generic);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="register-held"
        className="px-2 py-0.5 rounded border border-primary/40 text-[10px] text-primary hover:bg-primary/10 transition-colors"
      >
        {o.button}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2 text-xs" data-testid="register-held-form">
      <p className="font-semibold text-primary">{o.title}</p>
      <p className="text-muted-foreground">{o.hint}</p>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] text-muted-foreground">{o.pair}</span>
          <input className={inputCls} value={pair} onChange={(e) => setPair(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-[10px] text-muted-foreground">{o.interval}</span>
          <select className={inputCls} value={interval} onChange={(e) => setInterval(e.target.value)}>
            {INTERVALS.map((iv) => (
              <option key={iv} value={iv}>{t.control.intervals[iv]}</option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <span className="text-[10px] text-muted-foreground">{o.direction}</span>
        <div className="flex gap-2 mt-0.5">
          {(["BUY", "SELL"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDirection(d)}
              data-testid={`own-dir-${d}`}
              aria-pressed={direction === d}
              className={`px-3 py-1 rounded border text-xs font-semibold transition-colors ${
                direction === d
                  ? (d === "BUY" ? "border-success text-success bg-success/10" : "border-destructive text-destructive bg-destructive/10")
                  : "border-border text-muted-foreground hover:bg-secondary/50"
              }`}
            >
              {d === "BUY" ? o.buy : o.sell}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-[10px] text-muted-foreground">{o.fillPrice}</span>
          <input className={inputCls} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-[10px] text-muted-foreground">{o.stopLoss}</span>
          <input className={inputCls} inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-[10px] text-muted-foreground">{o.tp1}</span>
          <input className={inputCls} inputMode="decimal" value={tp1} onChange={(e) => setTp1(e.target.value)} />
        </label>
      </div>
      <p className="text-[10px] text-muted-foreground">{o.whyLevels}</p>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] text-muted-foreground">{o.tp2}</span>
          <input className={inputCls} inputMode="decimal" value={tp2} onChange={(e) => setTp2(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-[10px] text-muted-foreground">{o.tp3}</span>
          <input className={inputCls} inputMode="decimal" value={tp3} onChange={(e) => setTp3(e.target.value)} />
        </label>
      </div>

      <label className="block">
        <span className="text-[10px] text-muted-foreground">{o.fillTime}</span>
        <input className={inputCls} type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
        <span className="text-[10px] text-muted-foreground">{o.fillTimeHint}</span>
        <TimePreview value={time} />
      </label>

      {/* Said on the form, not only in the docs: a position the app did not
          call must not be read as part of the app's record. */}
      <p className="text-[10px] text-muted-foreground" data-testid="own-not-counted">{o.notCounted}</p>

      {error && <p className="text-destructive" data-testid="own-register-error">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50"
        >
          {o.submit}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground"
        >
          {o.cancel}
        </button>
      </div>
    </form>
  );
};

export default HeldPositionRegistration;
