// Rewind to here and Undo rewind, as the Claude Code the Agent SDK bundles runs them, against a
// stand-in API (stand-in-api.ts), in this test's temporary folders: Code only puts files back from
// Claude Code's own copies (rewindFiles); the conversation starts again at the entry before the
// prompt (resumeSessionAt) and Pelican keeps the cut; Undo rewind resumes the session whole until
// the next message; Claude at work gets 409; Claude Code's check refusing to drop more than the
// prompt's turn (resumeDropsTurn) falls back to the whole session; the demo refuses; and Fork from
// here copies up to just before a prompt (none before the first, also after a SessionStart hook's
// context), or the end of a reply. Rewinds, Undo and messages go one at a time; a failed rewind
// leaves the conversation as it read; Fork, side chats, Changes and a Claude started again read the
// conversation up to the cut; and a rewind renames nothing.
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, MessagesPage, RewindCheck, RewindDone, SessionChanges, SessionSummary } from '../src/shared/protocol';
import { REWIND_BUSY } from '../src/shared/rewind';
import { app } from '../src/server/app';
import { config } from '../src/server/config';
import { saveUpload } from '../src/server/files';
import { forgetCuts } from '../src/server/rewound';
import { closeAll, getRun, sendMessage } from '../src/server/runner';
import { loadMessages } from '../src/server/sessions';
import { transcriptPath } from '../src/server/transcripts';
import { pelicanChoice, rememberChoice } from '../src/server/trust';
import { type MessagesRequest, type StandIn, standInApi, textOf, until } from './stand-in-api';

// Looking a folder's trust up takes as long as a test asks (`slow.launch`, in ms): the moment a
// rewind starts Claude again, which another page's message or rewind can land in.
const slow = vi.hoisted(() => ({ launch: 0 }));
vi.mock('../src/server/trust', async (original) => {
  const actual = await original<typeof import('../src/server/trust')>();
  return {
    ...actual,
    launchFor: async (folder: string) => {
      if (slow.launch > 0) await new Promise((resolve) => setTimeout(resolve, slow.launch));
      return actual.launchFor(folder);
    },
  };
});

const home = vi.hoisted(() => {
  // Nothing of a Claude Code this test may itself run under reaches the one it starts, and the
  // computer's own home (shell files, settings) stays out of it: test/setup.ts made the folders.
  for (const key of Object.keys(process.env)) if ((key.startsWith('CLAUDE') && key !== 'CLAUDE_CONFIG_DIR') || key.startsWith('ANTHROPIC_')) delete process.env[key];
  process.env.HOME = `${process.env.CLAUDE_CONFIG_DIR}-home`;
  return process.env.HOME;
});

const ORIGINAL = 'The colors are CSS variables in theme.css.\n';
// One white pixel.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
let api: StandIn;
let folder: string;
let notes: string;

/** The words of the last message of a request, and whether it brings a tool's result. */
function said(request: MessagesRequest): { results: boolean; text: string } {
  const last = request.messages?.at(-1);
  const results = Array.isArray(last?.content) && last.content.some((block) => block.type === 'tool_result');
  return { results, text: textOf(last?.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() };
}

/** The request of the turn a prompt started (titles and suggestions come without tools). */
const turnOf = (prompt: string) => api.requests.filter((r) => (r.tools?.length ?? 0) > 0 && JSON.stringify(r.messages ?? []).includes(prompt)).at(-1);

/** A request as Pelican's page makes it. */
const ask = (url: string, body?: unknown) => app.request(url, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { host: 'localhost:7860', 'x-pelican': '1', 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const json = async <T>(response: Response) => ({ status: response.status, body: await response.json() as T & { error?: string } });

/** A session with these prompts, each turn done before the next goes. */
async function session(prompts: string[], settings = {}): Promise<string> {
  let id: string | undefined;
  for (const text of prompts) {
    id = await sendMessage(id ? { sessionId: id } : { cwd: folder }, { text, attachments: [], settings });
    const sent = id;
    await until(() => getRun(sent)?.busy === false, 90_000, `the turn of “${text}”`);
  }
  return id!;
}

/** The conversation as the page reads it, and where it was rewound. */
const page = async (id: string) => (await json<MessagesPage>(await ask(`/api/sessions/${id}/messages`))).body;
const words = (messages: ChatMessage[]) => messages.flatMap((m) => m.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])));
const uuidOf = async (id: string, prompt: string) => (await loadMessages(id)).find((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text === prompt))!.uuid;

