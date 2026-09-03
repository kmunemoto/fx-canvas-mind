// Scheduled events, so the analyzer stops being surprised by the calendar.
//
// Two things went wrong without this. The plan prompt only knew what a web
// search happened to surface, so a plan could be written an hour before
// Non-Farm Payrolls with no mention of it; and the post-mortem inferred
// "news_shock" from the shape of a bar alone (a range three times the
// median), which is a guess about cause dressed up as a fact.
//
// The source is Forex Factory's weekly JSON — free, no key, no account.
// Verified against the live feed on 2026-09-03: 114 events for the week,
// `impact` one of High/Medium/Low/Holiday, `country` an ISO currency code
// (or "All"), `date` an ISO timestamp carrying its own Eastern offset, and
// **no `actual` field**. So this layer answers "what is scheduled, and what
// was consensus", never "what was the print" — a post-mortem may say a plan
// died into NFP, not that NFP missed.
//
// Deno-free on purpose: src/test/events.test.ts imports this file directly.

export type Impact = "High" | "Medium" | "Low" | "Holiday";

export interface EconEvent {
  id: string;
  // When it is scheduled, in UTC
  event_at: string;
  // ISO currency code, or "All" for things like a G20 meeting
  country: string;
  title: string;
  impact: Impact;
  forecast: string | null;
  previous: string | null;
  // A holiday or an event the feed gives no time for: the timestamp is the
  // day, not the minute, so a window around it means the whole session
  all_day: boolean;
  source: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

// No entry may be timed inside this window around a high-impact release
export const BLACKOUT_MS = 30 * MIN;
// How far ahead a plan of each timeframe is told to look
export const HORIZON_MS: Record<string, number> = {
  "15min": 6 * HOUR,
  "1h": 12 * HOUR,
  "4h": 48 * HOUR,
  "1day": 5 * 24 * HOUR,
};
// A bar is attributed to an event released inside it, allowing for a print
// landing just before the bar opened
export const ATTRIBUTION_LEAD_MS = 5 * MIN;

const IMPACTS: readonly string[] = ["High", "Medium", "Low", "Holiday"];
const isImpact = (v: unknown): v is Impact => typeof v === "string" && IMPACTS.includes(v);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// A stable key for the same event across refetches: the feed has no id, and
// a title can repeat across countries and weeks
export const eventId = (country: string, at: string, title: string): string =>
  `${country}|${at}|${title}`.toLowerCase().replace(/\s+/g, " ").slice(0, 200);

// The feed's `date` carries its own Eastern offset ("2026-09-04T08:30:00-04:00"),
// so Date parses it correctly through daylight saving without a timezone table.
export const parseEvents = (body: unknown, source = "forexfactory"): EconEvent[] => {
  if (!Array.isArray(body)) return [];
  const out: EconEvent[] = [];
  const seen = new Set<string>();
  for (const row of body) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const title = str(r.title);
    const country = str(r.country);
    const rawDate = str(r.date);
    if (!title || !country || !rawDate) continue;
    const ms = Date.parse(rawDate);
    if (!Number.isFinite(ms)) continue;
    const impact: Impact = isImpact(r.impact) ? r.impact : "Low";
    const at = new Date(ms).toISOString();
    const id = eventId(country, at, title);
    if (seen.has(id)) continue;
    seen.add(id);
    // Forex Factory stamps an all-day item with midnight in its own
    // (Eastern) zone. Read that off the raw string rather than the UTC
    // instant, or a genuine 04:00 UTC release would look like an all-day one.
    const localTime = rawDate.slice(11, 16);
    out.push({
      id,
      event_at: at,
      country,
      title,
      impact,
      forecast: str(r.forecast) || null,
      previous: str(r.previous) || null,
      all_day: impact === "Holiday" || localTime === "00:00",
      source,
    });
  }
  out.sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
  return out;
};

// The currencies a pair is exposed to. "All" is exposure for everyone.
export const currenciesOf = (pair: string): string[] => {
  const parts = pair.toUpperCase().split(/[\/_]/).map((p) => p.trim()).filter(Boolean);
  return parts.length === 2 ? parts : [];
};

