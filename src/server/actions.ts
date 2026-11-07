import { deleteSession, forkSession } from '@anthropic-ai/claude-agent-sdk';

import { revealHidden } from '../shared/hidden.js';
import { hasQuotes, readPrompt } from '../shared/quoted.js';
import { partsShown, requestShown } from '../shared/requests.js';
import { durationText } from '../shared/workflows.js';
// The conversation as the app shows it: the export leaves out what the view leaves out.
import { baseName, shortPath } from '../web/lib/format.js';
import { type PrCreated, readPrCreated } from '../web/lib/requests.js';
import { buildItems, cleanOutput, type SentFile, type ToolCall, type WorkflowNotice } from '../web/lib/turns.js';
import { config } from './config.js';
import { asCode, asText, codeBlock, inlineCode, inlineText, reply } from './markdown.js';
import { sessionInfo, shownMessages } from './sessions.js';
import { refreshTranscriptIndex } from './transcripts.js';

/**
 * A copy of the session to carry on separately (Fork). With `upTo`, the copy ends at that entry
 * of the transcript: Fork from here, from a reply (its end) or a prompt (the entry just before it).
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

export async function remove(sessionId: string): Promise<void> {
  if (config.demo) throw new Error('This is the demo: nothing changes.');
  const info = await sessionInfo(sessionId);
  await deleteSession(sessionId, info?.cwd ? { dir: info.cwd } : {});
  await refreshTranscriptIndex();
}

/** Lines as a quote, at each line ending a reader takes, a lone carriage return too. */
const quoted = (text: string) => text.split(/\r\n?|\n/).map((line) => (line ? `> ${line}` : '>')).join('\n');

/** A quote's lines under what they are from (a file and its lines, a terminal), as code, or its words as text. */
const quoteBlock = (text: string | undefined, from?: string) => quoted(from ? [inlineCode(from), ...(text ? [codeBlock(text)] : [])].join('\n') : asText(text ?? ''));

/**
 * A prompt as the conversation shows it (shared/quoted reads it, as Claude Desktop writes one): the
 * files it attached by name; each quote as a quote, one of lines of a file or of a terminal under
 * where they are from, as code, and the note on it after it as text; a comment on lines under the
 * file and lines it is on, its code as code, and the comment after it; and its words as text. One
 * with none of these reads as it was typed.
 */
const prompt = (text: string): string[] => {
  const parts = readPrompt(text);
  if (!hasQuotes(parts)) {
    const typed = text.replace(/^\n+|\n+$/g, '');
    return typed ? [asText(typed)] : [];
  }
  const files = parts.flatMap((part) => (part.kind === 'file' ? [`${baseName(part.path)}${part.folder ? '/' : ''}`] : []));
  const blocks = files.length > 0 ? [`Attached: ${inlineText(files.join(', '))}`] : [];
  for (const part of parts) {
    if (part.kind === 'text') blocks.push(asText(part.text));
    else if (part.kind === 'quote') blocks.push(quoteBlock(part.text, part.label), ...(part.note ? [asText(part.note)] : []));
    else if (part.kind === 'comment') {
      const [from, to] = part.lines;
      const where = `${baseName(part.path)}:${from === to ? from : `${from}-${to}`}${part.removed ? ' · before changes' : ''}`;
      blocks.push(quoted(part.code === undefined ? inlineCode(where) : `${inlineCode(where)}\n${codeBlock(part.code)}`), ...(part.note ? [asText(part.note)] : []));
    }
  }
  return blocks;
};

/**
 * The files a call sent you that the conversation shows, as their cards do: what Claude Code
 * delivered with SendUserFile, the page an Artifact call published; none for a call that did not
 * run, or failed.
 */
const shownFiles = ({ name, input, result }: ToolCall): string[] => {
  if (!result || result.is_error) return [];
  if (name === 'SendUserFile') return (result.delivered?.files ?? []).map((file) => file.path);
  return name === 'Artifact' && typeof input.file_path === 'string' && (!input.action || input.action === 'publish') ? [input.file_path] : [];
};

/** The words Claude sent with the files a call sent, which the conversation shows with them, as a reply reads. */
const caption = (call: ToolCall): string | undefined => {
  if (shownFiles(call).length === 0) return undefined;
  const words = [call.result?.delivered?.caption, call.input.caption, call.input.description].find((value) => typeof value === 'string' && value.trim());
  return typeof words === 'string' ? words.trim() : undefined;
};

