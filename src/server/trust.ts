import { execFile } from 'node:child_process';
import { mkdir, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listSessions } from '@anthropic-ai/claude-agent-sdk';

import type { CommandAt } from '../shared/protocol.js';
import { config } from './config.js';
import { openRegular } from './open.js';
import { lastTurnTime, transcriptPath } from './transcripts.js';

/**
 * Folder trust. A folder can bring programs of its own: hooks, MCP servers, helper commands and
 * environment variables in its Claude Code settings, commands, skills and agents that run a shell
 * or tools without asking, filters in its git config. Claude Code asks before it runs them in an
 * interactive session, but an SDK session never asks, so Pelican asks instead, before the first
 * Claude Code process in a folder nobody has trusted.
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
  constructor(readonly folder: string, readonly brings: string[], readonly commands: CommandAt[][] = []) {
    super('Trust this folder before Claude Code starts in it.');
  }
}

/** An item of what a folder brings: its text, and where in it a command is (CommandAt). */
type Item = { text: string; commands: CommandAt[] };

/** What a folder brings, each item whole, and the commands in each, item by item. */
export type Brings = { brings: string[]; commands: CommandAt[][] };

const said = (text: string): Item => ({ text, commands: [] });

/** `label`, then a command a shell runs or a program and its arguments, then `after`. */
const runs = (label: string, command: string, how: CommandAt[2], after = ''): Item => ({
  text: `${label}${command}${after}`,
  commands: [[label.length, label.length + command.length, how]],
});

const exists = (file: string) => stat(file).then(() => true, () => false);
const real = (folder: string) => realpath(folder).catch(() => path.resolve(folder));

/** Larger than any settings file; a folder could otherwise make the server read without end. */
const MAX_READ = 16 * 1024 * 1024;

/**
 * A file's text, read only when it is a regular file of a sane size (`odd` when something else is
 * there): a named pipe in its place would hold one of Node's few file threads until someone wrote
 * to it, and a folder from a tarball can bring one.
 */
async function readText(file: string): Promise<{ text?: string; odd?: true }> {
  let handle: Awaited<ReturnType<typeof openRegular>>;
  try {
    handle = await openRegular(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? {} : { odd: true };
  }
  try {
    if ((await handle.stat()).size > MAX_READ) return { odd: true };
    return { text: decoded(await handle.readFile()) };
  } catch {
    return { odd: true };
  } finally {
    await handle.close();
  }
}

/**
 * A file's text as Claude Code reads it: UTF-8 with its byte-order mark left out, or UTF-16 when it
 * starts with one, as Windows' Notepad saves either. Kept, the mark made JSON.parse fail.
 */
function decoded(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const text = bytes.toString('utf8');
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

/**
 * A JSON file's value (undefined when it is missing or not JSON), whether it is not a regular file,
 * and whether it has words that are not JSON as Pelican reads it: Claude Code may read more than
 * that, so a folder's such file is asked about rather than taken to bring nothing.
 */
async function readJsonFile(file: string): Promise<{ value: unknown; odd?: true; unparsed?: true }> {
  const { text, odd } = await readText(file);
  try {
    return { value: text === undefined ? undefined : JSON.parse(text) as unknown, ...(odd ? { odd } : {}) };
  } catch {
    return { value: undefined, ...(text?.trim() ? { unparsed: true as const } : {}) };
  }
}

const readJson = async (file: string): Promise<unknown> => (await readJsonFile(file)).value;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Whether a folder is itself a git directory (HEAD, objects, refs), which git takes as a repository. */
async function isGitDirectory(dir: string): Promise<boolean> {
  const [head, objects, refs] = await Promise.all(['HEAD', 'objects', 'refs'].map((name) => stat(path.join(dir, name)).catch(() => undefined)));
  return Boolean(head?.isFile() && objects?.isDirectory() && refs?.isDirectory());
}

/** The top of the git repository a folder is in, by its `.git`, or a git directory git would use (this runs nothing). */
async function gitRoot(dir: string): Promise<string | undefined> {
  for (let d = dir; ; d = path.dirname(d)) {
    if ((await exists(path.join(d, '.git'))) || (await isGitDirectory(d))) return d;
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
// Claude Code keeps its own), oldest first; at most this many answers to trust.
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
  // Answers to trust are kept up to a number, the oldest going first (each scratch session gives
  // one). "Use my settings only" is never let go of: the folder would count as trusted again,
  // through the very sessions started that way.
  let trusted = [...folders.values()].filter((kept) => kept === 'trusted').length;
  for (const [folder, kept] of folders) {
    if (trusted <= MAX_CHOICES) break;
    if (kept !== 'trusted') continue;
    folders.delete(folder);
    trusted -= 1;
  }
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

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** Settings that run a command of the folder's choosing, as Claude Code's trust dialog lists them. */
const HELPERS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'proxyAuthHelper'];

function fromSettings(settings: unknown): Item[] {
  if (!isObject(settings)) return [];
  const found: Item[] = [];
  if (isObject(settings.hooks)) {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of isObject(group) && Array.isArray(group.hooks) ? group.hooks : []) {
          if (!isObject(hook)) continue;
          if (typeof hook.command !== 'string') {
            found.push(said(`${event} hook: ${typeof hook.url === 'string' ? hook.url : String(hook.type ?? 'hook')}`));
          } else if (Array.isArray(hook.args)) {
            // Its exec form: the program, run with these arguments and no shell.
            found.push(runs(`${event} hook: `, [hook.command, ...hook.args.map(String)].join(' '), 'argv'));
          } else {
            // Run by a shell, or by PowerShell, which takes every space for one (but in what it hands a POSIX shell).
            found.push(runs(`${event} hook: `, hook.command, hook.shell === 'powershell' ? 'powershell' : 'shell'));
          }
        }
      }
    }
  }
  for (const name of HELPERS) if (typeof settings[name] === 'string') found.push(runs(`${name}: `, settings[name] as string, 'shell'));
  if (isObject(settings.env) && Object.keys(settings.env).length > 0) found.push(said(`Environment variables: ${Object.keys(settings.env).join(', ')}`));
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  if (strings(permissions.allow).length > 0) found.push(said(`Allowed without asking: ${strings(permissions.allow).join(', ')}`));
  if (strings(permissions.additionalDirectories).length > 0) found.push(said(`Extra folders: ${strings(permissions.additionalDirectories).join(', ')}`));
  if (typeof permissions.defaultMode === 'string' && !['default', 'plan', 'dontAsk'].includes(permissions.defaultMode)) {
    found.push(said(`Permission mode: ${permissions.defaultMode}`));
  }
  const plugins = isObject(settings.enabledPlugins) ? Object.entries(settings.enabledPlugins).filter(([, on]) => on).map(([name]) => name) : [];
  if (plugins.length > 0) found.push(said(`Plugins: ${plugins.join(', ')}`));
  if (isObject(settings.extraKnownMarketplaces) && Object.keys(settings.extraKnownMarketplaces).length > 0) {
    found.push(said(`Plugin marketplaces: ${Object.keys(settings.extraKnownMarketplaces).join(', ')}`));
  }
  if (typeof settings.autoMemoryDirectory === 'string') found.push(said(`Memory folder: ${settings.autoMemoryDirectory}`));
  return found;
}

