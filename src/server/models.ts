import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

import type { Command, ModelOption } from '../shared/protocol.js';
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

export type ModelList = { models: ModelOption[]; signedIn: boolean | null };

let cache: { at: number; value: ModelList } | undefined;
let inflight: Promise<ModelList> | undefined;

/**
 * The models this account can use, with their effort levels and fast-mode
 * support, as Claude Code reports them, and whether Claude Code is signed in.
 */
export async function listModels(): Promise<ModelList> {
  if (config.demo) return { models: DEMO_MODELS, signedIn: true };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  inflight ??= probe(os.homedir(), async (q) => {
    const models = (await q.supportedModels()).map(toOption);
    const account = await q.accountInfo().catch(() => undefined);
    const signedIn = account ? Boolean(account.email || account.tokenSource || account.apiKeySource || account.apiProvider) : null;
    return { models, signedIn };
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

const commandCache = new Map<string, { at: number; commands: Command[] }>();

/** Slash commands available in a folder: built-in ones, the project's and the user's, skills. */
export async function listCommands(cwd: string): Promise<Command[]> {
  if (config.demo) return DEMO_COMMANDS;
  const cached = commandCache.get(cwd);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.commands;
  const commands = (await probe(cwd, (q) => q.supportedCommands())).map((c: SlashCommand) => ({
    name: c.name,
    description: c.description ?? '',
    argumentHint: c.argumentHint ?? '',
  }));
  commandCache.set(cwd, { at: Date.now(), commands });
  return commands;
}
