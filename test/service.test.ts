import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cannotInstall, installService, LABEL, launchdPlist, logFile, plistFile, restartService, type Run, serviceEnvironment, type ServiceContext,
  serviceState, stableNode, systemdUnit, uninstallService, unitFile,
} from '../src/server/service';

// launchctl, systemctl and loginctl are never run: every command goes to this stand-in, which
// notes it and answers as the real one would.
let calls: string[] = [];
let answers: Record<string, { code: number; stdout?: string }> = {};
const fake: Run = async (command, args) => {
  const line = [command, ...args].join(' ');
  calls.push(line);
  const answer = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1];
  return { code: answer?.code ?? 0, stdout: answer?.stdout ?? '', stderr: '' };
};

const homes: string[] = [];
async function context(platform: NodeJS.Platform, overrides: Partial<ServiceContext> = {}): Promise<ServiceContext> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pelican-service-'));
  homes.push(home);
  return {
    platform,
    home,
    uid: 501,
    user: 'ada',
    node: '/opt/homebrew/bin/node',
    script: '/opt/homebrew/lib/node_modules/pelican-cc/dist/server/index.js',
    args: ['--port', '7861'],
    env: {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      SHELL: '/bin/zsh',
      HOME: home,
      PELICAN_PUBLIC_URL: 'https://laptop.tail1234.ts.net/',
      ANTHROPIC_API_KEY: 'sk-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
      CLAUDE_CONFIG_DIR: '/Users/ada/.claude',
      UNRELATED: 'x',
    },
    run: fake,
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  answers = {};
});
afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

