import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { listSummaries, sessionTitle } from '../src/server/sessions';
import { columns, shortTitle } from '../src/shared/titles';

describe('a prompt as a title', () => {
  it('that quotes, as Claude Desktop and Pelican write one, is called by its words, else its note, never its markers', () => {
    const info = (firstPrompt: string) => ({ sessionId: 's1', summary: '', lastModified: 0, firstPrompt });
    expect(sessionTitle(info('<!-- reply 1 -->\n> one more set of values\n\nUse the names we have\n\n\nThen run the tests.'))).toBe('Then run the tests.');
    expect(sessionTitle(info('<!-- reply 1 -->\n> one more set of values\n\nUse the names we have\n\n\n'))).toBe('Use the names we have');
    expect(sessionTitle(info('@"src/prefs.ts"\n<!-- attach: src/app.ts:7-8 -->\n> const a = 1;\n\nExplain this'))).toBe('Explain this');
    expect(sessionTitle(info('> a quote typed by hand\n\nand words'))).toBe('and words');
  });

  it('stays as it is when it fits on a line', () => {
    expect(shortTitle('Fix the flaky login test')).toBe('Fix the flaky login test');
    expect(shortTitle('  Fix\n  the test  ')).toBe('Fix the test');
  });

  it('is cut at the last word that fits, about 60 columns, with an ellipsis', () => {
    const title = shortTitle('Fix the login test, then update the docs and add a changelog entry for the release');
    expect(title).toBe('Fix the login test, then update the docs and add a…');
    expect(columns(title)).toBeLessThanOrEqual(60);
    // A phrase's end is a break too, and its mark goes with the rest.
    expect(shortTitle('Look into why the nightly export is slow. The owners table grew past a million rows')).toBe('Look into why the nightly export is slow. The owners table…');
  });

  it('counts a CJK character as two columns and breaks at CJK punctuation', () => {
    const title = shortTitle('帮我修复登录测试中的偶发失败问题，并且更新文档，还要检查一下发布流程是否正常工作以及其他的相关事项');
    expect(title).toBe('帮我修复登录测试中的偶发失败问题，并且更新文档…');
    expect(columns('登录')).toBe(4);
    expect(columns(title)).toBeLessThanOrEqual(60);
  });

  it('cuts where the limit falls when no break comes late enough, and never inside a file name’s dot', () => {
    expect(shortTitle('https://example.com/a/very/long/path/that/goes/on/and/on/forever/and/ever/index.html')).toBe('https://example.com/a/very/long/path/that/goes/on/and/on/fo…');
    expect(shortTitle('Rename it everywhere: packages/server/src/handlers/authentication.middleware.ts and the tests')).toBe('Rename it everywhere: packages/server/src/handlers/authenti…');
  });
});

describe('the titles of listed sessions', () => {
  let dir: string;
  let project: string;
  const saved = { claudeHome: config.claudeHome, env: process.env.CLAUDE_CONFIG_DIR };
  const id = (n: number) => `7a7a7a7a-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = new Date(Date.now() - 3600_000).toISOString();
  const LONG = 'Please go through the whole export pipeline, find out why the nightly run went from four minutes to forty, and fix it with a test that counts the queries';
  const prompt = (session: string, text: string) => ({ type: 'user', uuid: `${session}-u`, parentUuid: null, sessionId: session, cwd: '/w/app', timestamp: at, message: { role: 'user', content: text } });
  const reply = (session: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: 'assistant', uuid: `${session}-a`, parentUuid: `${session}-u`, sessionId: session, cwd: '/w/app', timestamp: at,
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] }, ...extra,
  });
  const write = (n: number, rows: unknown[]) => writeFile(path.join(project, `${id(n)}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const listed = async (n: number) => (await listSummaries(() => undefined)).find((s) => s.id === id(n));

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-titles-'));
    config.claudeHome = dir;
    process.env.CLAUDE_CONFIG_DIR = dir;
    project = path.join(dir, 'projects', '-w-app');
    await mkdir(project, { recursive: true });
    await write(1, [prompt(id(1), LONG), reply(id(1), 'Done.')]);
    await write(2, [{ type: 'custom-title', customTitle: 'Speed up the nightly export, by batching the owner lookups in export_rows', sessionId: id(2) }, prompt(id(2), LONG), reply(id(2), 'Done.')]);
    // Claude Code once wrote summaries; one at the end of a file is what the SDK titles the session with.
    await write(3, [prompt(id(3), LONG), reply(id(3), 'Done.'), { type: 'summary', summary: 'Batching the owner lookups in the nightly export pipeline for speed', leafUuid: `${id(3)}-a` }]);
    await write(4, [prompt(id(4), 'Short first prompt'), reply(id(4), 'Done.'), { type: 'last-prompt', lastPrompt: LONG, sessionId: id(4) }]);
    // A session whose only reply is Claude Code saying it is signed out.
    await write(5, [prompt(id(5), 'Deploy the site'), reply(id(5), 'Not logged in · Please run /login', { isApiErrorMessage: true, error: 'authentication_failed', message: { id: 'msg_x', type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } })]);
  });
  afterAll(async () => {
    config.claudeHome = saved.claudeHome;
    if (saved.env === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.env;
    await rm(dir, { recursive: true, force: true });
  });

  it('shortens a title that is the text of a prompt, the first or the last', async () => {
    expect((await listed(1))?.title).toBe('Please go through the whole export pipeline, find out why…');
    expect((await listed(4))?.title).toBe('Please go through the whole export pipeline, find out why…');
  });

  it('keeps a title the session was given, and a summary Claude Code wrote, as they are', async () => {
    expect((await listed(2))?.title).toBe('Speed up the nightly export, by batching the owner lookups in export_rows');
    expect((await listed(3))?.title).toBe('Batching the owner lookups in the nightly export pipeline for speed');
  });

  it('shows why a turn stopped, not Claude Code’s error as the reply', async () => {
    const session = await listed(5);
    expect(session?.stopped).toBe('not signed in');
    expect(session?.preview).toBeUndefined();
    // A reply after it is the preview again.
    await appendFile(path.join(project, `${id(5)}.jsonl`), `${JSON.stringify({ ...prompt(id(5), 'Deploy the site'), uuid: `${id(5)}-u2` })}\n${JSON.stringify({ ...reply(id(5), 'Deployed.'), uuid: `${id(5)}-a2` })}\n`);
    expect(await listed(5)).toMatchObject({ preview: 'Deployed.' });
    expect((await listed(5))?.stopped).toBeUndefined();
  });
});
