// Terminals end to end: a Pelican of the tests' own (temporary folders, port 0), real shells in
// real PTYs, and pages as the web app's would be (terminal-page.ts). The shell is bash without
// any profile, so nothing of the computer's own shell setup runs.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import xtermHeadless from '@xterm/headless';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { SIGNED_OUT_CLOSE } from '../src/shared/protocol';
import type { TerminalColors, TerminalInfo, TerminalList } from '../src/shared/terminal';
import { commandRunnable, TERMINAL_CLOSE, TERMINAL_LIMITS } from '../src/shared/terminal';
import { MARKS_PER_CHARACTER } from '../src/shared/terminal-widths';
import { accessToken, cookieName } from '../src/server/auth';
import { config } from '../src/server/config';
import { usePtyLoader } from '../src/server/pty';
import { startServer } from '../src/server/server';
import {
  closeAllTerminals, closeIdleTerminals, type ColorRequest, colorReport, onColorRequests, parseProcessTable, runsIn, shellEnvironment, terminalState,
  terminalTiming, testShell,
} from '../src/server/terminals';
import { modesBeyondSnapshot } from '../src/server/terminal-snapshot';
import { Page, pause, until } from './terminal-page';

let dir: string;
let port: number;
let stop: () => Promise<void>;
const saved = { ...config };
const timing = { ...terminalTiming };
const env = { PS1: process.env.PS1, BASH_SILENCE_DEPRECATION_WARNING: process.env.BASH_SILENCE_DEPRECATION_WARNING };

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-terminals-')));
  Object.assign(config, {
    host: '127.0.0.1', port: 0, auth: 'auto',
    configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), claudeHome: path.join(dir, 'claude'),
  });
  await mkdir(path.join(dir, 'work'));
  Object.assign(testShell, { file: '/bin/bash', args: ['--noprofile', '--norc', '-i'] });
  Object.assign(process.env, { PS1: 'PROMPT$ ', BASH_SILENCE_DEPRECATION_WARNING: '1' });
  const started = await startServer();
  port = Number(new URL(started.url).port);
  stop = started.close;
});
afterEach(() => {
  closeAllTerminals();
  Object.assign(terminalTiming, timing);
  config.demo = false;
  config.terminal = true;
  usePtyLoader();
});
afterAll(async () => {
  await stop();
  Object.assign(config, saved);
  delete testShell.file;
  delete testShell.args;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

const work = () => path.join(dir, 'work');
const origin = () => `http://127.0.0.1:${port}`;
const signedIn = () => ({ origin: origin(), authorization: `Bearer ${accessToken()}` });

/** A request as Pelican's page makes one. */
async function api(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin()}${pathname}`, {
    method,
    headers: { 'x-pelican': '1', 'content-type': 'application/json', ...signedIn(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function open(cwd = work(), more: Record<string, unknown> = {}): Promise<TerminalInfo> {
  const response = await api('POST', '/api/terminals', { cwd, cols: 80, rows: 24, ...more });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.terminal as TerminalInfo;
}

const page = (id: string, options: ConstructorParameters<typeof Page>[2] = {}) => new Page(port, id, { headers: signedIn(), ...options });

/** A page with the shell at its prompt. */
async function atPrompt(id: string, options: ConstructorParameters<typeof Page>[2] = {}): Promise<Page> {
  const shown = page(id, options);
  await shown.readied();
  await until(() => /PROMPT\$ $/.test(shown.lines().filter(Boolean).at(-1) ?? ''), 10_000, 'the prompt');
  return shown;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('a terminal', () => {
  it('runs a shell in the folder, takes keys and sizes, names the program in front, and says how it ended', async () => {
    const terminal = await open();
    expect(terminal).toMatchObject({ cwd: work(), program: 'bash', viewers: 0 });
    const listed = await api('GET', `/api/terminals?cwd=${encodeURIComponent(work())}`);
    expect(listed.body).toMatchObject({ available: true, terminals: [{ id: terminal.id, cwd: work() }] });
    // Which shell a terminal runs, for Run in terminal to offer a step only to the shell it is written for.
    expect(listed.body.shell).toBe('bash');
    expect((await api('GET', '/api/info')).body.terminal).toEqual({ available: true, shell: 'bash' });
    expect((await api('GET', `/api/terminals?cwd=${encodeURIComponent(dir)}`)).body.terminals).toEqual([]);

    const shown = await atPrompt(terminal.id);
    expect((await api('GET', '/api/terminals')).body.terminals[0].viewers).toBe(1);
    shown.type('pwd; stty size\r');
    await shown.sees(new RegExp(`${literally(work())}\\r\\n24 80\\r\\n`));
    shown.send({ type: 'resize', cols: 100, rows: 30 });
    shown.type('stty size\r');
    await shown.sees(/30 100\r\n/);
    shown.type('printf "\\344\\270\\255\\346\\226\\207 caf\\303\\251\\n"\r');
    await shown.sees(/中文 café\r\n/);

    shown.type('sleep 30\r');
    await until(() => shown.messages.some((m) => m.type === 'program' && m.program === 'sleep'), 5000, 'sleep in front');
    shown.type('\u0003');
    await until(() => shown.messages.findLast((m) => m.type === 'program')?.type === 'program'
      && (shown.messages.findLast((m) => m.type === 'program') as { program: string }).program === 'bash', 5000, 'bash in front');

    shown.type('exit 3\r');
    await until(() => shown.messages.some((m) => m.type === 'exit'), 5000, 'the end');
    expect(shown.messages.find((m) => m.type === 'exit')).toEqual({ type: 'exit', code: 3, signal: null });
    expect((await api('GET', '/api/terminals')).body.terminals[0]).toMatchObject({ id: terminal.id, exit: { code: 3, signal: null } });
    // Ended, it keeps its screen for a page that comes to it.
    const later = page(terminal.id);
    expect((await later.readied()).exit).toEqual({ code: 3, signal: null });
    await until(() => later.lines().some((line) => line.includes('exit 3')));
  }, 30_000);

  it('closes as a window does: the shell and its jobs are hung up, and its pages are told', async () => {
    const terminal = await open();
    const shown = await atPrompt(terminal.id);
    shown.type('sleep 300 & echo "pids $$ $(jobs -p)"\r');
    const [, shell, job] = (await shown.sees(/pids (\d+) (\d+)\r\n/)).map(Number);
    expect(alive(shell!) && alive(job!)).toBe(true);
    expect((await api('DELETE', `/api/terminals/${terminal.id}`)).status).toBe(200);
    await until(() => shown.closed !== undefined);
    expect(shown.closed?.code).toBe(TERMINAL_CLOSE.closed);
    await until(() => !alive(shell!) && !alive(job!), 5000, 'the shell and its job to end');
    expect((await api('GET', '/api/terminals')).body.terminals).toEqual([]);
    expect((await api('DELETE', `/api/terminals/${terminal.id}`)).status).toBe(404);
    // A page that comes back to it is told it is gone.
    const late = page(terminal.id);
    await until(() => late.closed !== undefined);
    expect(late.closed?.code).toBe(TERMINAL_CLOSE.gone);
  }, 30_000);

  it('belongs to the folder itself, links followed, as the session there does: opened under a link’s name, it is listed under both', async () => {
    // A new session's page in a folder reached through a link (on a Mac, /tmp is /private/tmp): the
    // session starts in the folder itself, and its page lists the terminal opened before it did.
    const link = path.join(dir, 'link-to-work');
    await symlink(work(), link);
    try {
      const terminal = await open(link);
      expect(terminal.cwd).toBe(work());
      const shown = await atPrompt(terminal.id);
      shown.type('pwd -P\r');
      await shown.sees(new RegExp(`\\r\\n${literally(work())}\\r\\n`));
      for (const name of [link, work()]) {
        const listed = await api('GET', `/api/terminals?cwd=${encodeURIComponent(name)}&folder=${encodeURIComponent(name)}`);
        expect(listed.body).toMatchObject({ terminals: [{ id: terminal.id, cwd: work() }], folder: work() });
      }
      expect((await api('GET', '/api/terminals')).body).not.toHaveProperty('folder');
    } finally {
      await rm(link);
    }
  }, 20_000);

  it('when Pelican stops, its pages lose the connection as to a server going away, to come back and start again', async () => {
    const terminal = await open();
    const shown = await atPrompt(terminal.id);
    closeAllTerminals();
    await until(() => shown.closed !== undefined);
    expect(shown.closed?.code).toBe(1001);
    const late = page(terminal.id);
    await until(() => late.closed !== undefined);
    expect(late.closed?.code).toBe(TERMINAL_CLOSE.gone);
  }, 20_000);

  it('runs a command once the shell is ready for it (Run in terminal)', async () => {
    const terminal = await open(work(), { command: 'echo "ran $((40 + 2))"' });
    const shown = page(terminal.id);
    await shown.readied();
    await until(() => shown.lines().includes('ran 42'), 10_000, 'the command');
  }, 20_000);

  it('has the shell read the command from a file of its own, readable by this account alone, its lines together, then Enter', async () => {
    // A shell that says it takes pastes, as zsh does, and writes down all it is sent.
    const typed = path.join(dir, 'typed');
    Object.assign(testShell, { file: '/bin/sh', args: ['-c', `stty raw -echo; printf '\\033[?2004h$ '; cat > ${typed}`] });
    try {
      const terminal = await open(work(), { command: 'echo one\necho two' });
      await until(() => existsSync(typed) && readFileSync(typed, 'utf8').endsWith('\r'), 10_000, 'the command');
      // Typed: `.` and the file, which holds the command as it was shown.
      const [, file] = /^\. (\/\S+)\r$/.exec(readFileSync(typed, 'utf8')) ?? [];
      expect(file).toBeDefined();
      expect(readFileSync(file!, 'utf8')).toBe('echo one\necho two\n');
      expect((await stat(file!)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file!))).mode & 0o777).toBe(0o700);
      // Gone with the terminal.
      await api('DELETE', `/api/terminals/${terminal.id}`);
      await until(() => !existsSync(file!), 5000, 'the file to go');
    } finally {
      Object.assign(testShell, { file: '/bin/bash', args: ['--noprofile', '--norc', '-i'] });
    }
  }, 20_000);

  it('types the command as a paste for a shell that reads no file of commands, so its lines go in together, then Enter', async () => {
    const typed = path.join(dir, 'typed-elsewhere');
    const shell = path.join(dir, 'elvish');
    await symlink('/bin/sh', shell);
    Object.assign(testShell, { file: shell, args: ['-c', `stty raw -echo; printf '\\033[?2004h$ '; cat > ${typed}`] });
    try {
      await open(work(), { command: 'echo one\necho two' });
      await until(() => existsSync(typed) && readFileSync(typed, 'utf8').endsWith('\r'), 10_000, 'the command');
      expect(readFileSync(typed, 'utf8')).toBe('\u001b[200~echo one\necho two\u001b[201~\r');
    } finally {
      Object.assign(testShell, { file: '/bin/bash', args: ['--noprofile', '--norc', '-i'] });
      await rm(shell);
    }
  }, 20_000);

  // As in the review: a history file holding a secret (made up here), and a command in Claude's
  // reply that would print it, or send it off, were a `!` in it expanded from the history. zsh reads
  // its history file at start with an rc file of its own (here an empty one), as a login shell does.
  for (const [name, file, args] of [['bash', '/bin/bash', ['--noprofile', '--norc', '-i']], ['zsh', '/bin/zsh', ['-d', '-i']]] as const) {
    it.skipIf(!existsSync(file))(`runs the command as it shows, with no \`!\` in it taken from ${name}’s history`, async () => {
      const history = path.join(dir, `history-${name}`);
      await writeFile(history, 'export AWS_SECRET_ACCESS_KEY=AKIA-SCRATCH-NOT-REAL-1234\necho second\n');
      const zdotdir = path.join(dir, `zdotdir-${name}`);
      await mkdir(zdotdir, { recursive: true });
      await writeFile(path.join(zdotdir, '.zshrc'), '');
      const before = { HISTFILE: process.env.HISTFILE, ZDOTDIR: process.env.ZDOTDIR };
      Object.assign(testShell, { file, args: [...args] });
      Object.assign(process.env, { HISTFILE: history, ZDOTDIR: zdotdir });
      try {
        const shown = page((await open(work(), { command: 'echo "exfil: !?AWS_SECRET?" "!!" "!-2" done-$((6 * 7))' })).id);
        await shown.readied();
        await shown.sees(/done-42/, 10_000);
        await pause(200);
        expect(shown.output).not.toMatch(/AKIA-SCRATCH/);
        expect(shown.lines().join('\n')).toContain('exfil: !?AWS_SECRET? !! !-2 done-42');
        // The shell has the history all the same: typed at its prompt by you, `!` works as ever.
        const from = shown.output.length;
        shown.type('echo "ran !?second?"\r');
        await shown.sees(/ran echo second/, 10_000, from);
      } finally {
        for (const [variable, value] of Object.entries(before)) {
          if (value === undefined) delete process.env[variable];
          else process.env[variable] = value;
        }
        Object.assign(testShell, { file: '/bin/bash', args: ['--noprofile', '--norc', '-i'] });
      }
    }, 30_000);
  }

  it('runs no command that does not show all it holds', async () => {
    // Keys a shell's line editor takes (Ctrl+U, Esc, a carriage return), or text turned around.
    for (const command of ['echo safe\u0015touch pwned', 'echo safe\u001b[201~', 'ls\rtouch pwned', 'echo \u202egnp.exe', 'ls\u009b']) {
      const refused = await api('POST', '/api/terminals', { cwd: work(), cols: 80, rows: 24, command });
      expect(refused.status, JSON.stringify(command)).toBe(400);
    }
    // Laid out so that its question would leave a tail out of sight: padded with spaces or tabs,
    // pushed down by blank lines, a line or a command too long to take in. As the page reads it.
    const marker = path.join(dir, 'HIDDEN_TAIL_RAN');
    const padded = [
      `ls -la${' '.repeat(300)}; touch ${marker}`, `ls${'\t'.repeat(60)}; touch ${marker}`, `ls${'\n'.repeat(200)}touch ${marker}`,
      `ls\n\n\n\ntouch ${marker}`, `echo ${'x'.repeat(500)}; touch ${marker}`,
      [...Array.from({ length: 50 }, (_, i) => `echo ${i}`), `touch ${marker}`].join('\n'),
    ];
    for (const command of padded) {
      expect(commandRunnable(command)).toBe(false);
      const refused = await api('POST', '/api/terminals', { cwd: work(), cols: 80, rows: 24, command });
      expect(refused.status, command.slice(0, 40)).toBe(400);
      expect(refused.body.error).toMatch(/out of sight|shows/);
    }
    expect((await api('GET', '/api/terminals')).body.terminals).toEqual([]);
    await pause(300);
    expect(existsSync(marker)).toBe(false);
    // What the page offers, the server runs.
    const offered = await api('POST', '/api/terminals', { cwd: work(), cols: 80, rows: 24, command: `ls${' '.repeat(16)}# aligned\n\n\necho done` });
    expect(offered.status).toBe(201);
  });

  it('shows on several pages at once, each in step, at the size of the page last typed in or resized', async () => {
    const terminal = await open();
    const phone = await atPrompt(terminal.id, { cols: 40, rows: 20 });
    const heard = phone.messages.length;
    // Another page comes in: it is told the size the shell has, the phone's.
    const computer = await atPrompt(terminal.id, { cols: 120, rows: 40 });
    expect(computer.ready).toMatchObject({ cols: 40, rows: 20 });
    expect(phone.messages.slice(heard).some((m) => m.type === 'size')).toBe(false);
    // Typed in, it says its own size first (TerminalScreen does): the shell takes it, the phone is told.
    computer.send({ type: 'resize', cols: 120, rows: 40 });
    await until(() => phone.messages.some((m) => m.type === 'size' && m.cols === 120 && m.rows === 40));
    phone.type('stty size\r');
    await computer.sees(/40 120\r\n/);
    await phone.sees(/40 120\r\n/);
    // The phone's link drops (it slept, or its network changed), and its page connects again by
    // itself, at its own size: nobody touched it, so the shell stays the computer's.
    await phone.close();
    const back = await atPrompt(terminal.id, { cols: 40, rows: 20 });
    expect(back.ready).toMatchObject({ cols: 120, rows: 40 });
    const from = computer.output.length;
    computer.type('stty size\r');
    await computer.sees(/40 120\r\n/, 10_000, from);
    expect(computer.messages.filter((m) => m.type === 'size')).toEqual([]);
  }, 20_000);
});

