import path from 'node:path';
import readline from 'node:readline';

import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';

import type { RunSettings } from '../shared/protocol.js';
import { promptGist } from '../shared/quoted.js';
import { shortTitle } from '../shared/titles.js';
import { openRegular } from './open.js';
import { everTitled, firstTurnSession, transcriptPath } from './transcripts.js';

/**
 * Side chats, as Claude Desktop has them ("Ask a side question without derailing the session"):
 * a copy of the session so far, titled as Desktop titles its own, where Claude answers questions
 * about the session. It reads the conversation and the folder and changes nothing, and nothing in
 * it goes back to the session. On disk it is a session like any other, so it goes on in the CLI
 * and Desktop too; the session list folds it under the session it copies.
 */
export const SIDE_CHAT_TITLE = 'Side chat';

/** All a side chat can use: Claude Code's tools that only read. */
export const SIDE_CHAT_TOOLS = ['Read', 'Grep', 'Glob'];

/** The mode a side chat runs in: anything not already allowed is refused, never asked about, and Bypass never applies. */
export const SIDE_CHAT_MODE = 'dontAsk' as const;

/**
 * Said to Claude with each question in a side chat, so it answers rather than reaching for tools
 * that do not run there: the session's tools are still listed to it, as they were.
 */
const SIDE_CHAT_NOTE = 'This is a side chat about the conversation above. Here you can only read, with Read, Grep and Glob, in the working folder: any other tool listed is refused, so do not call one. Answer the user\'s questions, reading files when that helps. Nothing you say or do here reaches the main session.';

/**
 * A question as a side chat sends it to Claude: after the note, in a system reminder, as Claude
 * Desktop sends its own. Not in the system prompt, which Claude Code keeps as the session had it
 * when it resumes a copy. Pelican shows the question alone, as Desktop does; the terminal shows
 * the note as well, as it does for Desktop's.
 */
export const sideChatPrompt = (text: string) => `<system-reminder>\n${SIDE_CHAT_NOTE}\n</system-reminder>\n\n${text}`;

/** Whatever Claude Code would still ask about in a side chat is refused: there is nobody there to ask. */
const refuse: CanUseTool = async () => ({ behavior: 'deny', message: 'A side chat only reads. Ask in the session itself for anything else.' });

/**
 * What a side chat's Claude runs with, over a session's own options:
 * - the reading tools and nothing else, and no MCP server at all (strictMcpConfig, with none
 *   given), whatever the folder or the user's settings configure;
 * - Don't ask, with Bypass not allowed, so a mode picked elsewhere never reaches it;
 * - no checkpoints, since it changes no file, and no prompt suggestions, which nobody reads there.
 * Its system prompt stays the session's (see sideChatPrompt).
 */
export function sideChatOptions(): Partial<Options> {
  return {
    tools: [...SIDE_CHAT_TOOLS],
    strictMcpConfig: true,
    mcpServers: {},
    permissionMode: SIDE_CHAT_MODE,
    allowDangerouslySkipPermissions: false,
    canUseTool: refuse,
    enableFileCheckpointing: false,
    promptSuggestions: false,
  };
}

/**
 * What a side chat's Claude is told besides: that the session it is a copy of goes on, in Claude
 * Code's own word for a copy whose source still runs. Work that session left running when it was
 * copied (a background agent, a command) is the session's own, not the copy's: Claude Code would
 * otherwise tell the copy's Claude it "didn't finish before the previous session ended", and so
 * failed. A side chat starts no work of its own: it only reads.
 */
export const SIDE_CHAT_ENV: Record<string, string> = { CLAUDE_CODE_RESUME_SOURCE_ALIVE: '1' };

/** The settings a side chat takes from its session: the model, effort and speed, in its own mode. */
export function sideChatSettings(settings: RunSettings): RunSettings {
  const { model, effort, fast } = settings;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(fast ? { fast } : {}), permissionMode: SIDE_CHAT_MODE };
}

/** A / command, which a side chat does not take: one could run what the folder brings. */
export const SIDE_CHAT_COMMAND = /^\/[\w:.-]+(?:\s|$)/;

/** How many copies of copies are followed back to the session they all start from. */
const COPIES_FOLLOWED = 8;

