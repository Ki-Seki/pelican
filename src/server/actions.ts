import { deleteSession, forkSession } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage } from '../shared/protocol.js';
import { config } from './config.js';
import { loadMessages, sessionInfo } from './sessions.js';
import { refreshTranscriptIndex } from './transcripts.js';

/**
 * A copy of the session to carry on separately. With `upTo`, the copy ends at
 * that message, which is how "edit and resend" works: the conversation
 * branches before the prompt you change, and the original stays as it was.
 */
export async function fork(sessionId: string, upTo?: string, title?: string): Promise<string> {
  if (config.demo) throw new Error('This is the demo: nothing changes.');
  const info = await sessionInfo(sessionId);
  const result = await forkSession(sessionId, {
    ...(info?.cwd ? { dir: info.cwd } : {}),
    ...(upTo ? { upToMessageId: upTo } : {}),
    ...(title ? { title } : {}),
  });
  await refreshTranscriptIndex();
  return result.sessionId;
}

/**
 * Where a branch that rewrites the message `uuid` starts: the message just
 * before it, or null when `uuid` is the first one (the branch is then a new
 * session in the same folder). Undefined when the message is not there.
 */
export async function messageBefore(sessionId: string, uuid: string): Promise<string | null | undefined> {
  const messages = await loadMessages(sessionId);
  const at = messages.findIndex((m) => m.uuid === uuid);
  if (at < 0) return undefined;
  return at === 0 ? null : messages[at - 1]!.uuid;
}

export async function remove(sessionId: string): Promise<void> {
  if (config.demo) throw new Error('This is the demo: nothing changes.');
  const info = await sessionInfo(sessionId);
  await deleteSession(sessionId, info?.cwd ? { dir: info.cwd } : {});
  await refreshTranscriptIndex();
}

const toolLine = (name: string, input: Record<string, unknown>) => {
  const target = ['file_path', 'command', 'pattern', 'url', 'query', 'description'].map((k) => input[k]).find((v) => typeof v === 'string');
  return `- ${name}${target ? `: \`${String(target).split('\n')[0]}\`` : ''}`;
};

/** The conversation as Markdown: prompts and replies in full, tool calls as one line each. */
export async function exportMarkdown(sessionId: string): Promise<{ title: string; markdown: string }> {
  const info = await sessionInfo(sessionId);
  const title = info?.customTitle || info?.summary || 'Claude Code session';
  const messages: ChatMessage[] = await loadMessages(sessionId);
  const out: string[] = [`# ${title}`, ''];
  if (info?.cwd) out.push(`Folder: \`${info.cwd}\``, '');
  let speaker: string | undefined;
  for (const message of messages) {
    // Claude Code's own notes (a local command's output) are neither side of the conversation.
    if (message.meta || message.parentToolUseId || message.role === 'system') continue;
    const parts: string[] = [];
    const tools: string[] = [];
    for (const block of message.blocks) {
      if (block.type === 'text' && block.text.trim()) parts.push(block.text.trim());
      else if (block.type === 'tool_use') tools.push(toolLine(block.name, block.input));
    }
    if (parts.length === 0 && tools.length === 0) continue;
    const who = message.role === 'user' ? 'You' : 'Claude';
    if (who !== speaker) {
      out.push(`## ${who}`, '');
      speaker = who;
    }
    if (tools.length > 0) out.push(...tools, '');
    if (parts.length > 0) out.push(parts.join('\n\n'), '');
  }
  return { title, markdown: `${out.join('\n').trim()}\n` };
}