describe('the size a terminal is drawn at', () => {
  it('stays the page’s last typed in when another page shows it again with nobody typing there, unless that one is alone', async () => {
    const terminal = await open();
    const phone = await atPrompt(terminal.id, { cols: 40, rows: 20 });
    const computer = await atPrompt(terminal.id, { cols: 120, rows: 40 });
    expect(computer.ready).toMatchObject({ cols: 40, rows: 20 });
    // The computer's Terminal tab is picked again after Files: it says its size as it shows, which
    // the shell does not take from the phone, and the computer is told nothing new.
    computer.send({ type: 'resize', cols: 120, rows: 40, shown: true });
    let from = computer.output.length;
    computer.type('stty size\r');
    await computer.sees(/\r\n20 40\r\n/, 10_000, from);
    expect(phone.messages.filter((m) => m.type === 'size')).toEqual([]);
    expect(computer.messages.filter((m) => m.type === 'size')).toEqual([]);
    // Alone, as the phone has gone, it takes its own size, and is told it so it draws at it.
    await phone.close();
    computer.send({ type: 'resize', cols: 120, rows: 40, shown: true });
    await until(() => computer.messages.some((m) => m.type === 'size' && m.cols === 120 && m.rows === 40), 5000, 'its size said back');
    from = computer.output.length;
    computer.type('stty size\r');
    await computer.sees(/\r\n40 120\r\n/, 10_000, from);
  }, 30_000);
});

