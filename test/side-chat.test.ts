import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fork } from '../src/server/actions';
import { config } from '../src/server/config';
import { listSummaries } from '../src/server/sessions';
import { isSideChat, SIDE_CHAT_TITLE, sideChatOf, sideChatOptions, sideChatPrompt, sideChatSettings } from '../src/server/side-chat';
import { refreshTranscriptIndex, transcriptPath } from '../src/server/transcripts';
import { buildItems } from '../src/web/lib/turns';

// The Agent SDK's own forkSession, on transcripts in a folder of this test's: nothing of this
// computer's Claude Code is read or written.
let home: string;
let folder: string;
let project: string;
const saved = { claudeHome: config.claudeHome, env: process.env.CLAUDE_CONFIG_DIR };
const id = (n: number) => `51de51de-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A row's id, of its own in each session. */
const row = (session: string, n: number) => `${session.slice(0, 24)}${String(Number(session.slice(24)) * 100 + n).padStart(12, '0')}`;
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const conversation = (session: string, cwd: string) => [
  { type: 'custom-title', customTitle: 'Add a dark theme', sessionId: session },
  { type: 'user', uuid: row(session, 1), parentUuid: null, sessionId: session, cwd, timestamp: at(30), message: { role: 'user', content: 'Add a dark theme with a toggle.' } },
  {
    type: 'assistant', uuid: row(session, 2), parentUuid: row(session, 1), sessionId: session, cwd, timestamp: at(29),
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The colors are already CSS variables, so it is one more set of values.' }] },
  },
];
const jsonl = (rows: object[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

beforeAll(async () => {
  // As Claude Code names a project's folder: by the real path (on macOS the temp folder is a link).
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-side-')));
  folder = path.join(home, 'code', 'acme-web');
  await mkdir(folder, { recursive: true });
  config.claudeHome = path.join(home, '.claude');
  process.env.CLAUDE_CONFIG_DIR = config.claudeHome;
  project = path.join(config.claudeHome, 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, `${id(1)}.jsonl`), jsonl(conversation(id(1), folder)));
  await refreshTranscriptIndex();
});
afterAll(async () => {
  config.claudeHome = saved.claudeHome;
  if (saved.env === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.env;
  await rm(home, { recursive: true, force: true });
});

describe('a side chat', () => {
  it('is a copy of the session titled as Claude Desktop titles its own, and the session stays byte for byte as it was', async () => {
    const parentFile = path.join(project, `${id(1)}.jsonl`);
    const before = await readFile(parentFile);
    const side = await fork(id(1), undefined, SIDE_CHAT_TITLE);
    expect(side).not.toBe(id(1));
    expect((await getSessionInfo(side, { dir: folder }))?.customTitle).toBe('Side chat');
    expect(await readFile(parentFile)).toEqual(before);
    // The copy holds the conversation so far.
    const copied = (await readFile((await transcriptPath(side))!, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string });
    expect(copied.filter((row) => row.type === 'user' || row.type === 'assistant')).toHaveLength(2);

    expect(await sideChatOf(side)).toBe(id(1));
    expect(await isSideChat(side)).toBe(true);
    expect(await isSideChat(id(1))).toBe(false);
    // The list folds it under the session it copies, as it folds Claude Desktop's.
    const listed = await listSummaries(() => undefined);
    expect(listed.find((s) => s.id === side)).toMatchObject({ title: 'Side chat', sideChatOf: id(1) });
    expect(listed.find((s) => s.id === id(1))?.sideChatOf).toBeUndefined();
  });

  it('is told apart the way Claude Desktop leaves one too, and a session only named so is none', async () => {
    // Desktop's: the conversation copied with its rows and ids unchanged, then the side question.
    const desktop = id(2);
    await writeFile(path.join(project, `${desktop}.jsonl`), jsonl([
      { type: 'custom-title', customTitle: 'Side chat', sessionId: desktop },
      ...conversation(id(1), folder).slice(1),
      { type: 'user', uuid: row(desktop, 3), parentUuid: row(id(1), 2), sessionId: desktop, cwd: folder, timestamp: at(5), message: { role: 'user', content: 'Why variables?' } },
    ]));
    // Called "Side chat", but a conversation of its own.
    const named = id(3);
    await writeFile(path.join(project, `${named}.jsonl`), jsonl([{ type: 'custom-title', customTitle: 'Side chat', sessionId: named }, ...conversation(named, folder).slice(1)]));
    await refreshTranscriptIndex();
    expect(await sideChatOf(desktop)).toBe(id(1));
    expect(await sideChatOf(named)).toBeUndefined();
    // A branch is a copy too, under another title: no side chat.
    const branch = await fork(id(1));
    expect(await isSideChat(branch)).toBe(false);
  });

  it('branched from one of its questions, stays a side chat of the same session', async () => {
    const side = await fork(id(1), undefined, SIDE_CHAT_TITLE);
    // Claude Code names the branch "Side chat (fork)", and its rows name the side chat they came from.
    const branch = await fork(side);
    expect((await getSessionInfo(branch, { dir: folder }))?.customTitle).toBe('Side chat (fork)');
    expect(await sideChatOf(branch)).toBe(id(1));
  });
});

describe('Claude Desktop’s side chats, as they are left on disk', () => {
  /**
   * The session's rows copied with their ids, its title rows too, then the side chat's own: Desktop
   * titles it "Side chat", the question and answer, and, when its Claude exits, Claude Code writes
   * the title it resumed with, the session's.
   */
  const desktopSideChat = (side: string, parent: string, between: object[] = []) => jsonl([
    ...conversation(parent, folder),
    { type: 'agent-name', agentName: 'Add a dark theme', sessionId: parent },
    { type: 'custom-title', customTitle: 'Side chat', sessionId: side },
    { type: 'user', uuid: row(side, 3), parentUuid: row(parent, 2), sessionId: side, cwd: folder, timestamp: at(5), message: { role: 'user', content: 'Why variables?' } },
    {
      type: 'assistant', uuid: row(side, 4), parentUuid: row(side, 3), sessionId: side, cwd: folder, timestamp: at(4),
      message: { id: 'msg_4', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'One set of values serves both themes.' }] },
    },
    ...between,
    { type: 'custom-title', customTitle: 'Add a dark theme', sessionId: side },
    { type: 'agent-name', agentName: 'Add a dark theme', sessionId: side },
    { type: 'mode', mode: 'normal', sessionId: side },
  ]);

  it('stay folded under their session once Claude Code has titled them as the session again, not listed as a second one', async () => {
    const side = id(4);
    await writeFile(path.join(project, `${side}.jsonl`), desktopSideChat(side, id(1)));
    await refreshTranscriptIndex();
    expect(await sideChatOf(side)).toBe(id(1));
    expect(await isSideChat(side)).toBe(true);
    const listed = await listSummaries(() => undefined);
    // Titled as Claude Code titles it, and said to be a side chat of the session.
    expect(listed.find((s) => s.id === side)).toMatchObject({ title: 'Add a dark theme', sideChatOf: id(1) });
    expect(listed.filter((s) => !s.sideChatOf && s.title === 'Add a dark theme').map((s) => s.id)).toEqual([id(1)]);
  });

  it('are told apart by their own "Side chat" title wherever it is: after a long side conversation too', async () => {
    const side = id(5);
    const long = Array.from({ length: 3 }, (_, n) => ({
      type: 'assistant', uuid: row(side, 10 + n), parentUuid: row(side, 4), sessionId: side, cwd: folder, timestamp: at(3),
      message: { id: `msg_${10 + n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x'.repeat(800_000) }] },
    }));
    await writeFile(path.join(project, `${side}.jsonl`), desktopSideChat(side, id(1), long));
    await refreshTranscriptIndex();
    expect(await sideChatOf(side)).toBe(id(1));
    expect((await listSummaries(() => undefined)).find((s) => s.id === side)?.sideChatOf).toBe(id(1));
  });

  it('a copy that holds a "Side chat" title only among the rows it copied is none', async () => {
    // A session that was itself titled "Side chat", copied: the title is the session's, not the copy's.
    const named = id(6);
    const copy = id(7);
    await writeFile(path.join(project, `${named}.jsonl`), jsonl([{ type: 'custom-title', customTitle: 'Side chat', sessionId: named }, ...conversation(named, folder).slice(1)]));
    await writeFile(path.join(project, `${copy}.jsonl`), jsonl([
      { type: 'custom-title', customTitle: 'Side chat', sessionId: named },
      ...conversation(named, folder).slice(1),
      { type: 'custom-title', customTitle: 'Try it another way', sessionId: copy },
    ]));
    await refreshTranscriptIndex();
    expect(await sideChatOf(copy)).toBeUndefined();
    expect((await listSummaries(() => undefined)).find((s) => s.id === copy)?.sideChatOf).toBeUndefined();
  });
});

