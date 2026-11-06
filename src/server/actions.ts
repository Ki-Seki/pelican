import { deleteSession, forkSession } from '@anthropic-ai/claude-agent-sdk';

import { promptParts } from '../shared/prompt-parts.js';
import type { ChatMessage } from '../shared/protocol.js';
import { durationText } from '../shared/workflows.js';
// The conversation as the app shows it: the export leaves out what the view leaves out.
import { buildItems, cleanOutput, type SentFile, type WorkflowNotice } from '../web/lib/turns.js';
import { config } from './config.js';
import { asCode, asText, codeBlock, inlineCode, inlineText, reply } from './markdown.js';
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

/**
 * A prompt as the conversation shows it: its words as text, and the quotes above them as quotes;
 * one from a file under where it is from, its lines as code, as the conversation shows them.
 */
const prompt = (text: string) => promptParts(text).map((part) => {
  if (part.kind === 'text') return asText(part.text);
  const quote = part.from ? [inlineCode(part.from), ...(part.text ? [codeBlock(part.text)] : [])].join('\n') : asText(part.text);
  return quote.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
});

const toolLine = (name: string, input: Record<string, unknown>) => {
  const target = ['file_path', 'command', 'pattern', 'url', 'query', 'description'].map((k) => input[k]).find((v) => typeof v === 'string');
  return `- ${inlineText(name)}${target ? `: ${inlineCode(String(target).split(/\r\n?|\n/)[0]!)}` : ''}`;
};

/**
 * A line of Claude Code's own, such as Interrupted, a failed request or a hook's word, in italics
 * as it is written: nothing in it is taken as Markdown.
 */
const note = (text: string) => text.split(/\r\n?|\n/).map((line) => line.trim()).filter(Boolean)
  .map((line) => `*${inlineText(line)}*`).join('\n');

/** What a prompt carried besides its words: pictures, which have no names, and files by name. */
const attached = (pictures: number, files: SentFile[]) => {
  const all = [...(pictures === 1 ? ['a picture'] : pictures > 1 ? [`${pictures} pictures`] : []), ...files.map((file) => file.name)];
  return all.length > 0 ? [`Attached: ${inlineText(all.join(', '))}`] : [];
};

/** A workflow's end, in the words of its line in the conversation. */
const workflowEnded = ({ name, status, durationMs }: WorkflowNotice) =>
  `Workflow ${name ? `${name} ` : ''}${status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped'}${durationMs !== undefined ? ` · ${durationText(durationMs)}` : ''}`;

/**
 * The conversation as Markdown, with all the conversation shows, as Claude Code's /export has all
 * its screen shows: prompts and replies in full with what was attached, `!` and `/` commands as
 * code with their output, tool calls as one line each, and Claude Code's own lines (a background
 * task's note, Interrupted, a failed request, a hook's word, a compaction) in italics. Each reads
 * as the conversation shows it: a prompt, a note and a name as text, none of it Markdown, and a
 * reply as Markdown that keeps to itself (markdown.ts): its headings under the speakers', its HTML
 * as text, its pictures as links, and its links by reference and footnotes its own, in any
 * reader. What the conversation leaves out stays out: the notes Claude Code and Pelican give
 * Claude with a prompt (a side chat's note, in a system reminder), the tags around commands and a
 * compaction's summary. The days the conversation is marked off by are left out, as the terminal
 * has none.
 */
export async function exportMarkdown(sessionId: string): Promise<{ title: string; markdown: string }> {
  const info = await sessionInfo(sessionId);
  const title = info?.customTitle || info?.summary || 'Claude Code session';
  const messages: ChatMessage[] = await loadMessages(sessionId);
  const out: string[] = [`# ${inlineText(title.replace(/\s+/g, ' ').trim())}`, ''];
  if (info?.cwd) out.push(`Folder: ${inlineCode(info.cwd)}`, '');
  let speaker: string | undefined;
  // Each reply's number, which its footnotes' labels start with: the conversation reads each reply
  // on its own, and the file reads all of them as one document.
  let replies = 0;
  const say = (who: 'You' | 'Claude', blocks: string[]) => {
    if (blocks.length === 0) return;
    if (who !== speaker) out.push(`## ${who}`, '');
    speaker = who;
    for (const block of blocks) out.push(block, '');
  };
  // What the conversation view shows, read the same way.
  for (const item of buildItems(messages, config.machine)) {
    if (item.kind === 'user') {
      const words = item.command ? [asCode(`${item.command.name} ${item.command.args}`.trim())] : item.text ? prompt(item.text) : [];
      say('You', [...words, ...attached(item.images.length, item.files)]);
    } else if (item.kind === 'shell') {
      const output = [item.stdout, item.stderr].map(cleanOutput).filter((part) => part.trim()).join('\n').replace(/^\s*\n/, '').trimEnd();
      // How it ended when not well, as the conversation marks it.
      const ended = item.ended ? note(item.ended === 'stopped' ? 'Stopped' : 'Failed') : '';
      say('You', [asCode(`!${item.command}`), ...(output ? [codeBlock(output)] : []), ...(ended ? [ended] : [])]);
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
          blocks.push(reply(part.text.trim(), (replies += 1)));
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