/** Sends one more message and waits for its turn to end. */
async function reply(id: string, text: string): Promise<void> {
  const sent = await json<{ sessionId: string }>(await ask(`/api/sessions/${id}/messages`, { text, settings: {} }));
  expect(sent.status).toBe(200);
  await until(() => getRun(id)?.busy === false && Boolean(turnOf(text)), 90_000, `the turn of “${text}”`);
}

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  folder = path.join(realpathSync(path.dirname(config.claudeHome)), 'acme-web');
  mkdirSync(folder, { recursive: true });
  notes = path.join(folder, 'notes.md');
  config.auth = 'none';
  api = await standInApi((request) => {
    if ((request.tools?.length ?? 0) === 0) return 'A title';
    const { results, text } = said(request);
    if (results) return 'Done.';
    if (text.endsWith('Write the notes')) return { tool: 'Write', input: { file_path: notes, content: 'Changed by Claude.\n' } };
    // Work left running between turns, which starting Claude again would end.
    if (text.endsWith('Start the watcher')) return { tool: 'Bash', input: { command: 'sleep 60', description: 'Watch', run_in_background: true } };
    // A question for the user, which Claude Code always waits on: its turn runs until it is answered.
    if (text.endsWith('Ask me')) return { tool: 'AskUserQuestion', input: { questions: [{ question: 'Which theme?', header: 'Theme', multiSelect: false, options: [{ label: 'Light', description: 'Light' }, { label: 'Dark', description: 'Dark' }] }] } };
    return `Reply to: ${text.split('\n').at(-1)}`;
  });
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'sk-ant-stand-in',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
  });
}, 60_000);

