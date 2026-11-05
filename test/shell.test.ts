import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { BASH_CAVEAT, bashModeMessages, bashModeSettings, CommandOutput, type ForClaude, forClaude, MAX_RUN_MS, SAVED_BYTES, type ShellResult, startCommand } from '../src/server/shell';
import { refreshTranscriptIndex } from '../src/server/transcripts';

/** A command run to its end. */
const runCommand = (cwd: string, command: string, limitMs?: number) => startCommand(cwd, command, limitMs === undefined ? {} : { limitMs }).result;
/** The command and its output as one text, as Claude reads them. */
const bashModeText = (result: ForClaude) => bashModeMessages(result, true).map((message) => message.text).join('');
/** What a command printed, kept as a command's output is. */
const printed = (text: string) => {
  const output = new CommandOutput();
  output.add(Buffer.from(text));
  return output;
};
/** All of it, as text. */
const all = (output: CommandOutput) => output.text(Infinity);

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
  it('returns when its shell is done, leaving what it started in the background running, and says only what Claude Code says', async () => {
    const result = await runCommand(os.tmpdir(), 'sleep 30 & echo $!');
    const pid = Number(all(result.output).trim());
    try {
      expect(result.durationMs).toBeLessThan(2000);
      expect(result.code).toBe(0);
      expect(alive(pid)).toBe(true);
      expect(bashModeText(result)).toBe(`<bash-input>sleep 30 & echo $!</bash-input><bash-stdout>${pid}</bash-stdout><bash-stderr></bash-stderr>`);
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  });

  it('stops everything it started when it takes too long, not just its shell', async () => {
    const result = await runCommand(os.tmpdir(), 'sleep 30 & echo $!; wait', 700);
    const pid = Number(all(result.output).trim());
    expect(result.code).toBeNull();
    expect(await gone(pid)).toBe(true);
    expect(result.endedBy).toBe('limit');
    expect(bashModeText(result)).toContain('(stopped after 1 second)');
  }, 15_000);

  it('says nothing more of a command that simply ends', async () => {
    const result = await runCommand(os.tmpdir(), 'echo done');
    expect(all(result.output)).toBe('done\n');
    expect(result).toMatchObject({ code: 0 });
    expect(result.endedBy).toBeUndefined();
  });

  it('runs in the folder and keeps the output and exit code', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'pelican-command-'));
    try {
      const ok = await runCommand(folder, 'pwd && echo out && sleep 0.1 && echo err >&2');
      expect(ok.code).toBe(0);
      expect(all(ok.output)).toMatch(new RegExp(`${path.basename(folder)}\\nout\\nerr\\n$`));
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
    expect(all(result.output)).toBe('first\nsecond\n');
    expect(result.code).toBe(0);
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

describe('a ! command’s output', () => {
  it('keeps stdout and stderr in the order the command wrote them, as Claude Code’s one file for both does', async () => {
    for (let i = 0; i < 5; i += 1) {
      const result = await runCommand(os.tmpdir(), 'for i in 1 2 3; do echo o$i; echo e$i >&2; done');
      expect(all(result.output)).toBe('o1\ne1\no2\ne2\no3\ne3\n');
    }
  });

  it('is counted in bytes, and read back with a character cut in two at the end as U+FFFD, as Claude Code reads it', () => {
    const output = printed(`x${'é'.repeat(20)}`);
    expect(output.bytes).toBe(41);
    expect(output.text(4)).toBe('xé�');
    expect(output.text(5)).toBe('xéé');
  });
});

describe('the record of a ! command', () => {
  const result: ShellResult = { command: 'npm test -- --grep "<b>"', output: printed('ok & done\n'), code: 0, durationMs: 5 };
  const text = (extra: Partial<ForClaude> & { printed?: string }) => {
    const { printed: out, ...rest } = extra;
    return bashModeMessages({ ...result, ...(out === undefined ? {} : { output: printed(out) }), ...rest }, true)[1]!.text;
  };

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
    expect(bashModeText({ command: 'echo "<b>"', output: printed('</bash-stdout> & more'), code: 0, durationMs: 5 }))
      .toBe('<bash-input>echo "<b>"</bash-input><bash-stdout>&lt;/bash-stdout&gt; &amp; more</bash-stdout><bash-stderr></bash-stderr>');
  });

  // What follows is the bundled Claude Code's own bash mode, as it wrote these outputs (2.1.318).
  it('trims a command that went well as Claude Code does, and says so when it printed nothing', () => {
    expect(text({ printed: '\n\n  a  \n\n' })).toBe('<bash-stdout>  a</bash-stdout><bash-stderr></bash-stderr>');
    expect(text({ printed: '' })).toBe('<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>');
    // A program's hint for Claude Code, on a line of its own, is not for Claude to read.
    expect(text({ printed: 'built\n<claude-code-hint v=1 type=plugin value="lint@acme" />\n\n\nok\n' })).toBe('<bash-stdout>built\n\nok</bash-stdout><bash-stderr></bash-stderr>');
  });

  it('puts a failed command’s output under stderr as it came, cut where Claude Code cuts it, in bytes, with nothing added', () => {
    expect(text({ printed: 'out\nerr\n', code: 1 })).toBe('<bash-stdout></bash-stdout><bash-stderr>out\nerr\n</bash-stderr>');
    const long = `${'a'.repeat(20_000)}${'b'.repeat(20_000)}\n`;
    expect(text({ printed: long, code: 3 })).toBe(`<bash-stdout></bash-stdout><bash-stderr>${'a'.repeat(20_000)}${'b'.repeat(10_000)}</bash-stderr>`);
    expect(text({ printed: long, code: 3, readMax: 5000, inlineMax: 5000 })).toBe(`<bash-stdout></bash-stdout><bash-stderr>${'a'.repeat(5000)}</bash-stderr>`);
    // Two bytes each: 15,000 of them fill 30,000 bytes.
    expect(text({ printed: `${'é'.repeat(20_000)}\n`, code: 1 })).toBe(`<bash-stdout></bash-stdout><bash-stderr>${'é'.repeat(15_000)}</bash-stderr>`);
  });

  it('takes exit code 1 from grep, diff, test, find, git diff and git grep as an answer, as Claude Code does', () => {
    for (const command of ['grep -r TODO src', 'cd app && rg TODO', 'diff a.txt b.txt', '[ -f x ]', 'test -d build', 'git -C app diff --exit-code', 'git grep -n TODO 2>&1']) {
      expect(text({ command, printed: '', code: 1 })).toBe('<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>');
      expect(text({ command, printed: 'grep: x: No such file\n', code: 2 })).toBe('<bash-stdout></bash-stdout><bash-stderr>grep: x: No such file\n</bash-stderr>');
    }
    for (const command of ['grep TODO src | wc -l', 'npm test', 'git status', 'echo "grep"; false']) {
      expect(text({ command, printed: 'x\n', code: 1 })).toBe('<bash-stdout></bash-stdout><bash-stderr>x\n</bash-stderr>');
    }
  });

  it('reads exit code 1 by the last statement of the line, as Claude Code’s parse takes it apart: a subshell or a group is one, a comment none', () => {
    const answer = '<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>';
    const failure = '<bash-stdout></bash-stdout><bash-stderr></bash-stderr>';
    // The CLI's own rows for these, from its bash mode in a terminal: its statement is `(grep`, `(cd` or `{`.
    for (const command of ['(grep nothing /dev/null)', '(cd . && grep nothing /dev/null)', '{ grep nothing /dev/null; }']) {
      expect(text({ command, printed: '', code: 1 })).toBe(failure);
    }
    expect(text({ command: 'echo a && (grep nothing /dev/null)', printed: 'a\n', code: 1 })).toBe('<bash-stdout></bash-stdout><bash-stderr>a\n</bash-stderr>');
    for (const command of ['grep nothing /dev/null # a;b', 'grep nothing /dev/null # trailing comment', 'echo x | grep nothing', 'grep "a;b" /dev/null']) {
      expect(text({ command, printed: '', code: 1 })).toBe(answer);
    }
    // As its parser takes these apart: quotes, substitutions, here-documents and [[ … ]] hold no
    // statement's end; a here-document's line after its << is part of the statement before it.
    for (const command of ['echo $(a; b) `c; d` ${x:-e;f} && grep x f', "grep x <<'EOF'\nbody; x)\nEOF", 'grep x <<<"a;b"', '[[ -n $a && $b ]] || grep x f', 'grep x f # (a | b) ; c']) {
      expect(text({ command, printed: '', code: 1 })).toBe(answer);
    }
    for (const command of ['x=$(grep a b)', 'cat <<EOF | grep x\nbody\nEOF', '! grep x f', '[[ -f x ]]', 'grep x f && echo done']) {
      expect(text({ command, printed: '', code: 1 })).toBe(failure);
    }
    // After a redirection, its parser takes a comment for more words, and its `;` ends the statement.
    expect(text({ command: 'grep x 2>/dev/null # note; more', printed: '', code: 1 })).toBe(failure);
    expect(text({ command: 'grep x 2>/dev/null # note', printed: '', code: 1 })).toBe(answer);
  });

  it('gives Claude the start of a long output and where all of it was saved, in Claude Code’s words', () => {
    const file = '/home/me/.claude/projects/-work/5e25f65d-1b8b-4490-a3d3-43540da07ef3/tool-results/b1b2gp6fw.txt';
    expect(text({ printed: `${'z'.repeat(30_000)}\n`, savedTo: file })).toBe(
      `<bash-stdout><persisted-output>\nOutput too large (29.3KB). Full output saved to: ${file}\n\nPreview (first 2KB):\n${'z'.repeat(2000)}\n...\n</persisted-output></bash-stdout><bash-stderr></bash-stderr>`,
    );
    // The start ends with a line when one ends past halfway, and is not escaped, as in Claude Code.
    const lines = `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')}\n`;
    expect(text({ printed: lines, savedTo: file })).toMatch(/\n\nPreview \(first 2KB\):\nline 0\nline 1\n[\s\S]*\nline 233\n\.\.\.\n<\/persisted-output><\/bash-stdout>/);
    expect(text({ printed: `${'<&>'.repeat(12_000)}\n`, savedTo: file })).toContain(`Preview (first 2KB):\n${'<&>'.repeat(666)}<&\n...\n`);
    // Its size in bytes, and the start trimmed as Claude would have had it inline: an npm script's
    // output begins with a blank line.
    const npm = `\n> app@1.0.0 test\n> vitest\n\n${'é'.repeat(20_000)}\n`;
    expect(text({ printed: npm, savedTo: file })).toContain(`Output too large (39.1KB). Full output saved to: ${file}\n\nPreview (first 2KB):\n> app@1.0.0 test\n> vitest\n\n${'é'.repeat(100)}`);
  });

  it('says, past the 64MB Claude Code saves of one, that only the first 64MB were saved', () => {
    const file = '/home/me/.claude/projects/-work/5e25f65d-1b8b-4490-a3d3-43540da07ef3/tool-results/b1b2gp6fw.txt';
    const output = printed('x'.repeat(40_000));
    output.bytes = SAVED_BYTES;
    expect(bashModeMessages({ ...result, output, savedTo: file }, true)[1]!.text).toContain(
      `<persisted-output>\nOutput exceeded the 64MB persist limit; only the first 64MB were saved to: ${file}\n\nPreview (first 2KB):\n`,
    );
  });

  it('says how it ended when Pelican ended it, which Claude Code has no record for, and adds nothing else', () => {
    expect(text({ code: null, endedBy: 'stop', printed: 'started\n' })).toBe('<bash-stdout></bash-stdout><bash-stderr>started\n\n(stopped)</bash-stderr>');
    expect(text({ code: null, endedBy: 'limit', limitMs: 30 * 60_000 })).toContain('(stopped after 30 minutes)');
    expect(text({ code: 2, printed: '' })).toBe('<bash-stdout></bash-stdout><bash-stderr></bash-stderr>');
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
    const result = await forClaude(session, { command: 'cat big.log', output: printed(output), code: 0, durationMs: 5 });
    expect(result.savedTo).toMatch(new RegExp(`^${project()}/${session}/tool-results/b[0-9a-z]{8}\\.txt$`));
    expect(await readFile(result.savedTo!, 'utf8')).toBe(output);
    expect((await stat(result.savedTo!)).mode & 0o777).toBe(0o600);
    expect(bashModeMessages(result, true)[1]!.text).toContain(`Full output saved to: ${result.savedTo}\n`);
  });

  it('goes inline up to the limit in bytes, and when the command failed, as in Claude Code', async () => {
    const inline = await forClaude(session, { command: 'cat log', output: printed(`${'y'.repeat(29_999)}\n`), code: 0, durationMs: 5 });
    expect(inline.savedTo).toBeUndefined();
    expect(bashModeMessages(inline, true)[1]!.text).toBe(`<bash-stdout>${'y'.repeat(29_999)}</bash-stdout><bash-stderr></bash-stderr>`);
    // 15,000 two-byte characters and a newline: 30,001 bytes, one past the limit.
    const wide = await forClaude(session, { command: 'cat log', output: printed(`${'é'.repeat(15_000)}\n`), code: 0, durationMs: 5 });
    expect(wide.savedTo).toBeDefined();
    const failed = await forClaude(session, { command: 'npm test', output: printed('x'.repeat(40_000)), code: 1, durationMs: 5 });
    expect(failed.savedTo).toBeUndefined();
  });

  it('goes inline, cut where Claude gets no more, where it cannot be saved, as from Claude Code when its copy fails', async () => {
    const result = await forClaude('not-a-session', { command: 'cat big.log', output: printed('z'.repeat(40_000)), code: 0, durationMs: 5 });
    expect(result.savedTo).toBeUndefined();
    expect(bashModeMessages(result, true)[1]!.text).toBe(`<bash-stdout>${'z'.repeat(30_000)}</bash-stdout><bash-stderr></bash-stderr>`);
  });

  it.skipIf(process.platform === 'win32')('is saved whole past what Pelican holds, written as it came, up to the 64MB Claude Code saves', async () => {
    // 300,000 bytes: more than the pages keep, and more than Claude ever gets inline.
    const middle = await runCommand(os.tmpdir(), `'${process.execPath}' -e 'process.stdout.write("é".repeat(150000))'`);
    const saved = await forClaude(session, middle);
    middle.output.release();
    expect(await readFile(saved.savedTo!, 'utf8')).toBe('é'.repeat(150_000));
    expect(bashModeMessages(saved, true)[1]!.text).toContain('Output too large (293KB). Full output saved to:');

    const before = process.memoryUsage().rss;
    const huge = await runCommand(os.tmpdir(), `head -c ${SAVED_BYTES + 5_000_000} /dev/zero | tr '\\0' x`);
    expect(huge.output.bytes).toBe(SAVED_BYTES + 5_000_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(100e6);
    const cut = await forClaude(session, huge);
    huge.output.release();
    expect((await stat(cut.savedTo!)).size).toBe(SAVED_BYTES);
    expect(bashModeMessages(cut, true)[1]!.text).toContain(`Output exceeded the 64MB persist limit; only the first 64MB were saved to: ${cut.savedTo}\n`);
  }, 30_000);
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
    expect(await bashModeSettings(project)).toEqual({ respond: true, readMax: 30_000, inlineMax: 30_000 });
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
      expect(await bashModeSettings(project)).toMatchObject({ readMax: inline, inlineMax: inline });
    }
  });

  describe('BASH_MAX_OUTPUT_LENGTH', () => {
    const before = process.env.BASH_MAX_OUTPUT_LENGTH;
    afterEach(() => {
      if (before === undefined) delete process.env.BASH_MAX_OUTPUT_LENGTH;
      else process.env.BASH_MAX_OUTPUT_LENGTH = before;
    });

    it('sets how much Claude Code reads back where bashOutputMaxChars is unset, from 1 to 150,000, read as Claude Code reads a number', async () => {
      for (const [value, read] of [['5000', 5000], ['1000', 1000], [' 1.5e3 ', 1500], ['1,000', 1000], ['12abc', 12], ['200000', 150_000], ['abc', 30_000], ['0', 30_000], ['-5', 30_000], ['', 30_000]] as const) {
        process.env.BASH_MAX_OUTPUT_LENGTH = value;
        expect(await bashModeSettings(project)).toEqual({ respond: true, readMax: read, inlineMax: 30_000 });
      }
    });

    it('comes from the settings’ env over Pelican’s own, as Claude Code sets it, and gives way to bashOutputMaxChars', async () => {
      process.env.BASH_MAX_OUTPUT_LENGTH = '8000';
      await set({ env: { BASH_MAX_OUTPUT_LENGTH: '5000' } });
      expect(await bashModeSettings(project)).toMatchObject({ readMax: 5000, inlineMax: 30_000 });
      await set({ env: { BASH_MAX_OUTPUT_LENGTH: '5000' }, bashOutputMaxChars: 8000 });
      expect(await bashModeSettings(project)).toMatchObject({ readMax: 8000, inlineMax: 8000 });
    });
  });
});

