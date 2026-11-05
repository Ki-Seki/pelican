import { useSyncExternalStore } from 'react';

import type { PermissionRequest } from '../../shared/protocol';
import { describeTool } from './tools';

/**
 * What screen readers are told, through one polite live region for the whole app: Claude asking
 * for something, a reply that came in, an error, the connection. Said once per change, never per
 * streamed word.
 */
let current = '';
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function announce(text: string): void {
  if (!text.trim()) return;
  // Emptied first, so the same words said twice are heard twice.
  current = '';
  notify();
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = text;
    notify();
  }, 60);
}

export function useAnnouncement(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** Markdown as it would be read aloud: the words, without the marks around them. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * Claude asking, in a sentence: the same words as the card, then what can be answered. `short`
 * leaves the answers out, to name the card itself.
 */
export function askedFor(request: PermissionRequest, cwd?: string, short = false): string {
  if (request.toolName === 'AskUserQuestion') {
    const questions = Array.isArray(request.input.questions) ? (request.input.questions as Array<{ question?: unknown }>) : [];
    const first = typeof questions[0]?.question === 'string' ? questions[0].question : '';
    const lead = questions.length > 1 ? `Claude has ${questions.length} questions` : 'Claude has a question';
    return short || !first ? lead : `${lead}. ${first}`;
  }
  if (request.toolName === 'ExitPlanMode') return short ? 'Claude’s plan' : 'Claude’s plan is ready for review.';
  const summary = describeTool(request.toolName, request.input, cwd);
  const target = summary.target ? ` ${summary.path ? summary.target.split('/').pop() : clip(summary.target, 80)}` : '';
  const asks = `Claude wants to ${summary.verb.toLowerCase()}${target}`;
  return short ? asks : `${asks}. ${request.canRemember ? 'Allow, Always allow or Deny.' : 'Allow or Deny.'}`;
}

export type ChatMoment = { permissions: PermissionRequest[]; busy: boolean; reply?: string; error?: string };

/** What to say when a chat changes from one moment to the next, if anything. */
export function announcement(before: ChatMoment, after: ChatMoment, cwd?: string): string | undefined {
  const fresh = after.permissions.find((p) => !before.permissions.some((q) => q.id === p.id));
  if (fresh) return askedFor(fresh, cwd);
  if (before.busy && !after.busy) {
    if (after.error) return `Claude stopped. ${clip(after.error, 200)}`;
    return after.reply ? `Claude replied. ${clip(plainText(after.reply), 300)}` : 'Claude finished.';
  }
  return undefined;
}
