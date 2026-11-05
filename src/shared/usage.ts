// Usage and activity: what the page and the session menu show, and the rules both sides follow.

/** The periods the page offers, as Claude Code's /stats does: the last 7 days, the last 30, everything. */
export type UsageRange = '7d' | '30d' | 'all';
export const USAGE_RANGES: UsageRange[] = ['7d', '30d', 'all'];

/** Tokens by kind, as the API reports them for each reply and Claude Code's /usage names them. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export const noTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const tokenTotal = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/**
 * The share of input served from the prompt cache, as Claude Code's "Prompt cache" line counts it:
 * cache reads over everything sent (new input, cache writes and cache reads). Undefined with no input.
 */
export function cacheShare(t: Tokens): number | undefined {
  const sent = t.input + t.cacheWrite + t.cacheRead;
  return sent > 0 ? t.cacheRead / sent : undefined;
}

/** The apps a session can run in, by what Claude Code records as each row's entrypoint. */
export type AppName = 'Terminal' | 'Claude Desktop' | 'VS Code' | 'Pelican' | 'Agent SDK' | 'Cowork' | 'Other';

/**
 * Claude Code's own clients by their entrypoint, in Claude Code's names. The Agent SDK covers
 * `claude -p` too (Claude Code counts it as the SDK). Rows a session got from Pelican are the SDK's
 * (`sdk-ts`); `pelican` says that this session is one Pelican ran. Anything else is "Other":
 * Pelican assumes nothing about programs it does not know.
 */
export function appOf(entrypoint: string | undefined, pelican: boolean): AppName {
  switch (entrypoint) {
    case 'cli':
      return 'Terminal';
    case 'claude-desktop':
    case 'claude-desktop-3p':
    case 'remote_desktop':
      return 'Claude Desktop';
    case 'claude-vscode':
      return 'VS Code';
    case 'local-agent':
    case 'local_agent':
    case 'remote_cowork':
      return 'Cowork';
    case 'sdk-ts':
    case 'sdk-py':
      return pelican ? 'Pelican' : 'Agent SDK';
    case 'sdk-cli':
      return 'Agent SDK';
    default:
      return 'Other';
  }
}

/** Which usage limit a Claude Code "You've hit your … limit" line is about, in Claude Code's own terms. */
export type LimitKind = 'session' | 'weekly' | 'model';

/**
 * The limit a usage-limit error names, as Claude Code itself classifies it: the 5-hour (session)
 * limit, the weekly one, or a model's weekly one (spend and fast-mode limits are none of these).
 * Older versions said only "You've hit your limit · resets 3pm": the 5-hour one when it resets at
 * a time of day, the weekly one when it names a day.
 */
