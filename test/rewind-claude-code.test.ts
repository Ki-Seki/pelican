// Rewind to here and Undo rewind, as the Claude Code the Agent SDK bundles runs them, against a
// stand-in API (stand-in-api.ts), in this test's temporary folders: Code only puts files back from
// Claude Code's own copies (rewindFiles); the conversation starts again at the entry before the
// prompt (resumeSessionAt) and Pelican keeps the cut; Undo rewind resumes the session whole until
// the next message; Claude at work gets 409; Claude Code's check refusing to drop more than the
// prompt's turn (resumeDropsTurn) falls back to the whole session; the demo refuses; and Fork from
// here copies up to just before a prompt, or the end of a reply.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, MessagesPage, RewindCheck, RewindDone } from '../src/shared/protocol';
import { app } from '../src/server/app';
import { config } from '../src/server/config';
import { saveUpload } from '../src/server/files';
import { closeAll, getRun, sendMessage } from '../src/server/runner';
import { loadMessages } from '../src/server/sessions';
import { transcriptPath } from '../src/server/transcripts';
import { type MessagesRequest, type StandIn, standInApi, textOf, until } from './stand-in-api';

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