function fromMcp(file: unknown): Item[] {
  if (!isObject(file) || !isObject(file.mcpServers)) return [];
  return Object.entries(file.mcpServers).map(([name, server]) => {
    if (!isObject(server)) return said(`MCP server ${name}`);
    // A server's program starts with its arguments and no shell; its headers helper runs in one.
    const command = typeof server.command === 'string' ? [server.command, ...strings(server.args)].join(' ') : undefined;
    const target = command ?? (typeof server.url === 'string' ? server.url : undefined);
    const item = target === undefined ? said(`MCP server ${name}`) : command === undefined ? said(`MCP server ${name}: ${target}`) : runs(`MCP server ${name}: `, command, 'argv');
    if (typeof server.headersHelper !== 'string') return item;
    const helper = runs(`${item.text} (headersHelper: `, server.headersHelper, 'shell', ')');
    return { text: helper.text, commands: [...item.commands, ...helper.commands] };
  });
}

/** Frontmatter keys that give a command, skill or agent powers of its own (Claude Code reads them in any case and with `_` for `-`). */
const POWERS = /(?:^|[{,])[ \t]*["']?(allowed[-_]?tools|hooks|mcp[-_]?servers|permission[-_]?mode)["']?[ \t]*:(.*)$/i;

/**
 * What a project's command, skill or agent may run without asking: tools its frontmatter allows,
 * hooks, MCP servers, a permission mode; and for a command or a skill, the shell it runs as it
 * starts (`!` and a command in backticks, or a ```! block), as Claude Code finds them.
 */
function fromMarkdown(what: string, text: string, shell: boolean): Item[] {
  const found: Item[] = [];
  // Found as Claude Code finds it: the closing --- may end a line rather than stand on its own. Its
  // YAML ends a line at a carriage return alone too.
  const front = /^\uFEFF?---\s*\n([\s\S]*?)---\s*\n?/.exec(text.replace(/\r\n?/g, '\n'))?.[1];
  const lines = front?.split('\n') ?? [];
  const indent = (line: string) => /^[ \t]*/.exec(line)![0].length;
  // Keys of the frontmatter itself, not of a map inside it.
  const top = indent(lines.find((line) => line.trim() && !line.trim().startsWith('#')) ?? '');
  const under = (line: string) => !line.trim() || indent(line) > top || (indent(line) === top && line.trim().startsWith('-'));
  lines.forEach((line, i) => {
    const power = POWERS.exec(line);
    if (!power || (indent(line) !== top && !line.includes('{'))) return;
    // A key of the frontmatter's with the lines under it (a list, a map, a block of text), as they
    // are written, each on its line: YAML reads a line break in a block as one, and a line that
    // went on from a `#` would read as a comment. Up to the next key, so each line is read once. A
    // flow map's line inside another value is that line alone.
    const block = [line.slice(indent(line)).trimEnd()];
    if (indent(line) === top) {
      for (let j = i + 1; j < lines.length && under(lines[j]!); j += 1) block.push(lines[j]!.slice(Math.min(top, indent(lines[j]!))).trimEnd());
      while (block.length > 1 && !block.at(-1)!.trim()) block.pop();
    }
    const mode = [power[2]!, ...block.slice(1)].map((part) => part.trim()).filter(Boolean).join(' ').replace(/^["']|["']$/g, '');
    if (/^permission/i.test(power[1]!) && ['default', 'plan', 'dontAsk'].includes(mode)) return;
    // Hooks and MCP servers hold commands in YAML: shown as written, every space but a plain one written out.
    const shown = block.join('\n');
    found.push(/^(?:hooks|mcp)/i.test(power[1]!) ? runs(`${what}: `, shown, 'argv') : said(`${what}: ${shown}`));
  });
  // YAML says the same thing in more ways than a line scan reads (escapes, ? keys, tags, flow maps):
  // frontmatter that uses them and names a power anywhere is asked about, and says so beside what
  // was read of it, as an escape such as `\n` reads otherwise than it is written.
  if (front && /allowed|hook|mcp|permission/i.test(front) && (/\\|^[ \t]*\?|!!/m.test(front) || (found.length === 0 && front.includes('{')))) {
    found.push(said(`${what}: settings Pelican cannot read in full`));
  }
  if (shell) {
    for (const block of text.matchAll(/```!\s*\n?([\s\S]*?)\n?```/g)) found.push(runs(`${what} runs: `, block[1]!.trim(), 'shell'));
    for (const inline of text.matchAll(/(?<=^|\s)!`([^`]+)`/g)) found.push(runs(`${what} runs: `, inline[1]!, 'shell'));
  }
  return found;
}

/** Where Claude Code finds a project's commands, skills and agents in each folder's `.claude`. */
const MARKDOWN = [['commands', 'Command'], ['skills', 'Skill'], ['agents', 'Agent']] as const;

/**
 * More than any project has: past this many files (or entries looked at), the folder is asked
 * about instead of being read without end.
 */
type Budget = { files: number; entries: number };
const budgetFor = (): Budget => ({ files: 500, entries: 10_000 });
const spent = (budget: Budget) => budget.files < 0 || budget.entries < 0;

/** The Markdown files in a folder and its subfolders, as Claude Code finds them (through links too). */
async function markdownIn(root: string, budget: Budget): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    const key = await realpath(dir).catch(() => dir);
    if (seen.has(key) || depth > 10) return;
    seen.add(key);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (spent(budget) || (budget.entries -= 1) < 0) return;
      const full = path.join(dir, entry.name);
      const isDir = entry.isSymbolicLink() ? await stat(full).then((s) => s.isDirectory(), () => false) : entry.isDirectory();
      if (isDir) await walk(full, depth + 1);
      else if (entry.name.endsWith('.md') && (budget.files -= 1) >= 0) files.push(full);
    }
  };
  await walk(root, 0);
  return files;
}

/** What a folder's own commands, skills and agents bring (see fromMarkdown). */
async function fromClaudeFolder(dir: string, from: string, budget: Budget): Promise<Item[]> {
  const found: Item[] = [];
  for (const [kind, what] of MARKDOWN) {
    const root = path.join(dir, '.claude', kind);
    for (const file of await markdownIn(root, budget)) {
      const skill = /^skill\.md$/i.test(path.basename(file));
      // A skill is its SKILL.md; the other files in its folder are documents Claude may read.
      if (kind === 'skills' && !skill && path.dirname(file) !== root) continue;
      const { text, odd } = await readText(file);
      if (odd || text === undefined) {
        found.push(said(`Cannot be read: ${path.relative(from, file)}`));
        continue;
      }
      const name = path.relative(root, skill ? path.dirname(file) : file.slice(0, -'.md'.length)) || path.basename(root);
      found.push(...fromMarkdown(`${what} ${kind === 'commands' ? '/' : ''}${name}`, text, kind !== 'agents'));
    }
  }
  return found;
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
    // config.worktree counts whenever git reads extensions.worktreeConfig as true, however it is
    // spelled (2, 1k, 0x1 and -1 are true too): ask git rather than parse it. With the extension
    // off, --worktree reads the same file as --local, or refuses where there are several worktrees.
    const seen = new Set(entries.map((e) => e.file));
    try {
      entries.push(...(await gitConfig(top, ['--worktree'])).filter((e) => !seen.has(e.file)));
    } catch (error) {
      if (!/worktreeConfig is enabled|extension worktreeConfig/i.test(String((error as Error).message))) throw error;
    }
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
function gitPrograms(repo: GitConfig): Item[] {
  const found: Item[] = [];
  for (const entry of repo.entries) {
    const { section, subsection, key } = nameParts(entry.name);
    if (section === 'filter' && ['clean', 'smudge', 'process'].includes(key) && entry.value) {
      found.push(runs(`Git filter ${subsection ?? ''}: `, entry.value, 'shell'));
    } else if (section === 'core' && key === 'fsmonitor' && !['false', 'true', '0', '1', 'no', 'yes', 'off', 'on', ''].includes(entry.value.toLowerCase())) {
      found.push(runs('Git fsmonitor: ', entry.value, 'shell'));
    } else if (section === 'core' && key === 'hookspath' && entry.value) {
      found.push(said(`Git hooks folder: ${entry.value}`));
    }
  }
  // An included file can change (another branch, a pull), and with it what git runs.
  for (const include of repo.includes) found.push(said(`Git config includes: ${include}`));
  if (repo.unread) found.push(said(UNREAD_GIT));
  return found;
}

/** What git would run of the repository's own config, also when git could not read it all. */
async function gitBrings(top: string): Promise<Item[]> {
  try {
    const repo = await repositoryConfig(top);
    return repo ? gitPrograms(repo) : [];
  } catch {
    return [said(UNREAD_GIT)];
  }
}

/**
 * What the folder brings: read from its files, nothing run. Settings, MCP servers, commands,
 * skills and agents of the folder and its parents up to the repository's top (Claude Code reads
 * the project's from there), never those of the home folder, which are the user's own (by either
 * of its paths: the folder's is a real one); and what the repository's git config runs.
 */
export async function whatFolderBrings(folder: string): Promise<Brings> {
  const dir = await real(folder);
  const homes = new Set([os.homedir(), await real(os.homedir())]);
  const top = await gitRoot(dir);
  const found: Item[] = [];
  // A file of the folder's that is not a regular file, or not JSON, is asked about instead.
  const json = async (file: string): Promise<unknown> => {
    const { value, odd, unparsed } = await readJsonFile(file);
    if (odd || unparsed) found.push(said(`Cannot be read: ${path.relative(dir, file)}`));
    return value;
  };
  const budget = budgetFor();
  for (let d = dir; !homes.has(d); d = path.dirname(d)) {
    for (const name of ['settings.json', 'settings.local.json']) found.push(...fromSettings(await json(path.join(d, '.claude', name))));
    found.push(...fromMcp(await json(path.join(d, '.mcp.json'))));
    found.push(...(await fromClaudeFolder(d, dir, budget)));
    if (d === top || path.dirname(d) === d) break;
  }
  if (spent(budget)) found.push(said('More commands, skills and agents than Pelican reads'));
  if (top) found.push(...(await gitBrings(top)));
  // Every item, each whole: the part of a command that matters can come after any amount of
  // padding, or after any number of harmless items (the sheet scrolls). Once each: an item said
  // twice with its commands in other places has every space but a plain one written out.
  const items = new Map<string, CommandAt[]>();
  for (const { text, commands } of found) {
    const known = items.get(text);
    items.set(text, known === undefined || JSON.stringify(known) === JSON.stringify(commands) ? commands : [[0, text.length, 'argv']]);
  }
  return { brings: [...items.keys()], commands: [...items.values()] };
}

/** What the folder brings (whatFolderBrings), item by item. */
export async function folderBrings(folder: string): Promise<string[]> {
  return (await whatFolderBrings(folder)).brings;
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
export async function trustQuestion(folder: string): Promise<({ folder: string } & Brings) | undefined> {
  if (await folderTrusted(folder)) return undefined;
  const { brings, commands } = await whatFolderBrings(folder);
  return brings.length > 0 ? { folder: await real(folder), brings, commands } : undefined;
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
  const { brings, commands } = await whatFolderBrings(dir);
  if (brings.length === 0) return FULL_SETTINGS;
  throw new NeedsTrust(dir, brings, commands);
}

/** For tests: forget what was read. */
export function forgetTrust(): void {
  ranCache.clear();
  claudeConfig = undefined;
  choices = undefined;
  gitWorks = undefined;
}
