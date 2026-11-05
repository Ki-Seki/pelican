import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';

import type { RunSettings } from '../shared/protocol.js';
import { sessionInfo, sessionTitle } from './sessions.js';
import { firstTurnSession, transcriptPath } from './transcripts.js';

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

/** Said to Claude in a side chat, so it answers rather than reaching for tools it does not have. */
const SIDE_CHAT_NOTE = 'This is a side chat about the conversation above. Answer the user\'s questions from it, reading files when that helps. You cannot change files or run commands here, and nothing said here reaches the main session.';

/** Whatever Claude Code would still ask about in a side chat is refused: there is nobody there to ask. */
const refuse: CanUseTool = async () => ({ behavior: 'deny', message: 'A side chat only reads. Ask in the session itself for anything else.' });

/**
 * What a side chat's Claude runs with, over a session's own options:
 * - the reading tools and nothing else, and no MCP server at all (strictMcpConfig, with none
 *   given), whatever the folder or the user's settings configure;
 * - Don't ask, with Bypass not allowed, so a mode picked elsewhere never reaches it;
 * - no checkpoints, since it changes no file, and no prompt suggestions, which nobody reads there.
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
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SIDE_CHAT_NOTE },
  };
}

/** The settings a side chat takes from its session: the model, effort and speed, in its own mode. */
export function sideChatSettings(settings: RunSettings): RunSettings {
  const { model, effort, fast } = settings;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(fast ? { fast } : {}), permissionMode: SIDE_CHAT_MODE };
}

/** A / command, which a side chat does not take: one could run what the folder brings. */
export const SIDE_CHAT_COMMAND = /^\/[\w:.-]+(?:\s|$)/;

/**
 * The session a side chat copies; undefined for any other session. A side chat is a session with
 * Desktop's title whose transcript starts as a copy of another (transcripts.ts, firstTurnSession),
 * as the session list tells them.
 */
export async function sideChatOf(sessionId: string): Promise<string | undefined> {
  const info = await sessionInfo(sessionId);
  if (!info || sessionTitle(info) !== SIDE_CHAT_TITLE) return undefined;
  const file = await transcriptPath(sessionId);
  const from = file ? await firstTurnSession(file) : undefined;
  return from && from !== sessionId ? from : undefined;
}

export const isSideChat = async (sessionId: string): Promise<boolean> => Boolean(await sideChatOf(sessionId));
