// What reading a command for its look-alike spaces may take, whatever the command (src/shared/
// shell-words.ts): nothing past 64 KB, and no more than a budget of steps and of characters made,
// past which every such space is written out with the warning. Timed and sized on the costliest
// commands found (test/worst-commands.ts), in Node, in Node with a heap of 128 MB, and in Chrome
// with its CPU slowed four times and the same heap: a command once took gigabytes and crashed the
// page the approval was on, again after each reload. Timed by the work it takes, not the time that
// passes, which a busy computer stretches many times over (workSince).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { revealHidden, revealInput } from '../src/shared/hidden';
import { inWords, MOST_COMMAND } from '../src/shared/shell-words';
import { COSTLIEST, WORST } from './worst-commands';

const N = '\u00a0';
/** The longest command read (MOST_COMMAND), written out so these sizes hold whatever the code says. */
const CAP = 64 * 1024;
const isSpace = (char: string) => /^\p{Zs}$/u.test(char) && char !== ' ';
const root = path.resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');

/**
 * Milliseconds of work since `started` (process.cpuUsage()), Node's threads together: time spent
 * working, not time passed. A busy computer slows the clock, not the work: with a Mac's efficiency
 * cores kept busy, a read of 0.4 s of work took 2.7 s, and one of 0.9 s took 6.8 s.
 */
const workSince = (started: NodeJS.CpuUsage) => {
  const spent = process.cpuUsage(started);
  return (spent.user + spent.system) / 1000;
};

let dir: string;
/** The reading and the commands, built for a page (IIFE) and for Node (ESM): run(name, size) reads one. */
let page: string;
let node: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pelican-budget-'));
  const entry = path.join(dir, 'entry.ts');
  const source = `import { revealHidden } from ${JSON.stringify(path.join(root, 'src/shared/hidden.ts'))};
import { WORST } from ${JSON.stringify(path.join(root, 'test/worst-commands.ts'))};
export function run(name: string, size: number) {
  const command = WORST[name]!(size);
  // In Node, the work it took (workSince); a page's is read from Chrome.
  const started = typeof process === 'undefined' ? undefined : process.cpuUsage();
  const { hidden } = revealHidden(command, { runs: 'shell' });
  const spent = started && process.cpuUsage(started);
  return { name, length: command.length, ...(spent ? { work: (spent.user + spent.system) / 1000 } : {}), hidden };
}
(globalThis as any).run = run;
if (typeof process !== 'undefined' && process.argv[2]) for (const name of JSON.parse(process.argv[2])) console.log(JSON.stringify(run(name, Number(process.argv[3]))));
`;
  await import('node:fs/promises').then(({ writeFile }) => writeFile(entry, source));
  page = path.join(dir, 'page.js');
  node = path.join(dir, 'node.mjs');
  await build({ entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', outfile: page, logLevel: 'silent' });
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: node, logLevel: 'silent' });
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('reading a command for its look-alike spaces', () => {
  it('reads no command longer than 64 KB, and writes out every such space in it', () => {
    expect(MOST_COMMAND).toBe(CAP);
    const quoted = (size: number) => `git commit -m "${'Fix the login\u3000page. '.repeat(Math.ceil(size / 20)).slice(0, size - 16)}"`;
    expect(quoted(CAP)).toHaveLength(CAP);
    expect(inWords(quoted(CAP), isSpace)).toBeDefined();
    const long = quoted(CAP + 100);
    const started = process.cpuUsage();
    expect(inWords(long, isSpace)).toBeUndefined();
    expect(revealHidden(long, { runs: 'shell' }).hidden).toBe(true);
    expect(workSince(started)).toBeLessThan(1000);
  });

  it('reads an ordinary long command whole: a commit message of 60 KB in Claude Code’s heredoc', () => {
    const message = Array.from({ length: 1500 }, (_, i) => `- Fix the login\u3000page (${i}): it's done, $(and) \`this\`.`).join('\n').slice(0, 60_000);
    const command = `git commit -m "$(cat <<'EOF'\n${message}\nEOF\n)"`;
    expect(revealHidden(command, { runs: 'shell' })).toEqual({ text: command, hidden: false });
  });

  it('reads each of the costliest commands at 64 KB in moments, counting any it cannot finish as one it cannot tell', () => {
    for (const [name, make] of Object.entries(WORST)) {
      const command = make(CAP);
      expect(command.length, name).toBeLessThanOrEqual(CAP);
      const started = process.cpuUsage();
      const shown = revealHidden(command, { runs: 'shell' });
      // Each took at most 170 ms of work here, 410 ms on the efficiency cores; the bound is for a slower computer.
      expect(workSince(started), name).toBeLessThan(2000);
      // Read in full, its one space is quoted text; not, it is written out, and warned of.
      expect(shown.hidden || shown.text === command, name).toBe(true);
    }
  }, 120_000);

  it('makes no script of the square of the command: the recheck’s command takes at most the budget, also at 16 KB, where it took 1.4 GB', () => {
    for (const size of [8 * 1024, 16 * 1024, 24 * 1024, CAP]) {
      const command = WORST['a value in many places of a script bash runs']!(size);
      const started = process.cpuUsage();
      expect(revealHidden(command, { runs: 'shell' }).hidden, String(size)).toBe(true);
      expect(workSince(started), String(size)).toBeLessThan(2000);
    }
  });

  it('reads the costliest commands at 64 KB in a Node whose heap is 128 MB', () => {
    const ran = spawnSync(process.execPath, ['--max-old-space-size=128', node, JSON.stringify(Object.keys(WORST)), String(CAP)], { encoding: 'utf8', timeout: 120_000 });
    expect(ran.stderr).not.toMatch(/heap out of memory|FATAL/);
    expect(ran.status).toBe(0);
    const read = ran.stdout.trim().split('\n').map((line) => JSON.parse(line) as { name: string; work: number });
    expect(read.map((each) => each.name)).toEqual(Object.keys(WORST));
    for (const each of read) expect(each.work, each.name).toBeLessThan(2000);
  }, 180_000);

  it('shares one budget among the commands of a tool’s input: past it, every such space in the rest is written out', () => {
    const costly = WORST['substitutions within substitutions']!(CAP - 100).replace(`echo 'a${N}b' `, `echo 'a${N}b'; echo `);
    const input = { steps: Array.from({ length: 40 }, () => ({ command: costly })) };
    const started = process.cpuUsage();
    const shown = revealInput(input);
    expect(workSince(started)).toBeLessThan(4000);
    expect(shown.hidden).toBe(true);
    // The first command is read, its space in quotes left as it is; the last is past the budget.
    const commands = shown.text.split('"command": ').slice(1);
    expect(commands[0]).toContain(`'a${N}b'`);
    expect(commands.at(-1)).toContain("'a⟨U+00A0⟩b'");
  }, 60_000);
});

