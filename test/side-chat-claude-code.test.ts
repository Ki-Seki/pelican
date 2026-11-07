// A side chat as the Claude Code the Agent SDK bundles runs it, against a stand-in API
// (stand-in-api.ts), in this test's temporary folders: what Claude is told there, that it runs
// nothing but the reading tools whatever the user's own rules allow, and how it stays on disk.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { config } from '../src/server/config';
import { closeAll, getRun, sendMessage, startSideChat } from '../src/server/runner';
import { listSummaries } from '../src/server/sessions';
import { refreshTranscriptIndex, transcriptPath } from '../src/server/transcripts';
import { type ContentBlock, type MessagesRequest, type StandIn, standInApi, textOf, until } from './stand-in-api';

const home = vi.hoisted(() => {
  // Nothing of a Claude Code this test may itself run under reaches the one it starts, and the
  // computer's own home (shell files, settings) stays out of it: test/setup.ts made the folders.
  for (const key of Object.keys(process.env)) if ((key.startsWith('CLAUDE') && key !== 'CLAUDE_CONFIG_DIR') || key.startsWith('ANTHROPIC_')) delete process.env[key];
  process.env.HOME = `${process.env.CLAUDE_CONFIG_DIR}-home`;
  return process.env.HOME;
});

const QUESTION = 'Why CSS variables?';
/** The id the page gives the side chat's first question, which its own conversation starts at. */
const ASKED = '5a5a5a5a-0000-4000-8000-000000000001';
let api: StandIn;
let folder: string;
let parent: string;
let side: string;

/** The turns Claude was asked to take (not titles or suggestions, which come without tools). */
const turns = () => api.requests.filter((request) => (request.tools?.length ?? 0) > 0);
const sideTurns = () => turns().filter((request) => JSON.stringify(request.messages ?? []).includes(QUESTION));
/** The results of the tools Claude called after the side question, in order. */
const resultsAfterQuestion = (request: MessagesRequest): ContentBlock[] => {
  const messages = request.messages ?? [];
  const at = messages.findIndex((message) => textOf(message.content).includes(QUESTION));
  return at < 0 ? [] : messages.slice(at).flatMap((message) => (Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_result') : []));
};
const systemOf = (request: MessagesRequest) => JSON.stringify(request.system);

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  folder = path.join(realpathSync(path.dirname(config.claudeHome)), 'acme-web');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'notes.md'), 'The colors are CSS variables in theme.css.\n');
  // The user's own rules allow touch and writing files anywhere: a side chat still does neither.
  mkdirSync(config.claudeHome, { recursive: true });
  writeFileSync(path.join(config.claudeHome, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(touch:*)', 'Write'] } }));
  api = await standInApi((request) => {
    if (!sideTurns().includes(request)) return 'OK.';
    // In the side chat, Claude tries to run a command and write a file, then reads one.
    const done = resultsAfterQuestion(request).length;
    if (done === 0) return { tool: 'Bash', input: { command: `touch ${folder}/made-by-bash`, description: 'Make a file' } };
    if (done === 1) return { tool: 'Write', input: { file_path: `${folder}/made-by-write.txt`, content: 'from a side chat\n' } };
    if (done === 2) return { tool: 'Read', input: { file_path: `${folder}/notes.md` } };
    return 'They let one set of values serve both themes.';
  });
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'sk-ant-stand-in',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
  });

  parent = await sendMessage({ cwd: folder }, { text: 'Add a dark theme', attachments: [], settings: {} });
  await until(() => turns().length >= 1 && getRun(parent)?.busy === false, 90_000, 'the session’s turn');
  side = await startSideChat(parent, { text: QUESTION, settings: {}, uuid: ASKED });
  await until(() => getRun(side)?.busy === false && sideTurns().some((request) => resultsAfterQuestion(request).length >= 3), 90_000, 'the side chat’s turn');
}, 200_000);

afterAll(async () => {
  closeAll();
  await api?.close();
});

describe('a side chat, in the Claude Code the Agent SDK bundles', () => {
  it('tells Claude with its question that it is a side chat that only reads, and keeps the session’s system prompt', () => {
    const first = sideTurns()[0]!;
    expect(systemOf(first)).toBe(systemOf(turns()[0]!));
    const asked = first.messages!.findLast((message) => textOf(message.content).includes(QUESTION))!;
    const text = textOf(asked.content);
    expect(text).toMatch(/^<system-reminder>\nThis is a side chat about the conversation above\..*Read, Grep and Glob, in the working folder.*refused.*Nothing you say or do here reaches the main session\.\n<\/system-reminder>\n\nWhy CSS variables\?$/s);
  });

  it('runs nothing but the reading tools, whatever the user’s own rules allow: Bash and Write are refused and change nothing', () => {
    const results = resultsAfterQuestion(sideTurns().at(-1)!);
    expect(results).toHaveLength(3);
    const [bash, write, read] = results.map((block) => ({ error: block.is_error === true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }));
    expect(bash!.error).toBe(true);
    expect(write!.error).toBe(true);
    expect(existsSync(path.join(folder, 'made-by-bash'))).toBe(false);
    expect(existsSync(path.join(folder, 'made-by-write.txt'))).toBe(false);
    // Reading works: the refusals are the side chat's, not a Claude that can do nothing.
    expect(read!.error).toBe(false);
    expect(read!.text).toContain('The colors are CSS variables in theme.css.');
  });

  it('is still titled "Side chat" once its Claude has exited, stays folded under its session, and is listed by its first question', async () => {
    getRun(side)?.close();
    // The run goes once its Claude has ended, which is when Claude Code writes what it writes on exit.
    await until(() => getRun(side) === undefined, 20_000, 'its Claude to exit');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const file = (await transcriptPath(side))!;
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type?: string; customTitle?: string });
    expect(rows.filter((row) => row.type === 'custom-title').at(-1)?.customTitle).toBe('Side chat');
    await refreshTranscriptIndex();
    const listed = await listSummaries(() => undefined);
    // Called by its question, which its own conversation starts at, after the copy of the session's.
    expect(listed.find((s) => s.id === side)).toMatchObject({ title: QUESTION, sideChatOf: parent, sideQuestion: QUESTION, sideStart: ASKED });
    expect(rows.filter((row) => row.type === 'user' && (row as { uuid?: string }).uuid === ASKED)).toHaveLength(1);
  }, 30_000);
});
