import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import { config } from '../src/server/config';
import { readHistory } from '../src/server/history';
import { storedImages, toChatMessage } from '../src/server/normalize';
import { refreshTranscriptIndex } from '../src/server/transcripts';

const png = (byte: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, byte]).toString('base64');
const picture = (byte: number, mediaType = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: png(byte) } });
const id = '0f0f0f0f-0000-4000-8000-0000000000cc';

let dir: string;
let file: string;
const saved = { ...config };
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-images-'));
  Object.assign(config, { claudeHome: dir, configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), auth: 'auto' });
  await mkdir(path.join(dir, 'projects', '-w-app'), { recursive: true });
  file = path.join(dir, 'projects', '-w-app', `${id}.jsonl`);
  const at = '2026-11-05T00:00:00.000Z';
  await writeFile(file, `${[
    { type: 'user', uuid: 'u1', parentUuid: null, timestamp: at, message: { role: 'user', content: [picture(1), { type: 'text', text: 'Like this' }] } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Screenshot', input: {} }] } },
    { type: 'user', uuid: 'r1', parentUuid: 'a1', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'shot' }, picture(2), picture(3, 'image/svg+xml')] }] } },
    { type: 'attachment', uuid: 'q1', parentUuid: 'r1', timestamp: at, attachment: { type: 'queued_command', prompt: [picture(4), { type: 'text', text: 'and this' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'q1', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Both done.' }] } },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`);
  await refreshTranscriptIndex();
  await loadAuth();
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

describe('pictures in messages', () => {
  it('are numbered the same way when a message is shown and when its picture is fetched', () => {
    const content = [picture(1), { type: 'tool_result', tool_use_id: 't', content: [picture(2), { type: 'image', source: { type: 'url', url: 'https://x.example/a.png' } }, picture(3)] }];
    const message = toChatMessage({ type: 'user', uuid: 'm', message: { role: 'user', content } }, (n) => `img/${n}`);
    const urls = JSON.stringify(message).match(/img\/\d|https:[^"]+/g);
    expect(urls).toEqual(['img/0', 'img/1', 'https://x.example/a.png', 'img/2']);
    expect(storedImages(content).map((image) => Buffer.from(image.data, 'base64')[4])).toEqual([1, 2, 3]);
    // Streamed in, before the transcript has it: the picture itself.
    expect(toChatMessage({ type: 'user', uuid: 'm', message: { role: 'user', content } })!.blocks[0]).toMatchObject({ source: { type: 'base64' } });
  });

  it('go out as addresses in pages of messages, not as data', async () => {
    const messages = await readHistory(file);
    const page = JSON.stringify(messages);
    expect(page).not.toContain(png(1));
    expect(messages[0]!.blocks[0]).toEqual({ type: 'image', source: { type: 'url', url: `api/sessions/${id}/images/u1/0` } });
    expect(page).toContain(`api/sessions/${id}/images/r1/1`);
    expect(page).toContain(`api/sessions/${id}/images/q1/0`);
  });

  it('are served from their message, inert and kept by the browser, to signed-in pages only', async () => {
    const get = (url: string, signedIn = true) => app.request(url, { headers: { host: 'localhost:7860', ...(signedIn ? { authorization: `Bearer ${accessToken()}` } : {}) } });
    const response = await get(`/api/sessions/${id}/images/r1/0`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('content-security-policy')).toMatch(/^sandbox/);
    expect(Buffer.from(await response.arrayBuffer())[4]).toBe(2);
    expect(Buffer.from(await (await get(`/api/sessions/${id}/images/q1/0`)).arrayBuffer())[4]).toBe(4);
    // Not a picture type Claude takes, no such position, no such message, not signed in.
    expect((await get(`/api/sessions/${id}/images/r1/1`)).status).toBe(404);
    expect((await get(`/api/sessions/${id}/images/r1/7`)).status).toBe(404);
    expect((await get(`/api/sessions/${id}/images/zz/0`)).status).toBe(404);
    expect((await get(`/api/sessions/${id}/images/u1/0`, false)).status).toBe(401);
  });
});

describe('long texts in messages', () => {
  it('are cut, also in a tool call’s input', () => {
    const big = 'x'.repeat(100_000);
    const message = toChatMessage({ type: 'assistant', uuid: 'w', message: { role: 'assistant', content: [{ type: 'text', text: big }, { type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/w/a.txt', content: big } }] } })!;
    expect(message.blocks[0]).toMatchObject({ type: 'text', truncated: true });
    const call = message.blocks[1];
    if (call?.type !== 'tool_use') throw new Error('not a tool call');
    expect(call.input.file_path).toBe('/w/a.txt');
    expect(String(call.input.content).length).toBeLessThan(61_000);
    expect(String(call.input.content).endsWith('\n…')).toBe(true);
  });
});