describe('Clear terminal', () => {
  /** The lines that hold anything, on a page's screen and in what scrolled off it. */
  const written = (shown: Page) => shown.lines().map((line) => line.trimEnd()).filter(Boolean);

  it('clears the screen and its scrollback on every page and in the copy, the prompt kept, so a page that comes back shows it cleared', async () => {
    const terminal = await open();
    const asker = await atPrompt(terminal.id);
    const other = await atPrompt(terminal.id);
    asker.type('seq 1 60\r');
    await asker.sees(/60\r\nPROMPT\$ $/);
    await until(() => written(other).includes('60'), 5000, 'the other page');
    asker.send({ type: 'clear' });
    // Every page is told, after the output before it, and clears as the copy does: the line the
    // cursor is on stays, at the top, and nothing scrolled off is kept.
    await until(() => asker.messages.some((m) => m.type === 'clear') && other.messages.some((m) => m.type === 'clear'), 5000, 'the clear');
    for (const shown of [asker, other]) {
      await until(() => written(shown).length === 1, 5000, 'a cleared screen');
      expect(written(shown)).toEqual(['PROMPT$']);
    }
    // A page that comes in now gets the screen as it is: cleared.
    const back = page(terminal.id);
    await back.readied();
    await until(() => written(back).length > 0, 5000, 'the screen');
    expect(written(back)).toEqual(['PROMPT$']);
    // The shell goes on from there.
    back.type('echo after\r');
    await back.sees(/after\r\n/);
    await until(() => written(back).includes('after'), 5000, 'the output after it');
    expect(written(back)[0]).toBe('PROMPT$ echo after');
  }, 30_000);

  it('has a program in front draw its screen again, as after Ctrl+L, with no key typed into it', async () => {
    const terminal = await open();
    const shown = await atPrompt(terminal.id);
    // A full-screen program that draws its screen when told the window changed, as vim and htop do.
    // What it prints is spelled in escapes, so the shell's echo of the command line holds none of
    // it: only the program's output meets the waits below, and only a key typed into it prints
    // " typed ". The line is typed in two parts, so its echo comes in two, as a busy computer's can.
    const program = `node -e "process.stdout.write('\\u001b[?1049h\\u001b[H\\x46IRST'); process.on('SIGWINCH', () => process.stdout.write('\\u001b[H\\u001b[2J\\x44RAWN AGAIN')); process.stdin.on('data', (d) => process.stdout.write(' \\x74yped ' + JSON.stringify(String(d)))); setInterval(() => {}, 1000)"\r`;
    const half = program.indexOf('process.stdin');
    shown.type(program.slice(0, half));
    await pause(300);
    shown.type(program.slice(half));
    await shown.sees(/\u001b\[\?1049h\u001b\[HFIRST/);
    const from = shown.output.length;
    shown.send({ type: 'clear' });
    await shown.sees(/\u001b\[2JDRAWN AGAIN/, 10_000, from);
    // Nothing was typed into it: Ctrl+L would have been, a form feed in vim's insert mode.
    await pause(200);
    expect(shown.output).not.toMatch(/ typed /);
    const back = page(terminal.id);
    await back.readied();
    await until(() => back.screen.buffer.active.type === 'alternate' && written(back)[0] === 'DRAWN AGAIN', 5000, 'the program’s screen');
  }, 30_000);

  it('gives a page still waiting for its first screen the clear at its place in the output', async () => {
    const terminal = await open();
    const asker = await atPrompt(terminal.id);
    asker.type('seq 1 30\r');
    await asker.sees(/30\r\nPROMPT\$ $/);
    // A page comes in with the clear asked at the same moment: whatever its screen holds, it ends cleared.
    const late = page(terminal.id);
    asker.send({ type: 'clear' });
    await late.readied();
    await until(() => written(late).length === 1, 5000, 'a cleared screen');
    expect(written(late)).toEqual(['PROMPT$']);
  }, 30_000);
});

describe('a page that comes back', () => {
  it('gets the screen as it was, a full-screen program’s with its modes, and goes on from there', async () => {
    const terminal = await open();
    const first = await atPrompt(terminal.id);
    first.type('for i in 1 2 3; do echo "line $i"; done\r');
    await first.sees(/line 3\r\n/);
    // A program in the alternate screen, with the modes vim sets, waiting for a key.
    first.type(`printf '\\033[?1049h\\033[?1h\\033[?2004h\\033[H\\033[2JNOTES\\r\\n~\\r\\n~\\033[24;1H"notes.txt" 2L'; read -r key; printf '\\033[?2004l\\033[?1l\\033[?1049l'; echo "got $key"\r`);
    await first.sees(/"notes\.txt" 2L/);
    // The link drops, as a phone's does when it sleeps.
    await first.close();

    const second = page(terminal.id);
    await second.readied();
    await until(() => second.screen.buffer.active.type === 'alternate', 5000, 'the alternate screen');
    await until(() => second.lines()[23] === '"notes.txt" 2L', 5000, 'the program’s screen');
    expect(second.lines().slice(0, 3)).toEqual(['NOTES', '~', '~']);
    expect(second.screen.modes.applicationCursorKeysMode).toBe(true);
    expect(second.screen.modes.bracketedPasteMode).toBe(true);
    expect(second.screen.buffer.normal.getLine(second.screen.buffer.normal.length - 1)).toBeDefined();
    // The program is where it was: a key, and it leaves the screen it drew for the one before.
    second.type('q\r');
    await until(() => second.screen.buffer.active.type === 'normal' && second.lines().includes('got q'), 5000, 'the normal screen');
    expect(second.lines()).toEqual(expect.arrayContaining(['line 1', 'line 2', 'line 3', 'got q']));
    expect(second.screen.modes.applicationCursorKeysMode).toBe(false);
  }, 30_000);

  it('coming in while output pours, ends with the very screen of a page that saw all of it', async () => {
    const terminal = await open();
    const all = await atPrompt(terminal.id);
    // Colored lines in bursts, fewer than the scrollback holds: every line is compared, where the
    // second page came in too. Each has an emoji (two cells wide), then a word put at column 40, as
    // a full-screen program places what it draws.
    all.type("for i in $(seq 1 1500); do printf '\\033[3%dmline %d \\360\\237\\232\\200\\033[40Gend\\033[0m\\n' $((i % 7)) $i; [ $((i % 50)) = 0 ] && sleep 0.02; done; echo EN''D\r");
    await all.sees(/line 600\b/, 30_000);
    const late = page(terminal.id);
    await late.readied();
    await all.sees(/END\r\n/, 60_000);
    await late.sees(/END\r\n/, 60_000);
    // Both have drawn all they were sent.
    const same = () => JSON.stringify(late.lines()) === JSON.stringify(all.lines());
    await until(same, 10_000).catch(() => undefined);
    expect(late.output).not.toMatch(/line 600\b/);
    expect(late.lines()).toEqual(all.lines());
    const drawn = late.lines().filter((line) => /^line \d+ \u{1f680} +end$/u.test(line));
    expect(drawn).toHaveLength(1500);
    // The word at column 40 on every line, the emoji counted as two cells (and two UTF-16 units).
    expect(drawn.every((line) => line.indexOf('end') === 39)).toBe(true);
  }, 90_000);

  it('keeps the modes a full-screen program set: how the mouse is reported, a hidden cursor, its shape, the rows that scroll', async () => {
    const terminal = await open();
    const all = await atPrompt(terminal.id);
    // As htop, fzf and neovim start: SGR mouse reports, the cursor hidden, a steady bar; and a
    // status line kept out of the rows that scroll (1 to 20).
    all.type(`printf '\\033[?1049h\\033[?1002h\\033[?1006h\\033[?25l\\033[6 q\\033[1;20r\\033[H\\033[2JTUI\\033[5;7H'; read -r x; printf '\\033[r\\033[0 q\\033[?25h\\033[?1006l\\033[?1002l\\033[?1049l'\r`);
    await until(() => all.screen.buffer.active.type === 'alternate' && all.lines()[0] === 'TUI', 5000, 'the program');
    await pause(200);
    const late = page(terminal.id);
    await late.readied();
    await until(() => late.screen.buffer.active.type === 'alternate' && late.lines()[0] === 'TUI', 5000, 'its screen');
    type Core = {
      coreMouseService: { activeEncoding: string; activeProtocol: string };
      coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean } };
      buffer: { scrollTop: number; scrollBottom: number };
    };
    const state = (shown: Page) => {
      const core = (shown.screen as unknown as { _core: Core })._core;
      const { cursorX, cursorY } = shown.screen.buffer.active;
      return {
        mouse: `${core.coreMouseService.activeProtocol} ${core.coreMouseService.activeEncoding}`,
        hidden: core.coreService.isCursorHidden,
        shape: `${core.coreService.decPrivateModes.cursorStyle} ${core.coreService.decPrivateModes.cursorBlink}`,
        scrolls: [core.buffer.scrollTop, core.buffer.scrollBottom],
        cursor: [cursorX, cursorY],
      };
    };
    expect(state(all)).toEqual({ mouse: 'DRAG SGR', hidden: true, shape: 'bar false', scrolls: [0, 19], cursor: [6, 4] });
    expect(state(late)).toEqual(state(all));
    all.type('\r');
    await until(() => late.screen.buffer.active.type === 'normal', 5000, 'the shell again');
    expect(state(late)).toMatchObject({ mouse: 'NONE DEFAULT', hidden: false, scrolls: [0, 23] });
  }, 20_000);

  it('reads what xterm keeps of those modes, as it did when this was written', async () => {
    const screen = new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    // Rows 3 to 20 scroll, and with origin mode the cursor's row counts from the first of them.
    await new Promise<void>((done) => screen.write('\u001b[?1016h\u001b[?25l\u001b[3;20r\u001b[?6h\u001b[2;5H\u001b[4 q\u001b[?12h\u001b[20h\u001b[?2026h', done));
    // The rows said with origin mode off, then the cursor back last, and a NUL, so nothing joins what came before.
    expect(modesBeyondSnapshot(screen)).toBe('\u001b[?1016h\u001b[?6l\u001b[3;20r\u001b[?6h\u001b[4 q\u001b[?25l\u001b[?12h\u001b[20h\u001b[?2026h\u001b[0m\u001b[2;5H\u0000');
    // A cursor that shows and does not blink is said too: a page's terminal keeps either through ESC c.
    expect(modesBeyondSnapshot(new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true }))).toBe('\u001b[?25h\u001b[?12l\u0000');
  });

  it('comes once its time is up, every time, while a program left a sequence open and prints nothing more', async () => {
    terminalTiming.cutMs = 30;
    const terminal = await open();
    const first = await atPrompt(terminal.id);
    // A title begun and never ended, as `cat` of a binary file can leave one, then quiet: waited
    // for as printed (ESC ]), not as the echo of the command line writes it.
    first.type(`printf 'A\\033]0;never ended'; sleep 60\r`);
    await first.sees(/A\u001b\]0;never ended/);
    const realNow = Date.now;
    try {
      for (let join = 0; join < 12; join += 1) {
        const late = page(terminal.id);
        await until(() => terminalState(terminal.id)!.viewers.some((v) => v.joining), 5000, 'the page to come in');
        // Timers keep a clock of their own: here the wall clock runs behind it, as it may by a millisecond.
        if (join % 2 === 0) Date.now = () => realNow() - 50;
        await late.readied();
        Date.now = realNow;
        await late.close();
      }
    } finally {
      Date.now = realNow;
    }
  }, 30_000);

  it('is never cut inside an escape sequence, so what follows reads as it was printed', async () => {
    terminalTiming.cutMs = 8000;
    const terminal = await open();
    const first = await atPrompt(terminal.id);
    // Half a color, a second's wait, the other half.
    first.type(`printf 'A\\033[3'; sleep 1; printf '1mRED\\033[0m\\n'\r`);
    await first.sees(/A\u001b\[3/);
    const second = page(terminal.id);
    await second.readied();
    await until(() => second.lines().some((line) => line.startsWith('ARED')), 10_000, 'the colored line');
    // As printed: A, then RED in red; not the end of the sequence as text.
    const y = second.lines().findIndex((line) => line.startsWith('ARED'));
    expect(second.lines()[y]).toBe('ARED');
    const red = second.screen.buffer.active.getLine(y)!.getCell(1)!;
    expect(red.isFgPalette() && red.getFgColor()).toBe(1);
  }, 20_000);
});

