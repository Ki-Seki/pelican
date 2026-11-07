// The other programs a repository's git config can name, past filters, diffs, pagers, credentials,
// signing and aliases (trust-git-programs.test.ts): editors, a merge driver, an ext:: remote and the
// setting that lets one run, a proxy for git://, a hook the config names, a command for an
// alternate's refs, add -p's diff filter, a trailer's command, a submodule's update command, the
// tools' programs (difftool, mergetool, the browser, help, git gui, send-email, imap-send,
// instaweb, git svn), and what git cannot be told to leave out: a remote's upload-pack and
// receive-pack, and a recent objects hook. Each is asked about when nobody trusted the folder, and
// under "Use my settings only" turned off, the user's own kept, or, where git cannot be told to,
// the folder does not start that way. Every program here only notes that it ran, in this test's
// folder; nothing goes to the network (ext:: runs a local command, git:// goes to a closed local
// port, a remote is a folder here).
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { folderBrings, forgetTrust, launchFor, NeedsTrust, rememberChoice } from '../src/server/trust';

let root: string;
let notes: string;
/** Whether this git runs a hook its config names (`hook.<name>.command`), as a recent one does: where it does not, what needs one is skipped. */
let configHooks = false;
const saved = { ...config };
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;

/** Git as a person or Claude runs it there: none of this computer's settings or editors, and those given. */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'VISUAL', 'EDITOR', 'GIT_PROXY_COMMAND']) delete env[name];
  return { ...env, ...extra };
}
const gitIn = (dir: string, args: string[], extra: Record<string, string> = {}, input = '') =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...args], { cwd: dir, env: gitEnv(extra), input, encoding: 'utf8', timeout: 20_000 });
const ran = async () => (await readFile(notes, 'utf8').catch(() => '')).split('\n').filter(Boolean);
/** A program that notes, under `name`, that it ran. */
const note = (name: string) => `${path.join(root, 'note.sh')} ${name}`;
/** The user's own editor: it notes that it ran, and writes a commit's message. */
const editor = () => path.join(root, 'editor.sh');

/** A repository as a tarball brings it: a commit, then `setup`, then `text` in its own config. */
async function repository(name: string, text: string, setup?: (dir: string) => Promise<unknown>): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  gitIn(dir, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', 'one']);
  await setup?.(dir);
  const own = path.join(dir, '.git', 'config');
  await writeFile(own, (await readFile(own, 'utf8')) + text);
  return dir;
}

/** A repository of its own next to `dir`, with a commit, for `dir` to fetch from. */
async function upstream(dir: string): Promise<string> {
  const other = `${dir}-upstream`;
  await mkdir(other, { recursive: true });
  gitIn(other, ['init', '-q', '-b', 'main']);
  gitIn(other, ['commit', '-q', '--allow-empty', '-m', 'upstream']);
  return other;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-git-beyond-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  Object.assign(config, { claudeHome: path.join(root, 'claude'), stateDir: path.join(root, 'state'), configDir: path.join(root, 'config') });
  notes = path.join(root, 'ran.txt');
  await writeFile(path.join(root, 'note.sh'), `#!/bin/sh\necho "$1" >> '${notes}'\n`);
  await writeFile(editor(), `#!/bin/sh\necho users-editor >> '${notes}'\ncase "$1" in *COMMIT_EDITMSG) echo from-users-editor > "$1";; esac\n`);
  // A proxy for git://, which git runs as it is, with the host and the port.
  await writeFile(path.join(root, 'proxy.sh'), `#!/bin/sh\necho git-proxy >> '${notes}'\nexit 1\n`);
  for (const file of ['note.sh', 'editor.sh', 'proxy.sh']) await chmod(path.join(root, file), 0o755);
  const probe = path.join(root, 'probe');
  await mkdir(probe);
  gitIn(probe, ['init', '-q', '-b', 'main']);
  gitIn(probe, ['-c', `hook.probe.command=${note('probe')}`, '-c', 'hook.probe.event=pre-commit', 'commit', '-q', '--allow-empty', '-m', 'probe']);
  configHooks = (await ran()).includes('probe');
});

beforeEach(async () => {
  forgetTrust();
  await rm(config.stateDir, { recursive: true, force: true });
  await rm(notes, { force: true });
  process.env.GIT_CONFIG_GLOBAL = os.devNull;
});

afterAll(async () => {
  Object.assign(config, saved);
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  await rm(root, { recursive: true, force: true });
});

