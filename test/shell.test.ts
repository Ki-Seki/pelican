import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ShellResult } from '../src/shared/protocol';
import { config } from '../src/server/config';
import { BASH_CAVEAT, bashModeMessages, bashModeSettings, forClaude, MAX_OUTPUT, MAX_RUN_MS, startCommand } from '../src/server/shell';
import { refreshTranscriptIndex } from '../src/server/transcripts';

/** A command run to its end. */
const runCommand = (cwd: string, command: string, limitMs?: number) => startCommand(cwd, command, limitMs === undefined ? {} : { limitMs }).result;
/** The command and its output as one text, as Claude reads them. */
const bashModeText = (result: ShellResult) => bashModeMessages(result, true).map((message) => message.text).join('');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive(pid);
}

describe.skipIf(process.platform === 'win32')('a ! command', () => {
  it('returns when its shell is done, leaving what it started in the background running', async () => {
    const result = await runCommand(os.tmpdir(), 'sleep 30 & echo $!');
    const pid = Number(result.output.trim());
    try {
      expect(result.durationMs).toBeLessThan(2000);
      expect(result.code).toBe(0);
      expect(result.background).toBe(true);
      expect(alive(pid)).toBe(true);
      expect(bashModeText(result)).toContain('(still running in the background)');
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  });

  it('stops everything it started when it takes too long, not just its shell', async () => {
    const result = await runCommand(os.tmpdir(), 'sleep 30 & echo $!; wait', 700);
    const pid = Number(result.output.trim());
    expect(result.code).toBeNull();
    expect(result.background).toBeUndefined();
    expect(await gone(pid)).toBe(true);
    expect(result.endedBy).toBe('limit');
    expect(bashModeText(result)).toContain('(stopped after 1 second)');
  }, 15_000);

  it('says nothing more of a command that simply ends', async () => {
    const result = await runCommand(os.tmpdir(), 'echo done');
    expect(result).toMatchObject({ output: 'done\n', code: 0 });
    expect(result.background).toBeUndefined();
  });

  it('runs in the folder and keeps the output and exit code', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'pelican-command-'));
    try {
      // stdout and stderr together, as they came, as Claude Code's bash mode keeps them.
      const ok = await runCommand(folder, 'pwd && echo out && sleep 0.1 && echo err >&2');
      expect(ok.code).toBe(0);
      expect(ok.output).toMatch(new RegExp(`${path.basename(folder)}\\nout\\nerr\\n$`));
      const failed = await runCommand(folder, 'exit 3');
      expect(failed.code).toBe(3);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('a live ! command', () => {
  it('hands on its output as it comes, before it ends', async () => {
    const seen: Array<{ text: string; at: number }> = [];
    const run = startCommand(os.tmpdir(), 'echo first; sleep 1; echo second', { onOutput: (text) => seen.push({ text, at: Date.now() }) });
    const result = await run.result;
    const ended = Date.now();
    expect(seen.map((s) => s.text).join('')).toBe('first\nsecond\n');
    expect(ended - seen[0]!.at).toBeGreaterThan(500);
    expect(result).toMatchObject({ output: 'first\nsecond\n', code: 0 });
  });

  it('has no wall at two minutes, only a generous one', () => {
    expect(MAX_RUN_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('Stop ends it and everything it started, and the record says so', async () => {
    let pid = 0;
    const run = startCommand(os.tmpdir(), 'sleep 30 & echo $!; wait', { onOutput: (text) => { pid = Number(text.trim()) || pid; } });
    for (let i = 0; i < 40 && !pid; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(alive(pid)).toBe(true);
    run.stop();
    const result = await run.result;
    expect(result).toMatchObject({ code: null, endedBy: 'stop' });
    expect(result.background).toBeUndefined();
    expect(await gone(pid)).toBe(true);
    expect(bashModeText(result)).toContain('(stopped)');
  });

  it('ends what ignores the polite request too', async () => {
    let pid = 0;
    const run = startCommand(os.tmpdir(), "sh -c 'trap \"\" TERM; echo $$; sleep 30'", { onOutput: (text) => { pid = Number(text.trim()) || pid; } });
    for (let i = 0; i < 40 && !pid; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    run.stop();
    await run.result;
    for (let i = 0; i < 80 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(pid)).toBe(false);
  });
});

describe('the record of a ! command', () => {
  const result: ShellResult = { command: 'npm test -- --grep "<b>"', output: 'ok & done\n', code: 0, durationMs: 5 };
  const text = (extra: Partial<ShellResult>) => bashModeMessages({ ...result, ...extra }, true)[1]!.text;

  it('is the command, then its output, as Claude Code writes them', () => {
    expect(bashModeMessages(result, true)).toEqual([
      { text: '<bash-input>npm test -- --grep "<b>"</bash-input>' },
      { text: '<bash-stdout>ok &amp; done</bash-stdout><bash-stderr></bash-stderr>' },
    ]);
  });

  it('starts with Claude Code’s caveat when Claude is not to answer', () => {
    const [caveat, ...rest] = bashModeMessages(result, false);
    expect(caveat).toEqual({ text: BASH_CAVEAT, meta: true });
    expect(rest).toHaveLength(2);
  });

  it('is the command as typed, then the output escaped so it cannot break the tags', () => {
    expect(bashModeText({ command: 'echo "<b>"', output: '</bash-stdout> & more', code: 0, durationMs: 5 }))
      .toBe('<bash-input>echo "<b>"</bash-input><bash-stdout>&lt;/bash-stdout&gt; &amp; more</bash-stdout><bash-stderr></bash-stderr>');
  });

  // What follows is the bundled Claude Code's own bash mode, as it wrote these outputs (2.1.318).
  it('trims a command that went well as Claude Code does, and says so when it printed nothing', () => {
    expect(text({ output: '\n\n  a  \n\n' })).toBe('<bash-stdout>  a</bash-stdout><bash-stderr></bash-stderr>');
    expect(text({ output: '' })).toBe('<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>');
  });

  it('puts a failed command’s output under stderr as it came, cut where Claude Code cuts it', () => {
    expect(text({ output: 'out\nerr\n', code: 1 })).toBe('<bash-stdout></bash-stdout><bash-stderr>out\nerr\n\n(exit code 1)</bash-stderr>');
    const long = `${'a'.repeat(20_000)}${'b'.repeat(20_000)}\n`;
    expect(text({ output: long, code: 3 })).toBe(`<bash-stdout></bash-stdout><bash-stderr>${'a'.repeat(20_000)}${'b'.repeat(10_000)}\n(exit code 3)\n(the rest of the output was left out)</bash-stderr>`);
    expect(text({ output: long, code: 3, inlineMax: 5000 })).toMatch(/^<bash-stdout><\/bash-stdout><bash-stderr>a{5000}\n\(exit code 3\)/);
  });

  it('gives Claude the start of a long output and where all of it was saved, in Claude Code’s words', () => {
    const file = '/home/me/.claude/projects/-work/5e25f65d-1b8b-4490-a3d3-43540da07ef3/tool-results/b1b2gp6fw.txt';
    expect(text({ output: `${'z'.repeat(30_000)}\n`, savedTo: file })).toBe(
      `<bash-stdout><persisted-output>\nOutput too large (29.3KB). Full output saved to: ${file}\n\nPreview (first 2KB):\n${'z'.repeat(2000)}\n...\n</persisted-output></bash-stdout><bash-stderr></bash-stderr>`,
    );
    // The start ends with a line when one ends past halfway, and is not escaped, as in Claude Code.
    const lines = `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')}\n`;
    expect(text({ output: lines, savedTo: file })).toMatch(/\n\nPreview \(first 2KB\):\nline 0\nline 1\n[\s\S]*\nline 233\n\.\.\.\n<\/persisted-output><\/bash-stdout>/);
    expect(text({ output: `${'<&>'.repeat(12_000)}\n`, savedTo: file })).toContain(`Preview (first 2KB):\n${'<&>'.repeat(666)}<&\n...\n`);
    // Past what Pelican keeps, only its first part was saved, as Claude Code says when it cuts one.
    expect(text({ output: 'x'.repeat(MAX_OUTPUT), truncated: true, savedTo: file })).toContain(
      `<persisted-output>\nOutput exceeded the 195.3KB persist limit; only the first 195.3KB were saved to: ${file}\n\nPreview (first 2KB):\n`,
    );
  });

  it('says how it ended when the output does not', () => {
    expect(text({ code: 2 })).toContain('(exit code 2)');
    expect(text({ code: null, endedBy: 'limit', limitMs: 30 * 60_000 })).toContain('(stopped after 30 minutes)');
    expect(text({ background: true })).toContain('(still running in the background)');
    expect(text({ truncated: true })).toContain('(the rest of the output was left out)');
  });
});

describe('a long ! output, as it goes to Claude', () => {
  const session = '5e25f65d-1b8b-4490-a3d3-43540da07ef3';
  const project = () => path.join(config.claudeHome, 'projects', '-work');
  beforeAll(async () => {
    await mkdir(project(), { recursive: true });
    await writeFile(path.join(project(), `${session}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'p1', sessionId: session, message: { role: 'user', content: 'hi' } })}\n`);
    await refreshTranscriptIndex();
  });

  it('is saved whole where Claude Code saves one, beside the session’s transcript, readable only by you', async () => {
    const output = `${'z'.repeat(30_000)}\n`;
    const result = await forClaude(session, { command: 'cat big.log', output, code: 0, durationMs: 5 }, 30_000);
    expect(result.savedTo).toMatch(new RegExp(`^${project()}/${session}/tool-results/b[0-9a-z]{8}\\.txt$`));
    expect(await readFile(result.savedTo!, 'utf8')).toBe(output);
    expect((await stat(result.savedTo!)).mode & 0o777).toBe(0o600);
    expect(bashModeMessages(result, true)[1]!.text).toContain(`Full output saved to: ${result.savedTo}\n`);
  });

  it('goes inline up to the limit, and when the command failed, as in Claude Code', async () => {
    const inline = await forClaude(session, { command: 'cat log', output: `${'y'.repeat(29_999)}\n`, code: 0, durationMs: 5 }, 30_000);
    expect(inline.savedTo).toBeUndefined();
    expect(bashModeMessages(inline, true)[1]!.text).toBe(`<bash-stdout>${'y'.repeat(29_999)}</bash-stdout><bash-stderr></bash-stderr>`);
    const failed = await forClaude(session, { command: 'npm test', output: 'x'.repeat(40_000), code: 1, durationMs: 5 }, 30_000);
    expect(failed.savedTo).toBeUndefined();
  });

  it('goes inline, cut and said to be, where it cannot be saved', async () => {
    const result = await forClaude('not-a-session', { command: 'cat big.log', output: 'z'.repeat(40_000), code: 0, durationMs: 5 }, 30_000);
    expect(result.savedTo).toBeUndefined();
    expect(bashModeMessages(result, true)[1]!.text).toBe(`<bash-stdout>${'z'.repeat(30_000)}</bash-stdout><bash-stderr>\n(the rest of the output was left out)</bash-stderr>`);
  });
});

describe('how Claude Code’s bash mode takes a ! command, from the settings', () => {
  let project: string;
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
  const set = async (value: Record<string, unknown>) => {
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify(value));
  };
  beforeAll(async () => {
    project = await mkdtemp(path.join(os.tmpdir(), 'pelican-respond-'));
  });
  afterEach(() => rm(settings, { force: true }));
  afterAll(() => rm(project, { recursive: true, force: true }));

  it('Claude answers unless the settings say respondToBashCommands: false, as in the CLI', async () => {
    expect(await bashModeSettings(project)).toEqual({ respond: true, inlineMax: 30_000 });
    await set({ respondToBashCommands: false });
    expect((await bashModeSettings(project)).respond).toBe(false);
  });

  it('reads the folder’s own settings too', async () => {
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify({ respondToBashCommands: false }));
    try {
      expect((await bashModeSettings(project)).respond).toBe(false);
    } finally {
      await rm(path.join(project, '.claude'), { recursive: true, force: true });
    }
  });

  it('gives Claude as much inline as bashOutputMaxChars says, held to Claude Code’s 4,000 to 128,000', async () => {
    for (const [value, inline] of [[5000, 5000], [1000, 4000], [200_000, 128_000], [-1, 30_000], ['lots', 30_000]] as const) {
      await set({ bashOutputMaxChars: value });
      expect((await bashModeSettings(project)).inlineMax).toBe(inline);
    }
  });
});
