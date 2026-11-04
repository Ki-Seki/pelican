import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerStatus, ModelInfo, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

import type { Account, Agent, Command, McpServer, ModelOption } from '../shared/protocol.js';
import { config } from './config.js';
import { DEMO_MODELS } from './demo.js';

const TTL_MS = 10 * 60 * 1000;

/** A prompt stream that never yields: the process starts, answers control requests, and sends no turn. */
const idlePrompt: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
};

/**
 * Starts Claude Code without a conversation, asks it something, and stops it.
 * Costs no tokens and writes no transcript.
 */
async function probe<T>(cwd: string, ask: (q: ReturnType<typeof query>) => Promise<T>): Promise<T> {
  const q = query({
    prompt: idlePrompt,
    options: {
      cwd,
      persistSession: false,
      settingSources: ['user', 'project', 'local'],
      ...(config.claudeExecutable ? { pathToClaudeCodeExecutable: config.claudeExecutable } : {}),
    },
  });
  try {
    return await ask(q);
  } finally {
    q.close();
  }
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
let inflight: Promise<ModelList> | undefined;

/**
 * The models this account can use, with their effort levels and fast-mode
 * support, as Claude Code reports them, and whether Claude Code is signed in.
 */
export async function listModels(): Promise<ModelList> {
  if (config.demo) return { models: DEMO_MODELS, signedIn: true, account: { email: 'you@example.com', plan: 'max' } };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  inflight ??= probe(os.homedir(), async (q) => {
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
    })
    .finally(() => {
      inflight = undefined;
    });
  try {
    return await inflight;
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
  const cached = completionCache.get(cwd);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = await probe(cwd, async (q) => {
    const [commands, agents] = await Promise.all([q.supportedCommands(), q.supportedAgents().catch(() => [])]);
    return {
      commands: commands.map((c: SlashCommand) => ({ name: c.name, description: c.description ?? '', argumentHint: c.argumentHint ?? '' })),
      agents: agents.map((a) => ({ name: a.name, description: a.description ?? '' })),
    };
  });
  completionCache.set(cwd, { at: Date.now(), value });
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
  const cached = mcpCache.get(cwd);
  if (cached && Date.now() - cached.at < 60_000) return cached.servers;
  const servers = toMcpServers(await probe(cwd, (q) => q.mcpServerStatus()));
  mcpCache.set(cwd, { at: Date.now(), servers });
  return servers;
}