afterAll(async () => {
  closeAll();
  await api?.close();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the session is called, as the list and the header say. */
const titleOf = async (id: string) => (await json<{ session: SessionSummary }>(await ask(`/api/sessions/${id}`))).body.session.title;

describe('Rewind to here, in the Claude Code the Agent SDK bundles', () => {
  it('Code only: Claude Code’s dry run says what goes back, then rewindFiles puts the file back and the conversation stays', async () => {
    writeFileSync(notes, ORIGINAL);
    const id = await session(['Code: Read the notes', 'Code: Write the notes', 'Code: Third question'], { permissionMode: 'acceptEdits' });
    expect(readFileSync(notes, 'utf8')).toBe('Changed by Claude.\n');
    const write = await uuidOf(id, 'Code: Write the notes');
    const check = await json<RewindCheck>(await ask(`/api/sessions/${id}/rewind`, { uuid: write, dryRun: true }));
    expect(check).toEqual({ status: 200, body: { files: [notes], insertions: 1, deletions: 1 } });
    // After the last prompt nothing changed: no code to put back, so its dialog has no choices.
    const last = await json<RewindCheck>(await ask(`/api/sessions/${id}/rewind`, { uuid: await uuidOf(id, 'Code: Third question'), dryRun: true }));
    expect(last.body).toEqual({ files: [], insertions: 0, deletions: 0 });
    const done = await json<RewindDone>(await ask(`/api/sessions/${id}/rewind`, { uuid: write, restore: 'code' }));
    expect(done).toEqual({ status: 200, body: { files: [notes], insertions: 1, deletions: 1 } });
    expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL);
    const after = await page(id);
    expect(after.rewound).toBeUndefined();
    expect(words(after.messages)).toContain('Code: Third question');
  }, 240_000);

  it('Code and conversation: both go back, the conversation first', async () => {
    writeFileSync(notes, ORIGINAL);
    const id = await session(['Both: Read the notes', 'Both: Write the notes', 'Both: Third question'], { permissionMode: 'acceptEdits' });
    const write = await uuidOf(id, 'Both: Write the notes');
    const done = await json<RewindDone>(await ask(`/api/sessions/${id}/rewind`, { uuid: write, restore: 'both' }));
    expect(done).toEqual({ status: 200, body: { files: [notes], insertions: 1, deletions: 1, prompt: { text: 'Both: Write the notes', attachments: [] } } });
    expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL);
    const shown = await page(id);
    expect(shown.rewound).toMatchObject({ prompt: write });
    expect(words(shown.messages)).toContain('Both: Read the notes');
    expect(words(shown.messages)).not.toContain('Both: Write the notes');
  }, 240_000);

  it('Code and conversation is all or nothing: code that cannot go back leaves the conversation whole', async () => {
    writeFileSync(notes, ORIGINAL);
    const id = await session(['Whole: Read the notes', 'Whole: Write the notes'], { permissionMode: 'acceptEdits' });
    // A copy of a session has no copies of its files (forkSession copies none): its code cannot go back.
    const copy = (await json<{ sessionId: string }>(await ask(`/api/sessions/${id}/fork`, {}))).body.sessionId;
    const write = await uuidOf(copy, 'Whole: Write the notes');
    const refused = await json(await ask(`/api/sessions/${copy}/rewind`, { uuid: write, restore: 'both' }));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/^Couldn’t restore the code from this point\./);
    expect(readFileSync(notes, 'utf8')).toBe('Changed by Claude.\n');
    const shown = await page(copy);
    expect(shown.rewound).toBeUndefined();
    expect(words(shown.messages)).toContain('Whole: Write the notes');
    // Its dialog says so before: no code to put back, only the conversation.
    expect((await json<RewindCheck>(await ask(`/api/sessions/${copy}/rewind`, { uuid: write, dryRun: true }))).body).toEqual({ files: [], insertions: 0, deletions: 0 });
  }, 240_000);

  it('the conversation starts again at the entry before the prompt, and Pelican keeps the cut: the prompt’s words and pictures come back for the box', async () => {
    const id = await session(['Cut: First question', 'Cut: Second question']);
    const image = await saveUpload(new File([Buffer.from(PIXEL, 'base64')], 'pixel.png', { type: 'image/png' }));
    await json(await ask(`/api/sessions/${id}/messages`, { text: 'Cut: Third question', attachments: [image.id], settings: {} }));
    await until(() => getRun(id)?.busy === false && Boolean(turnOf('Cut: Third question')), 90_000, 'the third turn');
    const third = await uuidOf(id, 'Cut: Third question');
    const done = await json<RewindDone>(await ask(`/api/sessions/${id}/rewind`, { uuid: third, restore: 'conversation' }));
    expect(done.status).toBe(200);
    expect(done.body.files).toBeUndefined();
    expect(done.body.prompt?.text).toBe('Cut: Third question');
    expect(done.body.prompt?.attachments).toEqual([expect.objectContaining({ name: 'image-1.png', mime: 'image/png' })]);
    // Saved again from the transcript, where Claude Code keeps the picture the prompt carried.
    expect(readFileSync(done.body.prompt!.attachments[0]!.path).subarray(1, 4).toString()).toBe('PNG');
    expect(done.body.prompt!.attachments[0]!.id).not.toBe(image.id);
    // The page shows the conversation up to the cut, and where it is.
    const shown = await page(id);
    expect(shown.rewound).toEqual({ prompt: third, at: expect.any(Number) });
    expect(words(shown.messages)).toContain('Cut: Second question');
    expect(words(shown.messages)).not.toContain('Cut: Third question');
    expect(shown.messages.at(-1)?.role).toBe('assistant');
    // Kept in Pelican's state folder, for a Pelican started again; the transcript itself is untouched.
    expect(JSON.parse(readFileSync(path.join(config.stateDir, 'rewound.json'), 'utf8')).cuts[id]).toMatchObject({ prompt: third });
    expect(readFileSync((await transcriptPath(id))!, 'utf8')).toContain('Cut: Third question');
    // Claude starts from the cut: the next message's turn has the conversation before it, not the turn rewound.
    await reply(id, 'Cut: Instead of the third');
    const request = JSON.stringify(turnOf('Cut: Instead of the third')!.messages);
    expect(request).toContain('Cut: Second question');
    expect(request).not.toContain('Cut: Third question');
  }, 240_000);

  it('Undo rewind brings the messages back, and the session’s Claude has the whole conversation again', async () => {
    const id = await session(['Undo: First question', 'Undo: Second question', 'Undo: Third question']);
    const second = await uuidOf(id, 'Undo: Second question');
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: second, restore: 'conversation' })).status).toBe(200);
    expect(words((await page(id)).messages)).not.toContain('Undo: Third question');
    expect((await json(await ask(`/api/sessions/${id}/rewind/undo`, {}))).status).toBe(200);
    const back = await page(id);
    expect(back.rewound).toBeUndefined();
    expect(words(back.messages)).toEqual(expect.arrayContaining(['Undo: Second question', 'Undo: Third question']));
    await reply(id, 'Undo: Fourth question');
    expect(JSON.stringify(turnOf('Undo: Fourth question')!.messages)).toContain('Undo: Third question');
  }, 240_000);

  it('the next message ends Undo rewind: the conversation goes on from the cut, in the transcript too', async () => {
    const id = await session(['Next: First question', 'Next: Second question']);
    const second = await uuidOf(id, 'Next: Second question');
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: second, restore: 'conversation' })).status).toBe(200);
    await reply(id, 'Next: Instead of the second');
    const undo = await json(await ask(`/api/sessions/${id}/rewind/undo`, {}));
    expect(undo).toEqual({ status: 409, body: { error: 'Undo rewind works until you send your next message.' } });
    // Its turn has ended: the transcript has it, and the cut is over.
    const cuts = () => JSON.parse(readFileSync(path.join(config.stateDir, 'rewound.json'), 'utf8')).cuts as Record<string, unknown>;
    await until(() => cuts()[id] === undefined, 10_000, 'the cut to end');
    const shown = await page(id);
    expect(shown.rewound).toBeUndefined();
    expect(words(shown.messages)).toEqual(expect.arrayContaining(['Next: First question', 'Next: Instead of the second']));
    expect(words(shown.messages)).not.toContain('Next: Second question');
  }, 240_000);

  it('answers 409 while Claude works, and does nothing', async () => {
    const id = await session(['Busy: First question']);
    await json(await ask(`/api/sessions/${id}/messages`, { text: 'Busy: Ask me', settings: {} }));
    // Claude waits for an answer: its turn runs.
    await until(() => (getRun(id)?.state().permissions.length ?? 0) > 0, 90_000, 'the question');
    const first = await uuidOf(id, 'Busy: First question');
    for (const body of [{ uuid: first, dryRun: true }, { uuid: first, restore: 'conversation' }, { uuid: first, restore: 'code' }]) {
      expect(await json(await ask(`/api/sessions/${id}/rewind`, body))).toEqual({ status: 409, body: { error: 'Rewind is unavailable while Claude is working.' } });
    }
    const run = getRun(id)!;
    run.decide(run.state().permissions[0]!.id, { behavior: 'deny' });
    await until(() => getRun(id)?.busy === false, 90_000, 'the turn to end');
    expect((await page(id)).rewound).toBeUndefined();
  }, 240_000);

  it('falls back to the whole session when Claude Code’s check refuses to drop more than the prompt’s turn', async () => {
    const id = await session(['Guard: First question', 'Guard: Second question']);
    const second = await uuidOf(id, 'Guard: Second question');
    // A background task's notice after the turn, as Claude Code writes one: not the user's, and not the turn's.
    const file = (await transcriptPath(id))!;
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const last = rows.filter((row) => typeof row.uuid === 'string').at(-1)!;
    appendFileSync(file, `${JSON.stringify({
      parentUuid: last.uuid, isSidechain: false, userType: 'external', cwd: folder, sessionId: id, version: last.version, type: 'user',
      message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Build" completed (exit code 0)</summary>\n</task-notification>' },
      uuid: '5a0f4a51-0000-4000-8000-000000000001', timestamp: new Date().toISOString(),
    })}\n`);
    const refused = await json(await ask(`/api/sessions/${id}/rewind`, { uuid: second, restore: 'conversation' }));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/^Can’t rewind to this message: .*nothing was rewound\.$/);
    // Nothing was rewound, and the session's Claude has it whole: the next message's turn has the prompt.
    expect((await page(id)).rewound).toBeUndefined();
    await reply(id, 'Guard: Third question');
    expect(JSON.stringify(turnOf('Guard: Third question')!.messages)).toContain('Guard: Second question');
  }, 240_000);

  it('Fork from here: from a prompt the copy ends just before it, its words coming back for the new box; from a reply, at the reply', async () => {
    const id = await session(['Fork: First question', 'Fork: Second question']);
    const second = await uuidOf(id, 'Fork: Second question');
    const fromPrompt = await json<{ sessionId: string; prompt: { text: string } }>(await ask(`/api/sessions/${id}/fork`, { before: second }));
    expect(fromPrompt.status).toBe(200);
    expect(fromPrompt.body.prompt).toEqual({ text: 'Fork: Second question', attachments: [] });
    const copied = words(await loadMessages(fromPrompt.body.sessionId));
    expect(copied).toContain('Fork: First question');
    expect(copied).not.toContain('Fork: Second question');
    const reply = (await loadMessages(id)).findLast((m) => m.role === 'assistant')!;
    const fromReply = await json<{ sessionId: string }>(await ask(`/api/sessions/${id}/fork`, { upTo: reply.uuid }));
    expect(words(await loadMessages(fromReply.body.sessionId))).toEqual(expect.arrayContaining(['Fork: Second question', 'Reply to: Fork: Second question']));
    // The first prompt has nothing before it: no copy, the words for a new session's box.
    const first = await json<{ sessionId: string | null; prompt: { text: string } }>(await ask(`/api/sessions/${id}/fork`, { before: await uuidOf(id, 'Fork: First question') }));
    expect(first.body).toEqual({ sessionId: null, prompt: { text: 'Fork: First question', attachments: [] } });
  }, 240_000);

  it('is refused in the demo, as all it would change is', async () => {
    config.demo = true;
    try {
      const id = '7f3c2a10-0000-4000-8000-000000000001';
      const uuid = '7f3c2a10-0000-4000-8000-000000000002';
      expect((await ask(`/api/sessions/${id}/rewind`, { uuid, dryRun: true })).status).toBe(403);
      expect((await ask(`/api/sessions/${id}/rewind`, { uuid, restore: 'conversation' })).status).toBe(403);
      expect((await ask(`/api/sessions/${id}/rewind/undo`, {})).status).toBe(403);
    } finally {
      config.demo = false;
    }
  });

  it('asks for a message and a choice of what to restore', async () => {
    const id = '7f3c2a10-0000-4000-8000-000000000001';
    expect((await ask(`/api/sessions/${id}/rewind`, { restore: 'both' })).status).toBe(400);
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: 'not-a-uuid', restore: 'both' })).status).toBe(400);
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: '7f3c2a10-0000-4000-8000-000000000002', restore: 'everything' })).status).toBe(400);
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: '7f3c2a10-0000-4000-8000-000000000002', restore: 'both' })).status).toBe(404);
    expect((await ask(`/api/sessions/${id}/rewind/undo`, {})).status).toBe(409);
  });
});