describe('output in frames', () => {
  it('reaches a page whole, a character cut by no frame, where xterm lost one cut after its 0x80', async () => {
    // Lines of characters whose second byte is 0x80 (an em dash is E2 80 94), lengths varied: what
    // a page keeps (2,000 lines) is about 900 KB, so a dozen frames end somewhere in it, a third of
    // the time right after a 0x80.
    const file = path.join(dir, 'dashes.txt');
    const marks = '\u2014\u2026\u201c\u201d\u2019\u2022\u3002\u3001';
    await writeFile(file, Array.from({ length: 2100 }, (_, n) => `${String(n).padStart(4, '0')} ${'\u2014'.repeat(20)}${'e'.repeat(n % 3)}${marks.repeat(16)}`).join('\n'));
    const size = { cols: 200, rows: 24 };
    const terminal = await open(work(), size);
    const shown = await atPrompt(terminal.id, size);
    shown.type(`cat ${file}; echo; echo DO''NE\r`);
    await shown.sees(/DONE\r\n/, 30_000);
    await until(() => shown.lines().includes('DONE'), 10_000, 'the screen');
    const late = page(terminal.id, size);
    await late.readied();
    await until(() => late.lines().includes('DONE'), 10_000, 'the screen');
    const count = (lines: string[]) => [...lines.join('')].filter((c) => marks.includes(c)).length;
    // The page that read it frame by frame draws what the server's copy holds, every character.
    expect(shown.lines()).toEqual(late.lines());
    const kept = shown.lines().filter((line) => /^\d{4} /.test(line));
    expect(kept.length).toBeGreaterThan(1900);
    expect(count(kept)).toBe(kept.length * (20 + 128));
  }, 60_000);
});

describe('what a program asks of the terminal', () => {
  it('is answered once, from the server’s copy, with no page showing it or several', async () => {
    // Nobody looks: a program that asks still gets its answer (fish asks as it starts).
    const answered = path.join(dir, 'answered');
    const ask = (to: string) => `printf '\\033[c'; IFS= read -rs -t 3 -d c reply; IFS= read -rs -t 0.5 -d c again; echo "\${reply#?} \${#again}" > ${to}`;
    await open(work(), { command: ask(answered) });
    await until(() => existsSync(answered) && readFileSync(answered, 'utf8').endsWith('\n'), 10_000, 'the answer');
    expect(readFileSync(answered, 'utf8')).toBe('[?1;2 0\n');

    // Two pages: still one answer, and where the cursor is, as the pages show it.
    const terminal = await open();
    const phone = await atPrompt(terminal.id);
    await atPrompt(terminal.id);
    phone.type(`printf '\\033[5;9H\\033[6n'; IFS= read -rs -t 3 -d R reply; IFS= read -rs -t 0.5 -d R again; echo; echo "at \${reply#??} \${#again}"\r`);
    await phone.sees(/at 5;9 0\r\n/);
    // After an emoji, two cells wide on the pages, so in the copy too.
    phone.type(`printf '\\033[5;1H\\360\\237\\232\\200\\033[6n'; IFS= read -rs -t 3 -d R reply; IFS= read -rs -t 0.5 -d R again; echo; echo "at \${reply#??} \${#again}"\r`);
    await phone.sees(/at 5;3 0\r\n/);
  }, 20_000);

  // As delta, bat and glow ask whether the background is light or dark: a color, then device
  // attributes, whose answer says all answers are in.
  const colors: TerminalColors = {
    foreground: '#171717', background: '#fafafa', cursor: '#171717',
    ansi: ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'],
  };
  /** A command that asks `queries`, then for device attributes, and writes every answer, in order, to `to`. */
  const asking = (queries: string, to: string) => `printf '${queries}\\033[c'; IFS= read -rs -t 3 -d c reply; IFS= read -rs -t 0.5 -d c again; printf '%s|%s' "$reply" "$again" > ${to}`;
  const answers = async (to: string) => {
    await until(() => existsSync(to) && readFileSync(to, 'utf8').includes('|'), 10_000, 'the answers');
    return readFileSync(to, 'utf8');
  };
  const DA1 = '\u001b[?1;2';
  const report = (ident: string, rgb: string) => `\u001b]${ident};rgb:${rgb}\u001b\\`;

  it('answers a color asked for once, before what was asked next, in the colors the pages draw in', async () => {
    // Nobody looks yet: the colors came with the terminal.
    const before = path.join(dir, 'colors-before');
    await open(work(), { colors, command: asking('\\033]11;?\\033\\\\\\033]4;2;?\\007', before) });
    expect(await answers(before)).toBe(`${report('11', 'fafa/fafa/fafa')}${report('4;2', '1111/6363/2929')}${DA1}|`);

    // One page, then two, each saying its colors: one answer still, before the next, in the
    // colors of the page last typed in (a phone in dark mode, a computer in light).
    const terminal = await open();
    const light = await atPrompt(terminal.id, { colors });
    const once = path.join(dir, 'colors-once');
    light.type(`${asking('\\033]10;?;?\\033\\\\\\033]4;196;?\\033\\\\', once)}\r`);
    expect(await answers(once)).toBe(`${report('10', '1717/1717/1717')}${report('11', 'fafa/fafa/fafa')}${report('4;196', 'ffff/0000/0000')}${DA1}|`);
    const dark = await atPrompt(terminal.id, { colors: { ...colors, background: '#0a0a0a' } });
    const typedHere = path.join(dir, 'colors-light');
    light.type(`${asking('\\033]11;?\\033\\\\', typedHere)}\r`);
    expect(await answers(typedHere)).toBe(`${report('11', 'fafa/fafa/fafa')}${DA1}|`);
    const typedThere = path.join(dir, 'colors-dark');
    dark.type(`${asking('\\033]11;?\\033\\\\', typedThere)}\r`);
    expect(await answers(typedThere)).toBe(`${report('11', '0a0a/0a0a/0a0a')}${DA1}|`);

    // A color a program set is the one it gets, until it puts it back.
    const set = path.join(dir, 'colors-set');
    dark.type(`printf '\\033]11;#102030\\033\\\\'; ${asking('\\033]11;?\\033\\\\', set)}\r`);
    expect(await answers(set)).toBe(`${report('11', '1010/2020/3030')}${DA1}|`);
    const back = path.join(dir, 'colors-back');
    dark.type(`printf '\\033]111\\033\\\\'; ${asking('\\033]11;?\\033\\\\', back)}\r`);
    expect(await answers(back)).toBe(`${report('11', '0a0a/0a0a/0a0a')}${DA1}|`);
    // The dark page gone, the light one's are answered.
    await dark.close();
    await until(() => terminalState(terminal.id)!.viewers.length === 1, 5000, 'the dark page to go');
    const left = path.join(dir, 'colors-left');
    light.type(`${asking('\\033]11;?\\033\\\\', left)}\r`);
    expect(await answers(left)).toBe(`${report('11', 'fafa/fafa/fafa')}${DA1}|`);
  }, 30_000);

  it('leaves a color unanswered while no page has said its colors, and answers what comes next', async () => {
    const unsaid = path.join(dir, 'colors-unsaid');
    await open(work(), { command: asking('\\033]11;?\\033\\\\', unsaid) });
    expect(await answers(unsaid)).toBe(`${DA1}|`);
  }, 20_000);

  it('hears what xterm reads of colors, as it did when this was written', () => {
    const screen = new xtermHeadless.Terminal({ allowProposedApi: true });
    const heard: ColorRequest[][] = [];
    expect(onColorRequests(screen, (requests) => heard.push(requests))).toBe(true);
    screen.write('\u001b]11;?\u001b\\\u001b]4;3;#ff0000\u0007\u001b]104\u0007', () => undefined);
    return until(() => heard.length === 3).then(() => {
      expect(heard).toEqual([[{ type: 0, index: 257 }], [{ type: 1, index: 3, color: [255, 0, 0] }], [{ type: 2 }]]);
      expect(colorReport(257, [250, 250, 250])).toBe(report('11', 'fafa/fafa/fafa'));
    });
  });
});

