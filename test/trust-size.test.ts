// What a folder nobody trusted brings, read from files a repository chooses: in time that grows with
// the files, never with its square, and into an answer of a size the phone can take, however the
// files are made. Where a file holds more than the sheet shows, it says so, and the folder is asked
// about all the same.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { config } from '../src/server/config';
import { forgetTrust, trustQuestion } from '../src/server/trust';

let root: string;
const saved = { ...config };
const savedClaude = process.env.CLAUDE_CONFIG_DIR;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-trust-size-')));
  // Nothing of this computer's Claude Code or Pelican is read.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  config.stateDir = path.join(root, 'state');
  config.configDir = path.join(root, 'config');
  config.auth = 'none';
});

beforeEach(() => forgetTrust());

afterAll(async () => {
  Object.assign(config, saved);
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  await rm(root, { recursive: true, force: true });
});

async function folderWith(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, name);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return dir;
}

/** Asks to start a session there, as the app does: the answer, its size, and how long it took. */
async function ask(dir: string): Promise<{ status: number; brings: string[]; commands: unknown[]; size: number; ms: number }> {
  const started = performance.now();
  const response = await app.request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ text: 'hi', cwd: dir }),
    headers: { host: 'localhost:7860', 'x-pelican': '1', 'content-type': 'application/json' },
  });
  const text = await response.text();
  const ms = performance.now() - started;
  const body = JSON.parse(text) as { brings: string[]; commands: unknown[] };
  return { status: response.status, brings: body.brings, commands: body.commands, size: text.length, ms };
}

const skill = (lines: string) => `---\nname: x\ndescription: y\n${lines}---\nBody\n`;

describe('a skill whose list items, as far in as its keys, name a power', () => {
  // A line that starts with `-` there is no key of the frontmatter's: it is that line alone, once,
  // as 0.4.0 showed it. Gathering every line after it, each of them an item, made 63 MB at 3,000
  // lines and stopped the server at 9,000.
  for (const line of ['- {hooks: 1}', '-{hooks: 1', '- {a: 1, hooks: 1}', '-,allowed-tools: x', '- {mcpServers: {}}']) {
    it(`(${line}) is that line alone, however many times it comes`, async () => {
      const dir = await folderWith(`list-${line.replace(/\W+/g, '-')}`, { '.claude/skills/x/SKILL.md': skill(`${line}\n`.repeat(2000)) });
      const answer = await ask(dir);
      expect(answer.status).toBe(409);
      expect(answer.brings).toEqual([`Skill x: ${line}`]);
      expect(answer.size).toBeLessThan(1000);
    });
  }
});

describe('a large hostile file', () => {
  it('is read in moments, and what it brings fits an answer the phone can take', async () => {
    // 2.6 MB of such lines, half of them each different: 30 s and out of memory before.
    const lines = `${'- {hooks: 1}\n'.repeat(100_000)}${Array.from({ length: 100_000 }, (_, i) => `- {hooks: ${i}}\n`).join('')}`;
    const dir = await folderWith('large', { '.claude/skills/x/SKILL.md': skill(lines) });
    const answer = await ask(dir);
    expect(answer.status).toBe(409);
    expect(answer.ms).toBeLessThan(5000);
    expect(answer.size).toBeLessThan(64 * 1024);
    expect(answer.brings.length).toBeLessThanOrEqual(202);
    expect(answer.brings).toContain('Skill x: - {hooks: 1}');
    expect(answer.brings.at(-1)).toBe('Skill x: more than Pelican shows');
    expect(answer.commands).toHaveLength(answer.brings.length);
  }, 60_000);

  it('whose ```! block or frontmatter never ends is read once, not once a character', async () => {
    // As Claude Code's patterns, read by backtracking: 8 s each at this size.
    const dir = await folderWith('never-ends', {
      '.claude/commands/fence.md': `\`\`\`!${' '.repeat(400_000)}`,
      '.claude/commands/front.md': `---${'\n'.repeat(400_000)}allowed-tools: Bash`,
      '.claude/commands/ok.md': '---\nallowed-tools: Bash\n---\nRun:\n```!\nnpm test\n```\n',
    });
    const started = performance.now();
    const question = await trustQuestion(dir);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(question?.brings).toEqual(['Command /ok: allowed-tools: Bash', 'Command /ok runs: npm test']);
  }, 60_000);
});

describe('a folder’s other files with more than any project’s', () => {
  it('list as many items as fit from each, and say there is more', async () => {
    const dir = await folderWith('many-items', {
      '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: Array.from({ length: 50_000 }, (_, i) => ({ type: 'command', command: `echo ${i}` })) }] } }),
      '.mcp.json': JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`s${i}`, { command: 'npx', args: [`m${i}`] }])) }),
    });
    execFileSync('git', ['init', '-q'], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } });
    const filters = Array.from({ length: 5000 }, (_, i) => `[include]\n\tpath = nowhere-${i}\n[filter "f${i}"]\n\tclean = cat ${i}\n`).join('');
    await writeFile(path.join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n${filters}`);
    const answer = await ask(dir);
    expect(answer.status).toBe(409);
    expect(answer.ms).toBeLessThan(10_000);
    expect(answer.size).toBeLessThan(128 * 1024);
    expect(answer.brings).toEqual(expect.arrayContaining([
      'SessionStart hook: echo 0',
      'More than Pelican shows: .claude/settings.json',
      'MCP server s0: npx m0',
      'More than Pelican shows: .mcp.json',
      'Git filter f0: cat 0',
      'More git config than Pelican shows',
    ]));
    expect(answer.brings.length).toBeLessThan(3 * 202);
  }, 60_000);

  it('list as many as fit from the whole folder, and say there is more', async () => {
    // 40 commands of 100 KB of tools each: 4 MB of items.
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`.claude/commands/c${i}.md`, `---\nallowed-tools: ${'Bash, '.repeat(17_000)}Read\n---\nGo.\n`]));
    const answer = await ask(await folderWith('many-files', files));
    expect(answer.status).toBe(409);
    expect(answer.size).toBeLessThan(1200 * 1024);
    expect(answer.brings.length).toBeLessThan(40);
    expect(answer.brings.at(-1)).toBe('More than Pelican shows');
  }, 60_000);

  it('are read only so far: past what any project’s commands, skills and agents hold, the folder is asked about', async () => {
    const files = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`.claude/commands/big${i}.md`, `---\nallowed-tools: Bash\n---\n${'x'.repeat(15 * 1024 * 1024)}`]));
    const brings = (await trustQuestion(await folderWith('large-files', files)))?.brings;
    expect(brings).toContain('More commands, skills and agents than Pelican reads');
    expect(brings?.length).toBeLessThanOrEqual(3);
  }, 60_000);
});
