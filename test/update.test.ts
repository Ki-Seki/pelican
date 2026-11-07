// Updating Pelican from its Settings (src/server/update.ts), with a stand-in registry and a
// stand-in npm on this computer: nothing goes to the network, and nothing is installed but into
// folders of the tests' own. The registry hands out tarballs as npm's does; npm installs them
// into the prefix it is given, checking their integrity, and writes down how it was run.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { changesBetween, compareVersions, type InstallInfo, isNewerVersion, type UpdateInfo, type UpdateState } from '../src/shared/update';
import { accessToken } from '../src/server/auth';
import { config } from '../src/server/config';
import { LABEL } from '../src/server/service';
import { startServer } from '../src/server/server';
import { closeAllTerminals, testShell } from '../src/server/terminals';
import {
  fileInTar, integrityHolds, nodeSatisfies, npmBeside, npmSaid, type Ran, type RunningSources, servedBy, shellWord, type UpdateContext, updateInfo, updateTiming,
  useRunningSources, useUpdateContext,
} from '../src/server/update';

const CURRENT = pkg.version;
/** The next version, as the registry will name it newest. */
const NEXT = CURRENT.replace(/(\d+)$/, (patch) => String(Number(patch) + 1));

let dir: string;
let port: number;
let stop: () => Promise<void>;
const saved = { ...config };
const timing = { ...updateTiming };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A .tgz as npm pack writes one: ustar entries under package/. */
function tgz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0);
    header.write('0000755\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const integrity = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;

/** Pelican's script, standing in: `--version` says its version as Pelican's does, or fails (`broken`). */
const standInScript = (version: string, broken = false) => broken
  ? '#!/usr/bin/env node\nconsole.error("SyntaxError: Unexpected token");\nprocess.exit(1);\n'
  : `#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('${version} (Pelican) · Claude Code 2.1.0 · Agent SDK 0.3.318 · Node ' + process.version);\n`;

const CHANGELOG = (versions: string[]) => `# Changelog\n\n${versions.map((v) => `## ${v}\n\nWhat ${v} brings, in a paragraph.\n\n### Highlights\n\n- **One thing.** Of ${v}.\n`).join('\n')}`;

/** A release of the package, as npm pack makes it. */
const release = (version: string, { broken = false, changelog = true } = {}) => tgz({
  'package.json': JSON.stringify({ name: 'pelican-cc', version, bin: { pelican: 'dist/server/index.js', 'pelican-cc': 'dist/server/index.js' }, engines: { node: '>=22.12' } }),
  ...(changelog ? { 'CHANGELOG.md': CHANGELOG([version, CURRENT, '0.4.1']) } : {}),
  'dist/server/index.js': standInScript(version, broken),
});

/** The stand-in registry: what it hands out, how it answers, and every request it got. */
const registry = {
  server: undefined as http.Server | undefined,
  url: '',
  tarballs: new Map<string, Buffer>(),
  latest: NEXT,
  /** How the package's document is answered: as npm's registry does, or not. */
  answer: 'ok' as 'ok' | 'error' | 'garbage' | 'wrong-integrity',
  engines: undefined as string | undefined,
  requests: [] as string[],
};

function packument() {
  return {
    name: 'pelican-cc',
    'dist-tags': { latest: registry.latest },
    versions: Object.fromEntries([...registry.tarballs].map(([version, data]) => [version, {
      // As npm's registry has it from the package.json: what npm links in the prefix's bin.
      name: 'pelican-cc', version, bin: { pelican: 'dist/server/index.js', 'pelican-cc': 'dist/server/index.js' },
      ...(registry.engines ? { engines: { node: registry.engines } } : {}),
      dist: { tarball: `${registry.url}pelican-cc/-/pelican-cc-${version}.tgz`, integrity: registry.answer === 'wrong-integrity' ? integrity(Buffer.from('other')) : integrity(data) },
    }])),
  };
}

async function serveRegistry(): Promise<void> {
  registry.server = http.createServer((request, response) => {
    registry.requests.push(request.url ?? '');
    const tarball = /^\/pelican-cc\/-\/pelican-cc-(.+)\.tgz$/.exec(request.url ?? '');
    if (request.url === '/pelican-cc') {
      if (registry.answer === 'error') return void response.writeHead(500).end('Internal Server Error');
      if (registry.answer === 'garbage') return void response.writeHead(200, { 'content-type': 'application/json' }).end('{"dist-tags":');
      return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(packument()));
    }
    if (tarball && registry.tarballs.has(tarball[1]!)) return void response.writeHead(200).end(registry.tarballs.get(tarball[1]!));
    response.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => registry.server!.listen(0, '127.0.0.1', resolve));
  registry.url = `http://127.0.0.1:${(registry.server!.address() as AddressInfo).port}/`;
}

/**
 * npm, standing in: `prefix --global` and `config get registry` as the tests set them, and
 * `install --global --prefix … pelican-cc@x`, which fetches the version's tarball from the registry
 * given, checks its integrity, puts the package in the prefix and links its command there. It
 * writes down each way it was run. STANDIN_NPM_FAIL: an install into a folder under it fails;
 * STANDIN_NPM_BREAK, with STANDIN_NPM_BREAK_VERSION: one there of that version does not start.
 */
const STAND_IN_NPM = `
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const args = process.argv.slice(2);
appendFileSync(process.env.STANDIN_NPM_LOG, JSON.stringify(args) + '\\n');
const flag = (name) => args[args.indexOf(name) + 1];
if (args[0] === 'prefix' && args[1] === '--global') {
  console.log(process.env.STANDIN_NPM_GLOBAL);
} else if (args.join(' ') === 'config get registry --global') {
  console.log(process.env.STANDIN_NPM_REGISTRY);
} else if (args[0] === 'install' && args.includes('--global')) {
  const prefix = flag('--prefix');
  const spec = /^pelican-cc@(.+)$/.exec(args.at(-1));
  if (!spec) { console.error('npm error code EINVALIDSPEC'); process.exit(1); }
  if (process.env.STANDIN_NPM_FAIL && prefix.startsWith(process.env.STANDIN_NPM_FAIL)) {
    console.error('npm error code ENOTFOUND\\nnpm error network request to the registry failed');
    process.exit(1);
  }
  const document = await (await fetch(new URL('pelican-cc', flag('--registry')))).json();
  const dist = document.versions[spec[1]]?.dist;
  if (!dist) { console.error('npm error code ETARGET\\nnpm error notarget No matching version found for ' + args.at(-1)); process.exit(1); }
  const data = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer());
  if ('sha512-' + createHash('sha512').update(data).digest('base64') !== dist.integrity) { console.error('npm error code EINTEGRITY'); process.exit(1); }
  const folder = path.join(prefix, 'lib', 'node_modules', 'pelican-cc');
  rmSync(folder, { recursive: true, force: true });
  const tar = gunzipSync(data);
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\\0.*$/s, '').trim(), 8);
    const file = path.join(folder, name.replace(/^package\\//, ''));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, tar.subarray(at + 512, at + 512 + size), { mode: 0o755 });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  if (process.env.STANDIN_NPM_BREAK && prefix.startsWith(process.env.STANDIN_NPM_BREAK) && spec[1] === process.env.STANDIN_NPM_BREAK_VERSION) {
    writeFileSync(path.join(folder, 'dist', 'server', 'index.js'), 'process.exit(3);\\n');
  }
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  for (const name of ['pelican', 'pelican-cc']) {
    rmSync(path.join(prefix, 'bin', name), { force: true });
    symlinkSync('../lib/node_modules/pelican-cc/dist/server/index.js', path.join(prefix, 'bin', name));
  }
  console.log('added 1 package in 1s');
} else {
  console.error('npm error unknown command ' + args.join(' '));
  process.exit(1);
}
`;

let npmScript: string;
const npmLog = () => path.join(dir, 'npm.log');
/** How the stand-in npm was run, each time, since the last look. */
async function npmRuns(): Promise<string[][]> {
  const text = await readFile(npmLog(), 'utf8').catch(() => '');
  await writeFile(npmLog(), '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

/** Pelican installed at `folder` (its package folder) as version `version`. */
async function pelicanAt(folder: string, version = CURRENT): Promise<string> {
  await mkdir(path.join(folder, 'dist', 'server'), { recursive: true });
  await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'pelican-cc', version, bin: { pelican: 'dist/server/index.js' } }));
  await writeFile(path.join(folder, 'dist', 'server', 'index.js'), standInScript(version), { mode: 0o755 });
  return path.join(folder, 'dist', 'server', 'index.js');
}