describe('output that works over the whole screen', () => {
  it('has the shell wait for the copy of the screen by the time its work takes, not only its bytes, and none of it is taken in once the terminal is closed', async () => {
    const terminal = await open(work(), { cols: 500, rows: 300 });
    // A page that acknowledges what it gets at once, drawing nothing: only the server's copy works.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?id=${terminal.id}&cols=500&rows=300`, { headers: signedIn() });
    let output = '';
    ws.on('message', (data, binary) => {
      if (!binary) return;
      output += String(data);
      ws.send(JSON.stringify({ type: 'ack', bytes: (data as Buffer).length }));
    });
    try {
      await until(() => output.includes('PROMPT$'), 10_000, 'the prompt');
      // Each line scrolls the whole screen by its rows: a few KB of them is seconds of work at this size.
      ws.send(Buffer.from("yes $'\\e[300S' | head -c 3000000; echo FLOOD-$((40 + 2))\r"));
      await until(() => terminalState(terminal.id)?.paused === true, 30_000, 'the shell to wait');
      const state = terminalState(terminal.id)!;
      // It waits on the work, long before a megabyte of it lags, as it did.
      expect(state.received - state.parsed).toBeLessThan(terminalTiming.copyHigh / 4);
      // Pelican answers meanwhile.
      const asked = performance.now();
      expect((await api('GET', '/api/terminals')).status).toBe(200);
      expect(performance.now() - asked).toBeLessThan(3000);
      // Closed, the copy takes in nothing more of what it had been given.
      const input = (state.copy as unknown as { _core: { _inputHandler: { parse: (...args: unknown[]) => unknown } } })._core._inputHandler;
      const parse = input.parse.bind(input);
      let parsedAfter = 0;
      input.parse = (...args: unknown[]) => {
        parsedAfter += 1;
        return parse(...args);
      };
      expect((await api('DELETE', `/api/terminals/${terminal.id}`)).status).toBe(200);
      parsedAfter = 0;
      await pause(500);
      expect(parsedAfter).toBe(0);
      expect(output).not.toContain('FLOOD-42');
    } finally {
      ws.terminate();
    }
  }, 60_000);
});

describe('flow control', () => {
  it('pauses the shell while a page is far behind, so nothing piles up, and goes on when it catches up', async () => {
    terminalTiming.stallMs = 60_000;
    const terminal = await open();
    const slow = await atPrompt(terminal.id, { ack: false });
    slow.sendAck();
    slow.type("yes 0123456789012345678901234567890123456789 | head -c 4000000; echo DO''NE\r");
    await until(() => terminalState(terminal.id)!.paused, 10_000, 'the pause');
    const at = terminalState(terminal.id)!.received;
    await pause(1000);
    const state = terminalState(terminal.id)!;
    // The program waits: nothing more comes while the page is behind, and nothing waits for it.
    expect(state.paused).toBe(true);
    expect(state.received - at).toBeLessThan(64 * 1024);
    expect(state.viewers[0]!.unacked).toBeLessThan(terminalTiming.high + 2 * 64 * 1024);
    expect(slow.received - slow.acked).toBeLessThan(terminalTiming.high + 2 * 64 * 1024);
    // It catches up: the rest comes.
    slow.ack = true;
    slow.sendAck();
    await slow.sees(/DONE\r\n/, 60_000);
    await until(() => !terminalState(terminal.id)!.paused, 5000, 'the shell to go on');
  }, 90_000);

  it('lets go of a page that stopped reading, so the shell runs on for the others, and repaints it when it is back', async () => {
    terminalTiming.stallMs = 300;
    const terminal = await open();
    const asleep = await atPrompt(terminal.id);
    const awake = await atPrompt(terminal.id);
    asleep.stall();
    awake.type("yes 0123456789012345678901234567890123456789 | head -c 4000000; echo DO''NE\r");
    await awake.sees(/DONE\r\n/, 60_000);
    // Nothing waits for the sleeping page any more.
    await until(() => terminalState(terminal.id)!.viewers.length === 1, 5000, 'the sleeping page to be let go');
    expect(terminalState(terminal.id)!.paused).toBe(false);
    asleep.resume();
    await until(() => asleep.closed !== undefined, 10_000, 'the sleeping page to hear');
    expect(asleep.closed?.code).toBe(TERMINAL_CLOSE.behind);
    // Back, it gets the screen as it is now.
    const back = page(terminal.id);
    await back.readied();
    await until(() => back.lines().some((line) => line.endsWith('DONE')), 10_000, 'the screen as it is');
  }, 90_000);
});

describe('marks on a character', () => {
  const marks = (n: number) => '\u0301'.repeat(n);
  /** The most marks a cell takes, and the most code points it holds with its letter. */
  const MARKS = MARKS_PER_CHARACTER;
  const FULL = MARKS + 1;

  /** The most code points a cell of the page's screen holds. */
  const heaviest = (shown: Page) => {
    const buffer = shown.screen.buffer.active;
    let most = 0;
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y)!;
      for (let x = 0; x < line.length; x += 1) most = Math.max(most, [...(line.getCell(x)?.getChars() ?? '')].length);
    }
    return most;
  };

  // What xterm passes over between marks, going on joining them to the letter before: a DEL, the
  // C1 string terminator, a sequence it does not take.
  for (const [name, between] of [['a DEL', '\u007f'], ['U+009C', '\u009c'], ['ESC [ 1 < m', '\u001b[1<m']]) {
    it(`are at most 11 on a cell of the copy and of the pages, with ${name} after every 11`, async () => {
      const file = path.join(dir, 'marks.txt');
      // One letter, then two million marks.
      await writeFile(file, `a${`${marks(MARKS)}${between}`.repeat(Math.ceil(2_000_000 / MARKS))}b\n`);
      // A narrow screen, whose scrollback the marks overflow: what it keeps is all a page gets.
      const size = { cols: 20, rows: 5 };
      const terminal = await open(work(), size);
      const shown = await atPrompt(terminal.id, size);
      shown.type(`cat ${file}; echo DO''NE\r`);
      await shown.sees(/DONE\r\n/, 60_000);
      const late = page(terminal.id, size);
      const ready = await late.readied();
      // xterm takes in what it is given a moment later, the screen a page is sent too.
      for (const seen of [shown, late]) await until(() => seen.lines().some((line) => line.endsWith('DONE')), 10_000, 'the screen');
      // A mark that started a cell of its own, and 11 more on it, where the page saw it all and
      // where the copy's screen came.
      expect(heaviest(shown)).toBe(FULL);
      expect(heaviest(late)).toBe(FULL);
      expect(late.lines()).toEqual(shown.lines());
      // The lines the copy keeps, each of 20 such cells (and a NUL before each that begins with a
      // mark, so it joins nothing before it), and no more however many came.
      expect(ready.snapshot.length).toBeLessThan((TERMINAL_LIMITS.scrollback + size.rows) * size.cols * (FULL + 1) + 10_000);
    }, 90_000);
  }

  it('are at most 11 on a cell, and a letter keeps its first 11, in one run however long', async () => {
    const file = path.join(dir, 'marks-run.txt');
    await writeFile(file, `a${marks(30)}b\n`);
    const terminal = await open();
    const shown = await atPrompt(terminal.id);
    shown.type(`cat ${file}; echo DO''NE\r`);
    await shown.sees(/DONE\r\n/);
    const late = page(terminal.id);
    await late.readied();
    for (const seen of [shown, late]) await until(() => seen.lines().some((line) => line.endsWith('DONE')), 10_000, 'the screen');
    for (const seen of [shown, late]) {
      const y = seen.lines().findIndex((line) => line.startsWith('a\u0301'));
      const line = seen.screen.buffer.active.getLine(y)!;
      // The letter and 11; then a mark, a cell of its own, and the 11 after it; then the last 7, and b.
      expect([0, 1, 2, 3].map((x) => line.getCell(x)?.getChars())).toEqual([`a${marks(MARKS)}`, marks(FULL), marks(7), 'b']);
    }
  }, 30_000);
});

describe('output xterm throws on', () => {
  it('stops neither Pelican nor its pages: erasing above from the last cell of a screen just opened', async () => {
    const terminal = await open();
    const shown = await atPrompt(terminal.id);
    // The cursor on the last cell, nothing scrolled off yet, then ED 1; what follows, at the top.
    shown.type(`printf '\\033[24;80H\\033[1J'; sleep 0.2; printf '\\033[HAF''TER\\033[2;1H'\r`);
    await shown.sees(/AFTER/);
    await until(() => shown.lines()[0] === 'AFTER' && /^PROMPT\$/.test(shown.lines()[1] ?? ''), 10_000, 'what came next');
    // All erased up to the cursor, the command too, as the server's copy has it.
    expect(shown.lines().slice(2).join('')).toBe('');
    const late = page(terminal.id);
    await late.readied();
    await until(() => late.lines()[0] === 'AFTER', 10_000, 'the screen');
    expect(late.lines()).toEqual(shown.lines());
  }, 20_000);
});