/** The environment Claude Code, its git and a terminal get in the folder, kept to the user's settings only. */
async function userOnly(dir: string): Promise<Record<string, string>> {
  forgetTrust();
  await rememberChoice(dir, 'user-only');
  return (await launchFor(dir)).env ?? {};
}

type Case = {
  name: string;
  /** What the folder's own config holds, and what is done before it is written. */
  config: () => string;
  setup?: (dir: string) => Promise<unknown>;
  /** How the item the trust sheet lists starts. */
  item: () => string;
  /** A git command that would run it, with what else the environment holds. */
  run: (dir: string, env: Record<string, string>) => SpawnSyncReturns<string>;
  /** What ran with the user's settings only (nothing of the folder's, but the user's own), and what git did. */
  ran?: string[];
  check?: (result: SpawnSyncReturns<string>, dir: string) => void | Promise<void>;
  /** What it notes as it runs, where that is not its name. */
  notes?: string;
  /** Run only by a git that runs hooks its config names. */
  configHook?: true;
};

const cases: Case[] = [
  {
    name: 'core-editor',
    config: () => `[core]\n\teditor = ${note('core-editor')}\n`,
    item: () => `Git editor: ${note('core-editor')}`,
    run: (dir, env) => gitIn(dir, ['commit', '--allow-empty'], { ...env, VISUAL: editor() }),
    // The user's editor, as git finds one with none set (VISUAL here), writes the message.
    ran: ['users-editor'],
    check: (result, dir) => {
      expect(result.status).toBe(0);
      expect(gitIn(dir, ['log', '-1', '--format=%s']).stdout.trim()).toBe('from-users-editor');
    },
  },
  {
    name: 'sequence-editor',
    config: () => `[sequence]\n\teditor = ${note('sequence-editor')}\n`,
    setup: async (dir) => gitIn(dir, ['commit', '-q', '--allow-empty', '-m', 'two']),
    item: () => `Git sequence editor: ${note('sequence-editor')}`,
    run: (dir, env) => gitIn(dir, ['rebase', '-i', 'HEAD~1'], { ...env, VISUAL: editor() }),
    ran: ['users-editor'],
    check: (result) => expect(result.status).toBe(0),
  },
  {
    name: 'merge-driver',
    config: () => `[merge "evil"]\n\tdriver = ${note('merge-driver')}\n`,
    setup: async (dir) => {
      await writeFile(path.join(dir, '.gitattributes'), '*.txt merge=evil\n');
      gitIn(dir, ['add', '-A']);
      gitIn(dir, ['commit', '-q', '-m', 'attributes']);
      gitIn(dir, ['checkout', '-q', '-b', 'other']);
      await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
      gitIn(dir, ['commit', '-q', '-am', 'other']);
      gitIn(dir, ['checkout', '-q', 'main']);
      await writeFile(path.join(dir, 'a.txt'), 'zero\none\ntwo\nthree\n');
      gitIn(dir, ['commit', '-q', '-am', 'main']);
    },
    item: () => `Git merge driver evil: ${note('merge-driver')}`,
    run: (dir, env) => gitIn(dir, ['merge', '--no-edit', 'other'], env),
    // Merged as git merges text: both sides in.
    check: async (result, dir) => {
      expect(result.status).toBe(0);
      expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('zero\none\ntwo\nthree\nfour\n');
    },
  },
  {
    name: 'ext-remote',
    config: () => `[protocol "ext"]\n\tallow = always\n[remote "evil"]\n\turl = ext::${note('ext-remote')}\n\tfetch = +refs/heads/*:refs/remotes/evil/*\n`,
    item: () => `Git remote evil runs: ${note('ext-remote')}`,
    run: (dir, env) => gitIn(dir, ['fetch', 'evil'], env),
    check: (result) => expect(result.stderr).toMatch(/transport 'ext' not allowed/),
  },
  {
    name: 'ext-instead-of',
    config: () => `[protocol]\n\tallow = always\n[url "ext::${note('ext-instead-of')}"]\n\tinsteadOf = https://example.invalid/\n`,
    item: () => `Git URLs starting https://example.invalid/ run: ${note('ext-instead-of')}`,
    run: (dir, env) => gitIn(dir, ['ls-remote', 'https://example.invalid/'], env),
    check: (result) => expect(result.stderr).toMatch(/transport 'ext' not allowed/),
  },
  {
    name: 'git-proxy',
    config: () => `[core]\n\tgitProxy = ${path.join(root, 'proxy.sh')}\n`,
    item: () => `Git proxy for git://: ${path.join(root, 'proxy.sh')}`,
    notes: 'git-proxy',
    // A closed port on this computer: with no proxy, git cannot connect, and goes nowhere else.
    run: (dir, env) => gitIn(dir, ['ls-remote', 'git://127.0.0.1:1/x'], env),
    check: (result) => expect(result.stderr).toMatch(/unable to connect|Connection refused/i),
  },
  {
    name: 'config-hook',
    configHook: true,
    config: () => `[hook "evil"]\n\tcommand = ${note('config-hook')}\n\tevent = pre-commit\n`,
    item: () => `Git hook evil: ${note('config-hook')}`,
    run: (dir, env) => gitIn(dir, ['commit', '-q', '--allow-empty', '-m', 'hooked'], env),
    check: (result) => expect(result.status).toBe(0),
  },
  {
    name: 'alternate-refs',
    config: () => `[core]\n\talternateRefsCommand = ${note('alternate-refs')}\n`,
    setup: async (dir) => {
      // Objects borrowed from another repository, whose refs a fetch offers the remote as had.
      const lender = await upstream(`${dir}-lender`);
      await writeFile(path.join(dir, '.git', 'objects', 'info', 'alternates'), `${path.join(lender, '.git', 'objects')}\n`);
      gitIn(dir, ['remote', 'add', 'up', await upstream(dir)]);
    },
    item: () => `Git alternate refs command: ${note('alternate-refs')}`,
    run: (dir, env) => gitIn(dir, ['fetch', 'up'], env),
    check: (result) => expect(result.status).toBe(0),
  },
  {
    name: 'diff-filter',
    config: () => `[interactive]\n\tdiffFilter = ${note('diff-filter')}\n`,
    setup: async (dir) => writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nchanged\n'),
    item: () => `Git diff filter: ${note('diff-filter')}`,
    // In color, as in a terminal, where add -p pipes the diff it shows through the filter.
    run: (dir, env) => gitIn(dir, ['-c', 'color.ui=always', 'add', '-p'], env, 'q\n'),
    check: (result) => expect(result.stdout).toContain('changed'),
  },
  {
    name: 'trailer',
    config: () => `[trailer "sign"]\n\tcmd = ${note('trailer')}\n`,
    item: () => `Git trailer sign: ${note('trailer')}`,
    run: (dir, env) => gitIn(dir, ['interpret-trailers', '--trailer', 'sign=as-given'], env, 'subject\n\nbody\n'),
    // The trailer's value as it was given.
    check: (result) => expect(result.stdout).toContain('sign: as-given'),
  },
  {
    name: 'submodule-update',
    config: () => `[submodule "sub"]\n\tupdate = !${note('submodule-update')}\n`,
    setup: async (dir) => {
      // A submodule a commit behind the one its superproject names.
      const sub = await upstream(dir);
      gitIn(dir, ['submodule', 'add', '-q', sub, 'sub']);
      gitIn(dir, ['commit', '-q', '-m', 'sub']);
      gitIn(sub, ['commit', '-q', '--allow-empty', '-m', 'newer']);
      gitIn(path.join(dir, 'sub'), ['pull', '-q', 'origin', 'main']);
      gitIn(dir, ['commit', '-q', '-am', 'newer sub']);
      gitIn(path.join(dir, 'sub'), ['checkout', '-q', 'HEAD~1']);
    },
    item: () => `Git submodule sub update: !${note('submodule-update')}`,
    run: (dir, env) => gitIn(dir, ['submodule', 'update'], env),
    check: (result) => expect(result.stdout).toMatch(/checked out/),
  },
  {
    name: 'difftool',
    config: () => `[difftool "evil"]\n\tcmd = ${note('difftool')}\n`,
    setup: async (dir) => writeFile(path.join(dir, 'a.txt'), 'changed\n'),
    item: () => `Git diff tool evil: ${note('difftool')}`,
    run: (dir, env) => gitIn(dir, ['difftool', '-y', '-t', 'evil'], env),
  },
];

