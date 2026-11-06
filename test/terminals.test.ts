// Terminals end to end: a Pelican of the tests' own (temporary folders, port 0), real shells in
// real PTYs, and pages as the web app's would be (terminal-page.ts). The shell is bash without
// any profile, so nothing of the computer's own shell setup runs.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import xtermHeadless from '@xterm/headless';

import type { TerminalColors, TerminalInfo, TerminalList } from '../src/shared/terminal';
import { TERMINAL_CLOSE } from '../src/shared/terminal';
import { accessToken, cookieName } from '../src/server/auth';
import { config } from '../src/server/config';
import { usePtyLoader } from '../src/server/pty';
import { startServer } from '../src/server/server';
import {
  closeAllTerminals, closeIdleTerminals, type ColorRequest, colorReport, onColorRequests, shellEnvironment, terminalState, terminalTiming, testShell,
} from '../src/server/terminals';
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

  it('comes once its time is up, every time, while a program left a sequence open and prints nothing more', async () => {
    terminalTiming.cutMs = 30;
    const terminal = await open();
    const first = await atPrompt(terminal.id);
    // A title begun and never ended, as `cat` of a binary file can leave one, then quiet.
    first.type(`printf 'A\\033]0;never ended'; sleep 60\r`);
    await first.sees(/never ended/);
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

    // One page, then two, each saying its colors: one answer still, before the next.
    const terminal = await open();
    const one = await atPrompt(terminal.id, { colors });
    const once = path.join(dir, 'colors-once');
    one.type(`${asking('\\033]10;?;?\\033\\\\\\033]4;196;?\\033\\\\', once)}\r`);
    expect(await answers(once)).toBe(`${report('10', '1717/1717/1717')}${report('11', 'fafa/fafa/fafa')}${report('4;196', 'ffff/0000/0000')}${DA1}|`);
    const dark = { ...colors, background: '#0a0a0a' };
    await atPrompt(terminal.id, { colors: dark });
    const twice = path.join(dir, 'colors-twice');
    one.type(`${asking('\\033]11;?\\033\\\\', twice)}\r`);
    expect(await answers(twice)).toBe(`${report('11', '0a0a/0a0a/0a0a')}${DA1}|`);

    // A color a program set is the one it gets, until it puts it back.
    const set = path.join(dir, 'colors-set');
    one.type(`printf '\\033]11;#102030\\033\\\\'; ${asking('\\033]11;?\\033\\\\', set)}\r`);
    expect(await answers(set)).toBe(`${report('11', '1010/2020/3030')}${DA1}|`);
    const back = path.join(dir, 'colors-back');
    one.type(`printf '\\033]111\\033\\\\'; ${asking('\\033]11;?\\033\\\\', back)}\r`);
    expect(await answers(back)).toBe(`${report('11', '0a0a/0a0a/0a0a')}${DA1}|`);
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

describe('the shell’s environment', () => {
  it('leaves out what is Pelican’s, npm’s, Claude Code’s mark and the outer terminal’s, and adds the folder’s launch settings', () => {
    const outer = {
      PATH: '/usr/bin:/bin', HOME: '/home/someone', LANG: 'fr_FR.UTF-8', NPM_CONFIG_REGISTRY: 'https://registry.example',
      PELICAN_AUTH: 'none', PELICAN_STATE_DIR: '/state', npm_config_cache: '/cache', npm_lifecycle_event: 'dev', CLAUDECODE: '1',
      TERM: 'dumb', TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_MAIN: '/vscode/askpass-main.js', GIT_ASKPASS: '/vscode/askpass.sh',
      CLAUDE_CODE_SSE_PORT: '51234', ITERM_SESSION_ID: 'w0t0p0', TMUX: '/tmp/tmux-501/default,1,0', SHLVL: '2',
      XPC_SERVICE_NAME: 'io.github.ki-seki.pelican', INVOCATION_ID: 'abc', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c',
    };
    const launch = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false' };
    expect(shellEnvironment(outer, launch, '/bin/zsh')).toEqual({
      PATH: '/usr/bin:/bin', HOME: '/home/someone', LANG: 'fr_FR.UTF-8', NPM_CONFIG_REGISTRY: 'https://registry.example',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
      TERM: 'xterm-256color', COLORTERM: 'truecolor', SHELL: '/bin/zsh',
    });
    // A git password helper of your own stays; a locale is set where there was none.
    expect(shellEnvironment({ GIT_ASKPASS: '/usr/libexec/ssh-askpass' }, undefined, '/bin/bash')).toMatchObject({ GIT_ASKPASS: '/usr/libexec/ssh-askpass', LANG: expect.stringMatching(/UTF-8$/) });
    expect(shellEnvironment({ LC_ALL: 'C' }, undefined, '/bin/bash')).not.toHaveProperty('LANG');
  });

  it('is Pelican’s, without Pelican’s settings, npm’s, Claude Code’s mark and the outer terminal’s', async () => {
    const before = { ...process.env };
    Object.assign(process.env, {
      PELICAN_TERMINAL_TEST: 'secret', npm_config_terminal_test: 'npm', npm_lifecycle_event: 'dev', CLAUDECODE: '1',
      TERM_PROGRAM: 'Elsewhere', ITERM_SESSION_ID: 'w0t0p0', XPC_SERVICE_NAME: 'com.example.pelican', KEPT_FOR_THE_SHELL: 'kept',
    });
    try {
      const terminal = await open();
      const shown = await atPrompt(terminal.id);
      shown.type('env | sort; echo "END-$((6 * 7))"\r');
      await shown.sees(/END-42\r\n/);
      const names = shown.output.split('\r\n').map((line) => line.split('=')[0]);
      expect(names).toContain('KEPT_FOR_THE_SHELL');
      for (const gone of ['PELICAN_TERMINAL_TEST', 'npm_config_terminal_test', 'npm_lifecycle_event', 'CLAUDECODE', 'TERM_PROGRAM', 'ITERM_SESSION_ID', 'XPC_SERVICE_NAME']) {
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

  it('at most 10 at once, an ended one making room, and 8 pages each', async () => {
    const terminals: TerminalInfo[] = [];
    for (let n = 0; n < 10; n += 1) terminals.push(await open());
    const refused = await api('POST', '/api/terminals', { cwd: work(), cols: 80, rows: 24 });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/^At most 10 terminals run at once/);
    const first = await atPrompt(terminals[0]!.id);
    first.type('exit\r');
    await until(() => first.messages.some((m) => m.type === 'exit'));
    await open();
    expect((await api('GET', '/api/terminals')).body.terminals.map((t: TerminalInfo) => t.id)).not.toContain(terminals[0]!.id);

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
