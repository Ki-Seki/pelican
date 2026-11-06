import { deleteSession, forkSession } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage } from '../shared/protocol.js';
import { durationText } from '../shared/workflows.js';
// The conversation as the app shows it: the export leaves out what the view leaves out.
import { buildItems, cleanOutput, type SentFile, type WorkflowNotice } from '../web/lib/turns.js';
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

/** Backticks around code, more of them than any run inside it, so nothing in it ends the code. */
const fence = (code: string, fewest: number) => '`'.repeat(Math.max(fewest, ...Array.from(code.matchAll(/`+/g), (run) => run[0].length + 1)));
const inlineCode = (code: string) => (code.includes('`') ? `${fence(code, 1)} ${code} ${fence(code, 1)}` : `\`${code}\``);
const codeBlock = (code: string) => `${fence(code, 3)}\n${code}\n${fence(code, 3)}`;
/** A command as typed: inline, or a block of its own when it has more lines, which would end inline code. */
const asCode = (code: string) => (/[\r\n]/.test(code) ? codeBlock(code) : inlineCode(code));

const toolLine = (name: string, input: Record<string, unknown>) => {
  const target = ['file_path', 'command', 'pattern', 'url', 'query', 'description'].map((k) => input[k]).find((v) => typeof v === 'string');
  return `- ${name}${target ? `: ${inlineCode(String(target).split(/\r\n?|\n/)[0]!)}` : ''}`;
};

/**
 * A line of Claude Code's own, such as Interrupted, a failed request or a hook's word, in italics
 * as it is written: nothing in it is taken as Markdown.
 */
const note = (text: string) => text.split(/\r\n?|\n/).map((line) => line.trim()).filter(Boolean)
  .map((line) => `*${line.replace(/[\\`*_[\]<>&~|]/g, '\\$&')}*`).join('\n');

/** What a prompt carried besides its words: pictures, which have no names, and files by name. */
const attached = (pictures: number, files: SentFile[]) => {
  const all = [...(pictures === 1 ? ['a picture'] : pictures > 1 ? [`${pictures} pictures`] : []), ...files.map((file) => file.name)];
  return all.length > 0 ? [`Attached: ${all.join(', ')}`] : [];
};

/** A workflow's end, in the words of its line in the conversation. */
const workflowEnded = ({ name, status, durationMs }: WorkflowNotice) =>
  `Workflow ${name ? `${name} ` : ''}${status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped'}${durationMs !== undefined ? ` · ${durationText(durationMs)}` : ''}`;

/**
 * The conversation as Markdown, with all the conversation shows, as Claude Code's /export has all
 * its screen shows: prompts and replies in full with what was attached, `!` and `/` commands as
 * code with their output, tool calls as one line each, and Claude Code's own lines (a background
 * task's note, Interrupted, a failed request, a hook's word, a compaction) in italics. What the
 * conversation leaves out stays out: the notes Claude Code and Pelican give Claude with a prompt (a
 * side chat's note, in a system reminder), the tags around commands and a compaction's summary.
 * The days the conversation is marked off by are left out, as the terminal has none.
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
      const words = item.command ? [asCode(`${item.command.name} ${item.command.args}`.trim())] : item.text ? [item.text] : [];
      say('You', [...words, ...attached(item.images.length, item.files)]);
    } else if (item.kind === 'shell') {
      const output = [item.stdout, item.stderr].map(cleanOutput).filter((part) => part.trim()).join('\n').replace(/^\s*\n/, '').trimEnd();
      say('You', [asCode(`!${item.command}`), ...(output ? [codeBlock(output)] : [])]);
    } else if (item.kind === 'notice' && item.tone === 'output') {
      // A `/` command's output, under the command.
      out.push(codeBlock(item.text), '');
    } else if (item.kind === 'notice') {
      const line = note(item.workflow ? workflowEnded(item.workflow) : item.text);
      if (line) out.push(line, '');
      speaker = undefined;
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
      out.push(note('Context compacted'), '');
      speaker = undefined;
    }
  }
  return { title, markdown: `${out.join('\n').trim()}\n` };
}
