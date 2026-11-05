import { shortTitle } from '../../shared/titles';
import { cacheShare, tokenTotal, type UsageRange, type UsageSummary } from '../../shared/usage';

/** A count as the page shows it: in full below 10,000 (1,284), then short (12.9K, 129K, 4.2M, 1.3B). */
export function compactNumber(n: number): string {
  const value = Math.max(0, Math.round(n));
  if (value < 10_000) return value.toLocaleString('en');
  const units: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (let i = 0; i < units.length; i += 1) {
    const [size, unit] = units[i]!;
    if (value < size) continue;
    const scaled = value / size;
    const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
    // 999,960 is 1M, not 1000K.
    if (rounded >= 1000 && i > 0) return `${Math.round((value / units[i - 1]![0]) * 10) / 10}${units[i - 1]![1]}`;
    return `${rounded}${unit}`;
  }
  return String(value);
}

/** A share as a whole percent; a share that is there but rounds to nothing is "<1%". */
export const percent = (share: number) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);

/** A length of time in a few characters: 40s, 12m, 3h 5m, 2d 4h. */
export function span(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** The figures' days are UTC dates (as Claude Code's /stats counts them): shown as such, wherever the page is read. */
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
export const dayText = (day: string) => utc(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const weekdayText = (day: string) => utc(day).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
export const longDayText = (day: string) => utc(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** What the period's figures cover, after "tokens": "in the last 7 days", "since Oct 6". */
export function periodWords(range: UsageRange, summary: Pick<UsageSummary, 'from' | 'tokensSince'>): string {
  if (range === '7d') return 'in the last 7 days';
  if (range === '30d') return 'in the last 30 days';
  return `since ${dayText(summary.tokensSince ?? summary.from)}`;
}

const hourText = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** The four hours of the day most of these times fall in (two in three or more), if they do. */
export function hourBand(hours: number[]): [number, number] | undefined {
  if (hours.length < 2) return undefined;
  let best: [number, number] | undefined;
  for (let start = 0; start < 24; start += 1) {
    const inside = hours.filter((h) => (h - start + 24) % 24 < 4).length;
    if (inside * 3 >= hours.length * 2 && (!best || inside > best[1])) best = [start, inside];
  }
  return best && [best[0], (best[0] + 4) % 24];
}

/** How often, in words: once, twice, 3 times. */
export const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const quoted = (title: string) => `“${shortTitle(title, 40)}”`;

/**
 * A few things the figures say, each in one plain sentence: where most of it went, how much came
 * from the prompt cache, the usage limits reached and when, how long Claude waited for you in
 * Pelican, and sessions compacted again and again. `hourOf` gives an hour of the day on this
 * device's clock.
 */
export function highlights(summary: UsageSummary, hourOf = (ms: number) => new Date(ms).getHours()): string[] {
  const out: string[] = [];
  const total = tokenTotal(summary.tokens);
  if (total > 0) {
    const project = summary.projects[0];
    if (summary.projects.length > 1 && project && project.tokens / total >= 0.4) out.push(`${percent(project.tokens / total)} of the tokens went to ${project.name}.`);
    const session = summary.sessions[0];
    if (summary.sessions.length > 1 && session && session.tokens / total >= 0.25) out.push(`One session, ${quoted(session.title)}, took ${percent(session.tokens / total)}.`);
    const share = cacheShare(summary.tokens);
    if (share !== undefined) {
      out.push(share >= 0.6
        ? `${percent(share)} of the input was read from the cache.`
        : `Only ${percent(share)} of the input was read from the cache. After a pause longer than the cache lasts, the next message sends the whole conversation again.`);
    }
  }
  const fiveHour = summary.limits.filter((l) => l.kind === 'session');
  if (fiveHour.length === 1) {
    out.push(`The 5-hour limit was reached once, around ${hourText(hourOf(fiveHour[0]!.at))}.`);
  } else if (fiveHour.length > 1) {
    const band = hourBand(fiveHour.map((l) => hourOf(l.at)));
    out.push(`The 5-hour limit was reached ${times(fiveHour.length)}${band ? `, mostly between ${hourText(band[0])} and ${hourText(band[1])}` : ''}.`);
  }
  const weekly = summary.limits.filter((l) => l.kind === 'weekly');
  if (weekly.length > 0) {
    const when = weekly.length === 1 ? `, on ${new Date(weekly[0]!.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
    out.push(`The weekly limit was reached ${times(weekly.length)}${when}.`);
  }
  const model = summary.limits.filter((l) => l.kind === 'model');
  if (model.length > 0) out.push(`A model’s weekly limit was reached ${times(model.length)}.`);
  if (summary.waits && summary.waits.ms >= 60_000) {
    out.push(`In Pelican, Claude waited ${span(summary.waits.ms)} for your answers${summary.waits.count >= 3 ? `, ${span(summary.waits.longest)} at most` : ''}.`);
  }
  const [first, ...rest] = summary.compacted;
  if (first) {
    out.push(rest.length === 0
      ? `${quoted(first.title)} was compacted ${times(first.times)}. A new session for each new task keeps the context small.`
      : `${summary.compacted.length} sessions were compacted three times or more, ${quoted(first.title)} ${times(first.times)}. A new session for each new task keeps the context small.`);
  }
  return out;
}