/** A global install in `prefix`, as npm makes one: the package, and its command linked in bin. */
async function globalInstall(prefix: string): Promise<string> {
  await pelicanAt(path.join(prefix, 'lib', 'node_modules', 'pelican-cc'));
  await mkdir(path.join(prefix, 'bin'), { recursive: true });
  await rm(path.join(prefix, 'bin', 'pelican'), { force: true });
  await symlink('../lib/node_modules/pelican-cc/dist/server/index.js', path.join(prefix, 'bin', 'pelican'));
  return path.join(prefix, 'bin', 'pelican');
}

const installedVersion = async (prefix: string) => (JSON.parse(await readFile(path.join(prefix, 'lib', 'node_modules', 'pelican-cc', 'package.json'), 'utf8')) as { version: string }).version;

/** What the stand-in services and ps were asked, and what they answer. */
const services = {
  calls: [] as string[][],
  /** launchctl print / systemctl show say this Pelican is the service's process. */
  ours: true,
  /** Asked to restart, they answer with this code (and never stop the tests' process). */
  restartCode: 0,
  /** What ps lists: nothing, so Pelican kills nothing of the computer's. */
  ps: '',
};

/** Runs programs for real (node: npm and Pelican, standing in); launchctl, systemctl and ps stand in. */
const run: UpdateContext['run'] = (file, args, { timeout = 60_000, env, signal, cwd } = {}) => {
  if (file === 'launchctl' || file === 'systemctl' || file === 'ps') {
    services.calls.push([file, ...args]);
    const said = (stdout: string, code = 0): Ran => ({ code, stdout, stderr: code ? `${file}: failed` : '' });
    if (file === 'ps') return Promise.resolve(said(services.ps));
    if (args[0] === 'print') return Promise.resolve(said(services.ours ? `\tstate = running\n\tpid = 4242\n` : '\tpid = 1\n'));
    if (args.includes('show')) return Promise.resolve(said(`MainPID=${services.ours ? 4242 : 1}\n`));
    return Promise.resolve(said('', services.restartCode));
  }
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env: env ?? process.env, ...(signal ? { signal } : {}), ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
};

/** Each start in place, as the tests' stand-in for process.execve sees it (it throws: the tests' process goes on). */
let started: Array<{ file: string; args: string[] }> = [];

/** A context for a Pelican started from `script`, on this computer's Node, with the stand-ins. */
function context(script: string, more: Partial<UpdateContext> & { global?: string } = {}): UpdateContext {
  const { global, ...rest } = more;
  return {
    platform: process.platform === 'win32' ? 'linux' : process.platform,
    execPath: process.execPath,
    execArgv: [],
    script,
    args: ['--port', '7860'],
    env: {
      PATH: process.env.PATH, HOME: dir,
      STANDIN_NPM_LOG: npmLog(), STANDIN_NPM_GLOBAL: global ?? path.join(dir, 'global'), STANDIN_NPM_REGISTRY: registry.url,
    },
    home: path.join(dir, 'home'),
    uid: 501,
    pid: 4242,
    ipc: false,
    npm: { file: process.execPath, args: [npmScript] },
    run,
    // Nothing goes to the network: only the stand-in registry answers.
    fetch: (input, init) => (new URL(String(input instanceof Request ? input.url : input)).hostname === '127.0.0.1'
      ? fetch(input, init)
      : Promise.reject(new TypeError('fetch failed: the tests reach no network'))),
    execve: (file, args) => {
      started.push({ file, args });
      throw new Error('stand-in: the tests go on in this process');
    },
    now: Date.now,
    ...rest,
  };
}

const origin = () => `http://127.0.0.1:${port}`;
const signedIn = () => ({ origin: origin(), authorization: `Bearer ${accessToken()}` });

