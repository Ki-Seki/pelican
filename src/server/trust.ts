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
  if (dir === os.homedir()) return true;
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

/** Keeps the user's answer for the folder's repository (or the folder itself, outside one). */
export async function rememberChoice(folder: string, choice: TrustChoice): Promise<void> {
  const dir = await real(folder);
  const key = (await gitRoot(dir)) ?? dir;
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

type GitEntry = { section: string; subsection?: string; key: string; value: string };

/** A git config file's entries, read as text (git itself is not run). */
function parseGitConfig(text: string): GitEntry[] {
  const entries: GitEntry[] = [];
  let section = '';
  let subsection: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (header) {
      const [name, ...rest] = header[1]!.split('.');
      section = name!.toLowerCase();
      subsection = header[2] ?? (rest.length > 0 ? rest.join('.') : undefined);
      continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (pair) entries.push({ section, ...(subsection !== undefined ? { subsection } : {}), key: pair[1]!.toLowerCase(), value: (pair[2] ?? 'true').replace(/^"(.*)"$/, '$1') });
  }
  return entries;
}

/** The repository's own config file (a worktree's is its main repository's). */
async function gitConfigOf(top: string): Promise<string | undefined> {
  const dotGit = path.join(top, '.git');
  const info = await stat(dotGit).catch(() => undefined);
  if (!info) return undefined;
  let gitDir = dotGit;
  if (info.isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''))?.[1]?.trim();
    if (!pointer) return undefined;
    gitDir = path.resolve(top, pointer);
    const common = (await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
    if (common) gitDir = path.resolve(gitDir, common);
  }
  return readFile(path.join(gitDir, 'config'), 'utf8').catch(() => undefined);
}

/** Programs the repository's git config makes git start on its own, even for `git status`. */
function gitPrograms(entries: GitEntry[]): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.section === 'filter' && ['clean', 'smudge', 'process'].includes(entry.key) && entry.value) {
      found.push(`Git filter ${entry.subsection ?? ''}: ${entry.value}`);
    } else if (entry.section === 'core' && entry.key === 'fsmonitor' && !['false', 'true', '0', '1', 'no', 'yes', 'off', 'on', ''].includes(entry.value.toLowerCase())) {
      found.push(`Git fsmonitor: ${entry.value}`);
    } else if (entry.section === 'core' && entry.key === 'hookspath' && entry.value) {
      found.push(`Git hooks folder: ${entry.value}`);
    }
  }
  return found;
}

/**
 * What Claude Code would run of the folder's own if it started there: read from the files, nothing
 * run. Settings and MCP servers of the folder and its parents up to the repository's top (Claude
 * Code reads the project's from there), never those of the home folder, which are the user's own.
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
  if (top) found.push(...gitPrograms(parseGitConfig((await gitConfigOf(top)) ?? '')));
  const unique = [...new Set(found.map(short))];
  return unique.length > MAX_ITEMS ? [...unique.slice(0, MAX_ITEMS - 1), `and ${unique.length - MAX_ITEMS + 1} more`] : unique;
}

/**
 * Git settings, for Claude Code and every git it starts, that turn off what the repository's own
 * config makes git run (filters, a file-system monitor, a hooks folder): the folder's settings are
 * left out, so are its programs.
 */
async function gitOff(dir: string): Promise<Record<string, string>> {
  const top = await gitRoot(dir);
  if (!top) return {};
  const entries = parseGitConfig((await gitConfigOf(top)) ?? '');
  const off: Array<[string, string]> = [];
  for (const name of new Set(entries.filter((e) => e.section === 'filter' && e.subsection).map((e) => e.subsection!))) {
    off.push([`filter.${name}.clean`, ''], [`filter.${name}.smudge`, ''], [`filter.${name}.process`, ''], [`filter.${name}.required`, 'false']);
  }
  if (entries.some((e) => e.section === 'core' && e.key === 'fsmonitor')) off.push(['core.fsmonitor', 'false']);
  if (entries.some((e) => e.section === 'core' && e.key === 'hookspath')) off.push(['core.hooksPath', '/dev/null']);
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
}
