import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bundledClaude } from '../src/server/claude-code';
import { SEARCH_LIMITS, searchText } from '../src/server/search';

let dir: string;
let cwd: string;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-search-')));
  cwd = path.join(dir, 'app');
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await mkdir(path.join(cwd, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(cwd, 'src', 'theme.css'), ':root {\n  --bg: #fff;\n}\n[data-theme=dark] {\n  --bg: #000;\n}\n');
  await writeFile(path.join(cwd, 'src', 'Toggle.tsx'), 'export const Theme = 1;\n');
  await writeFile(path.join(cwd, 'node_modules', 'x', 'theme.js'), 'theme\n');
  await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 116, 104, 101, 109, 101]));
  await writeFile(path.join(dir, 'outside.txt'), 'theme outside\n');
  await symlink(path.join(dir, 'outside.txt'), path.join(cwd, 'link.txt'));
  await symlink(dir, path.join(cwd, 'up'));
  await writeFile(path.join(cwd, 'many.txt'), Array.from({ length: 100 }, () => 'theme').join('\n'));
  await writeFile(path.join(cwd, 'long.md'), `${'A paragraph on one line, as Markdown keeps them. '.repeat(20)}The needle is here, ${'and the line goes on. '.repeat(20)}\n`);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const found = (result: Awaited<ReturnType<typeof searchText>>) => Object.fromEntries(result.files.map((f) => [f.path, f.lines.map((l) => l.n)]));

describe('searching the folder’s text', () => {
  it('with Claude Code’s ripgrep: smart case, lines numbered, nothing through links, ignored folders skipped', async () => {
    if (!bundledClaude()) return;
    const result = await searchText(cwd, 'theme');
    expect(result.engine).toBe('rg');
    const files = found(result);
    expect(files['src/theme.css']).toEqual([4]);
    expect(files['src/Toggle.tsx']).toEqual([1]);
    expect(files['many.txt']).toHaveLength(SEARCH_LIMITS.perFile);
    expect(Object.keys(files).some((f) => f.startsWith('node_modules') || f.startsWith('up/') || f === 'link.txt' || f === 'binary.bin')).toBe(false);
    // A capital letter makes it match case.
    expect(Object.keys(found(await searchText(cwd, 'Theme')))).toEqual(['src/Toggle.tsx']);
    // A query that looks like an option is still a query.
    expect((await searchText(cwd, '--files')).files).toEqual([]);
  });

  it('without it, the scan finds the same, within the same limits', async () => {
    const result = await searchText(cwd, 'theme', 'scan');
    expect(result.engine).toBe('scan');
    const files = found(result);
    expect(files['src/theme.css']).toEqual([4]);
    expect(files['src/Toggle.tsx']).toEqual([1]);
    expect(files['many.txt']).toHaveLength(SEARCH_LIMITS.perFile);
    expect(Object.keys(files).some((f) => f.startsWith('node_modules') || f.startsWith('up/') || f === 'link.txt' || f === 'binary.bin')).toBe(false);
    expect(Object.keys(found(await searchText(cwd, 'Theme', 'scan')))).toEqual(['src/Toggle.tsx']);
  });

  it('sends a long line cut around what it found, however far along the line that is', async () => {
    for (const engine of [undefined, 'scan'] as const) {
      if (!engine && !bundledClaude()) continue;
      const [line] = (await searchText(cwd, 'needle', engine)).files.find((f) => f.path === 'long.md')!.lines;
      expect(line!.text).toContain('The needle is here');
      expect(line!.text).toMatch(/^….*…$/);
      expect(line!.text.length).toBeLessThanOrEqual(SEARCH_LIMITS.text + 2);
    }
  });

  it('runs no git and nothing of the folder’s: a repository’s hooks and filters stay still', async () => {
    const repo = path.join(dir, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const marker = path.join(dir, 'ran');
    execFileSync('git', ['config', 'core.fsmonitor', `sh -c 'echo fsmonitor >> ${marker}'`], { cwd: repo });
    await writeFile(path.join(repo, 'a.txt'), 'needle\n');
    await searchText(repo, 'needle');
    await searchText(repo, 'needle', 'scan');
    await expect(import('node:fs/promises').then((fs) => fs.readFile(marker, 'utf8'))).rejects.toThrow();
  });
});