describe('git programs past the usual ones', () => {
  for (const c of cases) {
    it(`${c.name}: listed when the folder is asked about, run by git there otherwise, and none of the folder’s with the user’s settings only`, async (context) => {
      if (c.configHook && !configHooks) context.skip();
      // Two copies: git runs it in one as it is, and in the other with the user's settings only.
      const plain = await repository(`${c.name}-plain`, c.config(), c.setup);
      const dir = await repository(c.name, c.config(), c.setup);
      const brings = await folderBrings(dir);
      expect(brings.some((item) => item.startsWith(c.item())), JSON.stringify(brings)).toBe(true);
      await expect(launchFor(dir)).rejects.toBeInstanceOf(NeedsTrust);
      expect(await ran()).toEqual([]);
      // Git runs it otherwise: the setting is a real one.
      c.run(plain, {});
      expect(await ran()).toContain(c.notes ?? c.name);
      await rm(notes, { force: true });
      const result = c.run(dir, await userOnly(dir));
      expect(await ran(), `${result.stdout}\n${result.stderr}`).toEqual(c.ran ?? []);
      await c.check?.(result, dir);
    }, 60_000);
  }

  it('the tools’ programs, which git runs only when asked (mergetool, the browser, help, git gui, send-email, imap-send, instaweb, git svn), and the setting that lets ext:: run: listed, and none of the folder’s with the user’s settings only', async () => {
    const settings: Array<[string, string, string]> = [
      // [the setting as the config writes it, its value, what it is with the user's settings only]
      ['mergetool "evil".cmd', note('mergetool'), ''],
      ['mergetool "vimdiff".path', note('vimdiff'), ''],
      ['difftool "vimdiff".path', note('vimdiff'), ''],
      ['browser "evil".cmd', note('browser'), ''],
      ['browser "firefox".path', note('firefox'), ''],
      ['man "evil".cmd', note('man'), 'man'],
      ['man "man".path', note('man-path'), 'man'],
      ['guitool "evil".cmd', note('guitool'), ''],
      ['sendemail.toCmd', note('to-cmd'), ''],
      ['sendemail "work".ccCmd', note('cc-cmd'), ''],
      ['sendemail.smtpServer', path.join(root, 'note.sh'), ''],
      ['imap.tunnel', note('imap'), ''],
      ['instaweb.httpd', note('httpd'), ''],
      ['svn.authorsProg', path.join(root, 'note.sh'), ''],
      ['protocol.allow', 'always', ''],
    ];
    const text = settings.map(([name, value]) => {
      const [section, key] = [name.slice(0, name.lastIndexOf('.')), name.slice(name.lastIndexOf('.') + 1)];
      const [plain, sub] = section.split(' ');
      return `[${plain}${sub ? ` ${sub}` : ''}]\n\t${key} = ${value}\n`;
    }).join('');
    const dir = await repository('tools', text);
    const brings = await folderBrings(dir);
    expect(brings).toEqual(expect.arrayContaining([
      `Git merge tool evil: ${note('mergetool')}`,
      `Git merge tool vimdiff's program: ${note('vimdiff')}`,
      `Git diff tool vimdiff's program: ${note('vimdiff')}`,
      `Git browser evil: ${note('browser')}`,
      `Git browser firefox's program: ${note('firefox')}`,
      `Git help viewer evil: ${note('man')}`,
      `Git help viewer man's program: ${note('man-path')}`,
      `Git GUI tool evil: ${note('guitool')}`,
      `Git send-email tocmd: ${note('to-cmd')}`,
      `Git send-email cccmd: ${note('cc-cmd')}`,
      `Git send-email server: ${path.join(root, 'note.sh')}`,
      `Git IMAP tunnel: ${note('imap')}`,
      `Git instaweb server: ${note('httpd')}`,
      `Git svn authors program: ${path.join(root, 'note.sh')}`,
      'Git lets ext:: remotes run commands: protocol.allow = always',
    ]));
    const env = await userOnly(dir);
    const value = (name: string) => gitIn(dir, ['config', '--get', name], env).stdout.replace(/\n$/, '');
    for (const [name, , off] of settings) {
      if (name === 'protocol.allow') continue;
      expect(value(name.replace(/ "([^"]+)"/, '.$1')), name).toBe(off);
    }
    // git:// and the rest as the user has them; ext:: runs nothing.
    expect(value('protocol.ext.allow')).toBe('never');
  });

  it('a remote that is plain git, or a git:// proxy of none, is nothing to ask about', async () => {
    const dir = await repository('plain-remote', `[remote "up"]\n\turl = https://example.invalid/x\n\tuploadpack = git-upload-pack\n\treceivepack = git-receive-pack\n[core]\n\tgitProxy = none for example.invalid\n[protocol "ext"]\n\tallow = never\n`);
    expect(await folderBrings(dir)).toEqual([]);
  });
});

describe('what the folder’s config gives git that it cannot be told to leave out', () => {
  const kinds: Array<[string, (dir: string) => Promise<string>, string, string]> = [
    ['upload-pack', async (dir) => `[remote "up"]\n\turl = ${await upstream(dir)}\n\tuploadpack = ${note('upload-pack')}; git-upload-pack\n\tfetch = +refs/heads/*:refs/remotes/up/*\n`, 'Git upload-pack for remote up: ', 'remote.up.uploadpack'],
    ['receive-pack', async (dir) => `[remote "up"]\n\turl = ${await upstream(dir)}\n\treceivepack = ${note('receive-pack')}; git-receive-pack\n`, 'Git receive-pack for remote up: ', 'remote.up.receivepack'],
    ['recent-objects-hook', async () => `[gc]\n\trecentObjectsHook = ${note('recent-objects-hook')}\n`, 'Git recent objects hook: ', 'gc.recentobjectshook'],
  ];
  for (const [name, text, item, setting] of kinds) {
    it(`${name}: listed, and with the user’s settings only the folder does not start, saying why`, async () => {
      const dir = path.join(root, name);
      const made = await repository(name, await text(dir));
      expect((await folderBrings(made)).some((brought) => brought.startsWith(item))).toBe(true);
      await rememberChoice(made, 'user-only');
      await expect(launchFor(made)).rejects.toThrow(`Git cannot be told to leave out what this folder’s git config has it run (${setting}), so Claude Code cannot start in it with your settings only.`);
    });
  }

  it('upload-pack: git takes the folder’s, the first it reads, over one given after it', async () => {
    const dir = path.join(root, 'first-upload-pack');
    const made = await repository('first-upload-pack', `[remote "up"]\n\turl = ${await upstream(dir)}\n\tuploadpack = ${note('upload-pack')}; git-upload-pack\n\tfetch = +refs/heads/*:refs/remotes/up/*\n`);
    gitIn(made, ['fetch', 'up'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.up.uploadpack', GIT_CONFIG_VALUE_0: 'git-upload-pack' });
    expect(await ran()).toEqual(['upload-pack']);
  });
});

describe('the user’s own, by the same names', () => {
  it('stay theirs: their editor, their merge driver, and their hook, on their events alone', async () => {
    const global = path.join(root, 'gitconfig-own');
    await writeFile(global, `[core]\n\teditor = ${editor()}\n[merge "evil"]\n\tdriver = ${note('users-merge')}\n${configHooks ? `[hook "evil"]\n\tcommand = ${note('users-hook')}\n\tevent = pre-commit\n` : ''}`);
    const hook = configHooks ? ['users-hook'] : [];
    process.env.GIT_CONFIG_GLOBAL = global;
    const dir = await repository('own', `[core]\n\teditor = ${note('core-editor')}\n[merge "evil"]\n\tdriver = ${note('merge-driver')}\n[hook "evil"]\n\tcommand = ${note('config-hook')}\n\tevent = post-commit\n`, async (made) => {
      await writeFile(path.join(made, '.gitattributes'), '*.txt merge=evil\n');
      gitIn(made, ['add', '-A']);
      gitIn(made, ['commit', '-q', '-m', 'attributes']);
      gitIn(made, ['checkout', '-q', '-b', 'other']);
      await writeFile(path.join(made, 'a.txt'), 'one\ntwo\nthree\nfour\n');
      gitIn(made, ['commit', '-q', '-am', 'other']);
      gitIn(made, ['checkout', '-q', 'main']);
    });
    await rm(notes, { force: true });
    const env = { ...(await userOnly(dir)), GIT_CONFIG_GLOBAL: global };
    gitIn(dir, ['commit', '--allow-empty'], env);
    expect(await ran()).toEqual([...hook, 'users-editor']);
    await rm(notes, { force: true });
    await writeFile(path.join(dir, 'a.txt'), 'zero\none\ntwo\nthree\n');
    gitIn(dir, ['commit', '-q', '-am', 'main'], env);
    gitIn(dir, ['merge', '--no-edit', 'other'], env);
    // The commit's pre-commit hook, then the merge's driver (a merge commit runs pre-merge-commit).
    expect(await ran()).toEqual([...hook, 'users-merge']);
  });
});