describe('the shell’s environment', () => {
  it('leaves out what is Pelican’s, npm’s, Claude Code’s own and the outer terminal’s, and adds the folder’s launch settings', () => {
    // Made-up values: a Claude Code session's id, its messaging socket and token, as Pelican started
    // from one has them, and the entrypoint the Agent SDK sets in Pelican's own process.
    const outer = {
      PATH: '/usr/bin:/bin', HOME: '/home/someone', LANG: 'fr_FR.UTF-8', NPM_CONFIG_REGISTRY: 'https://registry.example',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock', HTTPS_PROXY: 'http://proxy.example:3128', ANTHROPIC_MODEL: 'claude-opus-5-5',
      PELICAN_AUTH: 'none', PELICAN_STATE_DIR: '/state', npm_config_cache: '/cache', npm_lifecycle_event: 'dev', CLAUDECODE: '1',
      INIT_CWD: '/home/someone/project', NODE: '/usr/local/bin/node',
      CLAUDE_AGENT_SDK_VERSION: '0.3.318', NoDefaultCurrentDirectoryInExePath: '1', CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_SESSION_ID: 'made-up-session', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/made-up.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'made-up-token',
      TERM: 'dumb', TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_MAIN: '/vscode/askpass-main.js', GIT_ASKPASS: '/vscode/askpass.sh',
      CLAUDE_CODE_SSE_PORT: '51234', ITERM_SESSION_ID: 'w0t0p0', TMUX: '/tmp/tmux-501/default,1,0', SHLVL: '2',
      XPC_SERVICE_NAME: 'io.github.ki-seki.pelican', INVOCATION_ID: 'abc', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c',
    };
    const launch = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false' };
    expect(shellEnvironment(outer, launch, '/bin/zsh')).toEqual({
      PATH: '/usr/bin:/bin', HOME: '/home/someone', LANG: 'fr_FR.UTF-8', NPM_CONFIG_REGISTRY: 'https://registry.example',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock', HTTPS_PROXY: 'http://proxy.example:3128', ANTHROPIC_MODEL: 'claude-opus-5-5',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
      TERM: 'xterm-256color', COLORTERM: 'truecolor', SHELL: '/bin/zsh',
    });
    // A git password helper of your own stays; a locale is set where there was none.
    expect(shellEnvironment({ GIT_ASKPASS: '/usr/libexec/ssh-askpass' }, undefined, '/bin/bash')).toMatchObject({ GIT_ASKPASS: '/usr/libexec/ssh-askpass', LANG: expect.stringMatching(/UTF-8$/) });
    expect(shellEnvironment({ LC_ALL: 'C' }, undefined, '/bin/bash')).not.toHaveProperty('LANG');
  });

  it('is Pelican’s, without Pelican’s settings, npm’s, Claude Code’s own and the outer terminal’s', async () => {
    const before = { ...process.env };
    // Made-up values only, for what a Claude Code session Pelican was started from would hand down.
    Object.assign(process.env, {
      PELICAN_TERMINAL_TEST: 'secret', npm_config_terminal_test: 'npm', npm_lifecycle_event: 'dev', CLAUDECODE: '1', CLAUDE_AGENT_SDK_VERSION: '0.3.318',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_SESSION_ID: 'made-up-session', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/made-up.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'made-up-token', INIT_CWD: '/made/up', NODE: '/made/up/node',
      TERM_PROGRAM: 'Elsewhere', ITERM_SESSION_ID: 'w0t0p0', XPC_SERVICE_NAME: 'com.example.pelican', KEPT_FOR_THE_SHELL: 'kept',
    });
    try {
      const terminal = await open();
      const shown = await atPrompt(terminal.id);
      shown.type('env | sort; echo "END-$((6 * 7))"\r');
      await shown.sees(/END-42\r\n/);
      const names = shown.output.split('\r\n').map((line) => line.split('=')[0]);
      expect(names).toContain('KEPT_FOR_THE_SHELL');
      expect(names.filter((name) => name?.startsWith('CLAUDE_CODE_'))).toEqual([]);
      expect(shown.output).not.toMatch(/made-up/);
      for (const gone of [
        'PELICAN_TERMINAL_TEST', 'npm_config_terminal_test', 'npm_lifecycle_event', 'CLAUDECODE', 'CLAUDE_AGENT_SDK_VERSION', 'INIT_CWD', 'NODE',
        'TERM_PROGRAM', 'ITERM_SESSION_ID', 'XPC_SERVICE_NAME',
      ]) {
        expect(names).not.toContain(gone);
      }
      expect(shown.output).toMatch(/\r\nTERM=xterm-256color\r\n/);
      expect(shown.output).toMatch(/\r\nCOLORTERM=truecolor\r\n/);
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
      Object.assign(process.env, before);
    }
  }, 20_000);

  describe('in a repository that runs a program of its own on `git status`', () => {
    async function downloaded(name: string) {
      const repo = path.join(dir, name);
      const marker = path.join(dir, `${name}-fsmonitor-ran`);
      await mkdir(repo);
      execFileSync('git', ['init', '-q'], { cwd: repo });
      await writeFile(path.join(repo, 'README.md'), 'hello\n');
      const program = path.join(dir, `${name}-fsmonitor.sh`);
      await writeFile(program, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
      execFileSync('git', ['config', 'core.fsmonitor', program], { cwd: repo });
      const ran = () => stat(marker).then(() => true, () => false);
      // It does run for a git of its own.
      execFileSync('git', ['status', '--short'], { cwd: repo });
      expect(await ran()).toBe(true);
      await rm(marker);
      return { repo, ran };
    }

    it('asks first, when nobody trusted the folder', async () => {
      const { repo } = await downloaded('asked');
      const asked = await api('POST', '/api/terminals', { cwd: repo, cols: 80, rows: 24 });
      expect(asked.status).toBe(409);
      expect(asked.body.needsTrust).toBe(true);
      expect(asked.body.brings.join('\n')).toMatch(/Git fsmonitor/);
      expect((await api('GET', '/api/terminals')).body.terminals).toEqual([]);
    });

    it('runs none of it in a folder kept to your settings only, as Claude Code and ! commands there', async () => {
      const { repo, ran } = await downloaded('user-only');
      // The answer to the trust sheet, sent again with the request.
      const terminal = await open(repo, { trust: 'user-only' });
      const shown = await atPrompt(terminal.id);
      shown.type('git status --short; echo "git-$((1 + 1))"\r');
      await shown.sees(/git-2\r\n/);
      expect(await ran()).toBe(false);
    }, 20_000);
  });
});

/** ps's line for a process, as `ps -A -o pid=,ppid=,pgid=,tpgid=,stat=,tty=` prints it. */
const psLine = (pid: number, ppid: number, pgid: number, tpgid: number, stat: string, tty: string) => `${pid} ${ppid} ${pgid} ${tpgid} ${stat} ${tty}`;

/** Whether the terminal says something runs in it, as End asks. */
const runningIn = async (id: string) => ((await api('GET', `/api/terminals/${id}`)).body as { running: boolean }).running;

/** Until the terminal says so; End's answer may lag a job's end by the moment the shell takes to reap it. */
async function saysRunning(id: string, expected: boolean): Promise<void> {
  for (const start = Date.now(); (await runningIn(id)) !== expected;) {
    if (Date.now() - start > 10_000) throw new Error(`the terminal never said running: ${expected}`);
    await pause(100);
  }
}

/** Ends what a test left running, by its process group, as only the test started it. */
function endGroup(pgid: number | undefined): void {
  if (!pgid) return;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Gone already.
  }
}