describe('a ! output under BASH_MAX_OUTPUT_LENGTH, as Claude Code’s bash mode wrote these (2.1.318)', () => {
  const session = '6e25f65d-1b8b-4490-a3d3-43540da07ef4';
  const project = () => path.join(config.claudeHome, 'projects', '-work-limits');
  beforeAll(async () => {
    await mkdir(project(), { recursive: true });
    await writeFile(path.join(project(), `${session}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'p1', sessionId: session, message: { role: 'user', content: 'hi' } })}\n`);
    await refreshTranscriptIndex();
  });
  const ran = (printed: string, code = 0): ShellResult => ({ command: 'python3 report.py', output: (() => {
    const output = new CommandOutput();
    output.add(Buffer.from(printed));
    return output;
  })(), code, durationMs: 5 });
  const row = (result: ForClaude) => bashModeMessages(result, true)[1]!.text;

  it('at 5000: one past it is saved whole, its preview from what was read back, and a failed one is cut there', async () => {
    const limits = { readMax: 5000, inlineMax: 30_000 };
    expect(row(await forClaude(session, ran('x'.repeat(5000)), limits))).toBe(`<bash-stdout>${'x'.repeat(5000)}</bash-stdout><bash-stderr></bash-stderr>`);
    const saved = await forClaude(session, ran('x'.repeat(5001)), limits);
    expect(path.basename(saved.savedTo!)).toMatch(/^b[0-9a-z]{8}\.txt$/);
    expect(row(saved)).toBe(`<bash-stdout><persisted-output>\nOutput too large (4.9KB). Full output saved to: ${saved.savedTo}\n\nPreview (first 2KB):\n${'x'.repeat(2000)}\n...\n</persisted-output></bash-stdout><bash-stderr></bash-stderr>`);
    expect(row(await forClaude(session, ran('x'.repeat(6000), 1), limits))).toBe(`<bash-stdout></bash-stdout><bash-stderr>${'x'.repeat(5000)}</bash-stderr>`);
    // At 1000 the preview is the 1000 bytes read back, with nothing after it to say more.
    const small = await forClaude(session, ran('x'.repeat(1001)), { readMax: 1000, inlineMax: 30_000 });
    expect(row(small)).toContain(`Output too large (1001 bytes). Full output saved to: ${small.savedTo}\n\nPreview (first 2KB):\n${'x'.repeat(1000)}\n</persisted-output>`);
  });

  it('at 50,000: read back whole, it goes inline up to 30,000 characters, past that its text to a file under a call’s id; a failed one goes whole', async () => {
    const limits = { readMax: 50_000, inlineMax: 30_000 };
    // 40,000 bytes, 20,000 characters: inline.
    expect(row(await forClaude(session, ran('é'.repeat(20_000)), limits))).toBe(`<bash-stdout>${'é'.repeat(20_000)}</bash-stdout><bash-stderr></bash-stderr>`);
    const text = await forClaude(session, ran(`${'x'.repeat(35_000)}\n\n\n`), limits);
    expect(path.basename(text.savedTo!)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt$/);
    expect(await readFile(text.savedTo!, 'utf8')).toBe('x'.repeat(35_000));
    expect(row(text)).toContain(`<persisted-output>\nOutput too large (34.2KB). Full output saved to: ${text.savedTo}\n\nPreview (first 2KB):\n`);
    const whole = await forClaude(session, ran('x'.repeat(60_000)), limits);
    expect(path.basename(whole.savedTo!)).toMatch(/^b[0-9a-z]{8}\.txt$/);
    expect(row(await forClaude(session, ran('x'.repeat(40_000), 1), limits))).toBe(`<bash-stdout></bash-stdout><bash-stderr>${'x'.repeat(40_000)}</bash-stderr>`);
    // At its 150,000 at most, all of a failed one Claude Code reads is kept.
    expect(row(await forClaude(session, ran('x'.repeat(160_000), 1), { readMax: 150_000, inlineMax: 30_000 }))).toBe(`<bash-stdout></bash-stdout><bash-stderr>${'x'.repeat(150_000)}</bash-stderr>`);
  });
});