describe.skipIf(!existsSync(CHROME))('in Chrome, its CPU slowed four times and its heap 128 MB, as a phone', () => {
  it('reads each of the costliest commands at 64 KB, and the recheck’s at 24 KB that crashed the page, without crashing, in moments', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--js-flags=--max-old-space-size=128'] });
    try {
      const context = await browser.newContext();
      const tab = await context.newPage();
      let crashed = false;
      tab.on('crash', () => {
        crashed = true;
      });
      const cdp = await context.newCDPSession(tab);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      // The work of the page's thread in milliseconds (Chrome's ThreadTime), not the time that passes
      // (workSince): Chrome slows the thread by keeping it busy three times as long as it runs, so
      // this is the time a phone takes, without what a busy computer adds.
      await cdp.send('Performance.enable');
      const work = async () => (await cdp.send('Performance.getMetrics')).metrics.find((metric) => metric.name === 'ThreadTime')!.value * 1000;
      await tab.setContent('<p>An approval</p>');
      await tab.addScriptTag({ path: page });
      for (const [name, size] of [['a value in many places of a script bash runs', 24 * 1024] as const, ...COSTLIEST.map((each) => [each, CAP] as const)]) {
        const started = await work();
        await tab.evaluate(([n, s]) => (globalThis as unknown as { run: (name: string, size: number) => unknown }).run(n, s), [name, size] as const);
        const spent = (await work()) - started;
        expect(crashed, name).toBe(false);
        // Each took at most 420 ms of work here, 570 ms on the efficiency cores; the bound is for a slower computer.
        expect(spent, name).toBeLessThan(5000);
      }
    } finally {
      await browser.close();
    }
  }, 180_000);
});