/** A file's path as the conversation shows a step's: from the session's folder where it is in it, as it is elsewhere (tools.ts, relPath). */
const shownPath = (file: string, cwd: string | undefined) => (cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file);

/**
 * A tool call as one line: its name and what it is about. A SendUserFile call names the files it
 * sent (those it asked to send, until they were), by name as their cards show them, a character
 * that hides or turns text around written out. A file is named as the conversation names it, from
 * the session's folder (`cwd`).
 */
const toolLine = (call: ToolCall, cwd?: string) => {
  const { name, input } = call;
  if (name === 'SendUserFile') {
    const asked = typeof input.files === 'string' ? [input.files] : Array.isArray(input.files) ? input.files.filter((file): file is string => typeof file === 'string') : [];
    const files = call.result && !call.result.is_error && call.result.delivered ? shownFiles(call) : asked;
    const names = files.map((file) => revealHidden(file.split(/[\\/]/).pop() || file).text.replace(/\r\n?|\n/g, ' '));
    return `- ${inlineText(name)}${names.length > 0 ? `: ${names.map(inlineCode).join(', ')}` : ''}`;
  }
  const key = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description'].find((k) => typeof input[k] === 'string');
  const target = key === undefined ? undefined : key.endsWith('_path') ? shownPath(input[key] as string, cwd) : (input[key] as string);
  return `- ${inlineText(name)}${target ? `: ${inlineCode(target.split(/\r\n?|\n/)[0]!)}` : ''}`;
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

/** A pull request Claude made, as its card names it where gh says nothing: Pull request, its repository and number, linked. */
const pullRequest = (pr: PrCreated) => `Pull request [${inlineText(`${pr.repo}#${pr.number}`)}](<${pr.url.replace(/[<>\s]/g, encodeURIComponent)}>)`;

/** A workflow's end, in the words of its line in the conversation. */
const workflowEnded = ({ name, status, durationMs }: WorkflowNotice) =>
  `Workflow ${name ? `${name} ` : ''}${status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped'}${durationMs !== undefined ? ` · ${durationText(durationMs)}` : ''}`;

/**
 * The conversation as Markdown, with all the conversation shows, as Claude Code's /export has all
 * its screen shows: prompts and replies with what was attached, as far as the conversation shows
 * them (one past 60,000 characters it ends with "…", as normalize.ts cuts it for the page), `!`
 * and `/` commands as code with their output, tool calls as one line each, the files Claude sent
 * by name with the words it sent with them, and Claude Code's own lines (a background
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
  // As the conversation reads: up to where it was rewound, while it is.
  const { messages } = await shownMessages(sessionId);
  const out: string[] = [`# ${inlineText(title.replace(/\s+/g, ' ').trim())}`, ''];
  // As the app shows it, `~/code/x` in the home folder (the demo's made-up one too, not where it
  // happens to be kept); on its line, as a title is: a line break in it would end the code, and
  // start a speaker's heading.
  if (info?.cwd) out.push(`Folder: ${inlineCode(shortPath(info.cwd, config.home).replace(/\r\n?|\n/g, ' '))}`, '');
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
      // Desktop's Create PR request as the command it shows, /create-pr, alone or among other prompts.
      const request = item.command ? undefined : requestShown(item.text);
      const words = item.command ? [asCode(`${item.command.name} ${item.command.args}`.trim())]
        : request ? [asCode(request)]
          : item.text ? prompt(partsShown(item.text) ?? item.text) : [];
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
        if (part.kind === 'tool') {
          tools.push(toolLine(part.call, info?.cwd));
          // The words Claude sent with files, under its line, as Claude's: a reply.
          const words = caption(part.call);
          if (words) {
            blocks.push(tools.join('\n'));
            tools = [];
            blocks.push(reply(words, (replies += 1)));
          }
        } else if (part.kind === 'text' && part.text.trim()) {
          if (tools.length > 0) blocks.push(tools.join('\n'));
          tools = [];
          // A pull request named in Desktop's <pr-created> tag is its card in the conversation:
          // here, a line under the words, its link.
          const { text, prs } = readPrCreated(part.text);
          if (text.trim()) blocks.push(reply(text.trim(), (replies += 1)));
          for (const pr of prs) blocks.push(pullRequest(pr));
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