describe('the conversation’s first prompt', () => {
  it('goes back in code only, also after a SessionStart hook’s context: Fork from here starts it again in a new session', async () => {
    // A folder whose own settings add context as each session starts, as many plugins do.
    const hooked = path.join(path.dirname(folder), 'hooked');
    mkdirSync(path.join(hooked, '.claude'), { recursive: true });
    const hook = path.join(hooked, '.claude', 'start.sh');
    writeFileSync(hook, '#!/bin/sh\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Remember the house style."}}\'\n', { mode: 0o755 });
    writeFileSync(path.join(hooked, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook }] }] } }));
    await rememberChoice(hooked, 'trusted');
    let id: string | undefined;
    for (const text of ['Hooked: First question', 'Hooked: Second question']) {
      id = await sendMessage(id ? { sessionId: id } : { cwd: hooked }, { text, attachments: [], settings: {} });
      const sent = id;
      await until(() => getRun(sent)?.busy === false, 90_000, `the turn of “${text}”`);
    }
    const first = await uuidOf(id!, 'Hooked: First question');
    // Claude Code wrote the hook's context first: the prompt has a parent, which is no conversation.
    const rows = readFileSync((await transcriptPath(id!))!, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const parent = rows.find((row) => row.uuid === rows.find((r) => r.uuid === first)!.parentUuid);
    expect(parent).toMatchObject({ type: 'attachment', attachment: { type: 'hook_additional_context' } });
    const check = await json<RewindCheck>(await ask(`/api/sessions/${id}/rewind`, { uuid: first, dryRun: true }));
    expect(check.body.conversationStays).toBe('It is the conversation’s first message: Fork from here starts it again in a new session.');
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: first, restore: 'conversation' })).status).toBe(409);
    const fork = await json<{ sessionId: string | null; prompt: { text: string } }>(await ask(`/api/sessions/${id}/fork`, { before: first }));
    expect(fork.body).toEqual({ sessionId: null, prompt: { text: 'Hooked: First question', attachments: [] } });
    // The second prompt has the first before it: it goes back, and a copy holds the first.
    const second = await uuidOf(id!, 'Hooked: Second question');
    const copy = await json<{ sessionId: string }>(await ask(`/api/sessions/${id}/fork`, { before: second }));
    expect(words(await loadMessages(copy.body.sessionId))).toContain('Hooked: First question');
  }, 240_000);
});

