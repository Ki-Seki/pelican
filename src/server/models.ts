import { realpath } from 'node:fs/promises';
import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AccountInfo, AgentInfo, McpServerStatus, ModelInfo, SDKControlGetUsageResponse, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

import type { Account, Agent, Command, McpServer, ModelOption, PlanUsage } from '../shared/protocol.js';
import { config } from './config.js';
import { DEMO_MODELS } from './demo.js';
import { folderTrusted } from './trust.js';

const TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_PROBES = 2;

/** A prompt stream that never yields: the process starts, answers control requests, and sends no turn. */
const idlePrompt: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
};

let running = 0;
const waiting: (() => void)[] = [];

/** At most MAX_PROBES Claude processes at a time, however many requests ask. */
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PROBES) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

const inflight = new Map<string, Promise<unknown>>();

/**
 * Starts Claude Code without a conversation in `cwd`, asks it something, and
 * stops it. Costs no tokens and writes no transcript. One probe per folder and
 * question at a time; it gives up after PROBE_TIMEOUT_MS.
 *
 * A probe is only a look, so it fires no hooks. In a folder nobody trusted it starts in the home
 * folder with the user's settings only: Claude Code runs git where it starts, and the folder's own
 * git config can name programs git runs (trust.ts).
 */
async function probe<T>(key: string, cwd: string, ask: (q: ReturnType<typeof query>) => Promise<T>): Promise<T> {
  const dir = await realpath(cwd);
  const id = `${key}:${dir}`;
  const pending = inflight.get(id);
  if (pending) return pending as Promise<T>;
  const work = slot(async () => {
    const trusted = await folderTrusted(dir);
    const q = query({
      prompt: idlePrompt,
      options: {
        cwd: trusted ? dir : os.homedir(),
        persistSession: false,
        settingSources: trusted ? ['user', 'project', 'local'] : ['user'],
        settings: { disableAllHooks: true },
        ...(config.claudeExecutable ? { pathToClaudeCodeExecutable: config.claudeExecutable } : {}),
      },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude Code did not answer in time.')), PROBE_TIMEOUT_MS);
      });
      return await Promise.race([ask(q), timeout]);
    } finally {
      clearTimeout(timer);
      q.close();
    }
  }).finally(() => inflight.delete(id));
  inflight.set(id, work);
  return work;
}

function toOption(info: ModelInfo): ModelOption {
  return {
    value: info.value,
    label: info.displayName || info.value,
    description: info.description ?? '',
    efforts: info.supportedEffortLevels ?? [],
    supportsFast: Boolean(info.supportsFastMode),
    ...(info.supportsAutoMode !== undefined ? { supportsAuto: info.supportsAutoMode } : {}),
    ...(info.resolvedModel ? { resolvedModel: info.resolvedModel } : {}),
  };
}

export type ModelList = { models: ModelOption[]; signedIn: boolean | null; account?: Account; version?: string };

let cache: { at: number; value: ModelList } | undefined;

/**
 * Whether Claude Code has a way to call the API. Signed out, it still names the first-party API
 * as its provider, and its token source as 'none'; a third-party provider (Bedrock, Vertex, a
 * gateway) signs in outside Claude Code, so it counts as signed in.
 */
export function signedInFrom(account: AccountInfo): boolean {
  const some = (value: string | undefined) => Boolean(value && value !== 'none');
  return Boolean(account.email || account.subscriptionType || some(account.apiKeySource) || some(account.tokenSource)
    || (account.apiProvider && account.apiProvider !== 'firstParty'));
}

/**
 * Claude Code failing to start, in Pelican's words: the SDK's own text names an option of the
 * SDK, not the setting a Pelican user has.
 */
export function startError(text: string): string | undefined {
  const missing = text.match(/(?:native binary|Claude Code executable) not found at (.+?)\. (?:Please|Is)/);
  if (!missing && !/native binary not found|Claude Code executable not found/.test(text)) return undefined;
  const at = missing?.[1] ? ` at ${missing[1]}` : '';
  return `Pelican could not find Claude Code${at}. Set PELICAN_CLAUDE_PATH to the claude program on ${config.machine}, or reinstall Pelican.`;
}

