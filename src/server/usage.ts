import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';

import type { UsageLimit } from '../shared/protocol.js';

/** The account's usage limits as Claude Code last reported them, one per kind of limit. */
const limits = new Map<string, UsageLimit>();

export function recordLimit(info: SDKRateLimitInfo): void {
  const type = info.rateLimitType ?? 'unknown';
  limits.set(type, {
    type,
    status: info.status,
    ...(typeof info.utilization === 'number' ? { utilization: info.utilization } : {}),
    ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt } : {}),
    at: Date.now(),
  });
}

export function usageLimits(): UsageLimit[] {
  const now = Date.now();
  // A limit that has reset since it was reported says nothing any more.
  return [...limits.values()].filter((limit) => !limit.resetsAt || limit.resetsAt > now);
}
