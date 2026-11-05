import { execFileSync } from 'node:child_process';
import { readdirSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import { config } from '../src/server/config';

let dir: string;
let cwd: string;
const saved = { ...config };
const SESSION = '7a7a7a7a-1111-4222-8333-444444444444';

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-routes-')));
  config.configDir = path.join(dir, 'config');
  config.stateDir = path.join(dir, 'state');
  config.auth = 'auto';
  await loadAuth();
  cwd = path.join(dir, 'app');
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await writeFile(path.join(cwd, 'src', 'a.ts'), 'one\n');
  await writeFile(path.join(dir, 'secret.txt'), 'outside\n');
  await symlink(path.join(dir, 'secret.txt'), path.join(cwd, 'link.txt'));
  // A session that edited a file there, as Claude Code records it.
  const projects = path.join(config.claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(projects, { recursive: true });
  const prompt = { type: 'user', uuid: 'p1', parentUuid: null, sessionId: SESSION, cwd, timestamp: '2026-11-05T10:00:00Z', message: { role: 'user', content: 'Change a.ts' } };
  const call = { type: 'assistant', uuid: 'c1', parentUuid: 'p1', sessionId: SESSION, cwd, timestamp: '2026-11-05T10:00:01Z', message: { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: `${cwd}/src/a.ts` } }] } };
  const done = {
    type: 'user', uuid: 'r1', parentUuid: 'c1', sessionId: SESSION, cwd, timestamp: '2026-11-05T10:00:02Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    toolUseResult: { filePath: `${cwd}/src/a.ts`, originalFile: 'one\n', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-one', '+two'] }] },
  };
  await writeFile(path.join(projects, `${SESSION}.jsonl`), `${[prompt, call, done].map((r) => JSON.stringify(r)).join('\n')}\n`);
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

/** How many descriptors this process holds open on a file. */
function openOn(file: string): number {
  if (process.platform === 'linux') {
    return readdirSync('/proc/self/fd').filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`) === file;
      } catch {
        return false;
      }
    }).length;
  }
  return execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' }).split('\n').filter((line) => line.endsWith(file)).length;
}

const ask = (url: string, headers: Record<string, string> = {}) =>
  app.request(url, { headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}`, ...headers } });

describe('which files are there', () => {
  it('answers only for regular files inside the folder: no link out of it, no ..', async () => {
    const q = (paths: string[]) => `/api/exists?cwd=${encodeURIComponent(cwd)}${paths.map((p) => `&p=${encodeURIComponent(p)}`).join('')}`;
    const response = await ask(q(['src/a.ts', 'src', 'link.txt', '../secret.txt', '/etc/hosts', 'gone.ts']));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paths: ['src/a.ts'] });
    expect((await ask(q(Array.from({ length: 51 }, (_, i) => `f${i}`)))).status).toBe(400);
  });

  it('is behind the same gate as the rest', async () => {
    const url = `/api/exists?cwd=${encodeURIComponent(cwd)}&p=src/a.ts`;
    expect((await ask(url, { 'x-pelican': '' })).status).toBe(403);
    expect((await ask(url, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await app.request(url, { headers: { host: 'localhost:7860', 'x-pelican': '1' } })).status).toBe(401);
  });
});

describe('a file downloaded', () => {
  it('comes as an attachment that runs nothing where it opens, and only from inside the folder', async () => {
    const response = await ask(`/api/file/raw?cwd=${encodeURIComponent(cwd)}&path=src%2Fa.ts`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('one\n');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''a.ts");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    for (const bad of ['link.txt', '../secret.txt', '/etc/hosts', 'src']) {
      expect((await ask(`/api/file/raw?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(bad)}`)).status).toBe(404);
    }
  });

  it('answers a HEAD with the headers alone, and leaves the file closed', async () => {
    await writeFile(path.join(cwd, 'big.bin'), Buffer.alloc(1024 * 1024, 1));
    const url = `/api/file/raw?cwd=${encodeURIComponent(cwd)}&path=big.bin`;
    for (let i = 0; i < 20; i += 1) {
      const head = await app.request(url, { method: 'HEAD', headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}` } });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String(1024 * 1024));
      expect(head.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''big.bin");
    }
    expect(openOn(path.join(cwd, 'big.bin'))).toBe(0);
  });

  it('is a plain link the page cannot mark, so it is let through only as the page itself would ask', async () => {
    const url = `/api/file/raw?cwd=${encodeURIComponent(cwd)}&path=src%2Fa.ts`;
    expect((await ask(url, { 'x-pelican': '' })).status).toBe(200);
    expect((await ask(url, { 'x-pelican': '', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await app.request(url, { headers: { host: 'localhost:7860' } })).status).toBe(401);
  });
});

describe('searching the folder', () => {
  it('needs some text, and finds it', async () => {
    expect((await ask(`/api/search?cwd=${encodeURIComponent(cwd)}&q=`)).status).toBe(400);
    const result = await (await ask(`/api/search?cwd=${encodeURIComponent(cwd)}&q=one`)).json() as { files: Array<{ path: string }> };
    expect(result.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });
});

describe('what each turn changed', () => {
  it('comes from the transcript, with each file’s diff, in any folder', async () => {
    const response = await ask(`/api/sessions/${SESSION}/changes`);
    const { turns } = await response.json() as { turns: Array<{ uuid: string; n: number; files: Array<{ path: string }> }> };
    expect(turns).toMatchObject([{ uuid: 'p1', n: 1, text: 'Change a.ts', files: [{ path: 'src/a.ts', added: 1, removed: 1 }], checkpoint: false }]);
    const diff = await (await ask(`/api/sessions/${SESSION}/changes?turn=p1&path=src%2Fa.ts`)).json() as { diff: string };
    expect(diff.diff).toContain('+two');
    expect((await ask(`/api/sessions/${SESSION}/changes?turn=p1`)).status).toBe(400);
    expect(await (await ask('/api/sessions/00000000-0000-4000-8000-000000000000/changes')).json()).toEqual({ turns: [], lines: {} });
  });
});