async function api(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin()}${pathname}`, {
    method,
    headers: { 'x-pelican': '1', 'content-type': 'application/json', ...signedIn(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

/** Until the update's state is `phase` (or none, for undefined). */
async function until(phase: UpdateState['phase'] | undefined, ms = 15_000): Promise<UpdateInfo> {
  for (const start = Date.now(); ;) {
    const info = (await api('GET', '/api/update')).body as UpdateInfo;
    if (info.state?.phase === phase) return info;
    if (Date.now() - start > ms) throw new Error(`the update never got to ${phase}: ${JSON.stringify(info.state)}`);
    await pause(30);
  }
}

/** Nothing runs: no Claude, no terminals, no `!` commands. */
const nothingRuns: RunningSources = { runs: () => [], terminals: async () => [], shells: () => [], title: async () => undefined };

let serving: { stops: number; agains: number };

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-update-test-')));
  await mkdir(path.join(dir, 'home'), { recursive: true });
  Object.assign(config, {
    host: '127.0.0.1', port: 0, auth: 'auto', demo: false,
    configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), claudeHome: path.join(dir, 'claude'),
  });
  Object.assign(testShell, { file: '/bin/bash', args: ['--noprofile', '--norc', '-i'] });
  npmScript = path.join(dir, 'npm-stand-in.mjs');
  await writeFile(npmScript, STAND_IN_NPM);
  await serveRegistry();
  const startedServer = await startServer();
  port = Number(new URL(startedServer.url).port);
  stop = startedServer.close;
});

beforeEach(async () => {
  registry.tarballs = new Map([[CURRENT, release(CURRENT)], [NEXT, release(NEXT)]]);
  registry.latest = NEXT;
  registry.answer = 'ok';
  registry.engines = undefined;
  registry.requests = [];
  Object.assign(services, { calls: [], ours: true, restartCode: 0, ps: '' });
  started = [];
  serving = { stops: 0, agains: 0 };
  // What the server does to start in place, standing in: nothing of the tests' server stops.
  servedBy({ stop: async () => void (serving.stops += 1), again: async () => void (serving.agains += 1) });
  Object.assign(updateTiming, { restartPauseMs: 0, serviceStopMs: 200, idleMs: 300, idleLookMs: 30, childrenMs: 100 });
  await rm(path.join(dir, 'state'), { recursive: true, force: true });
  await writeFile(npmLog(), '');
  useRunningSources(nothingRuns);
});

afterEach(() => {
  useUpdateContext();
  useRunningSources();
  Object.assign(updateTiming, timing);
  config.demo = false;
  closeAllTerminals();
});

afterAll(async () => {
  await stop();
  await new Promise((resolve) => registry.server?.close(resolve));
  Object.assign(config, saved);
  delete testShell.file;
  delete testShell.args;
  await chmod(path.join(dir, 'root-owned', 'lib', 'node_modules'), 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe('versions and what changed', () => {
  it('orders versions as semver does, prereleases before their release', () => {
    expect(compareVersions('0.5.1', '0.5.0')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-beta.9')).toBeGreaterThan(0);
    for (const bad of ['', 'latest', '1.0', '1.0.0.0', '01.0.0', 'v1.0.0', '1.0.0 --registry=x', '../1.0.0', 'file:x.tgz']) {
      expect(compareVersions(bad, '1.0.0'), bad).toBeUndefined();
      expect(isNewerVersion(bad, '0.0.1'), bad).toBe(false);
    }
  });

  it('takes the changelog’s sections after the running version up to the new one, newest first', () => {
    const changelog = CHANGELOG(['0.6.1', '0.6.0', '0.5.1', '0.5.0', '0.4.1']);
    const changes = changesBetween(changelog, '0.5.0', '0.6.0')!;
    expect(changes.split('\n').filter((line) => line.startsWith('## '))).toEqual(['## 0.6.0', '## 0.5.1']);
    expect(changes).toContain('What 0.6.0 brings');
    expect(changes).not.toContain('0.6.1 brings');
    expect(changesBetween(changelog, '0.5.0', '0.7.0')).toBeUndefined();
    expect(changesBetween('# Changelog\r\n\r\n## v1.0.0\r\n\r\nWindows lines.\r\n', '0.9.0', '1.0.0')).toBe('## v1.0.0\n\nWindows lines.');
  });

  it('reads a file out of a tarball, and checks a tarball against its integrity', () => {
    const data = release(NEXT);
    expect(integrityHolds(data, integrity(data))).toBe(true);
    expect(integrityHolds(data, `${integrity(Buffer.from('x'))} sha1-abc`)).toBe(false);
    expect(integrityHolds(data, 'sha1-abc')).toBe(false);
    const tar = gunzipSync(data);
    expect(fileInTar(tar, 'package/CHANGELOG.md')?.toString()).toContain(`## ${NEXT}`);
    expect(fileInTar(tar, 'package/missing.md')).toBeUndefined();
  });

  it('says in a line what npm said went wrong', () => {
    const refused = [
      'npm error code ECONNREFUSED', 'npm error syscall connect', 'npm error errno ECONNREFUSED',
      'npm error FetchError: request to http://127.0.0.1:48089/pelican-cc failed, reason: connect ECONNREFUSED 127.0.0.1:48089',
      'npm error     at ClientRequest.<anonymous> (/usr/local/lib/node_modules/npm/node_modules/minipass-fetch/lib/index.js:130:14) {',
      "npm error   code: 'ECONNREFUSED',", "npm error   type: 'system',", 'npm error }', 'npm error',
      "npm error If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'",
      'npm error A complete log of this run can be found in: /tmp/npm-cache/_logs/2026-11-07T07_49_26_284Z-debug-0.log',
    ].join('\n');
    expect(npmSaid({ code: 1, stdout: '', stderr: refused })).toBe('ECONNREFUSED: FetchError: request to http://127.0.0.1:48089/pelican-cc failed, reason: connect ECONNREFUSED 127.0.0.1:48089');
    const missing = 'npm error code ETARGET\nnpm error notarget No matching version found for pelican-cc@9.9.9.\nnpm error notarget In most cases you or one of your dependencies are requesting a package version that doesn’t exist.\n';
    expect(npmSaid({ code: 1, stdout: '', stderr: missing })).toBe('ETARGET: No matching version found for pelican-cc@9.9.9.');
    expect(npmSaid({ code: 1, stdout: '', stderr: 'npm error code EACCES\nnpm error syscall rename\nnpm error path /usr/local/lib/node_modules/pelican-cc\nnpm error errno -13\nnpm error Error: EACCES: permission denied, rename' }))
      .toBe('EACCES: Error: EACCES: permission denied, rename');
    // Not npm's words: the end of what was printed.
    expect(npmSaid({ code: 127, stdout: '', stderr: 'sh: npm: command not found' })).toBe('sh: npm: command not found');
  });

  it('knows which Node a version needs, and writes commands a shell takes as they are', () => {
    expect(nodeSatisfies('>=22.12', '22.12.0')).toBe(true);
    expect(nodeSatisfies('>=22.12', '22.11.9')).toBe(false);
    expect(nodeSatisfies('>=24', '22.20.0')).toBe(false);
    expect(nodeSatisfies('>=22.12', '24.1.0')).toBe(true);
    expect(nodeSatisfies('^22 || >=24', '20.0.0')).toBe(true);
    expect(nodeSatisfies(undefined, '1.0.0')).toBe(true);
    expect(shellWord('pelican-cc@0.5.1')).toBe('pelican-cc@0.5.1');
    expect(shellWord('~/.local')).toBe('~/.local');
    expect(shellWord('~')).toBe('~');
    expect(shellWord('/Users/a b/.local')).toBe("'/Users/a b/.local'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
    // The ~ stays outside the quotes, where the shell expands it.
    expect(shellWord('~/my projects/pelican')).toBe("~/'my projects/pelican'");
    expect(shellWord("~/it's")).toBe("~/'it'\\''s'");
    expect(shellWord('~user/x')).toBe("'~user/x'");
  });

  it('runs the npm of the Node running Pelican, not the first on PATH', async () => {
    const node = path.join(dir, 'node-install');
    await mkdir(path.join(node, 'bin'), { recursive: true });
    await mkdir(path.join(node, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
    await writeFile(path.join(node, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    expect(npmBeside(path.join(node, 'bin', 'node'))).toEqual({ file: path.join(node, 'bin', 'node'), args: [path.join(node, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] });
    expect(npmBeside(path.join(dir, 'nowhere', 'bin', 'node'))).toBeUndefined();
  });
});

/** Forgets what the last check found, here and in the state folder, as a Pelican never started before. */
async function forget(): Promise<void> {
  await rm(path.join(dir, 'state'), { recursive: true, force: true });
}

/** What Settings offers for a Pelican started from `script`. */
async function offered(script: string, more: Parameters<typeof context>[1] = {}): Promise<InstallInfo> {
  useUpdateContext(context(script, more));
  const info = await updateInfo(true);
  expect(info.latest).toBe(NEXT);
  return info.install!;
}

describe('how Pelican was installed, and what Settings offers', () => {
  it('updates itself where npm installed it into its global folder, which this account can write to', async () => {
    const prefix = path.join(dir, 'global');
    const install = await offered(await globalInstall(prefix), { global: prefix });
    expect(install).toEqual({ kind: 'npm', folder: path.join(prefix, 'lib', 'node_modules', 'pelican-cc'), prefix, self: true, restart: 'in-place' });
    expect(await npmRuns()).toEqual([['config', 'get', 'registry', '--global'], ['prefix', '--global']]);
  }, 30_000);

  it('shows the command, and why, where npm’s global folder is not this one: another tool’s, such as a script of your own', async () => {
    const prefix = path.join(dir, 'home', '.local');
    const install = await offered(await globalInstall(prefix), { global: path.join(dir, 'global') });
    expect(install).toMatchObject({ kind: 'managed', prefix, self: false, command: `npm install --global --prefix ~/.local pelican-cc@${NEXT}` });
    expect(install.why).toMatch(/installed in ~\/\.local, not in npm’s global folder \(.*global\)/);
    // Started through a link to its folder (as /tmp is one to /private/tmp on a Mac): named so.
    await rm(path.join(dir, 'linked'), { force: true });
    await symlink(path.join(dir, 'home'), path.join(dir, 'linked'));
    await forget();
    const linked = await offered(path.join(dir, 'linked', '.local', 'bin', 'pelican'), { global: path.join(dir, 'global') });
    expect(linked).toMatchObject({ prefix: path.join(dir, 'linked', '.local'), command: `npm install --global --prefix ${path.join(dir, 'linked', '.local')} pelican-cc@${NEXT}` });
  }, 30_000);

  it('shows the command with sudo where the global folder belongs to another account', async () => {
    if (process.getuid?.() === 0) return;
    const prefix = path.join(dir, 'root-owned');
    const script = await globalInstall(prefix);
    await chmod(path.join(prefix, 'lib', 'node_modules'), 0o555);
    try {
      const install = await offered(script, { global: prefix });
      expect(install).toMatchObject({ kind: 'npm-elsewhere-owned', self: false, command: `sudo npm install --global pelican-cc@${NEXT}` });
      expect(install.why).toMatch(/belongs to another account/);
    } finally {
      await chmod(path.join(prefix, 'lib', 'node_modules'), 0o755);
    }
  }, 30_000);

  it('says to start npx with the new version, which npx’s cache gets by itself', async () => {
    const script = await pelicanAt(path.join(dir, 'home', '.npm', '_npx', '6c0de8e1', 'node_modules', 'pelican-cc'));
    expect(await offered(script)).toMatchObject({ kind: 'npx', self: false, command: `npx pelican-cc@${NEXT} --port 7860` });
  }, 30_000);

  it('leaves a source checkout to you, also one linked with npm link', async () => {
    const checkout = path.join(dir, 'home', 'pelican');
    const script = await pelicanAt(checkout);
    await mkdir(path.join(checkout, '.git'), { recursive: true });
    const linked = path.join(dir, 'global', 'lib', 'node_modules', 'linked');
    await mkdir(path.dirname(linked), { recursive: true });
    await rm(linked, { force: true });
    await symlink(checkout, linked);
    for (const started of [script, path.join(linked, 'dist', 'server', 'index.js')]) {
      expect(await offered(started)).toMatchObject({ kind: 'source', self: false, folder: checkout, command: 'cd ~/pelican && git pull && npm ci && npm run build' });
    }
  }, 30_000);

  it('shows commands that work as shown for folders whose names have spaces, under the home folder too', async () => {
    const home = path.join(dir, 'home');
    /** What a shell makes of `words` (a command's start), run as the page shows it, with this home folder. */
    const shells = ['/bin/sh', '/bin/bash', '/bin/zsh'].filter((shell) => existsSync(shell));
    const said = (shell: string, words: string) => new Promise<string>((resolve) => {
      execFile(shell, ['-c', `${words} && pwd -P`], { env: { HOME: home, PATH: '/usr/bin:/bin' }, cwd: dir }, (error, stdout, stderr) => resolve(error ? `failed: ${stderr}` : stdout.trim()));
    });
    // A checkout in ~/my projects/pelican: its cd goes there.
    const checkout = path.join(home, 'my projects', 'pelican');
    const script = await pelicanAt(checkout);
    await mkdir(path.join(checkout, '.git'), { recursive: true });
    const source = await offered(script);
    expect(source.command).toBe("cd ~/'my projects/pelican' && git pull && npm ci && npm run build");
    for (const shell of shells) expect(await said(shell, source.command!.split(' && ')[0]!), shell).toBe(checkout);
    // A project's package, in ~/my app: the same.
    await forget();
    const project = await offered(await pelicanAt(path.join(home, 'my app', 'node_modules', 'pelican-cc')));
    expect(project.command).toBe(`cd ~/'my app' && npm install pelican-cc@${NEXT}`);
    for (const shell of shells) expect(await said(shell, project.command!.split(' && ')[0]!), shell).toBe(path.join(home, 'my app'));
    // Another prefix in ~/Library/Application Support: the shell names the folder whole.
    await forget();
    const prefix = path.join(home, 'Library', 'Application Support', 'tool');
    const other = await offered(await globalInstall(prefix), { global: path.join(dir, 'global') });
    expect(other.command).toBe(`npm install --global --prefix ~/'Library/Application Support/tool' pelican-cc@${NEXT}`);
    const word = /--prefix (.+) pelican-cc@/.exec(other.command!)![1]!;
    for (const shell of shells) expect(await said(shell, `cd ${word}`), shell).toBe(prefix);
  }, 30_000);

  it('says to start pnpm dlx and bunx with the new version, as npx, since each runs the copy in its cache', async () => {
    const cases: Array<[string, string, RegExp]> = [
      // pnpm 9 and later, then before: the cache's dlx folder, in pnpm's own layout.
      ['Library/Caches/pnpm/dlx/abc123/19a0c1e0d4b-1f2e/node_modules/.pnpm/pelican-cc@0.5.0/node_modules/pelican-cc', `pnpm dlx pelican-cc@${NEXT} --port 7860`, /pnpm dlx’s cache/],
      ['tmp/dlx-4242/node_modules/.pnpm/pelican-cc@0.5.0/node_modules/pelican-cc', `pnpm dlx pelican-cc@${NEXT} --port 7860`, /pnpm dlx’s cache/],
      ['tmp/bunx-501-pelican-cc@latest/node_modules/pelican-cc', `bunx pelican-cc@${NEXT} --port 7860`, /bunx’s cache/],
    ];
    for (const [where, command, why] of cases) {
      await forget();
      const install = await offered(await pelicanAt(path.join(dir, 'home', where)));
      expect(install, where).toMatchObject({ kind: 'npx', self: false, command });
      expect(install.why, where).toMatch(why);
    }
  }, 30_000);

  it('leaves a project’s package, Volta’s, pnpm’s, Yarn’s and Bun’s to them', async () => {
    const cases: Array<[string, RegExp, string]> = [
      ['project/node_modules/pelican-cc', /package of ~\/project/, `cd ~/project && npm install pelican-cc@${NEXT}`],
      ['.volta/tools/image/packages/pelican-cc/lib/node_modules/pelican-cc', /Volta/, `volta install pelican-cc@${NEXT}`],
      ['Library/pnpm/global/5/node_modules/pelican-cc', /pnpm/, `pnpm add --global pelican-cc@${NEXT}`],
      ['.config/yarn/global/node_modules/pelican-cc', /Yarn/, `yarn global add pelican-cc@${NEXT}`],
      ['.bun/install/global/node_modules/pelican-cc', /Bun/, `bun add --global pelican-cc@${NEXT}`],
    ];
    for (const [where, why, command] of cases) {
      const install = await offered(await pelicanAt(path.join(dir, 'home', where)));
      expect(install, where).toMatchObject({ kind: 'managed', self: false, command });
      expect(install.why, where).toMatch(why);
    }
  }, 30_000);

  it('cannot update itself without npm beside its Node, nor when it cannot find itself', async () => {
    const prefix = path.join(dir, 'global');
    const script = await globalInstall(prefix);
    // Without npm, the registry its setting in the environment names.
    const withRegistry = { ...context(script).env, npm_config_registry: registry.url };
    const install = await offered(script, { npm: undefined, env: withRegistry });
    expect(install).toMatchObject({ kind: 'managed', self: false, command: `npm install --global --prefix ${prefix} pelican-cc@${NEXT}` });
    expect(install.why).toMatch(/npm is not beside the Node that runs Pelican/);
    await forget();
    expect(await offered(path.join(dir, 'gone', 'index.js'), { npm: undefined, env: withRegistry })).toMatchObject({ kind: 'unknown', self: false, command: `npm install --global pelican-cc@${NEXT}` });
    // Without npm or its setting, the registry is npm's own, out of the tests' reach: nothing is said.
    await forget();
    useUpdateContext(context(script, { npm: undefined }));
    expect((await updateInfo(true)).latest).toBeUndefined();
  }, 30_000);

  it('starts again through launchd or systemd when it runs as Pelican’s service, else in its place, else by hand', async () => {
    const prefix = path.join(dir, 'global');
    const script = await globalInstall(prefix);
    await mkdir(path.join(dir, 'home', 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(path.join(dir, 'home', 'Library', 'LaunchAgents', `${LABEL}.plist`), '<plist/>');
    await mkdir(path.join(dir, 'home', '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(path.join(dir, 'home', '.config', 'systemd', 'user', 'pelican.service'), '[Service]');
    const launchd = { platform: 'darwin' as const, global: prefix };
    expect((await offered(script, { ...launchd, env: { ...context(script, launchd).env, XPC_SERVICE_NAME: LABEL } })).restart).toBe('launchd');
    expect(services.calls).toContainEqual(['launchctl', 'print', `gui/501/${LABEL}`]);
    // A login item of another's, or a terminal (whose XPC_SERVICE_NAME says 0): in its place.
    expect((await offered(script, { ...launchd, env: { ...context(script, launchd).env, XPC_SERVICE_NAME: '0' } })).restart).toBe('in-place');
    const systemd = { platform: 'linux' as const, global: prefix };
    expect((await offered(script, { ...systemd, env: { ...context(script, systemd).env, INVOCATION_ID: 'abc' } })).restart).toBe('systemd');
    services.ours = false;
    expect((await offered(script, { ...systemd, env: { ...context(script, systemd).env, INVOCATION_ID: 'abc' } })).restart).toBe('in-place');
    // Node without process.execve, or a parent that talks to Pelican: by hand.
    expect((await offered(script, { global: prefix, execve: undefined })).restart).toBe('by-hand');
    expect((await offered(script, { global: prefix, ipc: true })).restart).toBe('by-hand');
  }, 30_000);

  it('does not update itself to a version that needs a newer Node', async () => {
    registry.engines = '>=99';
    const prefix = path.join(dir, 'global');
    const install = await offered(await globalInstall(prefix), { global: prefix });
    expect(install).toMatchObject({ kind: 'npm', self: false, command: `npm install --global --prefix ${prefix} pelican-cc@${NEXT}` });
    expect(install.why).toMatch(/needs Node 99 or newer/);
  }, 30_000);
});

describe('the registry, as a global install has it', () => {
  // npm itself: the npm of the Node running the tests, with a home folder, a global folder and a cache of the tests' own.
  const realNpm = npmBeside(process.execPath);

  it.skipIf(!realNpm)('is the user’s, never one a project’s .npmrc names in the folder Pelican was started in, for the check and the update alike', async () => {
    // A registry a cloned project's .npmrc names: it hears nothing.
    const heard: string[] = [];
    const other = http.createServer((request, response) => {
      heard.push(request.url ?? '');
      response.writeHead(404).end('{}');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    try {
      const project = path.join(dir, 'cloned-project');
      await mkdir(project, { recursive: true });
      await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'cloned', version: '1.0.0', private: true }));
      await writeFile(path.join(project, '.npmrc'), `registry=http://127.0.0.1:${(other.address() as AddressInfo).port}/\n`);
      // The user's own settings name the stand-in registry.
      const home = path.join(dir, 'npm-user');
      await mkdir(home, { recursive: true });
      await writeFile(path.join(home, '.npmrc'), `registry=${registry.url}\n`);
      const prefix = path.join(dir, 'npm-prefix');
      await rm(prefix, { recursive: true, force: true });
      const script = await globalInstall(prefix);
      const npmRanIn: Array<string | undefined> = [];
      useUpdateContext(context(script, {
        home,
        npm: realNpm,
        env: {
          PATH: process.env.PATH, HOME: home, npm_config_prefix: prefix, npm_config_cache: path.join(home, '.npm'), npm_config_update_notifier: 'false',
          // Nothing but 127.0.0.1 is reached, whatever npm would ask.
          npm_config_proxy: 'http://127.0.0.1:9', npm_config_https_proxy: 'http://127.0.0.1:9', npm_config_noproxy: '127.0.0.1',
        },
        // Pelican was started in the project: what it runs runs there, unless it says where.
        run: (file, args, options = {}) => {
          if (file === realNpm!.file && args[0] === realNpm!.args[0]) npmRanIn.push(options.cwd);
          return run(file, args, { ...options, cwd: options.cwd ?? project });
        },
      }));
      const info = (await api('GET', '/api/update?check=1')).body as UpdateInfo;
      expect(info).toMatchObject({ latest: NEXT, changes: expect.stringContaining(`What ${NEXT} brings`), install: { kind: 'npm', prefix, self: true } });
      expect((await api('POST', '/api/update', { version: NEXT, when: 'now' })).status).toBe(202);
      // npm installed it into the prefix, from the user's registry; the stand-in for process.execve said so.
      const failed = await until('failed', 100_000);
      expect(failed.state).toMatchObject({ error: expect.stringMatching(/could not start it in its place \(stand-in/) });
      expect(await installedVersion(prefix)).toBe(NEXT);
      expect(await realpath(path.join(prefix, 'bin', 'pelican'))).toBe(path.join(prefix, 'lib', 'node_modules', 'pelican-cc', 'dist', 'server', 'index.js'));
      expect(started).toHaveLength(1);
      expect(heard).toEqual([]);
      // Each npm ran from the home folder: config get registry --global, prefix --global, and both installs.
      expect(npmRanIn.length).toBeGreaterThanOrEqual(4);
      expect(new Set(npmRanIn)).toEqual(new Set([home]));
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  }, 120_000);
});

describe('the check', () => {
  const prefix = () => path.join(dir, 'global');

  it('finds the newest version on the registry and what changed since the running one, from its CHANGELOG.md', async () => {
    useUpdateContext(context(await globalInstall(prefix())));
    const info = await updateInfo(true);
    expect(info).toMatchObject({ current: CURRENT, latest: NEXT, busy: [] });
    expect(info.changes).toBe(`## ${NEXT}\n\nWhat ${NEXT} brings, in a paragraph.\n\n### Highlights\n\n- **One thing.** Of ${NEXT}.`);
    expect(registry.requests).toEqual(['/pelican-cc', `/pelican-cc/-/pelican-cc-${NEXT}.tgz`]);
  }, 30_000);

  it('says nothing when the newest is this one, or older', async () => {
    useUpdateContext(context(await globalInstall(prefix())));
    registry.latest = CURRENT;
    expect(await updateInfo(true)).toEqual({ current: CURRENT });
    await forget();
    useUpdateContext(context(await globalInstall(prefix())));
    registry.latest = '0.0.1';
    registry.tarballs.set('0.0.1', release('0.0.1'));
    expect(await updateInfo(true)).toEqual({ current: CURRENT });
  }, 30_000);

  it('says nothing offline, or when the registry fails or answers garbage', async () => {
    for (const answer of ['error', 'garbage'] as const) {
      await forget();
      useUpdateContext(context(await globalInstall(prefix())));
      registry.answer = answer;
      expect(await updateInfo(true), answer).toEqual({ current: CURRENT });
    }
    await forget();
    useUpdateContext(context(await globalInstall(prefix()), { env: { ...context('').env, STANDIN_NPM_REGISTRY: 'http://127.0.0.1:9/' } }));
    expect(await updateInfo(true)).toEqual({ current: CURRENT });
  }, 30_000);

  it('links to the release notes when the changelog cannot be had: a tarball whose integrity does not hold, or none', async () => {
    useUpdateContext(context(await globalInstall(prefix())));
    registry.answer = 'wrong-integrity';
    const info = await updateInfo(true);
    expect(info).toMatchObject({ latest: NEXT, notes: `https://github.com/Ki-Seki/pelican/releases/tag/v${NEXT}` });
    expect(info.changes).toBeUndefined();
    await forget();
    useUpdateContext(context(await globalInstall(prefix())));
    registry.answer = 'ok';
    registry.tarballs.set(NEXT, release(NEXT, { changelog: false }));
    expect((await updateInfo(true)).notes).toBeDefined();
  }, 30_000);

  it('asks the registry by itself at most once a day, also across restarts, and again when Settings opens after a few minutes', async () => {
    let now = Date.parse('2026-11-07T10:00:00Z');
    const clock = () => now;
    useUpdateContext(context(await globalInstall(prefix()), { now: clock }));
    expect((await updateInfo()).latest).toBe(NEXT);
    const asked = () => registry.requests.filter((request) => request === '/pelican-cc').length;
    expect(asked()).toBe(1);
    now += 3600_000;
    await updateInfo();
    // Pelican started again: what it found is in its state folder, and it asks no sooner for that.
    useUpdateContext(context(await globalInstall(prefix()), { now: clock }));
    expect((await updateInfo()).latest).toBe(NEXT);
    expect(asked()).toBe(1);
    // Settings opens: asked, unless it was a few minutes ago.
    await updateInfo(true);
    expect(asked()).toBe(2);
    now += 60_000;
    await updateInfo(true);
    expect(asked()).toBe(2);
    now += 25 * 3600_000;
    await updateInfo();
    expect(asked()).toBe(3);
  }, 30_000);

  it('asks nothing in the demo', async () => {
    useUpdateContext(context(await globalInstall(prefix())));
    config.demo = true;
    expect(await updateInfo(true)).toEqual({ current: CURRENT });
    expect((await api('GET', '/api/update?check=1')).body).toEqual({ current: CURRENT });
    expect(registry.requests).toEqual([]);
  }, 30_000);
});

describe('what an update would end', () => {
  it('lists Claude working or waiting, the messages queued for the end of its turn, its background tasks, terminals with a program and ! commands', async () => {
    useUpdateContext(context(await globalInstall(path.join(dir, 'global'))));
    useRunningSources({
      runs: () => [
        { sessionId: 's1', cwd: '/w/app', busy: true, waiting: false, queued: 2, tasks: [], checks: 0, unseen: false },
        { sessionId: 's2', cwd: '/w/api', busy: true, waiting: true, tasks: [], checks: 0, unseen: false },
        {
          sessionId: 's3', cwd: '/w/web', busy: false, waiting: false, checks: 1, unseen: false,
          tasks: [
            { id: 't1', description: 'Explore', type: 'Explore' }, { id: 't2', description: 'Review', type: 'general-purpose' },
            { id: 't3', description: 'npm run dev', type: 'local_bash', output: true }, { id: 't4', description: 'fix', type: 'local_workflow' },
          ],
        },
        { sessionId: 's4', cwd: '/w/ops', busy: false, waiting: false, tasks: [], checks: 0, unseen: true },
        { sessionId: 's5', cwd: '/w/idle', busy: false, waiting: false, tasks: [], checks: 0, unseen: false },
      ],
      terminals: async () => [{ program: 'vim', cwd: path.join(dir, 'home', 'repo') }],
      shells: () => [{ sessionId: 's1', command: 'npm test -- --watch\nsecond line' }],
      title: async (id) => ({ s1: 'Fix the build', s2: 'Ship the API', s3: 'Redo the site' } as Record<string, string>)[id],
    });
    const { busy } = await updateInfo(true);
    expect(busy).toEqual([
      { kind: 'session', title: 'Fix the build', detail: 'Claude is working', sessionId: 's1' },
      { kind: 'queued', title: 'Fix the build', detail: '2 messages for when this turn ends', sessionId: 's1' },
      { kind: 'session', title: 'Ship the API', detail: 'Claude waits for you', sessionId: 's2' },
      { kind: 'work', title: 'Redo the site', detail: '2 agents, a workflow, a command and a check it scheduled in the background', sessionId: 's3' },
      { kind: 'work', title: 'ops', detail: 'work it keeps running in the background', sessionId: 's4' },
      { kind: 'terminal', title: 'vim', detail: 'in ~/repo' },
      { kind: 'command', title: '!npm test -- --watch…', detail: 'in Fix the build', sessionId: 's1' },
    ]);
  });

  it('lists a terminal running a program, as End asks for it, and not one at its prompt', async () => {
    useUpdateContext(context(await globalInstall(path.join(dir, 'global'))));
    useRunningSources();
    {
      await mkdir(path.join(dir, 'work'), { recursive: true });
      const quiet = await api('POST', '/api/terminals', { cwd: path.join(dir, 'work'), cols: 80, rows: 24 });
      expect(quiet.status).toBe(201);
      const busy = await api('POST', '/api/terminals', { cwd: path.join(dir, 'work'), cols: 80, rows: 24, command: 'sleep 300' });
      expect(busy.status).toBe(201);
      for (const start = Date.now(); ;) {
        const ended = (await updateInfo(true)).busy ?? [];
        // Once sleep is in front (the shell starting it shows as a moment of bash running something).
        if (ended.some((item) => item.title === 'sleep')) {
          expect(ended).toEqual([{ kind: 'terminal', title: 'sleep', detail: `in ${path.join(dir, 'work')}` }]);
          break;
        }
        if (Date.now() - start > 10_000) throw new Error(`the terminal was not listed: ${JSON.stringify(ended)}`);
        await pause(100);
      }
    }
  }, 20_000);
});

describe('updating', () => {
  const prefix = () => path.join(dir, 'global');

  async function ready(more: Parameters<typeof context>[1] = {}): Promise<UpdateInfo> {
    useUpdateContext(context(await globalInstall(prefix()), { global: prefix(), ...more }));
    const info = (await api('GET', '/api/update?check=1')).body as UpdateInfo;
    expect(info).toMatchObject({ latest: NEXT, install: { self: true } });
    await npmRuns();
    return info;
  }

  it('installs the version shown, first apart and then over this install with its prefix, checks it starts, and starts it in place', async () => {
    await ready();
    const asked = await api('POST', '/api/update', { version: NEXT, when: 'now' });
    expect(asked.status).toBe(202);
    expect(asked.body.state).toMatchObject({ phase: 'preparing', version: NEXT, when: 'now' });
    // The stand-in for process.execve throws: Pelican serves again, and says so.
    const failed = await until('failed');
    expect(await installedVersion(prefix())).toBe(NEXT);
    const runs = await npmRuns();
    const install = (into: string, ...more: string[]) => [
      'install', '--global', '--prefix', into, '--registry', registry.url,
      '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error', ...more, `pelican-cc@${NEXT}`,
    ];
    expect(runs).toHaveLength(2);
    expect(runs[0]![3]).toMatch(/pelican-update-/);
    expect(runs[0]).toEqual(install(runs[0]![3]!));
    // Over this install, from what npm got moments ago where it can.
    expect(runs[1]).toEqual(install(prefix(), '--prefer-offline'));
    // The folder it was tried in is gone.
    expect(existsSync(runs[0]![3]!)).toBe(false);
    // What ran stopped, then the new version was started in this process's place, as Pelican was started.
    expect(serving.stops).toBe(1);
    expect(started).toEqual([{ file: process.execPath, args: [process.execPath, path.join(prefix(), 'bin', 'pelican'), '--port', '7860'] }]);
    expect(serving.agains).toBe(1);
    expect(failed.state).toMatchObject({ error: expect.stringMatching(/could not start it in its place \(stand-in/), running: CURRENT });
  }, 30_000);

  it('takes one of two requests at once (a double tap, two pages): the other is told an update is under way', async () => {
    // What runs takes a moment to read (ps, for a terminal): the second request comes meanwhile.
    useRunningSources({ ...nothingRuns, terminals: async () => pause(40).then(() => []) });
    await ready();
    const answers = await Promise.all([1, 2].map(() => api('POST', '/api/update', { version: NEXT, when: 'now' })));
    expect(answers.map((answer) => answer.status).sort()).toEqual([202, 409]);
    expect(answers.find((answer) => answer.status === 409)!.body.error).toBe('Pelican is already updating.');
    await until('failed');
    await pause(300);
    // One install apart, one over this install, one start.
    expect((await npmRuns()).map((args) => args[3] === prefix() ? 'over' : 'apart')).toEqual(['apart', 'over']);
    expect(started).toHaveLength(1);
  }, 30_000);

  it('starts in place once what it started has ended, not waiting on the ps it asks, which is one of its own while it runs', async () => {
    await ready();
    // ps lists itself, as the tests' process's child; given time, Pelican would wait it all out.
    services.ps = '5001 4242 R    ps\n';
    Object.assign(updateTiming, { childrenMs: 20_000 });
    const start = Date.now();
    expect((await api('POST', '/api/update', { version: NEXT, when: 'now' })).status).toBe(202);
    await until('failed', 25_000);
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(started).toHaveLength(1);
    expect(services.calls.filter(([file]) => file === 'ps').length).toBeGreaterThan(0);
  }, 30_000);

  it('starts again through launchd, or systemd, as Pelican’s service; one that does not is said', async () => {
    await mkdir(path.join(dir, 'home', 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(path.join(dir, 'home', 'Library', 'LaunchAgents', `${LABEL}.plist`), '<plist/>');
    await mkdir(path.join(dir, 'home', '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(path.join(dir, 'home', '.config', 'systemd', 'user', 'pelican.service'), '[Service]');
    for (const [platform, env, restart] of [['darwin', { XPC_SERVICE_NAME: LABEL }, ['launchctl', 'kickstart', '-k', `gui/501/${LABEL}`]], ['linux', { INVOCATION_ID: 'x' }, ['systemctl', '--user', '--no-block', 'restart', 'pelican.service']]] as const) {
      for (const code of [0, 1]) {
        services.restartCode = code;
        services.calls = [];
        await ready({ platform, env: { ...context('').env, ...env } });
        expect((await api('POST', '/api/update', { version: NEXT, when: 'now' })).status).toBe(202);
        const failed = await until('failed');
        expect(services.calls).toContainEqual(restart);
        // Asked, the service manager stops this Pelican; the stand-in does not, which is said.
        expect(failed.state).toMatchObject({ error: code ? expect.stringMatching(/did not start it: .*failed\. Run pelican service restart/) : expect.stringMatching(/did not stop this Pelican/) });
        expect(started).toEqual([]);
        await api('POST', '/api/update/cancel');
      }
    }
  }, 30_000);

  it('says to restart it by hand where it cannot start in place', async () => {
    await ready({ execve: undefined });
    expect((await api('POST', '/api/update', { version: NEXT, when: 'now' })).status).toBe(202);
    const done = await until('installed');
    expect(done.state).toMatchObject({ version: NEXT, note: expect.stringMatching(/is installed\. .*has no process\.execve\): stop it and start it again/) });
    expect(await installedVersion(prefix())).toBe(NEXT);
  }, 30_000);

  it('leaves this install as it was when the new version does not install, or does not start, apart', async () => {
    await ready({ env: { ...context('').env, STANDIN_NPM_FAIL: os.tmpdir() } });
    expect((await api('POST', '/api/update', { version: NEXT, when: 'now' })).status).toBe(202);
    let failed = await until('failed');
    expect(failed.state).toMatchObject({ error: expect.stringMatching(/^npm could not install .*ENOTFOUND/s), running: CURRENT });
    expect(await installedVersion(prefix())).toBe(CURRENT);
    expect((await npmRuns()).map((args) => args[3])).toEqual([expect.stringMatching(/pelican-update-/)]);
    // A version that does not start.
    registry.tarballs.set(NEXT, release(NEXT, { broken: true }));
    await ready();
    expect((await api('POST', '/api/update', { version: NEXT, when: 'now' })).status).toBe(202);
    failed = await until('failed');
    expect(failed.state).toMatchObject({ error: expect.stringMatching(/does not start: pelican --version failed: .*SyntaxError/s) });
    expect(await installedVersion(prefix())).toBe(CURRENT);
    expect(serving.stops).toBe(0);
  }, 30_000);

  it('puts the running version back when the new one does not start over this install', async () => {
    await ready({ env: { ...context('').env, STANDIN_NPM_BREAK: prefix(), STANDIN_NPM_BREAK_VERSION: NEXT } });
    expect((await api('POST', '/api/update', { version: NEXT, when: 'now' })).status).toBe(202);
    const failed = await until('failed');
    expect(failed.state).toMatchObject({ error: expect.stringMatching(new RegExp(`was installed but does not start .*; npm put ${CURRENT.replace(/\./g, '\\.')} back\\.`, 's')) });
    expect(await installedVersion(prefix())).toBe(CURRENT);
    expect((await npmRuns()).map((args) => [args[3], args.at(-1)])).toEqual([
      [expect.stringMatching(/pelican-update-/), `pelican-cc@${NEXT}`], [prefix(), `pelican-cc@${NEXT}`], [prefix(), `pelican-cc@${CURRENT}`],
    ]);
    expect(serving.stops).toBe(0);
  }, 30_000);

  it('asks first while something runs that it would end, then updates now, or once nothing has run for a minute', async () => {
    let running = true;
    useRunningSources({ ...nothingRuns, runs: () => (running ? [{ sessionId: 's1', cwd: '/w/app', busy: true, waiting: false, tasks: [], checks: 0, unseen: false }] : []) });
    const info = await ready();
    expect(info.busy).toEqual([{ kind: 'session', title: 'app', detail: 'Claude is working', sessionId: 's1' }]);
    // Now, unconfirmed: the page is to list what it ends first.
    const unconfirmed = await api('POST', '/api/update', { version: NEXT, when: 'now' });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.busy).toEqual(info.busy);
    // When idle: ready first, then waiting while Claude works.
    expect((await api('POST', '/api/update', { version: NEXT, when: 'idle' })).status).toBe(202);
    const waiting = await until('waiting');
    expect(waiting.busy).toHaveLength(1);
    await pause(updateTiming.idleMs * 2);
    expect((await api('GET', '/api/update')).body.state.phase).toBe('waiting');
    expect(await installedVersion(prefix())).toBe(CURRENT);
    // A turn ends; a minute (here, idleMs) with nothing running, and it updates.
    running = false;
    const idle = Date.now();
    await until('failed');
    expect(Date.now() - idle).toBeGreaterThanOrEqual(updateTiming.idleMs);
    expect(await installedVersion(prefix())).toBe(NEXT);
    expect(started).toHaveLength(1);
  }, 30_000);

  it('waits again when something starts before a minute is up, and Cancel stops the wait with nothing changed', async () => {
    let running = true;
    useRunningSources({ ...nothingRuns, shells: () => (running ? [{ sessionId: 's1', command: 'make' }] : []) });
    Object.assign(updateTiming, { idleMs: 600 });
    await ready();
    expect((await api('POST', '/api/update', { version: NEXT, when: 'idle' })).status).toBe(202);
    await until('waiting');
    running = false;
    await pause(200);
    expect((await api('GET', '/api/update')).body.state).toMatchObject({ phase: 'waiting', idleSince: expect.any(Number) });
    running = true;
    await pause(200);
    expect((await api('GET', '/api/update')).body.state).toEqual({ phase: 'waiting', version: NEXT, since: expect.any(Number) });
    running = false;
    await pause(200);
    const cancelled = await api('POST', '/api/update/cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBeUndefined();
    await pause(updateTiming.idleMs * 2);
    expect((await api('GET', '/api/update')).body.state).toBeUndefined();
    expect(await installedVersion(prefix())).toBe(CURRENT);
    expect((await npmRuns()).filter((args) => args[3] === prefix())).toEqual([]);
  }, 30_000);

  it('lets nothing new start while it replaces the install and starts again', async () => {
    await ready();
    expect((await api('POST', '/api/update', { version: NEXT, when: 'idle' })).status).toBe(202);
    await until('waiting');
    // A request that would start something (a session with no folder: refused as such otherwise)
    // waits while it installs, checks it and starts again; reading goes on all the while.
    const answers = new Set<number>();
    let reads = 0;
    const watching = (async () => {
      for (let i = 0; i < 2000 && !answers.has(503); i += 1) {
        answers.add((await api('POST', '/api/sessions', {})).status);
        if ((await api('GET', '/api/update')).status === 200) reads += 1;
      }
    })();
    const failed = await until('failed');
    await watching;
    expect([...answers].sort()).toEqual([400, 503]);
    expect(reads).toBeGreaterThan(0);
    expect(failed.state).toMatchObject({ phase: 'failed' });
    // Once over, it is as before.
    expect((await api('POST', '/api/sessions', {})).status).toBe(400);
  }, 30_000);
});

describe('who may update, and to what', () => {
  const prefix = () => path.join(dir, 'global');

  beforeEach(async () => {
    useUpdateContext(context(await globalInstall(prefix()), { global: prefix() }));
    expect((await api('GET', '/api/update?check=1')).body.latest).toBe(NEXT);
    await npmRuns();
  }, 30_000);

  it('takes nothing but the newest version npm’s registry named, written as a version', async () => {
    for (const version of [`${NEXT} --registry=http://evil.example/`, `../${NEXT}`, 'latest', `file:/tmp/pelican-cc-${NEXT}.tgz`, `pelican-cc@${NEXT}`, `${NEXT}\n`, '', 7, null]) {
      expect((await api('POST', '/api/update', { version, when: 'now' })).status, JSON.stringify(version)).toBe(400);
    }
    expect((await api('POST', '/api/update', { version: NEXT, when: 'soon' })).status).toBe(400);
    for (const version of [CURRENT, '9.9.9']) expect((await api('POST', '/api/update', { version, when: 'now' })).status, version).toBe(409);
    expect(await npmRuns()).toEqual([]);
  }, 30_000);

  it('takes it only from Pelican’s own page, signed in, and never in the demo', async () => {
    const body = JSON.stringify({ version: NEXT, when: 'now' });
    const post = (headers: Record<string, string>) => fetch(`${origin()}/api/update`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }).then((r) => r.status);
    expect(await post({ origin: origin(), authorization: `Bearer ${accessToken()}` })).toBe(403);
    expect(await post({ 'x-pelican': '1', origin: origin() })).toBe(401);
    expect(await post({ 'x-pelican': '1', origin: 'https://evil.example', authorization: `Bearer ${accessToken()}` })).toBe(403);
    expect(await post({ 'x-pelican': '1', 'sec-fetch-site': 'cross-site', authorization: `Bearer ${accessToken()}` })).toBe(403);
    expect(await post({ 'x-pelican': '1', origin: origin(), authorization: 'Bearer wrong' })).toBe(401);
    config.demo = true;
    expect(await post({ 'x-pelican': '1', ...signedIn() })).toBe(403);
    expect((await api('POST', '/api/update/cancel')).status).toBe(403);
    config.demo = false;
    expect(await npmRuns()).toEqual([]);
  }, 30_000);

  it('takes nothing where Pelican cannot update itself, nor twice at once', async () => {
    useUpdateContext(context(await globalInstall(path.join(dir, 'home', '.local')), { global: prefix() }));
    expect((await api('GET', '/api/update?check=1')).body.install.self).toBe(false);
    const refused = await api('POST', '/api/update', { version: NEXT, when: 'now' });
    expect(refused).toMatchObject({ status: 409, body: { error: expect.stringMatching(/not in npm’s global folder/) } });
    useUpdateContext(context(await globalInstall(prefix()), { global: prefix() }));
    await api('GET', '/api/update?check=1');
    expect((await api('POST', '/api/update', { version: NEXT, when: 'idle' })).status).toBe(202);
    expect((await api('POST', '/api/update', { version: NEXT, when: 'now' })).status).toBe(409);
    await until('waiting');
    expect((await api('POST', '/api/update', { version: NEXT, when: 'now', confirmed: true })).status).toBe(409);
    expect((await api('POST', '/api/update/cancel')).status).toBe(200);
    expect((await api('POST', '/api/update/cancel')).status).toBe(409);
  }, 30_000);
});
