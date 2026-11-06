import { deleteSession, forkSession } from '@anthropic-ai/claude-agent-sdk';

import { promptParts } from '../shared/prompt-parts.js';
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

/**
 * Where a Markdown reader with GitHub's extensions makes a link of bare text: an address that
 * starts with http://, https:// or www., or an email. It does that to the text an escape leaves,
 * so only code keeps one text.
 */
const BARE_LINK = /(?<![\p{L}\p{N}])(?:(?:https?:\/\/|www\.)[^\s<`]*[^\s<`.,:;!?"')\]}*_~]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/giu;
const escaped = (text: string) => text.replace(/[\\`*_[\]<>&~|]/g, '\\$&');

/** Text of a line as it reads, none of it taken as Markdown: what would be escaped, and links as code. */
function inlineText(text: string): string {
  let out = '';
  let at = 0;
  for (const link of text.matchAll(BARE_LINK)) {
    out += escaped(text.slice(at, link.index)) + inlineCode(link[0]);
    at = link.index + link[0].length;
  }
  return out + escaped(text.slice(at));
}

/**
 * A line of words as it reads: its indentation kept as spaces that stay, and nothing at its start
 * taken for a heading, a list, a quote, a rule or code.
 */
function textLine(line: string): string {
  const [, indent = '', rest = ''] = /^([ \t]*)(.*)$/s.exec(line)!;
  const body = inlineText(rest).replace(/^(?:[#+=-]|\d+(?=[.)]))/, (start) => (/\d/.test(start) ? `${start}\\` : `\\${start}`));
  return `${indent.replace(/\t/g, '    ').replace(/ /g, '&nbsp;')}${body}`;
}

/** Words as the conversation shows them, read as text: a line for each line, a blank line between paragraphs. */
function asText(text: string): string {
  const paragraphs: string[][] = [[]];
  for (const line of text.split(/\r\n?|\n/)) {
    if (line.trim()) paragraphs.at(-1)!.push(textLine(line.trimEnd()));
    else if (paragraphs.at(-1)!.length > 0) paragraphs.push([]);
  }
  return paragraphs.filter((lines) => lines.length > 0).map((lines) => lines.join('\\\n')).join('\n\n');
}

/** A prompt as the conversation shows it: its words as text, and the quotes above them as quotes, under where one is from. */
const prompt = (text: string) => promptParts(text).map((part) => {
  if (part.kind === 'text') return asText(part.text);
  const body = asText(part.text);
  const quote = part.from ? `${inlineCode(part.from)}${body ? `\\\n${body}` : ''}` : body;
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

/** A fence that opens a code block: up to 3 spaces, then backticks with none after them, or tildes. */
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
/** A heading's #s, after the quote and list item markers its line starts with. */
const HEADING = /^((?: {0,3}>[ \t]?)*(?: {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)?[ \t]{0,3})(#{1,6})(?=[ \t]|$)/;
/** A line under a paragraph that makes it a heading: `===` for the first level, `---` the second. */
const UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
/** A line that starts a block other than a paragraph: a quote, a heading, a list item, a code fence, HTML. */
const BLOCK = /^ {0,3}(?:[>#<]|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|`{3}|~{3})/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
/** A line that starts HTML, which a reader shows as it is, Markdown or not, to a blank line. */
const HTML = /^ {0,3}<[A-Za-z/!?]/;
const QUOTE_MARKS = /^(?: {0,3}>[ \t]?)+/;

/**
 * A reply as the conversation shows it, where it keeps to itself: its headings two levels down,
 * under the speakers' (`===` and `---` ones as `###` and `####`), so none passes for one, and a
 * code block it leaves open closed at its end, so it takes nothing after it.
 */
function reply(text: string): string {
  const out: string[] = [];
  /** The code block open: its fence, and whether it is in a quote or a list item, which end it when they end. */
  let code: { fence: string; quote: boolean; list: boolean } | undefined;
  let list = false;
  let html = false;
  let blank = true;
  /** Where the paragraph under way began, outside quotes and lists. */
  let paragraph: number | undefined;
  for (const line of text.split(/\r\n?|\n/)) {
    const quoted = /^ {0,3}>/.test(line);
    const indented = /^[ \t]/.test(line);
    if (code && ((code.quote && !quoted) || (code.list && line.trim() && !indented))) code = undefined;
    if (code) {
      const inner = code.quote ? line.replace(QUOTE_MARKS, '') : code.list ? line.trimStart() : line;
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(inner)?.[1];
      if (close && close[0] === code.fence[0] && close.length >= code.fence.length) code = undefined;
      out.push(line);
      blank = false;
      continue;
    }
    if (html || (paragraph === undefined && HTML.test(line))) {
      html = Boolean(line.trim());
      out.push(line);
      blank = !html;
      continue;
    }
    if (LIST_ITEM.test(line)) list = true;
    else if (line.trim() && !indented && !quoted && (blank || BLOCK.test(line))) list = false;
    const fence = FENCE.exec(quoted ? line.replace(QUOTE_MARKS, '') : list && indented ? line.trimStart() : line)?.[1];
    if (fence) {
      code = { fence, quote: quoted, list: list && !quoted && indented };
      paragraph = undefined;
      out.push(line);
      blank = false;
      continue;
    }
    const underline = UNDERLINE.exec(line)?.[1];
    if (underline && paragraph !== undefined && !list) {
      const words = out.splice(paragraph).map((part) => part.trim()).join(' ');
      out.push(`${underline[0] === '=' ? '###' : '####'} ${words}`);
      paragraph = undefined;
      blank = false;
      continue;
    }
    const heading = HEADING.exec(line);
    out.push(heading ? `${heading[1]}${'#'.repeat(Math.min(6, heading[2]!.length + 2))}${line.slice(heading[0].length)}` : line);
    if (!line.trim() || quoted || list || BLOCK.test(line) || heading) paragraph = undefined;
    else if (paragraph === undefined && !/^(?: {4}|\t)/.test(line)) paragraph = out.length - 1;
    blank = !line.trim();
  }
  if (code && !code.quote && !code.list) out.push(code.fence);
  return out.join('\n');
}

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
 * reply as Markdown that keeps to itself, its headings under the speakers'. What the conversation
 * leaves out stays out: the notes Claude Code and Pelican give Claude with a prompt (a side chat's
 * note, in a system reminder), the tags around commands and a compaction's summary. The days the
 * conversation is marked off by are left out, as the terminal has none.
 */
export async function exportMarkdown(sessionId: string): Promise<{ title: string; markdown: string }> {
  const info = await sessionInfo(sessionId);
  const title = info?.customTitle || info?.summary || 'Claude Code session';
  const messages: ChatMessage[] = await loadMessages(sessionId);
  const out: string[] = [`# ${inlineText(title.replace(/\s+/g, ' ').trim())}`, ''];
  if (info?.cwd) out.push(`Folder: ${inlineCode(info.cwd)}`, '');
  let speaker: string | undefined;
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
          blocks.push(reply(part.text.trim()));
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