/**
 * The models this account can use, with their effort levels and fast-mode
 * support, as Claude Code reports them, and whether Claude Code is signed in.
 */
export async function listModels(): Promise<ModelList> {
  if (config.demo) return { models: DEMO_MODELS, signedIn: true, account: { email: 'you@example.com', plan: 'max' } };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const asking = probe('models', os.homedir(), async (q) => {
    const init = await q.initializationResult();
    const models = init.models.map(toOption);
    const account: AccountInfo | undefined = init.account;
    const who: Account | undefined = account?.email || account?.organization || account?.subscriptionType
      ? {
        ...(account.email ? { email: account.email } : {}),
        ...(account.organization ? { organization: account.organization } : {}),
        ...(account.subscriptionType ? { plan: account.subscriptionType } : {}),
      }
      : undefined;
    return {
      models,
      signedIn: account ? signedInFrom(account) : null,
      ...(who ? { account: who } : {}),
      ...(init.claude_code_version ? { version: init.claude_code_version } : {}),
    };
  })
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    });
  try {
    return await asking;
  } catch (error) {
    if (cache) return cache.value;
    const readable = startError((error as Error).message);
    throw readable ? new Error(readable) : error;
  }
}

/** The model list as last read, without starting Claude Code to read it. */
export const knownModels = (): ModelOption[] | undefined => (config.demo ? DEMO_MODELS : cache?.value.models);

/** Whether the account pays through a Claude plan (Pro, Max, Team…), as last read; then dollar costs mean nothing to it. */
export const onSubscription = (): boolean => Boolean(cache?.value.account?.plan);

/**
 * Claude Code's state on this machine for a line at start-up: its version and whether it is
 * signed in, or why it cannot start.
 */