describe('Rewind to here, all or nothing', () => {
  it('Code and conversation that fails on the code leaves an earlier rewind as it was, for Claude too', async () => {
    writeFileSync(notes, ORIGINAL);
    const id = await session(['Kept: Read the notes', 'Kept: Write the notes', 'Kept: Third question', 'Kept: Fourth question'], { permissionMode: 'acceptEdits' });
    const fourth = await uuidOf(id, 'Kept: Fourth question');
    const write = await uuidOf(id, 'Kept: Write the notes');
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: fourth, restore: 'conversation' })).status).toBe(200);
    // The file can't be written now: its code does not go back.
    chmodSync(notes, 0o444);
    let both;
    try {
      both = await json(await ask(`/api/sessions/${id}/rewind`, { uuid: write, restore: 'both' }));
    } finally {
      chmodSync(notes, 0o644);
    }
    expect(both.status).toBe(409);
    expect(both.body.error).toMatch(/^Couldn’t restore the code from this point\./);
    expect(readFileSync(notes, 'utf8')).toBe('Changed by Claude.\n');
    // Still rewound before the fourth prompt, on the page and for Claude: the next turn has the third, not the fourth.
    const shown = await page(id);
    expect(shown.rewound).toMatchObject({ prompt: fourth });
    expect(words(shown.messages)).toContain('Kept: Third question');
    expect(words(shown.messages)).not.toContain('Kept: Fourth question');
    await reply(id, 'Kept: After the failed rewind');
    const request = JSON.stringify(turnOf('Kept: After the failed rewind')!.messages);
    expect(request).toContain('Kept: Third question');
    expect(request).not.toContain('Kept: Fourth question');
    expect(words((await page(id)).messages)).not.toContain('Kept: Fourth question');
  }, 240_000);

  it('Code and conversation that fails on the code leaves the session’s Claude with the whole conversation', async () => {
    writeFileSync(notes, ORIGINAL);
    const id = await session(['Claude whole: Read the notes', 'Claude whole: Write the notes'], { permissionMode: 'acceptEdits' });
    // A copy of a session has no copies of its files: its code cannot go back.
    const copy = (await json<{ sessionId: string }>(await ask(`/api/sessions/${id}/fork`, {}))).body.sessionId;
    const write = await uuidOf(copy, 'Claude whole: Write the notes');
    expect((await ask(`/api/sessions/${copy}/rewind`, { uuid: write, restore: 'both' })).status).toBe(409);
    await reply(copy, 'Claude whole: Next');
    expect(JSON.stringify(turnOf('Claude whole: Next')!.messages)).toContain('Claude whole: Write the notes');
  }, 240_000);

  it('Code only whose copy Claude Code has let go since its check answers 409, in Desktop’s words', async () => {
    writeFileSync(notes, ORIGINAL);
    const id = await session(['Gone: Read the notes', 'Gone: Write the notes', 'Gone: Third question'], { permissionMode: 'acceptEdits' });
    const write = await uuidOf(id, 'Gone: Write the notes');
    // Claude Code clears its old copies of files: the dry run still says the file can go back.
    rmSync(path.join(config.claudeHome, 'file-history', id), { recursive: true, force: true });
    expect((await json<RewindCheck>(await ask(`/api/sessions/${id}/rewind`, { uuid: write, dryRun: true }))).body.files).toEqual([notes]);
    const done = await json(await ask(`/api/sessions/${id}/rewind`, { uuid: write, restore: 'code' }));
    expect(done.status).toBe(409);
    expect(done.body.error).toMatch(/^Couldn’t restore the code from this point\. \S/);
    expect(readFileSync(notes, 'utf8')).toBe('Changed by Claude.\n');
  }, 240_000);
});