/** The processes of the computer, as Pelican reads them. */
const table = () => parseProcessTable(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=']).toString())!;

/**
 * How gitstatus.plugin.zsh (github.com/romkatv/gitstatus, which powerlevel10k brings) starts
 * gitstatusd, kept to the steps that make its processes what they are: from the interactive shell,
 * with job control on, a process substitution whose subshell (a group of its own) starts the daemon
 * and a lock watcher in the background, disowned, and ends, so they are left to the system, in that
 * group, on the terminal. `sleep` stands in for gitstatusd.
 */
const GITSTATUS_STAND_IN = `
zmodload zsh/system zsh/files || return
_standin_daemon() {
  local -i pipe_fd
  exec 0<&- {pipe_fd}>&1 1>>/dev/null 2>&1 || return
  local pgid=$sysparams[pid]
  [[ $pgid == <1-> ]] || return
  builtin cd -q / || return
  {
    {
      trap '' PIPE
      command mkfifo -- $file_prefix.fifo || return
      print -rnu $pipe_fd -- \${(l:20:)pgid} || return
      exec <$file_prefix.fifo || return
      zf_rm -- $file_prefix.fifo || return
      command sleep 300 >&$pipe_fd
    } always {
      zf_rm -f -- $file_prefix.lock $file_prefix.fifo
      kill -- -$pgid
    }
  } &!
  (( lock_fd == -1 )) && return
  {
    if zsystem flock -- $file_prefix.lock && command sleep 5 && [[ -e $file_prefix.lock ]]; then
      zf_rm -f -- $file_prefix.lock $file_prefix.fifo
      kill -- -$pgid
    fi
  } &!
}
standin_start() {
  emulate -L zsh -o no_aliases -o no_bg_nice -o extended_glob -o typeset_silent || return
  local -i lock_fd resp_fd req_fd
  local file_prefix=\${TMPDIR:-/tmp}/standin.$sysparams[pid]
  () {
    setopt monitor || return
    print -rn >$file_prefix.lock || return
    zsystem flock -f lock_fd $file_prefix.lock || return
    sysopen -r -o cloexec -u resp_fd <(_standin_daemon) || return
    local pgid
    while (( $#pgid < 20 )); do
      sysread -s $((20 - $#pgid)) -t 5 -i $resp_fd 'pgid[$#pgid+1]' || return
    done
    typeset -gi STANDIN_DAEMON_PGID=pgid
    sysopen -w -o cloexec -u req_fd -- $file_prefix.fifo || return
    typeset -gi STANDIN_REQ_FD=req_fd STANDIN_RESP_FD=resp_fd STANDIN_LOCK_FD=lock_fd
  }
}
`;

const zsh = ['/bin/zsh', '/usr/bin/zsh'].find((file) => existsSync(file));

describe('what runs in a terminal', () => {
  it('is a program in front, or a job of the shell’s own on its terminal, running or stopped; not a helper the shell left there, or one it started on another', () => {
    const shell = 500;
    const at = (...rows: string[]) => parseProcessTable([psLine(1, 0, 1, 0, 'Ss', '??'), ...rows].join('\n'));
    // On a Mac (ttys001) and on Linux (pts/3): the shell at its prompt, the terminal's foreground group its own.
    for (const [tty, none] of [['ttys001', '??'], ['pts/3', '?']] as const) {
      const prompt = psLine(shell, 400, shell, shell, 'Ss+', tty);
      expect(runsIn(shell, at(prompt)), tty).toBe(false);
      // gitstatusd as powerlevel10k starts it: its subshell ended, so it and its watcher are the system's,
      // in the subshell's group, on the terminal.
      expect(runsIn(shell, at(prompt, psLine(611, 1, 610, shell, 'S', tty), psLine(612, 1, 610, shell, 'S', tty), psLine(613, 611, 610, shell, 'S', tty)))).toBe(false);
      // A worker on a terminal of its own (zsh-async's zpty), or none (a daemon that left its terminal).
      expect(runsIn(shell, at(prompt, psLine(620, shell, 620, 620, 'Ss+', 'ttys009'), psLine(621, shell, 621, 0, 'Ss', none)))).toBe(false);
      // A job that ended, until the shell reaps it.
      expect(runsIn(shell, at(prompt, psLine(630, shell, 630, shell, 'Z', tty)))).toBe(false);
      // A job in the background, running or stopped, and one started with job control off.
      for (const job of [psLine(640, shell, 640, shell, 'S', tty), psLine(641, shell, 641, shell, 'T', tty), psLine(642, shell, shell, shell, 'S', tty)]) {
        expect(runsIn(shell, at(prompt, job)), job).toBe(true);
      }
      // A program in front: the terminal's foreground group is not the shell's.
      expect(runsIn(shell, at(psLine(shell, 400, shell, 650, 'Ss', tty), psLine(650, shell, 650, 650, 'S+', tty)))).toBe(true);
    }
    // ps could not say, or did not list the shell: it cannot be told.
    expect(runsIn(shell, undefined)).toBeUndefined();
    expect(runsIn(shell, at(psLine(700, 1, 700, 0, 'S', '??')))).toBeUndefined();
    expect(parseProcessTable('')).toBeUndefined();
    expect(parseProcessTable('ps: illegal option')).toBeUndefined();
  });

  it('is said for End to ask first: a program in front, or a job in the background, but not the shell at its prompt', async () => {
    const terminal = await open();
    const shown = await atPrompt(terminal.id);
    const running = async () => (await api('GET', `/api/terminals/${terminal.id}`)).body as { terminal: TerminalInfo; running: boolean };
    expect(await running()).toEqual({ terminal: expect.objectContaining({ id: terminal.id, program: 'bash' }), running: false });
    // A helper left on the terminal, as gitstatusd is: started from a subshell that ended at once,
    // the system's now, in that subshell's group.
    shown.type('echo "shell $$"; ( sleep 300 & echo "helper $(jobs -p)" )\r');
    await shown.sees(/helper \d+/);
    const shell = Number(/shell (\d+)/.exec(shown.output)![1]);
    const helper = Number(/helper (\d+)/.exec(shown.output)![1]);
    try {
      await until(() => /PROMPT\$ $/.test(shown.lines().filter(Boolean).at(-1) ?? ''), 10_000, 'the prompt');
      const processes = table();
      expect(processes.get(helper)).toMatchObject({ tty: processes.get(shell)!.tty });
      expect(processes.get(helper)!.ppid).not.toBe(shell);
      expect(await running()).toEqual({ terminal: expect.objectContaining({ program: 'bash' }), running: false });
    } finally {
      endGroup(table().get(helper)?.pgid);
    }
    // A job in the background: the shell is in front, and a process of its own runs.
    shown.type('sleep 300 &\r');
    await shown.sees(/\[1\] \d+/);
    await until(() => /PROMPT\$ $/.test(shown.lines().filter(Boolean).at(-1) ?? ''), 10_000, 'the prompt');
    expect(await running()).toEqual({ terminal: expect.objectContaining({ program: 'bash' }), running: true });
    shown.type('kill %1; wait\r');
    await shown.sees(/Terminated/);
    await saysRunning(terminal.id, false);
    // A job stopped (Ctrl+Z), in the background.
    shown.type('sleep 300\r');
    await pause(600);
    shown.type('\u001a');
    await shown.sees(/Stopped/);
    await until(() => /PROMPT\$ $/.test(shown.lines().filter(Boolean).at(-1) ?? ''), 10_000, 'the prompt');
    expect(await running()).toEqual({ terminal: expect.objectContaining({ program: 'bash' }), running: true });
    shown.type("kill -9 %1; echo KI''LLED\r");
    await shown.sees(/KILLED/);
    await saysRunning(terminal.id, false);
    // A program in front.
    shown.type('sleep 300\r');
    await pause(600);
    expect(await running()).toEqual({ terminal: expect.objectContaining({ program: 'sleep' }), running: true });
    shown.type('\u0003');
    // Ended, nothing runs; gone, there is no such terminal.
    shown.type('exit\r');
    await until(() => shown.messages.some((m) => m.type === 'exit'));
    expect((await running()).running).toBe(false);
    await api('DELETE', `/api/terminals/${terminal.id}`);
    expect((await api('GET', `/api/terminals/${terminal.id}`)).status).toBe(404);
  }, 30_000);

  it.skipIf(!zsh)('is not gitstatusd, started as powerlevel10k starts it, nor a zpty worker, as zsh-async starts one: End asks only for a job', async () => {
    const saved = { ...testShell };
    Object.assign(testShell, { file: zsh, args: ['-f', '-i'] });
    let daemon: number | undefined;
    try {
      const terminal = await open();
      const shown = await atPrompt(terminal.id);
      const script = path.join(dir, 'gitstatus-stand-in.zsh');
      await writeFile(script, GITSTATUS_STAND_IN);
      shown.type(`echo "shell $$"; source ${script} && standin_start && echo "STARTED $STANDIN_DAEMON_PGID"\r`);
      await shown.sees(/STARTED \d+/);
      const shell = Number(/shell (\d+)/.exec(shown.output)![1]);
      daemon = Number(/STARTED (\d+)/.exec(shown.output)![1]);
      await until(() => /PROMPT\$ $/.test(shown.lines().filter(Boolean).at(-1) ?? ''), 10_000, 'the prompt');
      // What it left: the daemon and its watcher in the group of the subshell that started them,
      // on the terminal, the system's once that subshell ended; none of them the shell's.
      await until(() => [...table().values()].filter((row) => row.pgid === daemon).length >= 3, 10_000, 'the daemon and its watcher');
      const processes = table();
      const tty = processes.get(shell)!.tty;
      for (const [pid, row] of processes) {
        if (row.pgid !== daemon) continue;
        expect(row.tty, String(pid)).toBe(tty);
        expect(row.ppid, String(pid)).not.toBe(shell);
      }
      expect(await runningIn(terminal.id)).toBe(false);
      // A worker on a terminal of its own, as zsh-async starts one: the shell's own, but not on its terminal.
      shown.type('zmodload zsh/zpty && zpty standin_worker sleep 300 && echo WORKER\r');
      await shown.sees(/WORKER/);
      await until(() => [...table().values()].some((row) => row.ppid === shell && row.tty !== tty), 10_000, 'the worker');
      expect(await runningIn(terminal.id)).toBe(false);
      // A job: End asks; once it ends, it does not.
      shown.type('sleep 300 &\r');
      await shown.sees(/\[1\] \d+/);
      expect(await runningIn(terminal.id)).toBe(true);
      shown.type('kill %1\r');
      await saysRunning(terminal.id, false);
      shown.type('zpty -d standin_worker; echo GONE\r');
      await shown.sees(/GONE/);
    } finally {
      endGroup(daemon);
      Object.assign(testShell, saved);
    }
  }, 30_000);
});

describe('a terminal left alone', () => {
  it('is closed after 12 hours unused with nothing running; one running a job, or shown, stays', async () => {
    const quiet = await open();
    const busy = await open();
    const shown = await open();
    const ended = await open();
    const job = await atPrompt(busy.id);
    job.type('sleep 300 &\r');
    await job.sees(/\[1\] \d+/);
    await job.close();
    const end = await atPrompt(ended.id);
    end.type('exit\r');
    await until(() => end.messages.some((m) => m.type === 'exit'));
    await end.close();
    const watching = await atPrompt(shown.id);
    await until(() => terminalState(busy.id)!.viewers.length === 0 && terminalState(ended.id)!.viewers.length === 0);
    const ids = async () => ((await api('GET', '/api/terminals')).body as TerminalList).terminals.map((t) => t.id);
    // Unused for an hour: nothing closes.
    await closeIdleTerminals(Date.now() + 3600_000);
    expect(await ids()).toEqual([quiet.id, busy.id, shown.id, ended.id]);
    await closeIdleTerminals(Date.now() + 13 * 3600_000);
    expect(await ids()).toEqual([busy.id, shown.id]);
    expect(watching.closed).toBeUndefined();
  }, 30_000);
});

describe('a page whose sign-in has gone', () => {
  it('is let go, and nothing it sends after reaches the shell: a new token signs a terminal out too', async () => {
    const terminal = await open();
    const old = signedIn();
    const stale = await atPrompt(terminal.id);
    const events = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: old });
    let eventsClosed: number | undefined;
    events.on('close', (code) => {
      eventsClosed = code;
    });
    await until(() => events.readyState === WebSocket.OPEN, 5000, 'api/ws');

    // `pelican token --reset`, from another process: a new token and secret, written whole.
    const file = path.join(config.configDir, 'token.json');
    await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, token: randomBytes(24).toString('base64url'), secret: randomBytes(32).toString('base64') }), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    // Pelican notices within a second: the old token gets nowhere.
    for (const start = Date.now(); (await api('GET', '/api/terminals', undefined, old)).status !== 401;) {
      if (Date.now() - start > 5000) throw new Error('the reset went unnoticed');
      await pause(100);
    }
    const marker = path.join(dir, 'typed-after-reset');
    if (stale.ws.readyState === WebSocket.OPEN) stale.type(`touch ${marker}\r`);
    await until(() => stale.closed !== undefined && eventsClosed !== undefined, 5000, 'the sockets to close');
    expect(stale.closed?.code).toBe(TERMINAL_CLOSE.signedOut);
    expect(eventsClosed).toBe(SIGNED_OUT_CLOSE);

    // Signed in again with the new token, the owner types: the old page saw none of it.
    const seen = stale.output.length;
    const owner = await atPrompt(terminal.id);
    owner.type(`echo "only the owner $((6 * 7))"\r`);
    await owner.sees(/only the owner 42\r\n/);
    expect(stale.output.length).toBe(seen);
    expect(existsSync(marker)).toBe(false);
    expect(terminalState(terminal.id)!.viewers).toHaveLength(1);
  }, 20_000);
});

