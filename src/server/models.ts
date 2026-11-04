import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ModelOption } from '../shared/protocol.js';
import { config } from './config.js';

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; models: ModelOption[] } | undefined;
let inflight: Promise<ModelOption[]> | undefined;

/** A prompt stream that never yields: the process starts, answers control requests, and sends no turn. */
const idlePrompt: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
};

function toOption(info: ModelInfo): ModelOption {
  return {
    value: info.value,
    label: info.displayName || info.value,
    description: info.description ?? '',
    efforts: info.supportedEffortLevels ?? [],
    supportsFast: Boolean(info.supportsFastMode),
    ...(info.resolvedModel ? { resolvedModel: info.resolvedModel } : {}),
  };
}

/**
 * The models this account can use, with their effort levels and fast-mode
 * support, as the CLI reports them. Costs no tokens and writes no transcript.
 */
async function fetchModels(): Promise<ModelOption[]> {
  const q = query({
    prompt: idlePrompt,
    options: {
      cwd: os.homedir(),
      persistSession: false,
      settingSources: ['user'],
      ...(config.claudeExecutable ? { pathToClaudeCodeExecutable: config.claudeExecutable } : {}),
    },
  });
  try {
    return (await q.supportedModels()).map(toOption);
  } finally {
    q.close();
  }
}

export async function listModels(): Promise<ModelOption[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
  inflight ??= fetchModels()
    .then((models) => {
      cache = { at: Date.now(), models };
      return models;
    })
    .finally(() => {
      inflight = undefined;
    });
  try {
    return await inflight;
  } catch (error) {
    if (cache) return cache.models;
    throw error;
  }
}
