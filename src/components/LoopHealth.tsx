import { Activity } from "lucide-react";
import type { LoopHealth as LoopHealthData } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import { formatJst } from "@/lib/candleTime";

interface Props {
  health: LoopHealthData | null;
}

// Both sweeps run every 15 minutes; a gap this long means they are not
const STALL_MINUTES = 60;
// Lessons that must gather before the rulebook is rewritten (see
// supabase/functions/postmortem/prompt.ts MIN_NEW_LESSONS)
const MIN_NEW_LESSONS = 5;

const minutesAgo = (iso: string | null, nowIso: string): number | null => {
  if (!iso) return null;
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.round((now - then) / 60_000));
};

// The review loop, made visible: when each sweep last ran, what is waiting
// on it, and how far the rulebook is from its next revision. A loop that
// has stopped shows up here as a stall, not as a silence.
const LoopHealth = ({ health }: Props) => {
  const { t } = useLocale();
  const s = t.loop;
  if (!health) return null;

  const jobs = Array.isArray(health.jobs) ? health.jobs : [];
  const jobActive = (name: string) => jobs.length === 0 || jobs.some((j) => j.name === name && j.active);

  const line = (label: string, jobName: string, lastIso: string | null) => {
    const ago = minutesAgo(lastIso, health.now);
    const active = jobActive(jobName);
    const stalled = ago === null || ago > STALL_MINUTES;
    const bad = stalled || !active;
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs" key={jobName}>
        <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${bad ? "bg-warning" : "bg-success"}`} aria-hidden="true" />
        <span className="font-semibold text-foreground">{label}</span>
        <span className="text-muted-foreground">{s.every15}</span>
        <span className="font-mono text-muted-foreground">
          {lastIso
            ? ago !== null ? s.lastLine(formatJst(lastIso, t.intlLocale), s.ago(ago)) : s.last(formatJst(lastIso, t.intlLocale))
            : s.never}
        </span>
        {!active && <span className="text-warning">{s.inactive}</span>}
        {active && stalled && <span className="text-warning">{s.stalled}</span>}
      </p>
    );
  };

  const untilRevision = Math.max(0, MIN_NEW_LESSONS - (health.lessons_since_rulebook ?? 0));

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-2" data-testid="loop-health">
      <div className="flex items-center gap-2 text-primary">
        <Activity className="h-4 w-4" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{s.title}</h3>
      </div>
      {line(s.tracker, "track-outcomes-sweep", health.tracker_last_run_at)}
      {line(s.postmortem, "postmortem-sweep", health.postmortem_last_run_at)}
      <p className="text-[11px] text-muted-foreground font-mono">
        {s.openPlans(health.open_plans ?? 0)} · {s.awaiting(health.awaiting_review ?? 0)} · {s.reviewed(health.reviewed ?? 0)} · {s.lessons(health.lessons ?? 0)}
        {typeof health.rulebook_version === "number" ? ` · ${s.rulebook(health.rulebook_version)}` : ""}
      </p>
      <p className="text-[10px] text-muted-foreground">{s.nextRevision(untilRevision)}</p>
      <p className="text-[10px] text-muted-foreground">{s.waits}</p>
    </div>
  );
};

export default LoopHealth;
