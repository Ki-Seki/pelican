import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listSessions } from '@anthropic-ai/claude-agent-sdk';

import { config } from './config.js';
import { lastTurnTime, transcriptPath } from './transcripts.js';

/**
 * Folder trust. A folder can bring programs of its own: hooks, MCP servers, helper commands and
 * environment variables in its Claude Code settings, filters in its git config. Claude Code asks
 * before it runs them in an interactive session, but an SDK session never asks, so Pelican asks
 * instead, before the first Claude Code process in a folder nobody has trusted.
 *
 * A folder is trusted when Claude Code's own record says so (the CLI's trust dialog, read and never
 * written), when it was trusted in Pelican, when Pelican made it (a scratch folder), or when Claude
 * Code has already run there. "Use my settings only" starts Claude Code there with the user's
 * settings and none of the folder's, and with the folder's git programs turned off.
 */

export type TrustChoice = 'trusted' | 'user-only';
export type SettingSource = 'user' | 'project' | 'local';

/** How Claude Code is started in a folder. */
export type Launch = { settingSources: SettingSource[]; env?: Record<string, string> };

export const FULL_SETTINGS: Launch = { settingSources: ['user', 'project', 'local'] };

/** Starting Claude Code would run what the folder brings, and nobody has said it may. */
export class NeedsTrust extends Error {
  constructor(readonly folder: string, readonly brings: string[]) {
    super('Trust this folder before Claude Code starts in it.');
  }
}

