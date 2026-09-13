import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { useLocale } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import { normalizePosition, registerErrorOf } from "@/lib/positions";
import { formatJst, priceDecimals } from "@/lib/candleTime";
import type { Position } from "@/lib/types";

// "I entered on this plan." The one thing the app never knew, and the reason
// a WAIT on the next run read as "close": with a registered position the
// next run evaluates the held plan separately (analyze/review.ts).
//
// Writes go through register_position, a SECURITY DEFINER function that
// checks the plan is the caller's own published BUY/SELL and copies its
// levels; nothing here builds an INSERT. The fill time is OPTIONAL and, left
// blank, is not sent at all — the server then records its own clock and says
// so on the row, so a browser with a fast or slow clock cannot be refused on
// the one-click path.

interface RegisterProps {
  analysisId: string;
  pair: string;
  // The plan's entry as displayed; the reader may overwrite it with a
  // slipped fill.
  defaultPrice: string;
  onRegistered: (position: Position, alreadyOpen: boolean) => void;
  // The wording of the button: the plan on screen, or the previous run's.
  label?: string;
  compact?: boolean;
}

const inputCls = "w-full rounded-md border border-border bg-background px-2 py-1 text-sm font-mono";

// What the typed time will actually be recorded as, in the zone the rest of
// the screen speaks. A datetime-local value carries no zone and is read in
// the browser's; a reader copying a JST time from their broker in a non-JST
// browser would otherwise store, and be shown, a different instant.
const TimePreview = ({ value }: { value: string }) => {
  const { t } = useLocale();
  if (value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return (
    <span className="block text-[10px] text-muted-foreground" data-testid="time-preview">
      {t.position.timePreview(formatJst(ms, t.intlLocale))}
    </span>
  );
};

export const EntryRegistration = ({ analysisId, pair, defaultPrice, onRegistered, label, compact = false }: RegisterProps) => {
  const { t } = useLocale();
  const p = t.position;
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(defaultPrice);
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) {
      setError(p.registerErrors.entry_price_must_be_positive);
      return;
    }
    const params: Record<string, unknown> = { p_analysis_id: analysisId, p_entry_price: n };
    if (time.trim() !== "") {
      const ms = Date.parse(time);
      if (!Number.isFinite(ms)) {
        setError(p.registerErrors.time_unreadable);
        return;
      }
      params.p_opened_at = new Date(ms).toISOString();
    }
    setBusy(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc("register_position", params);
      if (rpcError) {
        setError(p.registerErrors[registerErrorOf(rpcError.message)]);
        return;
      }
      const row = data && typeof data === "object" ? data as { position?: unknown; already_open?: unknown } : null;
      const position = normalizePosition(row?.position);
      if (!position) {
        setError(p.registerErrors.generic);
        return;
      }
      const already = row?.already_open === true;
      toast({ title: already ? p.alreadyOpen(position.entry_price.toFixed(priceDecimals(pair))) : p.registered });
      setOpen(false);
      onRegistered(position, already);
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
        data-testid="register-entry"
        className={compact
          ? "px-2 py-0.5 rounded border border-primary/40 text-[10px] text-primary hover:bg-primary/10 transition-colors"
          : "px-3 py-1.5 rounded-lg border border-primary/40 text-xs font-semibold text-primary hover:bg-primary/10 transition-colors"}
      >
        {label ?? p.registerButton}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2 text-xs" data-testid="register-form">
      <p className="font-semibold text-primary">{p.registerTitle}</p>
      <p className="text-muted-foreground">{p.registerHint}</p>
      <label className="block">
        <span className="text-[10px] text-muted-foreground">{p.fillPrice}</span>
        <input className={inputCls} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <label className="block">
        <span className="text-[10px] text-muted-foreground">{p.fillTime}</span>
        <input className={inputCls} type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
        <span className="text-[10px] text-muted-foreground">{p.fillTimeHint}</span>
        {/* The input is read in the BROWSER's zone; every time this app shows
            is JST. Rather than explain that, show what will be recorded. */}
        <TimePreview value={time} />
      </label>
      {error && <p role="alert" className="text-destructive" data-testid="register-error">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold disabled:opacity-60"
        >
          {busy ? p.registering : p.registerSubmit}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg border border-border text-muted-foreground">
          {p.cancel}
        </button>
      </div>
    </form>
  );
};

// "I closed it." Recorded, not inferred: the app cannot see the reader's
// broker. The close price and time are what a later scoring of hold/exit
// decisions will be measured against, so they are the reader's own words.
interface CloseProps {
  position: Position;
  onClosed: (position: Position) => void;
}

export const ClosePositionForm = ({ position, onClosed }: CloseProps) => {
  const { t } = useLocale();
  const p = t.position;
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState("");
  const [time, setTime] = useState("");
  const [reason, setReason] = useState<"manual" | "stop" | "target" | "other">("manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) {
      setError(p.registerErrors.close_price_must_be_positive);
      return;
    }
    // The close time is the reader's, not the clock's: a stop hit at 02:00 and
    // recorded at 09:00 is a 02:00 exit, and a later scoring of hold/exit
    // decisions measures from it. Left blank the server records its own
    // instant and marks the row as such rather than passing it off as a fill.
    const params: Record<string, unknown> = { p_position_id: position.id, p_close_price: n, p_reason: reason };
    if (time.trim() !== "") {
      const ms = Date.parse(time);
      if (!Number.isFinite(ms)) {
        setError(p.registerErrors.time_unreadable);
        return;
      }
      params.p_closed_at = new Date(ms).toISOString();
    }
    setBusy(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc("close_position", params);
      if (rpcError) {
        setError(p.registerErrors[registerErrorOf(rpcError.message)]);
        return;
      }
      const closed = normalizePosition(data);
      if (!closed) {
        setError(p.registerErrors.generic);
        return;
      }
      toast({ title: p.closed });
      setOpen(false);
      onClosed(closed);
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
        data-testid="close-position"
        className="px-2 py-1 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
      >
        {p.closeButton}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-border bg-background/60 p-3 space-y-2 text-xs" data-testid="close-form">
      <p className="font-semibold">{p.closeTitle}</p>
      <label className="block">
        <span className="text-[10px] text-muted-foreground">{p.closePrice}</span>
        <input className={inputCls} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <label className="block">
        <span className="text-[10px] text-muted-foreground">{p.closeTime}</span>
        <input className={inputCls} type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
        <span className="text-[10px] text-muted-foreground">{p.closeTimeHint}</span>
        <TimePreview value={time} />
      </label>
      <label className="block">
        <span className="text-[10px] text-muted-foreground">{p.closeReason}</span>
        <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
          {(["manual", "stop", "target", "other"] as const).map((r) => (
            <option key={r} value={r}>{p.closeReasons[r]}</option>
          ))}
        </select>
      </label>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold disabled:opacity-60">
          {busy ? p.closing : p.closeSubmit}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg border border-border text-muted-foreground">
          {p.cancel}
        </button>
      </div>
    </form>
  );
};