export function limitKind(text: string): LimitKind | undefined {
  const t = text.trim();
  if (/^You(?:'|’)ve hit your limit\b/.test(t)) {
    const resets = /resets\s+([^\n(]+)/i.exec(t)?.[1]?.trim() ?? '';
    if (!resets) return undefined;
    return /^\d{1,2}(:\d\d)?\s*(am|pm)?$/i.test(resets) ? 'session' : 'weekly';
  }
  const name = /^You(?:'|’)ve hit your (.+?) limit/.exec(t)?.[1]?.toLowerCase();
  if (name === '5-hour' || name === 'session') return 'session';
  if (name === 'weekly') return 'weekly';
  if (name && /^(opus|sonnet|haiku|fable)$/.test(name)) return 'model';
  return undefined;
}

/**
 * A model id as people say it: claude-opus-5-5 is Opus 5.5, us.anthropic.claude-sonnet-4-5-20250929-v1:0
 * and claude-sonnet-4-5@20250929 are Sonnet 4.5. An id of another shape stays as it is.
 */
export function modelName(id: string): string {
  const bare = id.replace(/^.*?(?=claude-)/, '').replace(/^claude-/, '').replace(/\[.*?\]/g, '').replace(/[@:].*$/, '').replace(/-v\d+$/, '');
  const parts = bare.split('-').filter((p) => !/^\d{8}$/.test(p));
  const family = parts.find((p) => /^[a-z]+$/.test(p));
  if (!family || !id.includes('claude')) return id;
  const version = parts.filter((p) => /^\d{1,2}$/.test(p));
  return `${family[0]!.toUpperCase()}${family.slice(1)}${version.length > 0 ? ` ${version.join('.')}` : ''}`;
}

/**
 * Whether dollar figures mean anything to this account. On a Claude plan (Pro, Max, Team,
 * Enterprise) usage counts against the plan's limits, which the page shows instead; with an API
 * key or a cloud provider it is billed per token, and Claude Code's own estimate at API prices
 * helps. Unknown (the account not read yet, or not signed in): no figure.
 */
export function costShown(account: { signedIn?: boolean | null; plan?: string | undefined }): boolean {
  return account.signedIn === true && !account.plan;
}

/** How every dollar figure is labeled: it is Claude Code's estimate, not a bill. */
export const COST_LABEL = 'estimated at API prices';

/**
 * A cost figure in words, as the page and the session menu say it. `without`: sessions in it for
 * which Claude Code kept no estimate (older versions, or a session in progress elsewhere).
 */
export function costWords(usd: number, without = 0): string {
  const amount = usd >= 100 ? `$${Math.round(usd).toLocaleString('en')}` : `$${usd.toFixed(2)}`;
  const missing = without > 0 ? `; ${without} ${without === 1 ? 'session has' : 'sessions have'} no estimate` : '';
  return `${amount}, ${COST_LABEL}${missing}`;
}

export type UsageProgress = {
  /** Transcripts found, and read so far (each read once, then only what it gains). */
  files: number;
  read: number;
  ready: boolean;
};

/** One bar of the chart: a UTC day (or the Monday of a UTC week), and the tokens of that day or week. */
export type UsagePoint = { day: string; tokens: number };

export type UsageSession = {
  id: string;
  title: string;
  project: string;
  app: AppName;
  tokens: number;
  /** ms since epoch: the session's last activity in the period. */
  at: number;
};

export type UsageSummary = {
  range: UsageRange;
  /** The UTC days the period covers, first and last, as Claude Code's /stats counts days. */
  from: string;
  to: string;
  tokens: Tokens;
  /** The first day with tokens, when the transcripts go back less far than the period. */
  tokensSince?: string;
  series: { unit: 'day' | 'week'; points: UsagePoint[] };
  models: Array<{ model: string; name: string; tokens: number }>;
  projects: Array<{ cwd: string; name: string; tokens: number; sessions: number }>;
  apps: Array<{ app: AppName; tokens: number; sessions: number }>;
  /** The sessions that used the most, most first. */
  sessions: UsageSession[];
  activity: {
    sessions: number;
    activeDays: number;
    days: number;
    currentStreak: number;
    longestStreak: number;
    longest?: { id: string; title: string; ms: number };
    /** The first day of activity anyone recorded, when Claude Code's own stats go back further than the transcripts. */
    since?: string;
  };
  /** Usage limits reached in the period, each once, by when Claude Code said so. */
  limits: Array<{ kind: LimitKind; at: number }>;
  /** Sessions compacted three times or more in the period, most first. */
  compacted: Array<{ id: string; title: string; times: number }>;
  /** How long Claude waited for an answer (an approval, a question, a plan) in sessions Pelican ran. */
  waits?: { ms: number; count: number; longest: number };
  /** Only for an API key or a cloud provider (costShown): Claude Code's own estimates. */
  cost?: { usd: number; without: number };
  progress: UsageProgress;
};

export type SessionUsage = {
  tokens: Tokens;
  models: Array<{ model: string; name: string; tokens: number }>;
  compactions: number;
  waits?: { ms: number; count: number };
  cost?: { usd: number };
};
