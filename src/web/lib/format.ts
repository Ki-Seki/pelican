const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short' });
}

/** The same in words, as a screen reader should say it: "3 minutes ago", "2 days ago", "March 4". */
export function timeAgo(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const ago = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'} ago`;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return ago(Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return ago(Math.floor(diff / HOUR), 'hour');
  if (diff < 7 * DAY) return ago(Math.floor(diff / DAY), 'day');
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en', sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' });
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * The heading a session's time puts it under in the list: Today, Yesterday, then the 7 and the 30
 * days before today, which is what they are (on 6 November, 23 October is no session of "this
 * month"), then Older.
 */
export function dayGroup(ms: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (ms >= today) return 'Today';
  if (ms >= today - DAY) return 'Yesterday';
  if (ms >= today - 6 * DAY) return 'Previous 7 days';
  if (ms >= today - 30 * DAY) return 'Previous 30 days';
  return 'Older';
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * A day as Claude Desktop names it above a conversation's messages: Today, Yesterday, or the
 * weekday and date ("Tuesday, Nov 4"), with the year when it is not this one. In the app's words,
 * so in English, as "Today" is.
 */
export function dayLabel(ms: number, now = Date.now()): string {
  const group = dayGroup(ms, now);
  if (group === 'Today' || group === 'Yesterday') return group;
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** `~/repos/x` for paths under home. */
export function shortPath(path: string, home?: string): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

export function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Shell-quotes a path, keeping a leading `~/` working. */
export function shellQuote(path: string): string {
  if (path.startsWith('~/')) return `~/${shellQuote(path.slice(2))}`;
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** A Claude Code session id: a UUID. Anything else (an id typed into the address) is not offered to a shell. */
export const isSessionId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * The command that carries a session on in a terminal; every part quoted, whatever it holds.
 * A folder with a backslash in its name is left out: no one quoting is safe in both POSIX
 * shells and fish for it.
 */
export function resumeCommand(sessionId: string, cwd?: string): string {
  return `${cwd && !cwd.includes('\\') ? `cd ${shellQuote(cwd)} && ` : ''}claude --resume ${shellQuote(sessionId)}`;
}

/** A time ahead, like a limit's reset: "14:30", "tomorrow 09:00", or "Sun 16:14". */
export function untilTime(ms: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((day(ms) - day(now)) / 86_400_000);
  const time = clockTime(ms);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  return `${new Date(ms).toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}