const exists = (file: string) => stat(file).then(() => true, () => false);
const real = (folder: string) => realpath(folder).catch(() => path.resolve(folder));

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The top of the git repository a folder is in, by its `.git` (this runs nothing). */
async function gitRoot(dir: string): Promise<string | undefined> {
  for (let d = dir; ; d = path.dirname(d)) {
    if (await exists(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return undefined;
  }
}

/** The folder and the parents Claude Code looks at for its trust: up to the repository's top, else to the root. */
async function lineage(dir: string): Promise<string[]> {
  const top = await gitRoot(dir);
  const dirs: string[] = [];
  for (let d = dir; ; d = path.dirname(d)) {
    dirs.push(d);
    if (d === top || path.dirname(d) === d) return dirs;
  }
}

// A yes holds for a while; a no is asked again soon (the folder's first session may be starting).
const YES_MS = 30_000;
const NO_MS = 3_000;
const ranCache = new Map<string, { at: number; value: boolean }>();

/**
 * Whether Claude Code has run in this very folder, so what the folder brings is something the user
 * already let run.
 *
 * Claude Code files sessions by the folder's path with punctuation turned into dashes, so `a.b`
 * and `a-b` share a list, and the list may fill in a session's folder from that shared name. A
 * session counts only by the folder its own transcript records, and only if it is this one.
 */
export async function claudeRanIn(folder: string): Promise<boolean> {
  const dir = await realpath(folder).catch(() => folder);
  if (dir === os.homedir() || dir === (await real(os.homedir()))) return true;
  const cached = ranCache.get(dir);
  if (cached && Date.now() - cached.at < (cached.value ? YES_MS : NO_MS)) return cached.value;
  let value = false;
  const sessions = await listSessions({ dir, limit: 50, includeWorktrees: false }).catch(() => []);
  for (const session of sessions) {
    const file = await transcriptPath(session.sessionId);
    const recorded = file ? (await lastTurnTime(file))?.lastTurn?.cwd : undefined;
    if (!recorded) continue;
    if (recorded === dir || (await realpath(recorded).catch(() => '')) === dir) {
      value = true;
      break;
    }
  }
  if (ranCache.size > 2000) ranCache.clear();
  ranCache.set(dir, { at: Date.now(), value });
  return value;
}

/** Claude Code's global config, where the CLI's trust dialog records its answer. */
const claudeJson = () => path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
let claudeConfig: { file: string; mtimeMs: number; size: number; projects: Record<string, unknown> } | undefined;

async function claudeProjects(): Promise<Record<string, unknown>> {
  const file = claudeJson();
  const info = await stat(file).catch(() => undefined);
  if (!info) return {};
  if (claudeConfig?.file === file && claudeConfig.mtimeMs === info.mtimeMs && claudeConfig.size === info.size) return claudeConfig.projects;
  const parsed = await readJson(file);
  const projects = isObject(parsed) && isObject(parsed.projects) ? parsed.projects : {};
  claudeConfig = { file, mtimeMs: info.mtimeMs, size: info.size, projects };
  return projects;
}

/** Whether the CLI's trust dialog was accepted for this folder or, as Claude Code reads it, a parent. */
export async function claudeCodeTrusts(folder: string): Promise<boolean> {
  const projects = await claudeProjects();
  const accepted = (dir: string) => [dir, dir.normalize('NFC')].some((key) => {
    const entry = projects[key];
    return isObject(entry) && entry.hasTrustDialogAccepted === true;
  });
  const given = path.resolve(folder);
  const dirs = new Set([...(await lineage(await real(folder))), ...(await lineage(given))]);
  for (const dir of dirs) if (accepted(dir)) return true;
  return false;
}

// What the user answered in Pelican, by the folder the answer was for (the repository's top, as
// Claude Code keeps its own), oldest first.
const MAX_CHOICES = 1000;
const choicesFile = () => path.join(config.stateDir, 'trust.json');
let choices: { file: string; folders: Map<string, TrustChoice> } | undefined;

async function loadChoices(): Promise<Map<string, TrustChoice>> {
  const file = choicesFile();
  if (choices?.file === file) return choices.folders;
  const parsed = await readJson(file);
  const folders = new Map<string, TrustChoice>();
  if (isObject(parsed) && isObject(parsed.folders)) {
    for (const [folder, choice] of Object.entries(parsed.folders)) {
      if (path.isAbsolute(folder) && (choice === 'trusted' || choice === 'user-only')) folders.set(folder, choice);
    }
  }
  choices = { file, folders };
  return folders;
}

async function saveChoices(folders: Map<string, TrustChoice>): Promise<void> {
  const file = choicesFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, folders: Object.fromEntries(folders) }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

/** What the user said in Pelican about this folder, or a parent of it in the same repository. */
export async function pelicanChoice(folder: string): Promise<TrustChoice | undefined> {
  const folders = await loadChoices();
  if (folders.size === 0) return undefined;
  for (const dir of await lineage(await real(folder))) {
    const choice = folders.get(dir);
    if (choice) return choice;
  }
  return undefined;
}

/** Whether `outer` is `inner` or a folder that holds it. */
const holds = (outer: string, inner: string) => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`);

/**
 * Keeps the user's answer for the folder's repository (or the folder itself, outside one), never
 * for the home folder or above it: a home folder kept in git would otherwise answer for all of it.
 */
export async function rememberChoice(folder: string, choice: TrustChoice): Promise<void> {
  const dir = await real(folder);
  const top = await gitRoot(dir);
  const home = await real(os.homedir());
  const key = top && !holds(top, home) ? top : dir;
  const folders = await loadChoices();
  folders.delete(key);
  folders.set(key, choice);
  while (folders.size > MAX_CHOICES) folders.delete(folders.keys().next().value!);
  await saveChoices(folders);
}

/**
 * Whether what the folder brings may run: Claude Code's record or Pelican's says so, or Claude Code
 * has run there and the user did not ask Pelican to leave the folder's settings out.
 */
export async function folderTrusted(folder: string): Promise<boolean> {
  if (config.demo) return true;
  const dir = await real(folder);
  const choice = await pelicanChoice(dir);
  if (choice === 'trusted' || (await claudeCodeTrusts(dir))) return true;
  if (choice === 'user-only') return false;
  return claudeRanIn(dir);
}

const MAX_ITEM = 200;
const MAX_ITEMS = 24;
const short = (text: string) => (text.length > MAX_ITEM ? `${text.slice(0, MAX_ITEM - 1)}…` : text);
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** Settings that run a command of the folder's choosing, as Claude Code's trust dialog lists them. */
const HELPERS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'proxyAuthHelper'];

function fromSettings(settings: unknown): string[] {
  if (!isObject(settings)) return [];
  const found: string[] = [];
  if (isObject(settings.hooks)) {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of isObject(group) && Array.isArray(group.hooks) ? group.hooks : []) {
          if (!isObject(hook)) continue;
          const what = typeof hook.command === 'string' ? hook.command : typeof hook.url === 'string' ? hook.url : String(hook.type ?? 'hook');
          found.push(`${event} hook: ${what}`);
        }
      }
    }
  }
  for (const name of HELPERS) if (typeof settings[name] === 'string') found.push(`${name}: ${settings[name] as string}`);
  if (isObject(settings.env) && Object.keys(settings.env).length > 0) found.push(`Environment variables: ${Object.keys(settings.env).join(', ')}`);
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  if (strings(permissions.allow).length > 0) found.push(`Allowed without asking: ${strings(permissions.allow).join(', ')}`);
  if (strings(permissions.additionalDirectories).length > 0) found.push(`Extra folders: ${strings(permissions.additionalDirectories).join(', ')}`);
  if (typeof permissions.defaultMode === 'string' && !['default', 'plan', 'dontAsk'].includes(permissions.defaultMode)) {
    found.push(`Permission mode: ${permissions.defaultMode}`);
  }
  const plugins = isObject(settings.enabledPlugins) ? Object.entries(settings.enabledPlugins).filter(([, on]) => on).map(([name]) => name) : [];
  if (plugins.length > 0) found.push(`Plugins: ${plugins.join(', ')}`);
  if (isObject(settings.extraKnownMarketplaces) && Object.keys(settings.extraKnownMarketplaces).length > 0) {
    found.push(`Plugin marketplaces: ${Object.keys(settings.extraKnownMarketplaces).join(', ')}`);
  }
  if (typeof settings.autoMemoryDirectory === 'string') found.push(`Memory folder: ${settings.autoMemoryDirectory}`);
  return found;
}

function fromMcp(file: unknown): string[] {
  if (!isObject(file) || !isObject(file.mcpServers)) return [];
  return Object.entries(file.mcpServers).map(([name, server]) => {
    if (!isObject(server)) return `MCP server ${name}`;
    const command = typeof server.command === 'string' ? [server.command, ...strings(server.args)].join(' ') : undefined;
    const target = command ?? (typeof server.url === 'string' ? server.url : undefined);
    const helper = typeof server.headersHelper === 'string' ? ` (headersHelper: ${server.headersHelper})` : '';
    return `MCP server ${name}${target ? `: ${target}` : ''}${helper}`;
  });
}

/** A setting of a git config as git reads it: its name in git's spelling, its value, the file it is in. */
type GitEntry = { name: string; value: string; file: string };

/** The repository's own git config, as far as it could be read, and every file it includes. */
type GitConfig = { entries: GitEntry[]; includes: string[]; unread: boolean };

/** `filter.Evil.clean`: section `filter`, subsection `Evil` (its case kept, as git keeps it), key `clean`. */
function nameParts(name: string): { section: string; subsection?: string; key: string } {
  const first = name.indexOf('.');
  const last = name.lastIndexOf('.');
  const section = name.slice(0, first);
  return first === last ? { section, key: name.slice(last + 1) } : { section, subsection: name.slice(first + 1, last), key: name.slice(last + 1) };
}

const isInclude = (entry: GitEntry) => entry.name === 'include.path' || /^includeif\..+\.path$/.test(entry.name);
const gitTrue = (value: string) => ['', 'true', 'yes', 'on', '1'].includes(value.toLowerCase());

/** git found no repository there: nothing of a repository's config can run. */
class NoRepository extends Error {}

/**
 * Settings of a git config, as git itself reads them: `git config` starts no filter, hook or
 * monitor. Without the git settings of Pelican's own environment, with a time limit (an included
 * file can be a pipe nobody writes to), and also in a repository another account owns, which the
 * user's own git may be told to trust.
 */
function gitConfig(top: string, which: string[]): Promise<GitEntry[]> {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('GIT_')) env[name] = value;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
  const args = ['-c', 'safe.directory=*', 'config', ...which, '--list', '-z', '--show-origin', '--includes'];
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: top, env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // A repository without a config file of its own has nothing in it to run.
        if (/unable to read config file '[^']*': No such file or directory/.test(String(stderr))) resolve([]);
        else reject(/not a git repository|can only be used inside a git repository/i.test(String(stderr)) ? new NoRepository() : error);
        return;
      }
      // `file:<path>` NUL `<name>` newline `<value>` NUL, a path relative to the top of the work tree.
      const fields = String(stdout).split('\0');
      const entries: GitEntry[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const origin = fields[i]!;
        const item = fields[i + 1]!;
        const cut = item.indexOf('\n');
        entries.push({
          file: origin.startsWith('file:') ? path.resolve(top, origin.slice('file:'.length)) : origin,
          name: cut < 0 ? item : item.slice(0, cut),
          value: cut < 0 ? '' : item.slice(cut + 1),
        });
      }
      resolve(entries);
    });
  });
}

/** Where an include points, as git resolves it; undefined where only git knows (`~user/`, `%(prefix)/`). */
function includeTarget(value: string, from: string): string | undefined {
  if (value.startsWith('~/')) return path.join(process.env.HOME || os.homedir(), value.slice(2));
  if (value.startsWith('~') || value.startsWith('%(')) return undefined;
  return path.resolve(path.dirname(from), value);
}

/**
 * The repository's own config, its worktree's and the files they include, through git, which reads
 * same-line keys, `[filter.Name]` and includes as nothing else does. An include whose condition
 * does not hold now (another branch) can hold later, so every included file is read; one that
 * cannot be read leaves the config unread. Rejects when git could not read it; undefined when git
 * is not there to run anything, or finds no repository.
 */
async function repositoryConfig(top: string): Promise<GitConfig | undefined> {
  let entries: GitEntry[];
  try {
    entries = await gitConfig(top, ['--local']);
    if (entries.some((e) => e.name === 'extensions.worktreeconfig' && gitTrue(e.value))) entries.push(...(await gitConfig(top, ['--worktree'])));
  } catch (error) {
    if (error instanceof NoRepository || !(await gitRuns())) return undefined;
    throw error;
  }
  const repo: GitConfig = { entries, includes: [], unread: false };
  const read = new Set(entries.map((e) => e.file));
  const pending = entries.filter(isInclude);
  while (pending.length > 0) {
    const include = pending.shift()!;
    repo.includes.push(include.value);
    const file = includeTarget(include.value, include.file);
    if (!file) repo.unread = true;
    if (!file || read.has(file)) continue;
    read.add(file);
    const info = await stat(file).catch(() => undefined);
    // Not there (yet): nothing to read now, and the include is listed.
    if (!info) continue;
    // A pipe or a device is not read, nor a chain of includes longer than any real one.
    const more = info.isFile() && read.size <= 50 ? await gitConfig(top, ['--file', file]).catch(() => undefined) : undefined;
    if (!more) {
      repo.unread = true;
      continue;
    }
    for (const entry of more) {
      if (isInclude(entry)) pending.push(entry);
      read.add(entry.file);
    }
    repo.entries.push(...more);
  }
  return repo;
}

/** Whether git can run here at all; where it cannot, it runs nothing a repository sets up either. */
let gitWorks: Promise<boolean> | undefined;
function gitRuns(): Promise<boolean> {
  gitWorks ??= new Promise((resolve) => {
    execFile('git', ['--version'], { cwd: os.tmpdir(), timeout: 5000 }, (error, stdout) => {
      const code = (error as NodeJS.ErrnoException | null)?.code as unknown;
      // Not there, or a stand-in that exits with an error (one that only offers to install git):
      // no git. A failure that says nothing of git (no process could start) counts as git.
      resolve(error ? !(code === 'ENOENT' || typeof code === 'number') : /^git version/.test(String(stdout)));
    });
  });
  return gitWorks;
}

const UNREAD_GIT = 'Git config that git could not read';

/** Programs the repository's git config makes git start on its own, even for `git status`. */
function gitPrograms(repo: GitConfig): string[] {
  const found: string[] = [];
  for (const entry of repo.entries) {
    const { section, subsection, key } = nameParts(entry.name);
    if (section === 'filter' && ['clean', 'smudge', 'process'].includes(key) && entry.value) {
      found.push(`Git filter ${subsection ?? ''}: ${entry.value}`);
    } else if (section === 'core' && key === 'fsmonitor' && !['false', 'true', '0', '1', 'no', 'yes', 'off', 'on', ''].includes(entry.value.toLowerCase())) {
      found.push(`Git fsmonitor: ${entry.value}`);
    } else if (section === 'core' && key === 'hookspath' && entry.value) {
      found.push(`Git hooks folder: ${entry.value}`);
    }
  }
  // An included file can change (another branch, a pull), and with it what git runs.
  for (const include of repo.includes) found.push(`Git config includes: ${include}`);
  if (repo.unread) found.push(UNREAD_GIT);
  return found;
}

/** What git would run of the repository's own config, also when git could not read it all. */
async function gitBrings(top: string): Promise<string[]> {
  try {
    const repo = await repositoryConfig(top);
    return repo ? gitPrograms(repo) : [];
  } catch {
    return [UNREAD_GIT];
  }
}

/**
 * What the folder brings: read from its files, nothing run. Settings and MCP servers of the folder
 * and its parents up to the repository's top (Claude Code reads the project's from there), never
 * those of the home folder, which are the user's own; and what the repository's git config runs.
 */
export async function folderBrings(folder: string): Promise<string[]> {
  const dir = await real(folder);
  const home = os.homedir();
  const top = await gitRoot(dir);
  const found: string[] = [];
  for (let d = dir; d !== home; d = path.dirname(d)) {
    for (const name of ['settings.json', 'settings.local.json']) found.push(...fromSettings(await readJson(path.join(d, '.claude', name))));
    found.push(...fromMcp(await readJson(path.join(d, '.mcp.json'))));
    if (d === top || path.dirname(d) === d) break;
  }
  if (top) found.push(...(await gitBrings(top)));
  const unique = [...new Set(found.map(short))];
  return unique.length > MAX_ITEMS ? [...unique.slice(0, MAX_ITEMS - 1), `and ${unique.length - MAX_ITEMS + 1} more`] : unique;
}

/**
 * Git settings, for Claude Code and every git it starts, that turn off what the repository's own
 * config makes git run (filters, a file-system monitor, a hooks folder): the folder's settings are
 * left out, so are its programs. Names as git spells them, so `[filter.Evil]` is turned off as
 * `filter.evil`. A config git could not read in full cannot be turned off, so nothing starts.
 */
async function gitOff(dir: string): Promise<Record<string, string>> {
  const top = await gitRoot(dir);
  if (!top) return {};
  const repo = await repositoryConfig(top).catch((): GitConfig => ({ entries: [], includes: [], unread: true }));
  if (!repo) return {};
  if (repo.unread) throw new Error('Git could not read this folder’s git config, so Claude Code cannot start in it with your settings only.');
  const off: Array<[string, string]> = [];
  const parts = repo.entries.map((e) => nameParts(e.name));
  for (const name of new Set(parts.filter((p) => p.section === 'filter' && p.subsection !== undefined).map((p) => p.subsection!))) {
    off.push([`filter.${name}.clean`, ''], [`filter.${name}.smudge`, ''], [`filter.${name}.process`, ''], [`filter.${name}.required`, 'false']);
  }
  if (parts.some((p) => p.section === 'core' && p.key === 'fsmonitor')) off.push(['core.fsmonitor', 'false']);
  if (parts.some((p) => p.section === 'core' && p.key === 'hookspath')) off.push(['core.hooksPath', '/dev/null']);
  if (off.length === 0) return {};
  // After any the environment already holds, which git reads first.
  const start = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(start + off.length) };
  off.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key;
    env[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return env;
}

/**
 * For a new session: what the folder would run when nobody has trusted it, so the user can be
 * asked first; undefined when there is nothing to ask (trusted, or it brings nothing).
 */
export async function trustQuestion(folder: string): Promise<{ folder: string; brings: string[] } | undefined> {
  if (await folderTrusted(folder)) return undefined;
  const brings = await folderBrings(folder);
  return brings.length > 0 ? { folder: await real(folder), brings } : undefined;
}

/**
 * How to start Claude Code in a folder: with every setting where the folder is trusted or brings
 * nothing, with the user's own only where the user chose that, and not at all otherwise.
 */
export async function launchFor(folder: string): Promise<Launch> {
  if (config.demo || (await folderTrusted(folder))) return FULL_SETTINGS;
  const dir = await real(folder);
  if ((await pelicanChoice(dir)) === 'user-only') {
    const env = await gitOff(dir);
    return { settingSources: ['user'], ...(Object.keys(env).length > 0 ? { env } : {}) };
  }
  const brings = await folderBrings(dir);
  if (brings.length === 0) return FULL_SETTINGS;
  throw new NeedsTrust(dir, brings);
}

/** For tests: forget what was read. */
export function forgetTrust(): void {
  ranCache.clear();
  claudeConfig = undefined;
  choices = undefined;
  gitWorks = undefined;
}