/**
 * The session a transcript's side chat copies; undefined for any other transcript. A side chat
 * starts as a copy of another session (transcripts.ts, firstTurnSession) and was titled "Side
 * chat" under its own id, wherever in the file: after it, Claude Code writes the title it resumed
 * with, the session's own, when its Claude exits, as it does in most of Claude Desktop's. A copy
 * of a side chat (a branch from one of its questions) is a side chat of the same session.
 */
export async function sideChatSource(file: string, followed = 0): Promise<string | undefined> {
  const from = await firstTurnSession(file);
  if (!from || from === path.basename(file, '.jsonl')) return undefined;
  const copied = followed < COPIES_FOLLOWED ? await transcriptPath(from) : undefined;
  const outer = copied ? await sideChatSource(copied, followed + 1) : undefined;
  if (outer) return outer;
  return (await everTitled(file, SIDE_CHAT_TITLE)) ? from : undefined;
}

/** The session a side chat copies, as the session list tells them; undefined for any other session. */
export async function sideChatOf(sessionId: string): Promise<string | undefined> {
  const file = await transcriptPath(sessionId);
  return file ? sideChatSource(file) : undefined;
}

export const isSideChat = async (sessionId: string): Promise<boolean> => Boolean(await sideChatOf(sessionId));

/** A side chat's first question: the message its own conversation starts at, and its words, as a title. */
export type SideQuestion = { uuid: string; text: string };

/** How far into a side chat's transcript its first question is looked for: past the copy of a long session. */
const QUESTION_SCAN = 64 * 1024 * 1024;

/** What Claude Code writes as a prompt that nobody asked: a command, what it printed, a task's news, an interruption. */
const NOT_ASKED = /^(?:<(?:command-name|command-message|command-args|local-command-[a-z]+|bash-[a-z]+|task-notification)>|\[Request interrupted)/;

/** What each side chat's transcript was found to hold, as it was then: a file only grows, so a question found stays. */
const questions = new Map<string, { ino: number; size: number; found?: SideQuestion }>();

/** A prompt's text, without the notes Claude Code and Pelican add for Claude (the side chat's own among them). */
function promptText(content: unknown): string {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.flatMap((block: unknown) => {
        const b = block as { type?: unknown; text?: unknown } | null;
        return b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [];
      }).join('\n\n')
      : '';
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/**
 * The first question a side chat asked, after the conversation it copied, by which Pelican names
 * it: its first prompt of its own (under its own id, not one the copy brought, which names where it
 * came from), as Pelican shows it, in a few words: not the note sideChatPrompt puts before it, nor
 * the markers of a passage it was asked with (a selection's attach block), only what was typed.
 * None before one is in the transcript.
 */
export async function sideChatQuestion(file: string): Promise<SideQuestion | undefined> {
  let handle: Awaited<ReturnType<typeof openRegular>> | undefined;
  try {
    handle = await openRegular(file);
    const { ino, size } = await handle.stat();
    const known = questions.get(file);
    if (known && known.ino === ino && (known.found || known.size === size)) return known.found;
    const own = path.basename(file, '.jsonl');
    const ownRow = `"sessionId":"${own}"`;
    let found: SideQuestion | undefined;
    let read = 0;
    const input = handle.createReadStream({ start: 0, autoClose: false });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        read += line.length + 1;
        if (read > QUESTION_SCAN) break;
        // A prompt of its own: a user row under its id, copied from nowhere, that is no tool's result.
        if (!line.includes('"type":"user"') || !line.includes(ownRow) || line.includes('"forkedFrom":{') || line.includes('"tool_use_id"')) continue;
        try {
          const row = JSON.parse(line) as {
            type?: unknown; uuid?: unknown; sessionId?: unknown; isSidechain?: unknown; isMeta?: unknown; isCompactSummary?: unknown; forkedFrom?: unknown;
            message?: { content?: unknown };
          };
          if (row.type !== 'user' || row.sessionId !== own || typeof row.uuid !== 'string' || row.isSidechain === true || row.isMeta === true || row.isCompactSummary === true) continue;
          if (row.forkedFrom !== undefined && row.forkedFrom !== null) continue;
          const text = promptText(row.message?.content);
          if (!text || NOT_ASKED.test(text)) continue;
          found = { uuid: row.uuid, text: shortTitle(promptGist(text)) };
          break;
        } catch {
          // A row being written.
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
    if (questions.size > 10_000) questions.clear();
    questions.set(file, { ino, size, ...(found ? { found } : {}) });
    return found;
  } catch {
    return undefined; // Missing or unreadable.
  } finally {
    await handle?.close();
  }
}