describe('a browser signed out', () => {
  it('has its terminal let go of within a second, from another tab too, and its cookie opens none again', async () => {
    const terminal = await open();
    // The browser signs in with the token, as its sign-in page does, and shows the terminal in two tabs.
    const login = await fetch(`${origin()}/api/auth/login`, { method: 'POST', headers: { 'x-pelican': '1', 'content-type': 'application/json', origin: origin() }, body: JSON.stringify({ token: accessToken() }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const browser = { origin: origin(), cookie };
    const tab = await atPrompt(terminal.id, { headers: browser });
    const otherTab = await atPrompt(terminal.id, { headers: browser });
    const owner = await atPrompt(terminal.id);

    // Signed out from the first tab: both close, and nothing the second sends after reaches the shell.
    const out = await api('POST', '/api/auth/logout', undefined, { authorization: '', cookie });
    expect(out.status).toBe(200);
    const at = Date.now();
    const marker = path.join(dir, 'typed-after-sign-out');
    if (otherTab.ws.readyState === WebSocket.OPEN) otherTab.type(`touch ${marker}\r`);
    await until(() => tab.closed !== undefined && otherTab.closed !== undefined, 1000, 'the signed-out tabs to close');
    expect(Date.now() - at).toBeLessThan(1000);
    expect(tab.closed?.code).toBe(TERMINAL_CLOSE.signedOut);
    expect(otherTab.closed?.code).toBe(TERMINAL_CLOSE.signedOut);

    // The same cookie opens no terminal again; the owner's page, signed in otherwise, stays.
    const again = new Page(port, terminal.id, { headers: browser });
    await again.opening();
    expect(again.opened).toBe(false);
    owner.type(`echo "still here $((6 * 7))"\r`);
    await owner.sees(/still here 42\r\n/);
    expect(existsSync(marker)).toBe(false);
    expect(terminalState(terminal.id)!.viewers).toHaveLength(1);
  }, 20_000);
});

describe('who gets a terminal', () => {
  it('only Pelican’s own page, signed in, under a name that points here, gets a socket', async () => {
    const terminal = await open();
    const opens = async (headers: Record<string, string>) => {
      const tried = new Page(port, terminal.id, { headers });
      await tried.opening();
      const opened = tried.opened;
      await tried.close();
      return opened;
    };
    expect(await opens(signedIn())).toBe(true);
    expect(await opens({ origin: 'https://evil.example', authorization: `Bearer ${accessToken()}` })).toBe(false);
    expect(await opens({ origin: origin() })).toBe(false);
    expect(await opens({ origin: origin(), cookie: `${cookieName()}=${Date.now() + 60_000}.forged` })).toBe(false);
    expect(await opens({ host: 'attacker.example', origin: 'http://attacker.example', authorization: `Bearer ${accessToken()}` })).toBe(false);
  }, 20_000);

  it('and the same through the API', async () => {
    const body = { cwd: work(), cols: 80, rows: 24 };
    expect((await api('POST', '/api/terminals', body, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('POST', '/api/terminals', body, { authorization: '' })).status).toBe(401);
    expect((await api('GET', '/api/terminals', undefined, { 'x-pelican': '' })).status).toBe(403);
    expect((await api('GET', '/api/terminals', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await api('POST', '/api/terminals', { ...body, cols: 1 })).status).toBe(400);
    expect((await api('POST', '/api/terminals', { ...body, cwd: path.join(dir, 'missing') })).status).toBe(404);
    expect((await api('GET', '/api/terminals')).body.terminals).toEqual([]);
  });

  it('none in the demo, which says so calmly', async () => {
    const terminal = await open();
    config.demo = true;
    const listed = await api('GET', '/api/terminals');
    expect(listed.body).toEqual({ available: false, reason: expect.stringMatching(/^This is the demo, so nothing runs here\./), terminals: [] });
    expect((await api('GET', '/api/info')).body.terminal).toEqual({ available: false, reason: listed.body.reason });
    expect((await api('POST', '/api/terminals', { cwd: work(), cols: 80, rows: 24 })).status).toBe(403);
    const refused = page(terminal.id);
    await until(() => refused.closed !== undefined);
    expect(refused.closed?.code).toBe(TERMINAL_CLOSE.refused);
  });

  it('none with --no-terminal', async () => {
    config.terminal = false;
    const listed = await api('GET', '/api/terminals');
    expect(listed.body).toEqual({ available: false, reason: 'The terminal is off: Pelican was started with --no-terminal.', terminals: [] });
    const refused = await api('POST', '/api/terminals', { cwd: work(), cols: 80, rows: 24 });
    expect(refused).toEqual({ status: 403, body: { error: listed.body.reason } });
  });

  it('none where the PTY cannot load, which says why, while ! commands are untouched', async () => {
    usePtyLoader(() => Promise.reject(new Error('Cannot find module \'pty.node\'\nRequire stack: …')));
    const listed = await api('GET', '/api/terminals');
    expect(listed.body).toEqual({
      available: false,
      reason: 'The terminal could not start here: Cannot find module \'pty.node\'. ! commands work as before.',
      terminals: [],
    });
    expect((await api('GET', '/api/info')).body.terminal).toEqual({ available: false, reason: listed.body.reason });
    expect((await api('POST', '/api/terminals', { cwd: work(), cols: 80, rows: 24 })).status).toBe(503);
  });

  it('at most 10 at once: an ended one makes room, else one nobody used that no page shows; and 8 pages each', async () => {
    const ids = async () => ((await api('GET', '/api/terminals')).body as TerminalList).terminals.map((t) => t.id);
    const terminals: TerminalInfo[] = [];
    for (let n = 0; n < 10; n += 1) terminals.push(await open());
    // Each typed into, then left: none makes room.
    for (const terminal of terminals) {
      const used = await atPrompt(terminal.id);
      used.type('true\r');
      await used.sees(/true\r\n/);
      await used.close();
    }
    await until(() => terminals.every((t) => terminalState(t.id)!.viewers.length === 0), 5000, 'the pages to go');
    const refused = await api('POST', '/api/terminals', { cwd: work(), cols: 80, rows: 24 });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/^At most 10 terminals run at once/);
    const first = await atPrompt(terminals[0]!.id);
    first.type('exit\r');
    await until(() => first.messages.some((m) => m.type === 'exit'));
    const untouched = await open();
    expect(await ids()).not.toContain(terminals[0]!.id);
    // One nobody typed into (a folder's Terminal tab looked at once) makes room, unless a page shows it.
    const looking = await atPrompt(untouched.id);
    expect((await api('POST', '/api/terminals', { cwd: work(), cols: 80, rows: 24 })).status).toBe(429);
    await looking.close();
    await until(() => terminalState(untouched.id)!.viewers.length === 0, 5000, 'the page to go');
    const next = await open();
    expect(await ids()).toEqual([...terminals.slice(1).map((t) => t.id), next.id]);

    const pages = Array.from({ length: 8 }, () => page(terminals[1]!.id));
    await Promise.all(pages.map((p) => p.readied()));
    const ninth = page(terminals[1]!.id);
    await until(() => ninth.closed !== undefined);
    expect(ninth.closed?.code).toBe(TERMINAL_CLOSE.tooManyViewers);
  }, 60_000);

  it('a socket for no terminal, at a size no terminal takes, or sending a frame too large, is closed', async () => {
    const terminal = await open();
    const nowhere = page('no-such-terminal');
    const tiny = page(terminal.id, { cols: 1, rows: 24 });
    await until(() => nowhere.closed !== undefined && tiny.closed !== undefined);
    expect(nowhere.closed?.code).toBe(TERMINAL_CLOSE.gone);
    expect(tiny.closed?.code).toBe(TERMINAL_CLOSE.badRequest);
    const flooding = await atPrompt(terminal.id);
    flooding.ws.send(Buffer.alloc(64 * 1024 + 1, 0x61), { binary: true });
    await until(() => flooding.closed !== undefined);
    expect(flooding.closed?.code).toBe(1009);
    // The shell took nothing of it, and goes on for the next page.
    const next = await atPrompt(terminal.id);
    expect(next.lines().join('')).not.toContain('aaaa');
  }, 20_000);
});