describe('Rewind to here, one at a time with what else changes the session’s Claude', () => {
  it('a message sent from another page while a rewind starts Claude again goes after the cut, to Claude as on the pages', async () => {
    const id = await session(['Race: First question', 'Race: Second question', 'Race: Third question']);
    const second = await uuidOf(id, 'Race: Second question');
    slow.launch = 400;
    let rewound;
    let sent;
    try {
      const rewinding = ask(`/api/sessions/${id}/rewind`, { uuid: second, restore: 'conversation' });
      // While the rewind looks the folder up, before Claude starts again.
      await pause(150);
      const sending = ask(`/api/sessions/${id}/messages`, { text: 'Race: Meanwhile', settings: {} });
      [rewound, sent] = await Promise.all([rewinding, sending]);
    } finally {
      slow.launch = 0;
    }
    expect(rewound.status).toBe(200);
    expect(sent.status).toBe(200);
    await until(() => getRun(id)?.busy === false && Boolean(turnOf('Race: Meanwhile')), 30_000, 'the message’s turn');
    const request = JSON.stringify(turnOf('Race: Meanwhile')!.messages);
    expect(request).toContain('Race: First question');
    expect(request).not.toContain('Race: Second question');
    const shown = words((await page(id)).messages);
    expect(shown).toEqual(expect.arrayContaining(['Race: First question', 'Race: Meanwhile']));
    expect(shown).not.toContain('Race: Second question');
  }, 240_000);

  it('two rewinds at once: one goes, the other is told Claude is busy, in Desktop’s words', async () => {
    const id = await session(['Twice: First question', 'Twice: Second question', 'Twice: Third question']);
    const [second, third] = [await uuidOf(id, 'Twice: Second question'), await uuidOf(id, 'Twice: Third question')];
    slow.launch = 300;
    let answers;
    try {
      answers = await Promise.all([
        Promise.resolve(ask(`/api/sessions/${id}/rewind`, { uuid: second, restore: 'conversation' })).then((r) => json(r)),
        Promise.resolve(ask(`/api/sessions/${id}/rewind`, { uuid: third, restore: 'conversation' })).then((r) => json(r)),
      ]);
    } finally {
      slow.launch = 0;
    }
    expect(answers.map((a) => a.status)).toEqual([200, 409]);
    expect(answers[1]!.body).toEqual({ error: REWIND_BUSY });
    expect((await page(id)).rewound).toMatchObject({ prompt: second });
    await reply(id, 'Twice: Instead');
    const request = JSON.stringify(turnOf('Twice: Instead')!.messages);
    expect(request).toContain('Twice: First question');
    expect(request).not.toContain('Twice: Second question');
  }, 240_000);

  it('a rewind while a message is on its way is told Claude is busy, and the message is answered whole', async () => {
    const id = await session(['Landing: First question', 'Landing: Second question']);
    const second = await uuidOf(id, 'Landing: Second question');
    // No Claude running: the message starts one, looking the folder up first.
    closeAll();
    await until(() => getRun(id) === undefined, 10_000, 'Claude to close');
    slow.launch = 400;
    let rewound;
    let sent;
    try {
      const sending = ask(`/api/sessions/${id}/messages`, { text: 'Landing: Meanwhile', settings: {} });
      await pause(150);
      rewound = await json(await ask(`/api/sessions/${id}/rewind`, { uuid: second, restore: 'conversation' }));
      sent = await sending;
    } finally {
      slow.launch = 0;
    }
    expect(rewound).toEqual({ status: 409, body: { error: REWIND_BUSY } });
    expect(sent.status).toBe(200);
    await until(() => getRun(id)?.busy === false && Boolean(turnOf('Landing: Meanwhile')), 30_000, 'the message’s turn');
    expect(JSON.stringify(turnOf('Landing: Meanwhile')!.messages)).toContain('Landing: Second question');
    expect((await page(id)).rewound).toBeUndefined();
  }, 240_000);

});