describe('the environment a service gets', () => {
  it('carries PATH and Pelican’s and Claude Code’s settings, and never a secret', () => {
    const { kept, secrets } = serviceEnvironment({ PATH: '/bin', PELICAN_PORT: '7861', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', AWS_PROFILE: 'p', OTHER: 'o' });
    expect(kept).toEqual({ AWS_PROFILE: 'p', PATH: '/bin', PELICAN_PORT: '7861' });
    expect(secrets).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });
});

describe('on macOS', () => {
  it('writes a login item that runs this Node and this Pelican, logs to a known file, and loads it', async () => {
    const ctx = await context('darwin');
    answers['launchctl print'] = { code: 113 };
    const said: string[] = [];
    await installService(ctx, (line) => said.push(line));
    const plist = await readFile(plistFile(ctx.home), 'utf8');
    expect(plist).toBe(launchdPlist(ctx));
    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toContain('<string>/opt/homebrew/bin/node</string>\n    <string>/opt/homebrew/lib/node_modules/pelican-cc/dist/server/index.js</string>\n    <string>--port</string>\n    <string>7861</string>');
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin</string>');
    expect(plist).toContain(`<string>${logFile(ctx.home)}</string>`);
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(plist).not.toContain('sk-secret');
    expect(plist).not.toContain('UNRELATED');
    expect((await stat(plistFile(ctx.home))).mode & 0o777).toBe(0o600);
    expect(calls).toEqual([
      `launchctl print gui/501/${LABEL}`,
      `launchctl enable gui/501/${LABEL}`,
      `launchctl bootstrap gui/501 ${plistFile(ctx.home)}`,
    ]);
    expect(said.join('\n')).toContain('ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('replaces a loaded one, restarts, tells its state, and goes away', async () => {
    const ctx = await context('darwin');
    await installService(ctx, () => {});
    expect(calls).toContain(`launchctl bootout gui/501/${LABEL}`);
    calls = [];
    await restartService(ctx, () => {});
    expect(calls).toEqual([`launchctl kickstart -k gui/501/${LABEL}`]);
    answers['launchctl print'] = { code: 0, stdout: `gui/501/${LABEL} = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}` };
    expect(await serviceState(ctx)).toEqual({ installed: true, running: true, pid: 4242, lastExit: '0' });
    calls = [];
    await uninstallService(ctx, () => {});
    expect(calls).toEqual([`launchctl bootout gui/501/${LABEL}`]);
    await expect(stat(plistFile(ctx.home))).rejects.toThrow();
    expect(await serviceState(ctx)).toEqual({ installed: false, running: false });
  });

  it('XML-escapes what it writes', async () => {
    const ctx = await context('darwin', { args: ['--name', 'R&D <laptop>'] });
    expect(launchdPlist(ctx)).toContain('<string>R&amp;D &lt;laptop&gt;</string>');
  });
});

describe('on Linux', () => {
  it('writes a systemd user unit, enables and starts it, and says how to keep it after logout', async () => {
    const ctx = await context('linux', { node: '/usr/bin/node', script: '/usr/lib/node_modules/pelican-cc/dist/server/index.js' });
    answers['loginctl show-user'] = { code: 0, stdout: 'Linger=no\n' };
    const said: string[] = [];
    await installService(ctx, (line) => said.push(line));
    const unit = await readFile(unitFile(ctx.home), 'utf8');
    expect(unit).toBe(systemdUnit(ctx));
    expect(unit).toContain('ExecStart="/usr/bin/node" "/usr/lib/node_modules/pelican-cc/dist/server/index.js" "--port" "7861"');
    expect(unit).toContain('Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"');
    expect(unit).toContain('Environment="PELICAN_PUBLIC_URL=https://laptop.tail1234.ts.net/"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toContain('sk-secret');
    expect(calls).toEqual([
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      'systemctl --user enable pelican.service',
      'systemctl --user restart pelican.service',
      'loginctl show-user ada --property=Linger',
    ]);
    expect(said.join('\n')).toContain('loginctl enable-linger');
  });

  it('keeps %, $ and quotes literal in the unit', async () => {
    const ctx = await context('linux', { args: ['--name', 'a "b" 100% $HOME'] });
    expect(systemdUnit(ctx)).toContain('"--name" "a \\"b\\" 100%% $$HOME"');
  });

  it('tells its state, restarts and goes away', async () => {
    const ctx = await context('linux');
    await installService(ctx, () => {});
    answers['systemctl --user show pelican.service'] = { code: 0, stdout: 'ActiveState=active\nMainPID=99\nExecMainStatus=0\n' };
    expect(await serviceState(ctx)).toEqual({ installed: true, running: true, pid: 99 });
    calls = [];
    await restartService(ctx, () => {});
    expect(calls).toEqual(['systemctl --user restart pelican.service']);
    calls = [];
    await uninstallService(ctx, () => {});
    expect(calls).toEqual(['systemctl --user disable --now pelican.service', 'systemctl --user daemon-reload']);
    await expect(stat(unitFile(ctx.home))).rejects.toThrow();
  });

  it('says so where there is no systemd for the user', async () => {
    const ctx = await context('linux');
    answers['systemctl --user show-environment'] = { code: 1 };
    expect(await cannotInstall(ctx)).toMatch(/systemd is not running/);
  });
});

describe('where a service cannot be set up', () => {
  it('says why: Windows, a copy npx may remove, an unbuilt checkout', async () => {
    expect(await cannotInstall(await context('win32'))).toMatch(/WSL/);
    expect(await cannotInstall(await context('darwin', { script: '/Users/ada/.npm/_npx/1a2b/node_modules/pelican-cc/dist/server/index.js' }))).toMatch(/npm install -g pelican-cc/);
    expect(await cannotInstall(await context('darwin', { script: '/Users/ada/pelican/src/server/cli.ts' }))).toMatch(/npm run build/);
    await expect(restartService(await context('darwin'), () => {})).rejects.toThrow(/service install/);
  });
});

describe('the Node a service starts', () => {
  it('is the one on PATH when it is this very Node, which survives an update of Node', () => {
    expect(stableNode(process.execPath, path.dirname(process.execPath))).toBe(path.join(path.dirname(process.execPath), 'node'));
    expect(stableNode(process.execPath, '/nonexistent')).toBe(process.execPath);
  });
});
