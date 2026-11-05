// The `pelican` command as people run it, against a Pelican it starts itself, on a computer of its
// own (temporary folders, a stand-in Claude Code and stand-in service managers): what it says,
// how it ends, and what it sends to whatever listens on a port.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { callable, reachable } from '../src/server/local';

const repo = path.resolve('.');
const CLI = path.join(repo, 'src', 'server', 'cli.ts');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const roots: string[] = [];
const children = new Set<ChildProcess>();
const pidFiles: string[] = [];
afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  // Pelicans the stand-in service manager started: only those, by the process ids it noted.
  for (const file of pidFiles) {
    const pid = Number(await readFile(file, 'utf8').catch(() => ''));
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  }
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

type Computer = { root: string; env: Record<string, string> };

/** A computer of its own: home, Pelican's and Claude Code's folders, and a Claude Code that only says its version. */
async function computer(): Promise<Computer> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-cli-')));
  roots.push(root);
  for (const dir of ['home', 'config', 'state', 'claude', 'bin']) await mkdir(path.join(root, dir), { recursive: true });
  const claude = path.join(root, 'bin', 'stand-in-claude');
  await writeFile(claude, '#!/bin/sh\ncase "$1" in --version) echo "2.1.318 (Claude Code)"; exit 0;; esac\nexit 1\n');
  await chmod(claude, 0o755);
  return {
    root,
    env: {
      PATH: [path.join(root, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
      HOME: path.join(root, 'home'),
      PELICAN_CONFIG_DIR: path.join(root, 'config'),
      PELICAN_STATE_DIR: path.join(root, 'state'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      PELICAN_CLAUDE_PATH: claude,
      PELICAN_KEEP_AWAKE: '0',
      PELICAN_SCRATCH_DIR: path.join(root, 'home', 'scratch'),
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  };
}

const command = (args: string[]) => [process.execPath, ['--import', 'tsx', CLI, ...args]] as const;

/** Runs `pelican <args>` to its end. */
function run(c: Computer, args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const [node, argv] = command(args);
    const child = spawn(node, argv, { cwd: repo, env: { ...c.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    child.stdout!.on('data', (data) => (out += data));
    child.stderr!.on('data', (data) => (out += data));
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** Starts Pelican, and waits until it has noted itself as running. */
async function start(c: Computer, args: string[]): Promise<ChildProcess> {
  const [node, argv] = command(args);
  const child = spawn(node, argv, { cwd: repo, env: c.env, stdio: ['ignore', 'ignore', 'ignore'] });
  children.add(child);
  for (let i = 0; i < 150; i += 1) {
    if ((await readFile(path.join(c.root, 'state', 'server.json'), 'utf8').catch(() => '')).includes(`"pid": ${child.pid},`)) return child;
    await sleep(100);
  }
  throw new Error('Pelican did not start');
}

async function freePort(host = '127.0.0.1'): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Another program on a port: it answers as Pelican does (without an id), and notes what it is sent. */
async function squatter(port: number, host = '127.0.0.1'): Promise<{ server: Server; seen: Array<{ method: string; url: string; secret: boolean }> }> {
  const seen: Array<{ method: string; url: string; secret: boolean }> = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', secret: Boolean(req.headers.cookie || req.headers['x-pelican-proof'] || req.headers.authorization) });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ required: true, mode: 'token', signedIn: false }));
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return { server, seen };
}

const ipv6 = await new Promise<boolean>((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(0, '::1', () => server.close(() => resolve(true)));
});
const python = spawnSync('python3', ['--version']).status === 0;

describe('a program that holds Pelican’s port', () => {
  it('is sent nothing by `pelican phone`, which refuses', async () => {
    const c = await computer();
    const port = await freePort();
    const other = await squatter(port);
    try {
      const { code, out } = await run(c, ['phone', 'https://laptop.example.ts.net/', '--port', String(port)]);
      expect(code).toBe(1);
      expect(out).toMatch(/not the Pelican started with these settings/);
      expect(other.seen.filter((r) => r.method !== 'GET' || r.secret)).toEqual([]);
    } finally {
      other.server.close();
    }
  }, 30_000);

  it('makes a start on that port fail, so a service tries again, instead of saying Pelican runs', async () => {
    const c = await computer();
    const port = await freePort();
    const other = await squatter(port);
    try {
      const { code, out } = await run(c, ['--port', String(port)]);
      expect(out).toMatch(/is in use by another program/);
      expect(code).toBe(1);
    } finally {
      other.server.close();
    }
  }, 30_000);
});

describe('where a command reaches Pelican', () => {
  it('is where it listens: a wildcard on loopback, ::1 as itself, a name as it resolves', () => {
    expect(callable('127.0.0.1', 7860)).toBe('http://127.0.0.1:7860/');
    expect(callable('0.0.0.0', 7860)).toBe('http://127.0.0.1:7860/');
    expect(callable('::1', 7860)).toBe('http://[::1]:7860/');
    expect(callable('::', 7860)).toBe('http://[::1]:7860/');
    expect(callable('localhost', 7860)).toBe('http://localhost:7860/');
    expect(callable('192.168.1.5', 7860)).toBe('http://192.168.1.5:7860/');
    expect(callable('fd7a::5', 7860)).toBe('http://[fd7a::5]:7860/');
    // What a server reports it listens at, as its note keeps it.
    expect(reachable('http://0.0.0.0:7860/')).toBe('http://127.0.0.1:7860/');
    expect(reachable('http://[::]:7860/')).toBe('http://[::1]:7860/');
    expect(reachable('http://[::1]:7860/')).toBe('http://[::1]:7860/');
  });
});

describe.skipIf(!ipv6)('a Pelican on --host ::1', () => {
  it('is found where it listens: a second start says it runs, and `pelican phone` signs a phone in with it alone', async () => {
    const c = await computer();
    const port = await freePort('::1');
    const pelican = await start(c, ['--host', '::1', '--port', String(port)]);
    const again = await run(c, ['--host', '::1', '--port', String(port)]);
    expect(again.out).toMatch(/Pelican is already running at/);
    expect(again.code).toBe(0);
    // Another program on the same port of 127.0.0.1 gets nothing either.
    const other = await squatter(port, '127.0.0.1').catch(() => undefined);
    try {
      const phone = await run(c, ['phone', `http://[::1]:${port}/`]);
      expect(phone.out).toMatch(/It works once, for two minutes/);
      expect(phone.code).toBe(0);
      expect(other?.seen ?? []).toEqual([]);
    } finally {
      other?.server.close();
      pelican.kill('SIGTERM');
    }
  }, 40_000);
});

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('`pelican service` for a service installed on its own port', () => {
  it('finds it there, not on the port of the shell it runs in: status, and restart', async () => {
    const c = await computer();
    const port = await freePort();
    const shellPort = await freePort();
    const pidFile = path.join(c.root, 'service.pid');
    pidFiles.push(pidFile);
    // The service manager, standing in for launchctl and systemctl: it says the service's process,
    // and restarts it as installed, with --port.
    // Started with nothing of its caller's open, so whoever runs this does not wait on it.
    const startService = `cd '${repo}'; '${process.execPath}' --import tsx '${CLI}' --port ${port} >> '${c.root}/service.log' 2>&1 < /dev/null & echo $! > '${pidFile}'`;
    const manager = `#!/bin/sh
pid=$(cat '${pidFile}' 2>/dev/null)
restart() { kill "$pid" 2>/dev/null; while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done; ${startService}; }
case "$*" in
  print*) printf '\\tstate = running\\n\\tpid = %s\\n\\tlast exit code = 0\\n' "$pid";;
  kickstart*) restart;;
  "--user show pelican.service"*) printf 'ActiveState=active\\nMainPID=%s\\nExecMainStatus=0\\n' "$pid";;
  "--user restart pelican.service") restart;;
esac
exit 0
`;
    for (const name of ['launchctl', 'systemctl']) {
      await writeFile(path.join(c.root, 'bin', name), manager);
      await chmod(path.join(c.root, 'bin', name), 0o755);
    }
    const unit = process.platform === 'darwin'
      ? path.join(c.env.HOME!, 'Library', 'LaunchAgents', 'io.github.ki-seki.pelican.plist')
      : path.join(c.env.HOME!, '.config', 'systemd', 'user', 'pelican.service');
    await mkdir(path.dirname(unit), { recursive: true });
    await writeFile(unit, 'installed with --port\n');
    spawnSync('sh', ['-c', startService], { env: c.env, stdio: 'ignore' });
    for (let i = 0; i < 150 && !(await readFile(path.join(c.root, 'state', 'server.json'), 'utf8').catch(() => '')).includes(`"port": ${port},`); i += 1) await sleep(100);

    const status = await run(c, ['service', 'status'], { PELICAN_PORT: String(shellPort) });
    expect(status.out).toContain(`, at http://localhost:${port}/.`);
    const restart = await run(c, ['service', 'restart'], { PELICAN_PORT: String(shellPort) });
    expect(restart.out).toContain('Pelican is starting again.');
    expect(restart.out).toContain(`http://localhost:${port}/`);
    // The old code looked on the shell's port and reported the restarted service as not answering.
    expect(restart.out).not.toContain('has not answered');
    expect(restart.out).not.toMatch(/has not answered yet/);
  }, 60_000);
});

describe.skipIf(!python || process.platform === 'win32')('a Pelican started in the background of a terminal (`pelican &`)', () => {
  it('keeps answering when the terminal is used, with a phone address known', async () => {
    const c = await computer();
    const port = await freePort();
    const pidFile = path.join(c.root, 'background.pid');
    pidFiles.push(pidFile);
    // An interactive shell on a terminal of its own: Pelican goes to the background, then a
    // command is typed. Only the process the shell noted is signalled.
    const script = `
import json, os, pty, select, signal, subprocess, sys, time, urllib.request
cmd, pid_file, port = sys.argv[1], sys.argv[2], sys.argv[3]
env = json.loads(os.environ['SHELL_ENV'])
child, fd = pty.fork()
if child == 0:
    os.execve('/bin/bash', ['bash', '--norc', '--noprofile', '-i'], env)
out = b''
def pump(seconds, until=None):
    global out
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                out += os.read(fd, 65536)
            except OSError:
                return
            if until and until in out:
                return
pump(1)
os.write(fd, (cmd + ' & echo $! > ' + pid_file + '\\n').encode())
pump(25, b'two minutes')
pump(1)
pid = int(open(pid_file).read().strip())
os.write(fd, b'echo hello\\n')
pump(2)
state = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
try:
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:' + port + '/api/auth', headers={'X-Pelican': '1'}), timeout=5) as response:
        answered = response.status
except Exception as error:
    answered = str(error)
os.kill(pid, signal.SIGKILL)
os.write(fd, b'exit\\n')
pump(1)
try:
    os.kill(child, signal.SIGKILL)
except ProcessLookupError:
    pass
os.waitpid(child, 0)
print(json.dumps({'state': state, 'answered': answered, 'banner': b'two minutes' in out, 'reads': b'Press Enter' in out}))
`;
    const shellEnv = { ...c.env, TERM: 'xterm', PS1: '$ ', PELICAN_PUBLIC_URL: `http://127.0.0.1:${port}/` };
    // `cd` first, on its own, so that what goes to the background, and `$!`, is Pelican itself.
    const cmd = `cd '${repo}'; '${process.execPath}' --import tsx '${CLI}' --port ${port}`;
    const result = spawnSync('python3', ['-I', '-c', script, cmd, pidFile, String(port)], { env: { ...c.env, SHELL_ENV: JSON.stringify(shellEnv) }, encoding: 'utf8', timeout: 45_000 });
    const seen = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as { state?: string; answered?: unknown; banner?: boolean; reads?: boolean };
    // Not stopped for reading the terminal (SIGTTIN), and answering.
    expect(seen.state, 'process state').not.toMatch(/^T/);
    expect(seen.answered).toBe(200);
    expect(seen.banner).toBe(true);
    expect(seen.reads).toBe(false);
  }, 60_000);
});