describe('Rewind to here and the session’s name', () => {
  it('stays: the session keeps its name through a rewind and Undo rewind', async () => {
    const id = await session(['Name: First question', 'Name: Second question', 'Name: Third question']);
    const before = await titleOf(id);
    expect(before).toBe('Name: First question');
    const second = await uuidOf(id, 'Name: Second question');
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: second, restore: 'conversation' })).status).toBe(200);
    // The Claude the rewind replaced has ended, writing the last prompt it had: the rewound third.
    expect(await titleOf(id)).toBe(before);
    expect((await ask(`/api/sessions/${id}/rewind/undo`, {})).status).toBe(200);
    await until(() => getRun(id) !== undefined, 10_000, 'Claude resumed whole');
    await pause(1500);
    expect(await titleOf(id)).toBe(before);
  }, 240_000);
});

describe('the conversation as it reads after a rewind, up to the cut', () => {
  it('is what a Claude started again later has: after Claude closed, and after Pelican started again', async () => {
    const id = await session(['Later: First question', 'Later: Second question', 'Later: Third question']);
    const third = await uuidOf(id, 'Later: Third question');
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: third, restore: 'conversation' })).status).toBe(200);
    closeAll();
    forgetCuts();
    await until(() => getRun(id) === undefined, 10_000, 'Claude to close');
    expect((await page(id)).rewound).toMatchObject({ prompt: third });
    await reply(id, 'Later: Instead');
    const request = JSON.stringify(turnOf('Later: Instead')!.messages);
    expect(request).toContain('Later: Second question');
    expect(request).not.toContain('Later: Third question');
  }, 240_000);

  it('is what Fork copies, a side chat is asked about and Changes lists', async () => {
    writeFileSync(notes, ORIGINAL);
    const id = await session(['Reads: Read the notes', 'Reads: Second question', 'Reads: Write the notes'], { permissionMode: 'acceptEdits' });
    const write = await uuidOf(id, 'Reads: Write the notes');
    const turns = async () => (await json<SessionChanges>(await ask(`/api/sessions/${id}/changes`))).body.turns;
    expect((await turns()).map((t) => t.uuid)).toContain(write);
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: write, restore: 'conversation' })).status).toBe(200);
    // Changes: the turns before the cut.
    expect((await turns()).map((t) => t.uuid)).not.toContain(write);
    // Fork: a copy of the conversation up to the cut.
    const copy = (await json<{ sessionId: string }>(await ask(`/api/sessions/${id}/fork`, {}))).body.sessionId;
    const copied = words(await loadMessages(copy));
    expect(copied).toContain('Reads: Second question');
    expect(copied).not.toContain('Reads: Write the notes');
    // A side chat: Claude is asked about the conversation up to the cut.
    const side = (await json<{ sessionId: string }>(await ask(`/api/sessions/${id}/side`, { question: 'Reads: What did I ask last?' }))).body.sessionId;
    await until(() => getRun(side)?.busy === false && Boolean(turnOf('Reads: What did I ask last?')), 90_000, 'the side chat’s answer');
    const asked = JSON.stringify(turnOf('Reads: What did I ask last?')!.messages);
    expect(asked).toContain('Reads: Second question');
    expect(asked).not.toContain('Reads: Write the notes');
  }, 240_000);
});