describe('what a side chat runs with', () => {
  it('reads and changes nothing: the reading tools only, no MCP server, never Bypass', () => {
    const options = sideChatOptions();
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({});
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.allowDangerouslySkipPermissions).toBe(false);
    expect(options.enableFileCheckpointing).toBe(false);
    // The session's own system prompt, which Claude Code keeps for a resumed copy anyway.
    expect(options).not.toHaveProperty('systemPrompt');
  });

  it('tells Claude with each question, in a system reminder as Claude Desktop does, that it is a side chat that only reads', () => {
    const prompt = sideChatPrompt('Why CSS variables?');
    expect(prompt).toMatch(/^<system-reminder>\nThis is a side chat about the conversation above\. Here you can only read, with Read, Grep and Glob, in the working folder: any other tool listed is refused, so do not call one\. .*Nothing you say or do here reaches the main session\.\n<\/system-reminder>\n\nWhy CSS variables\?$/s);
    // Pelican shows the question alone, as Desktop does.
    expect(buildItems([{ uuid: 'q', role: 'user', blocks: [{ type: 'text', text: prompt }] }])).toMatchObject([{ kind: 'user', text: 'Why CSS variables?' }]);
  });

  it('refuses whatever Claude Code would still ask about', async () => {
    const answer = await sideChatOptions().canUseTool!('Read', { file_path: '/etc/hosts' }, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' } as never);
    expect(answer?.behavior).toBe('deny');
  });

  it('takes the session’s model, effort and speed, and its own mode, whatever was picked', () => {
    expect(sideChatSettings({ model: 'opus', effort: 'high', fast: true, ultracode: true, permissionMode: 'bypassPermissions' }))
      .toEqual({ model: 'opus', effort: 'high', fast: true, permissionMode: 'dontAsk' });
    expect(sideChatSettings({})).toEqual({ permissionMode: 'dontAsk' });
  });
});
