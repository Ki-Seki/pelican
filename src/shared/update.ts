/**
 * Updating Pelican from its own Settings (src/server/update.ts): what the server says of updates,
 * and the rules both sides keep. Nothing here runs anything.
 */

/** The package Pelican updates itself to, by name: never another. */
export const PACKAGE_NAME = 'pelican-cc';

/** A version as npm publishes one: x.y.z, perhaps with a prerelease, and nothing else. */
export const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** "Update when idle" waits until nothing has run for this long. */
export const IDLE_FOR_MS = 60_000;

/** How Pelican was installed, as far as updating it goes. */
export type InstallKind =
  /** `npm install -g`, into npm's global folder, which this account can write to. */
  | 'npm'
  /** `npm install -g`, into a global folder another account owns (root's, with sudo). */
  | 'npm-elsewhere-owned'
  /** A cache of npx, pnpm dlx or bunx: each fetches a new version when asked for it. */
  | 'npx'
  /** A source checkout (git), built and started from there, or linked with `npm link`. */
  | 'source'
  /** Something else put it there and keeps its version: another prefix, a project, pnpm, yarn, bun, Volta. */
  | 'managed'
  /** Pelican could not tell. */
  | 'unknown';

/** How a Pelican that updated itself starts again. */
export type RestartWay =
  /** Its login item (`pelican service install`), through launchd. */
  | 'launchd'
  /** Its systemd user service (`pelican service install`). */
  | 'systemd'
  /** In a terminal: it starts the new version in its own place (process.execve), the same process. */
  | 'in-place'
  /** It cannot start again by itself here: you restart it. */
  | 'by-hand';

export type InstallInfo = {
  kind: InstallKind;
  /** Pelican's own folder (the package's). */
  folder: string;
  /** The npm prefix it was installed into, for a global install. */
  prefix?: string;
  /** One tap updates it. */
  self: boolean;
  /** How it starts again after an update. */
  restart: RestartWay;
  /** Where it cannot update itself: the command to run instead, for the version offered. */
  command?: string;
  /** Why: what Pelican found, in a sentence. */
  why?: string;
};

/** Something an update would end, as it restarts Pelican. */
export type Interruption = {
  /**
   * session: Claude working or waiting for you in a session; work: its background tasks
   * (agents, workflows, commands) or checks it stays running for; terminal: a program in a
   * terminal; command: a `!` command.
   */
  kind: 'session' | 'work' | 'terminal' | 'command';
  /** The session's title, the terminal's program, the command. */
  title: string;
  /** What it is doing, or where. */
  detail: string;
  sessionId?: string;
};

/** Where an update stands; none while nothing is under way. */
export type UpdateState =
  /** Getting the version and checking that it starts, apart from this install: nothing changes yet. */
  | { phase: 'preparing'; version: string; when: 'now' | 'idle' }
  /** Ready, waiting until nothing has run for IDLE_FOR_MS (since `idleSince`, while nothing runs). */
  | { phase: 'waiting'; version: string; since: number; idleSince?: number }
  /** Installing over this install, checking it starts, and starting it: new work waits. */
  | { phase: 'installing' | 'checking' | 'restarting'; version: string }
  /** Installed, but this Pelican cannot start it by itself: `note` says how. */
  | { phase: 'installed'; version: string; note: string }
  /** It failed; Pelican `running` still runs, and `error` says what failed. */
  | { phase: 'failed'; version: string; error: string; running: string };

/** What Settings shows of updates (GET api/update). */
export type UpdateInfo = {
  /** The version running. */
  current: string;
  /** The newest version on npm's registry, when it is newer; none when not, or unknown. */
  latest?: string;
  /** What changed since the running version, from the new version's CHANGELOG.md (Markdown). */
  changes?: string;
  /** Where the release notes are, when the changelog could not be read. */
  notes?: string;
  /** How this Pelican was installed, and what it offers. */
  install?: InstallInfo;
  /** What an update would end now. */
  busy?: Interruption[];
  state?: UpdateState;
};

/** The parts of a version: its numbers, and its prerelease identifiers. */
function parts(version: string): { numbers: number[]; pre: string[] } | undefined {
  const match = VERSION.exec(version);
  if (!match) return undefined;
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

/**
 * How `a` and `b` are ordered as semver orders them: negative when `a` comes first, positive when
 * after, 0 when the same; undefined when either is not a version.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i += 1) if (x.numbers[i] !== y.numbers[i]) return x.numbers[i]! - y.numbers[i]!;
  // A prerelease comes before its release; between two, identifier by identifier.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const [m, n] = [/^\d+$/.test(p) ? Number(p) : undefined, /^\d+$/.test(q) ? Number(q) : undefined];
    if (m !== undefined && n !== undefined) return m - n;
    if (m !== undefined || n !== undefined) return m !== undefined ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether `a` is a version that comes after `b`. */
export const isNewerVersion = (a: string, b: string): boolean => (compareVersions(a, b) ?? 0) > 0;

/**
 * The sections of a changelog (`## 0.5.1` headings, as CHANGELOG.md has them) for the versions
 * after `from` up to `to`, newest first, as they are written; undefined when there is none for `to`.
 */
export function changesBetween(changelog: string, from: string, to: string): string | undefined {
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let keeping = false;
  let found = false;
  for (const line of lines) {
    const heading = /^##\s+v?(\S+)\s*$/.exec(line);
    if (heading) {
      const version = heading[1]!;
      keeping = compareVersions(version, from) !== undefined && isNewerVersion(version, from) && !isNewerVersion(version, to);
      if (keeping && version === to) found = true;
    } else if (/^#\s/.test(line)) {
      keeping = false;
    }
    if (keeping) kept.push(line);
  }
  return found ? kept.join('\n').trim() : undefined;
}