describe('what only the code can go back to before', () => {
  it('a prompt before a compaction', async () => {
    const id = await session(['Compact: First question', 'Compact: Second question']);
    await sendMessage({ sessionId: id }, { text: '/compact', attachments: [], settings: {} });
    await until(() => getRun(id)?.busy === false, 90_000, 'the compaction');
    await reply(id, 'Compact: Third question');
    const check = await json<RewindCheck>(await ask(`/api/sessions/${id}/rewind`, { uuid: await uuidOf(id, 'Compact: Second question'), dryRun: true }));
    expect(check.body.conversationStays).toBe('The conversation was compacted after this message, so it can no longer go back to before it.');
    const refused = await json(await ask(`/api/sessions/${id}/rewind`, { uuid: await uuidOf(id, 'Compact: Second question'), restore: 'conversation' }));
    expect(refused).toEqual({ status: 409, body: { error: check.body.conversationStays } });
    // After it, the conversation can go back.
    const later = await json<RewindCheck>(await ask(`/api/sessions/${id}/rewind`, { uuid: await uuidOf(id, 'Compact: Third question'), dryRun: true }));
    expect(later.body.conversationStays).toBeUndefined();
  }, 240_000);

  it('a session another app has open, as Desktop has it; Pelican’s own Claude is no other app', async () => {
    const id = await session(['Other: First question', 'Other: Second question']);
    const second = await uuidOf(id, 'Other: Second question');
    expect((await json<RewindCheck>(await ask(`/api/sessions/${id}/rewind`, { uuid: second, dryRun: true }))).body.conversationStays).toBeUndefined();
    // Claude Code in a terminal, by its registry entry: a process of its own, not one of Pelican's
    // (started through a shell that leaves it, so it is no child of this one).
    const pid = Number(execFileSync('/bin/sh', ['-c', `"${process.execPath}" -e "setTimeout(() => {}, 120000)" > /dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).trim());
    const entry = path.join(config.claudeHome, 'sessions', `${pid}.json`);
    try {
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, JSON.stringify({ pid, sessionId: id, cwd: folder, startedAt: Date.now(), entrypoint: 'cli', status: 'idle', updatedAt: Date.now() }));
      await pause(1700);
      const held = await json<RewindCheck>(await ask(`/api/sessions/${id}/rewind`, { uuid: second, dryRun: true }));
      expect(held.body.conversationStays).toBe('The session is open in the terminal too, so only its code can go back here.');
      expect(await json(await ask(`/api/sessions/${id}/rewind`, { uuid: second, restore: 'conversation' }))).toEqual({ status: 409, body: { error: held.body.conversationStays } });
    } finally {
      rmSync(entry, { force: true });
      process.kill(pid);
    }
  }, 240_000);

  it('a session with work Claude left running, which starting Claude again would end', async () => {
    const id = await session(['Watch: First question', 'Watch: Start the watcher'], { permissionMode: 'bypassPermissions' });
    await until(() => getRun(id)?.hasBackgroundTasks === true, 30_000, 'the watcher');
    const first = await uuidOf(id, 'Watch: Start the watcher');
    const check = await json<RewindCheck>(await ask(`/api/sessions/${id}/rewind`, { uuid: first, dryRun: true }));
    expect(check.body.conversationStays).toBe('Claude has work running in the background here, which starting it again would stop. Stop it first.');
    expect(await json(await ask(`/api/sessions/${id}/rewind`, { uuid: first, restore: 'conversation' }))).toEqual({ status: 409, body: { error: check.body.conversationStays } });
    for (const task of getRun(id)!.state().tasks ?? []) await getRun(id)!.stopTask(task.id);
  }, 240_000);

});

describe('Rewind to here, with an answer about the folder’s trust', () => {
  it('keeps the answer it brings, as a message does', async () => {
    const asked = path.join(path.dirname(folder), 'asked');
    mkdirSync(asked, { recursive: true });
    let id: string | undefined;
    for (const text of ['Asked: First question', 'Asked: Second question']) {
      id = await sendMessage(id ? { sessionId: id } : { cwd: asked }, { text, attachments: [], settings: {} });
      const sent = id;
      await until(() => getRun(sent)?.busy === false, 90_000, `the turn of “${text}”`);
    }
    // Kept to the user's settings only until now; the answer the sheet gave comes with the rewind.
    await rememberChoice(asked, 'user-only');
    const second = await uuidOf(id!, 'Asked: Second question');
    expect((await ask(`/api/sessions/${id}/rewind`, { uuid: second, dryRun: true, trust: 'trusted' })).status).toBe(200);
    expect(await pelicanChoice(realpathSync(asked))).toBe('trusted');
  }, 240_000);
});
