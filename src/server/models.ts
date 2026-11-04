import { realpath } from 'node:fs/promises';
import os from 'node:os';

import { listSessions, query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerStatus, ModelInfo, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

import type { Account, Agent, Command, McpServer, ModelOption } from '../shared/protocol.js';
import { config } from './config.js';
import { DEMO_MODELS } from './demo.js';

const TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_PROBES = 2;

/** A prompt stream that never yields: the process starts, answers control requests, and sends no turn. */
const idlePrompt: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
};

/**
 * Whether Claude Code has run in this folder before, so its own settings, hooks
 * and MCP servers are ones the user already let run. A folder Pelican is merely
 * shown (a fresh clone, a download) gets only the user's settings: looking at it
 * must not start what it brings.
 */
async function ranHere(dir: string): Promise<boolean> {
  if (dir === os.homedir()) return true;
  // Claude Code files sessions by the folder's path with punctuation turned into dashes, so
  // `a.b` and `a-b` share a list: a session counts only if it ran in this very folder.
  const sessions = await listSessions({ dir, limit: 50, includeWorktrees: false }).catch(() => []);
  for (const session of sessions) {
    if (!session.cwd) continue;
    if (session.cwd === dir || (await realpath(session.cwd).catch(() => '')) === dir) return true;
  }
  return false;
}

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
 */
async function probe<T>(key: string, cwd: string, ask: (q: ReturnType<typeof query>) => Promise<T>): Promise<T> {
  const dir = await realpath(cwd);
  const id = `${key}:${dir}`;
  const pending = inflight.get(id);
  if (pending) return pending as Promise<T>;
  const work = slot(async () => {
    const q = query({
      prompt: idlePrompt,
      options: {
        cwd: dir,
        persistSession: false,
        settingSources: (await ranHere(dir)) ? ['user', 'project', 'local'] : ['user'],
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

export type ModelList = { models: ModelOption[]; signedIn: boolean | null; account?: Account };

let cache: { at: number; value: ModelList } | undefined;

/**
 * The models this account can use, with their effort levels and fast-mode
 * support, as Claude Code reports them, and whether Claude Code is signed in.
 */
export async function listModels(): Promise<ModelList> {
  if (config.demo) return { models: DEMO_MODELS, signedIn: true, account: { email: 'you@example.com', plan: 'max' } };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const asking = probe('models', os.homedir(), async (q) => {
    const models = (await q.supportedModels()).map(toOption);
    const account = await q.accountInfo().catch(() => undefined);
    const signedIn = account ? Boolean(account.email || account.tokenSource || account.apiKeySource || account.apiProvider) : null;
    const who: Account | undefined = account?.email || account?.organization || account?.subscriptionType
      ? {
        ...(account.email ? { email: account.email } : {}),
        ...(account.organization ? { organization: account.organization } : {}),
        ...(account.subscriptionType ? { plan: account.subscriptionType } : {}),
      }
      : undefined;
    return { models, signedIn, ...(who ? { account: who } : {}) };
  })
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    });
  try {
    return await asking;
  } catch (error) {
    if (cache) return cache.value;
    throw error;
  }
}

const DEMO_COMMANDS: Command[] = [
  { name: 'compact', description: 'Summarize the conversation so far to free up context', argumentHint: '' },
  { name: 'review', description: 'Review the changes on this branch', argumentHint: '' },
  { name: 'init', description: 'Write a CLAUDE.md for this project', argumentHint: '' },
];
const DEMO_AGENTS: Agent[] = [{ name: 'code-reviewer', description: 'Reviews a change for bugs and style' }];

export type Completions = { commands: Command[]; agents: Agent[] };
const completionCache = new Map<string, { at: number; value: Completions }>();

/** Slash commands (built-in, the project's and the user's, skills) and subagents available in a folder. */
export async function listCompletions(cwd: string): Promise<Completions> {
  if (config.demo) return { commands: DEMO_COMMANDS, agents: DEMO_AGENTS };
  const dir = await realpath(cwd);
  const cached = completionCache.get(dir);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = await probe('completions', dir, async (q) => {
    const [commands, agents] = await Promise.all([q.supportedCommands(), q.supportedAgents().catch(() => [])]);
    return {
      commands: commands.map((c: SlashCommand) => ({ name: c.name, description: c.description ?? '', argumentHint: c.argumentHint ?? '' })),
      agents: agents.map((a) => ({ name: a.name, description: a.description ?? '' })),
    };
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
