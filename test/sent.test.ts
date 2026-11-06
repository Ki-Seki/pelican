import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import { config } from '../src/server/config';
import { toChatMessage } from '../src/server/normalize';
import { sentFiles } from '../src/server/sessions';
import type { ToolResultBlock } from '../src/shared/protocol';

let root: string;
let work: string;
const saved = { ...config };
const savedClaude = process.env.CLAUDE_CONFIG_DIR;
const A = randomUUID();
const B = randomUUID();
const MB = 1024 * 1024;
const ODD = ['page.constructor', 'page.__proto__', 'page.toString'];
/** Sent, then moved away: a name a page would take for markup, with a character that turns text around. */
const GONE = 'old <img src=x onerror=alert(1)> \u202efdp.pdf';
const PAGE = '<!doctype html><h1>Hi</h1>\n';

/** What Claude Code records of a SendUserFile result, for files at these paths. */
const record = (files: Array<string | Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  attachments: files.map((file) => (typeof file === 'string' ? { path: file, size: 12, isImage: /\.png$/.test(file), media_type: 'text/plain', pathValidated: true } : file)),
  ...extra,
});

/** A session's transcript: each row points at the one before it, as Claude Code writes them. */
async function transcript(id: string, cwd: string, rows: Array<{ type: 'user' | 'assistant'; content: unknown[]; toolUseResult?: unknown }>) {
  const dir = path.join(config.claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(dir, { recursive: true });
  const at = Date.now();
  let parent: string | null = null;
  const lines = rows.map((row, i) => {
    const uuid = randomUUID();
    const line = JSON.stringify({
      type: row.type, uuid, parentUuid: parent, sessionId: id, cwd, timestamp: new Date(at + i * 1000).toISOString(),
      message: { role: row.type, content: row.content }, ...(row.toolUseResult ? { toolUseResult: row.toolUseResult } : {}),
    });
    parent = uuid;
    return line;
  });
  await writeFile(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
}

const send = (id: string, files: unknown) => ({ type: 'tool_use', id, name: 'SendUserFile', input: { files, status: 'normal' } });
const answer = (id: string, text = '1 file delivered to user.', error = false) => ({ type: 'tool_result', tool_use_id: id, content: text, ...(error ? { is_error: true } : {}) });

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-sent-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  config.configDir = path.join(root, 'config');
  config.stateDir = path.join(root, 'state');
  config.auth = 'auto';
  await loadAuth();
  work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  await writeFile(path.join(work, 'report.md'), '# Report\n\nAll good.\n');
  await writeFile(path.join(work, 'chart.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  await writeFile(path.join(work, 'notes.pdf'), '%PDF-1.4\n%%EOF\n');
  await writeFile(path.join(work, 'data.zip'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));
  await writeFile(path.join(work, 'page.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
  await writeFile(path.join(root, 'secret.txt'), 'not for the page\n');
  // A file Claude sent that a link has since replaced, leading out of its folder.
  await symlink(path.join(root, 'secret.txt'), path.join(work, 'swapped.md'));
  // Larger than a file Claude sent is served, without taking that much disk.
  const big = await open(path.join(work, 'huge.bin'), 'w');
  await big.truncate(201 * 1024 * 1024);
  await big.close();
  await mkdir(path.join(root, 'other'), { recursive: true });
  await writeFile(path.join(root, 'other', 'theirs.txt'), 'another session’s\n');
  // Named by what every object has (Object.prototype): no type of picture.
  for (const name of ODD) await writeFile(path.join(work, name), PAGE);
  // Changed while they are downloaded.
  await writeFile(path.join(work, 'grow.bin'), Buffer.alloc(MB, 1));
  await writeFile(path.join(work, 'shrink.bin'), Buffer.alloc(MB, 1));
  await writeFile(path.join(work, 'empty.txt'), '');
  await writeFile(path.join(work, GONE), '%PDF-1.4\n%%EOF\n');

  await transcript(A, work, [
    { type: 'user', content: [{ type: 'text', text: 'Send me what you made' }] },
    {
      type: 'assistant',
      content: [
        send('ran', ['report.md']),
        // Claude asked for one file; Claude Code delivered what it checked, at its own path.
        send('asked-other', '/etc/hosts'),
        send('failed', ['missing.md']),
        send('unanswered', ['/Users/ada/.ssh/id_ed25519']),
        send('kinds', ['chart.png', 'notes.pdf', 'data.zip', 'page.svg', 'swapped.md', 'huge.bin']),
        send('refused', ['secret.txt']),
        send('odd', [...ODD, 'grow.bin', 'shrink.bin', 'empty.txt', GONE]),
      ],
    },
    { type: 'user', content: [answer('ran')], toolUseResult: record([path.join(work, 'report.md')], { caption: 'The report', display: 'render' }) },
    { type: 'user', content: [answer('asked-other')], toolUseResult: record([path.join(work, 'report.md')]) },
    { type: 'user', content: [answer('failed', 'Attachment "missing.md" does not exist.', true)], toolUseResult: 'Error: Attachment "missing.md" does not exist.' },
    {
      type: 'user',
      content: [answer('kinds', '6 files delivered to user.')],
      toolUseResult: record(['chart.png', 'notes.pdf', 'data.zip', 'page.svg', 'swapped.md', 'huge.bin'].map((f) => path.join(work, f))),
    },
    {
      type: 'user',
      content: [answer('refused', '1 file could NOT be delivered to the user')],
      toolUseResult: record([{ path: path.join(root, 'secret.txt'), size: 17, isImage: false, pathValidated: true, upload_error: 'not sent: it now resolves to what was not approved' }]),
    },
    { type: 'user', content: [answer('odd', '7 files delivered to user.')], toolUseResult: record([...ODD, 'grow.bin', 'shrink.bin', 'empty.txt', GONE].map((f) => path.join(work, f))) },
  ]);
  await rm(path.join(work, GONE));
  await transcript(B, path.join(root, 'other'), [
    { type: 'user', content: [{ type: 'text', text: 'Send me yours' }] },
    { type: 'assistant', content: [send('b1', ['theirs.txt'])] },
    { type: 'user', content: [answer('b1')], toolUseResult: record([path.join(root, 'other', 'theirs.txt')]) },
  ]);
});
afterAll(async () => {
  Object.assign(config, saved);
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  await rm(root, { recursive: true, force: true });
});

const resultOf = (raw: Record<string, unknown>) => toChatMessage(raw)!.blocks[0] as ToolResultBlock;
const row = (extra: Record<string, unknown>, error = false) => ({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: [answer('t', 'x', error)] }, ...extra });

describe('what Claude Code records a SendUserFile call delivered', () => {
  it('is read from the transcript and from the stream alike: each file at the path Claude Code checked, its caption and how to show it', () => {
    const output = record(['/w/report.md', '/w/chart.png'], { caption: 'Before and after', display: 'attach' });
    const expected = {
      files: [{ path: '/w/report.md', size: 12, type: 'text/plain' }, { path: '/w/chart.png', size: 12, image: true, type: 'text/plain' }],
      caption: 'Before and after',
      display: 'attach',
    };
    expect(resultOf(row({ toolUseResult: output })).delivered).toEqual(expected);
    expect(resultOf(row({ tool_use_result: output })).delivered).toEqual(expected);
  });

  it('counts, and never keeps, a file Claude Code did not deliver, did not check, or names by no absolute path', () => {
    const delivered = resultOf(row({
      toolUseResult: record([
        { path: '/w/swapped.md', size: 3, isImage: false, pathValidated: true, upload_error: 'not sent: it now resolves to what was not approved' },
        { path: 'uploaded.png', size: 3, isImage: true, file_uuid: 'f1', pathValidated: false },
        { path: 'relative.md', size: 3, isImage: false, pathValidated: true },
        { path: '/w/ok.md', size: 3, isImage: false, pathValidated: true, media_type: 'text/markdown; charset=<b>' },
        'not an attachment',
      ]),
    })).delivered;
    expect(delivered).toEqual({ files: [{ path: '/w/ok.md', size: 3 }], missed: 4 });
  });

  it('is nothing on a call that failed, and leaves other tools’ records alone', () => {
    expect(resultOf(row({ toolUseResult: record(['/w/a.md']) }, true)).delivered).toBeUndefined();
    expect(resultOf(row({ toolUseResult: { filePath: '/w/a.md', structuredPatch: [] } })).delivered).toBeUndefined();
    expect(resultOf(row({ toolUseResult: { attachments: [] } })).delivered).toBeUndefined();
  });
});

describe('files Claude sent', () => {
  it('are what Claude Code recorded it delivered, from calls that ran: not what Claude asked for, nor a call that failed, was only written, or was refused', async () => {
    expect([...(await sentFiles(A))].sort()).toEqual(['report.md', 'chart.png', 'notes.pdf', 'data.zip', 'page.svg', 'swapped.md', 'huge.bin', ...ODD, 'grow.bin', 'shrink.bin', 'empty.txt', GONE].map((f) => path.join(work, f)).sort());
    expect([...(await sentFiles(B))]).toEqual([path.join(root, 'other', 'theirs.txt')]);
  });
});

const ask = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  app.request(url, { method, headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}`, ...headers } });
const shown = (id: string, file: string) => ask(`/api/sessions/${id}/sent?path=${encodeURIComponent(file)}`);
/** As a page asks for a file by a link (an image, a tab, a download): no header of Pelican's. A HEAD comes from the page's own code, marked. */
const linked = (id: string, file: string, extra = '', { method = 'GET', ...headers }: Record<string, string> = {}) =>
  ask(`/api/sessions/${id}/sent/raw?path=${encodeURIComponent(file)}${extra}`, { 'x-pelican': method === 'HEAD' ? '1' : '', 'sec-fetch-site': 'same-origin', ...headers }, method);

describe('a file Claude sent, to show', () => {
  it('reads the text of one it sent in this session, an SVG as text for its preview, a picture as data', async () => {
    expect(await (await shown(A, path.join(work, 'report.md'))).json()).toMatchObject({ text: '# Report\n\nAll good.\n', size: 20 });
    expect(await (await shown(A, path.join(work, 'page.svg'))).json()).toMatchObject({ text: expect.stringContaining('<circle') });
    expect((await (await shown(A, path.join(work, 'chart.png'))).json()).image).toMatch(/^data:image\/png;base64,/);
  });

  it('refuses any other path, one a link has turned into a way out of its folder, and another session’s file', async () => {
    for (const file of [path.join(root, 'secret.txt'), path.join(work, 'missing.md'), '/etc/hosts', '/Users/ada/.ssh/id_ed25519', 'report.md', `${work}/../secret.txt`]) {
      expect((await shown(A, file)).status).toBe(404);
      expect((await linked(A, file)).status).toBe(404);
    }
    // What Claude sent is no longer there: what the link leads to is never served instead.
    for (const answer of [await shown(A, path.join(work, 'swapped.md')), await linked(A, path.join(work, 'swapped.md'))]) {
      expect(answer.status).toBe(410);
      expect(await answer.text()).not.toContain('not for the page');
    }
    expect((await shown(A, path.join(root, 'other', 'theirs.txt'))).status).toBe(404);
    expect((await linked(A, path.join(root, 'other', 'theirs.txt'))).status).toBe(404);
    expect((await shown(B, path.join(root, 'other', 'theirs.txt'))).status).toBe(200);
  });

  it('is behind the same gate as the rest: the page’s own requests, signed in', async () => {
    const file = path.join(work, 'report.md');
    expect((await shown(A, file)).status).toBe(200);
    expect((await ask(`/api/sessions/${A}/sent?path=${encodeURIComponent(file)}`, { 'x-pelican': '' })).status).toBe(403);
    expect((await linked(A, file, '', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await app.request(`/api/sessions/${A}/sent/raw?path=${encodeURIComponent(file)}`, { headers: { host: 'localhost:7860' } })).status).toBe(401);
  });
});

describe('whether the files Claude sent are still there', () => {
  const states = (id: string, files: string[], headers: Record<string, string> = {}) =>
    ask(`/api/sessions/${id}/sent/state?${files.map((f) => `p=${encodeURIComponent(f)}`).join('&')}`, headers);

  it('says which are there, gone or too large to serve, for files Claude sent in this session only', async () => {
    const answer = await states(A, [
      path.join(work, 'report.md'), path.join(work, GONE), path.join(work, 'huge.bin'), path.join(work, 'swapped.md'),
      path.join(root, 'secret.txt'), '/etc/hosts', path.join(root, 'other', 'theirs.txt'), 'report.md',
    ]);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      there: [path.join(work, 'report.md')],
      gone: [path.join(work, GONE), path.join(work, 'swapped.md')].sort(),
      large: [path.join(work, 'huge.bin')],
    });
    expect(await (await states(B, [path.join(root, 'other', 'theirs.txt'), path.join(work, 'report.md')])).json()).toEqual({ there: [path.join(root, 'other', 'theirs.txt')], gone: [], large: [] });
    expect((await states(A, Array.from({ length: 51 }, (_, i) => path.join(work, `f${i}`)))).status).toBe(400);
  });

  it('is behind the same gate as the rest', async () => {
    const files = [path.join(work, 'report.md')];
    expect((await states(A, files, { 'x-pelican': '' })).status).toBe(403);
    expect((await states(A, files, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await app.request(`/api/sessions/${A}/sent/state?p=${encodeURIComponent(files[0]!)}`, { headers: { host: 'localhost:7860', 'x-pelican': '1' } })).status).toBe(401);
  });
});

describe('a file Claude sent, by a link', () => {
  it('is a picture as itself, inert, that a browser keeps and asks about again', async () => {
    const response = await linked(A, path.join(work, 'chart.png'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    const tag = response.headers.get('etag')!;
    expect((await linked(A, path.join(work, 'chart.png'), '', { 'if-none-match': tag })).status).toBe(304);
  });

  it('is a PDF for the browser’s own viewer, never sniffed and never framed', async () => {
    const response = await linked(A, path.join(work, 'notes.pdf'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''notes.pdf");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(await response.text()).toBe('%PDF-1.4\n%%EOF\n');
  });

  it('downloads anything else, and anything asked to download, as an attachment that runs nothing', async () => {
    for (const [file, extra] of [['data.zip', ''], ['page.svg', ''], ['report.md', '&download=1'], ['chart.png', '&download=1'], ['notes.pdf', '&download=1']] as const) {
      const response = await linked(A, path.join(work, file), extra);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${file}`);
      expect(response.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
      await response.arrayBuffer();
    }
  });

  it('is not served past 200 MB', async () => {
    const response = await linked(A, path.join(work, 'huge.bin'));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Larger than Pelican serves (200 MB)' });
    expect((await linked(A, path.join(work, 'huge.bin'), '', { method: 'HEAD' })).status).toBe(413);
  });

  it('says a file no longer where Claude Code delivered it is Gone, to the page, and to a HEAD before any tap', async () => {
    const file = path.join(work, GONE);
    const read = await shown(A, file);
    expect(read.status).toBe(410);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(await read.json()).toEqual({ error: 'No longer on this computer' });
    for (const extra of ['', '&download=1']) {
      const head = await linked(A, file, extra, { method: 'HEAD' });
      expect(head.status).toBe(410);
      expect(await head.text()).toBe('');
      expect((await linked(A, file, extra)).status).toBe(410);
    }
    // Still there: a HEAD says so, and reads nothing.
    const there = await linked(A, path.join(work, 'notes.pdf'), '', { method: 'HEAD' });
    expect(there.status).toBe(200);
    expect(await there.text()).toBe('');
  });

  it('says so in a page of its own to a browser that opened it, in Pelican’s words, running nothing', async () => {
    const page = await linked(A, path.join(work, GONE), '', { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
    expect(page.status).toBe(410);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'$/);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const text = await page.text();
    expect(text).toContain('<p class="name">old &lt;img src=x onerror=alert(1)&gt; ⟨U+202E⟩fdp.pdf</p>');
    expect(text).toContain('<p>No longer on this computer</p>');
    expect(text).not.toContain('<img');
    expect(text).not.toContain('<script');
    const large = await linked(A, path.join(work, 'huge.bin'), '', { accept: 'text/html' });
    expect(large.status).toBe(413);
    expect(await large.text()).toContain('<p>Larger than Pelican serves (200 MB)</p>');
    // Nothing of the asked-for path comes back for a file Claude did not send.
    const other = await linked(A, '/etc/<b>hosts', '', { accept: 'text/html' });
    expect(other.status).toBe(404);
    const refused = await other.text();
    expect(refused).toContain('<p>Not a file Claude sent in this session</p>');
    expect(refused).not.toContain('hosts');
  });

  it('is no picture for an extension every object has a property of: it downloads, and reads as text', async () => {
    for (const name of ODD) {
      const response = await linked(A, path.join(work, name));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${name}`);
      expect(await response.text()).toBe(PAGE);
      const read = await shown(A, path.join(work, name));
      expect(await read.json()).toEqual({ path: name, size: PAGE.length, text: PAGE });
    }
  });

  it('sends exactly the bytes it said, however the file changes meanwhile', async () => {
    const grown = await linked(A, path.join(work, 'grow.bin'), '&download=1');
    expect(grown.headers.get('content-length')).toBe(String(MB));
    await appendFile(path.join(work, 'grow.bin'), Buffer.alloc(8 * MB, 2));
    expect((await grown.arrayBuffer()).byteLength).toBe(MB);
    // Cut short meanwhile: the response breaks off rather than ending as if it were whole.
    const cut = await linked(A, path.join(work, 'shrink.bin'), '&download=1');
    expect(cut.headers.get('content-length')).toBe(String(MB));
    await truncate(path.join(work, 'shrink.bin'), 100);
    await expect(cut.arrayBuffer()).rejects.toThrow();
    const empty = await linked(A, path.join(work, 'empty.txt'));
    expect(empty.status).toBe(200);
    expect(empty.headers.get('content-length')).toBe('0');
    expect(await empty.text()).toBe('');
  });
});