export async function claudeCodeStatus(): Promise<{ version?: string; signedIn: boolean | null } | { error: string }> {
  try {
    const list = await listModels();
    return { signedIn: list.signedIn, ...(list.version ? { version: list.version } : {}) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

const DEMO_COMMANDS: Command[] = [
  { name: 'compact', description: 'Clear history but keep a summary in context', argumentHint: '', builtin: true },
  { name: 'fork', description: 'Copy this conversation into a new background session and keep working here', argumentHint: '', builtin: true },
  { name: 'review', description: 'Review the changes on this branch', argumentHint: '', builtin: true },
  { name: 'init', description: 'Write a CLAUDE.md for this project', argumentHint: '', builtin: true },
  { name: 'context', description: 'Show how full the context window is', argumentHint: '', builtin: true },
  { name: 'ship', description: 'Run the checks, then open a pull request (project)', argumentHint: '[base branch]' },
];
const DEMO_AGENTS: Agent[] = [{ name: 'code-reviewer', description: 'Reviews a change for bugs and style' }];

export type Completions = { commands: Command[]; agents: Agent[] };
const completionCache = new Map<string, { at: number; value: Completions }>();

/**
 * Commands whose screen is Claude Code's terminal; a phone has nowhere to show them. Claude Code
 * names more in each session's start (`terminal_slash_commands`), which runs add here.
 */
const terminalCommands = new Set(['exit', 'quit', 'statusline', 'terminal-setup', 'theme', 'doctor', 'color', 'focus', 'vim', 'keybindings', 'ide']);

export function noteTerminalCommands(names: string[]): void {
  for (const name of names) terminalCommands.add(name);
}

/** The commands and agents Claude Code lists, in the app's terms, without the terminal's own. */
export function toCompletions(commands: SlashCommand[], agents: AgentInfo[]): Completions {
  return {
    commands: commands
      .filter((c) => !terminalCommands.has(c.name))
      .map((c) => ({ name: c.name, description: c.description ?? '', argumentHint: c.argumentHint ?? '', ...(c.builtin ? { builtin: true } : {}) })),
    agents: agents.map((a) => ({ name: a.name, description: a.description ?? '' })),
  };
}

/** A folder's list changed (Claude Code found skills while it worked there): asked again next time. */
export async function forgetCompletions(cwd: string): Promise<void> {
  completionCache.delete(await realpath(cwd).catch(() => cwd));
}

/** Slash commands (built-in, the project's and the user's, skills) and subagents available in a folder. */
export async function listCompletions(cwd: string): Promise<Completions> {
  if (config.demo) return { commands: DEMO_COMMANDS, agents: DEMO_AGENTS };
  const dir = await realpath(cwd);
  const cached = completionCache.get(dir);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = await probe('completions', dir, async (q) => {
    const [commands, agents] = await Promise.all([q.supportedCommands(), q.supportedAgents().catch(() => [])]);
    return toCompletions(commands, agents);
  });
  completionCache.set(dir, { at: Date.now(), value });
  return value;
}

export function toMcpServers(list: McpServerStatus[]): McpServer[] {
  return list.map((server) => ({
    name: server.name,
    status: server.status,
    ...(server.error ? { error: server.error } : {}),
    tools: server.tools?.length ?? 0,
    ...(server.scope ? { scope: server.scope } : {}),
  }));
}

const mcpCache = new Map<string, { at: number; servers: McpServer[] }>();

/** The MCP servers a session in this folder gets, and whether they connect, when no Claude runs there. */
export async function probeMcpServers(cwd: string): Promise<McpServer[]> {
  if (config.demo) return [{ name: 'github', status: 'connected', tools: 26, scope: 'user' }, { name: 'linear', status: 'needs-auth', tools: 0, scope: 'project' }];
  const dir = await realpath(cwd);
  const cached = mcpCache.get(dir);
  if (cached && Date.now() - cached.at < 60_000) return cached.servers;
  const servers = toMcpServers(await probe('mcp', dir, (q) => q.mcpServerStatus()));
  mcpCache.set(dir, { at: Date.now(), servers });
  return servers;
}

const DEMO_PLAN: PlanUsage = {
  windows: [
    { type: 'five_hour', utilization: 0.42, resetsAt: Date.now() + 2.4 * 3600_000 },
    { type: 'seven_day', utilization: 0.18, resetsAt: Date.now() + 3.5 * 86400_000 },
  ],
};

type Window = { utilization: number | null; resets_at: string | null } | null | undefined;
let planCache: { at: number; value: PlanUsage | null } | undefined;

/**
 * The plan's usage, as Claude Code's `/usage` reads it from claude.ai: the windows of a Pro or
 * Max plan, and the monthly cap on extra usage that Team and Enterprise plans have instead.
 * Null where plan limits do not apply (an API key, Bedrock, Vertex) or the answer is not there.
 * The SDK marks this call experimental, so anything unexpected is no answer, not an error.
 */
export async function planUsage(): Promise<PlanUsage | null> {
  if (config.demo) return DEMO_PLAN;
  if (planCache && Date.now() - planCache.at < 60_000) return planCache.value;
  const value = await probe('usage', os.homedir(), async (q) => {
    const ask = (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<SDKControlGetUsageResponse> })
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof ask !== 'function') return null;
    const answer = await ask.call(q, { skipBehaviors: true });
    const limits = answer?.rate_limits;
    if (!answer?.rate_limits_available || !limits) return null;
    const windows: PlanUsage['windows'] = [];
    const add = (type: string, window: Window, label?: string) => {
      if (!window || typeof window.utilization !== 'number') return;
      const resetsAt = window.resets_at ? Date.parse(window.resets_at) : NaN;
      windows.push({ type, ...(label ? { label } : {}), utilization: window.utilization / 100, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) });
    };
    add('five_hour', limits.five_hour);
    add('seven_day', limits.seven_day);
    add('seven_day_opus', limits.seven_day_opus);
    add('seven_day_sonnet', limits.seven_day_sonnet);
    for (const scoped of limits.model_scoped ?? []) add(`model:${scoped.display_name}`, scoped, `Weekly ${scoped.display_name} limit`);
    const extra = limits.extra_usage;
    return {
      windows,
      ...(extra ? {
        extra: {
          enabled: Boolean(extra.is_enabled),
          ...(typeof extra.used_credits === 'number' ? { usedCents: extra.used_credits } : {}),
          ...(typeof extra.monthly_limit === 'number' ? { limitCents: extra.monthly_limit } : {}),
          ...(typeof extra.utilization === 'number' ? { utilization: extra.utilization / 100 } : {}),
          ...(extra.currency ? { currency: extra.currency } : {}),
        },
      } : {}),
    };
  }).catch(() => null);
  planCache = { at: Date.now(), value };
  return value;
}
