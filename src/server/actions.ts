import { deleteSession, forkSession } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage } from '../shared/protocol.js';
// The conversation as the app shows it: the export leaves out what the view leaves out.
import { buildItems, cleanOutput } from '../web/lib/turns.js';
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

/** Backticks around code, more of them than any run inside it, so nothing in it ends the code. */
const fence = (code: string, fewest: number) => '`'.repeat(Math.max(fewest, ...Array.from(code.matchAll(/`+/g), (run) => run[0].length + 1)));
const inlineCode = (code: string) => (code.includes('`') ? `${fence(code, 1)} ${code} ${fence(code, 1)}` : `\`${code}\``);
const codeBlock = (code: string) => `${fence(code, 3)}\n${code}\n${fence(code, 3)}`;

/**
 * The conversation as Markdown, as the conversation shows it: prompts and replies in full, a `!`
 * command with its output, tool calls as one line each. What the conversation leaves out stays
 * out: the notes Claude Code and Pelican give Claude with a prompt (a side chat's note, in a
 * system reminder), the tags around commands, Claude Code's own lines, and a compaction's summary.
 */
export async function exportMarkdown(sessionId: string): Promise<{ title: string; markdown: string }> {
  const info = await sessionInfo(sessionId);
  const title = info?.customTitle || info?.summary || 'Claude Code session';
  const messages: ChatMessage[] = await loadMessages(sessionId);
  const out: string[] = [`# ${title}`, ''];
  if (info?.cwd) out.push(`Folder: \`${info.cwd}\``, '');
  let speaker: string | undefined;
  const say = (who: 'You' | 'Claude', blocks: string[]) => {
    if (blocks.length === 0) return;
    if (who !== speaker) out.push(`## ${who}`, '');
    speaker = who;
    for (const block of blocks) out.push(block, '');
  };
  // What the conversation view shows, read the same way.
  for (const item of buildItems(messages)) {
    if (item.kind === 'user') {
      const text = item.command ? `${item.command.name} ${item.command.args}`.trim() : item.text;
      say('You', [...(text ? [text] : []), ...(item.files.length > 0 ? [`Attached: ${item.files.map((file) => file.name).join(', ')}`] : [])]);
    } else if (item.kind === 'shell') {
      const output = [item.stdout, item.stderr].map(cleanOutput).filter((part) => part.trim()).join('\n').replace(/^\s*\n/, '').trimEnd();
      say('You', [inlineCode(`!${item.command}`), ...(output ? [codeBlock(output)] : [])]);
    } else if (item.kind === 'assistant') {
      const blocks: string[] = [];
      let tools: string[] = [];
      for (const part of item.parts) {
        if (part.kind === 'tool') tools.push(toolLine(part.call.name, part.call.input));
        else if (part.kind === 'text' && part.text.trim()) {
          if (tools.length > 0) blocks.push(tools.join('\n'));
          tools = [];
          blocks.push(part.text.trim());
        }
      }
      if (tools.length > 0) blocks.push(tools.join('\n'));
      say('Claude', blocks);
    } else if (item.kind === 'compact') {
      out.push('*Context compacted*', '');
      speaker = undefined;
    }
    // Claude Code's notes (a command's output, an interruption, a failed request) and the days
    // are neither side of the conversation.
  }
  return { title, markdown: `${out.join('\n').trim()}\n` };
}
