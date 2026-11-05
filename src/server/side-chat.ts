import path from 'node:path';

import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';

import type { RunSettings } from '../shared/protocol.js';
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
