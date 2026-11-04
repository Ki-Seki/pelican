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

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function dayGroup(ms: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (ms >= today) return 'Today';
  if (ms >= today - DAY) return 'Yesterday';
  if (ms >= today - 6 * DAY) return 'This week';
  if (ms >= today - 30 * DAY) return 'This month';
  return 'Older';
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(ms: number, now = Date.now()): string {
  const group = dayGroup(ms, now);
  if (group === 'Today' || group === 'Yesterday') return group;
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
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

/** The command that carries a session on in a terminal. */
export function resumeCommand(sessionId: string, cwd?: string): string {
  return `${cwd ? `cd ${shellQuote(cwd)} && ` : ''}claude --resume ${sessionId}`;
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