export const affectsPair = (event: { country: string }, pair: string): boolean => {
  if (event.country === "All") return true;
  return currenciesOf(pair).includes(event.country.toUpperCase());
};

// Events this pair is exposed to between now and the horizon, soonest first
export const upcomingFor = (
  events: EconEvent[],
  pair: string,
  nowMs: number,
  horizonMs: number,
  impacts: readonly Impact[] = ["High", "Medium"],
): EconEvent[] =>
  events
    .filter((e) => affectsPair(e, pair) && impacts.includes(e.impact))
    .filter((e) => {
      const t = Date.parse(e.event_at);
      return Number.isFinite(t) && t >= nowMs && t <= nowMs + horizonMs;
    })
    .sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));

const hoursUntil = (fromMs: number, iso: string): number =>
  Math.round(((Date.parse(iso) - fromMs) / HOUR) * 10) / 10;

// The block that goes into the plan prompt. Times stay UTC because every
// other number in that prompt is UTC; the model converts for prose.
export const renderEventBlock = (events: EconEvent[], nowMs: number, locale: "ja" | "en" = "ja"): string => {
  if (events.length === 0) return "";
  const head = locale === "ja"
    ? `今後の重要イベント（UTC。High は発表前後${BLACKOUT_MS / MIN}分に約定するプランを出さないこと。プランの想定保有時間がイベントを跨ぐ場合は、見送るか、イベントの値幅を吸収できる損切り幅にし、その旨を thesis に書くこと）:`
    : `Scheduled events ahead (UTC. Do not place a plan that would fill within ${BLACKOUT_MS / MIN} minutes of a High-impact release. If the plan's expected life spans one, either stand aside or set a stop that can absorb the event's range, and say so in the thesis):`;
  const lines = events.slice(0, 8).map((e) => {
    const when = e.all_day
      ? `${e.event_at.slice(0, 10)} (${locale === "ja" ? "時刻未定" : "time TBD"})`
      : e.event_at.slice(0, 16).replace("T", " ");
    const consensus = [
      e.forecast ? `${locale === "ja" ? "予想" : "forecast"} ${e.forecast}` : "",
      e.previous ? `${locale === "ja" ? "前回" : "prev"} ${e.previous}` : "",
    ].filter(Boolean).join(", ");
    const inHours = hoursUntil(nowMs, e.event_at);
    const ahead = e.all_day ? "" : ` [${inHours}h]`;
    return `- ${when} ${e.country} ${e.impact} — ${e.title}${consensus ? ` (${consensus})` : ""}${ahead}`;
  });
  return [head, ...lines].join("\n");
};

// Is a fill at this moment inside the blackout around a high-impact release?
export const blackoutAt = (events: EconEvent[], pair: string, atMs: number): EconEvent | null => {
  for (const e of events) {
    if (e.impact !== "High" || e.all_day || !affectsPair(e, pair)) continue;
    const t = Date.parse(e.event_at);
    if (!Number.isFinite(t)) continue;
    if (Math.abs(atMs - t) <= BLACKOUT_MS) return e;
  }
  return null;
};

// Which scheduled event a bar can be attributed to — what the post-mortem
// needs to turn "an abnormal bar" into "the plan died into this release".
// An all-day item covers its whole session rather than an instant.
export const eventInBar = (
  events: EconEvent[],
  pair: string,
  barOpenMs: number,
  barCloseMs: number,
): EconEvent | null => {
  let best: { e: EconEvent; impact: number } | null = null;
  const rank: Record<Impact, number> = { High: 3, Medium: 2, Low: 1, Holiday: 0 };
  for (const e of events) {
    if (!affectsPair(e, pair)) continue;
    const t = Date.parse(e.event_at);
    if (!Number.isFinite(t)) continue;
    const from = e.all_day ? t : t - ATTRIBUTION_LEAD_MS;
    const to = e.all_day ? t + 24 * HOUR : t + ATTRIBUTION_LEAD_MS;
    const overlaps = from < barCloseMs && to > barOpenMs;
    if (!overlaps) continue;
    const r = rank[e.impact];
    if (best === null || r > best.impact) best = { e, impact: r };
  }
  return best?.e ?? null;
};
