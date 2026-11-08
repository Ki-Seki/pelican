import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  askedBySystemd, cannotInstall, installService, LABEL, LAUNCHD_EXIT_TIMEOUT_S, launchdExitTimeout, launchdPlist, logFile, plistFile, restartService, type Run, serviceEnvironment, type ServiceContext,
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

  it('keeps a count of tokens, a name that ends in TOKENS, and still leaves out one with TOKENS elsewhere in it', () => {
    const { kept, secrets } = serviceEnvironment({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', ANTHROPIC_TOKENS_BACKUP: 'made-up', CLAUDE_CODE_TOKENS_FILE: '/tmp/made-up' });
    expect(kept).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000' });
    expect(secrets).toEqual(['ANTHROPIC_TOKENS_BACKUP', 'CLAUDE_CODE_TOKENS_FILE']);
  });
});

describe('a service installed from inside a Claude Code session', () => {
  // Settings of yours, documented or not, some named like what a session sets, or like a secret
  // (a count of tokens).
  const settings = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '400000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
    CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '5000',
    CLAUDE_CODE_TMUX_TRUECOLOR: '1',
    CLAUDE_CODE_TMPDIR: '/var/tmp/ada',
    CLAUDE_CODE_TASK_LIST_ID: 'release',
    CLAUDE_CODE_SOME_LATER_SETTING: 'on',
    AWS_REGION: 'us-east-1',
  };
  // What a `!` or Bash command gets in a session: what Claude Code 2.1.318 sets there, and what the
  // Agent SDK, Pelican, an IDE's terminal, the desktop app, Remote Control, a cloud session, a
  // relaunch or a teammate in tmux set for the Claude Code they run. Made-up values.
  const session = {
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: '11111111-2222-4333-8444-555555555555',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_SESSION_KIND: 'bg',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDE_CODE_EXECPATH: '/Users/ada/.local/share/claude/versions/2.1.318',
    CLAUDE_CODE_INVOKED_SKILLS: 'review',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude-501/inbox-made-up.sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 'made-up-inbox-token',
    CLAUDE_CODE_SSE_PORT: '47401',
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true',
    CLAUDE_CODE_QUESTION_PREVIEW_FORMAT: 'html',
    CLAUDE_CODE_QUESTION_EXTENDED: '1',
    CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
    CLAUDE_CODE_ATTACHMENTS_BY_PATH: '1',
    CLAUDE_CODE_RESUME_SOURCE_ALIVE: '1',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_HOST_HTTP_PROXY_PORT: '47402',
    CLAUDE_CODE_DESKTOP_APP_VERSION: '4.23118.0',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_made_up',
    CLAUDE_CODE_REMOTE: 'true',
    CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_made_up',
    CLAUDE_CODE_RELAUNCH_TERMINAL_SIZE: '120x40',
    CLAUDE_CODE_AGENT: 'reviewer',
    CLAUDE_CODE_TMUX_SESSION: 'made-up-team',
    CLAUDE_PID: '4242',
    CLAUDE_EFFORT: 'high',
    CLAUDE_AGENT_SDK_VERSION: '0.3.318',
    AI_AGENT: 'claude-code',
    GIT_EDITOR: 'true',
  };

  it('carries your settings and none of what the session set for itself, saying nothing of it', () => {
    const { kept, secrets } = serviceEnvironment({ PATH: '/bin', ...settings, ...session });
    expect(kept).toEqual({ PATH: '/bin', ...settings });
    // The inbox's token is the session's, not a secret of yours to set up another way.
    expect(secrets).toEqual([]);
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`writes none of it into the service (${platform})`, async () => {
      const ctx = await context(platform, { env: { PATH: '/bin', ...settings, ...session } });
      answers['launchctl print'] = { code: 113 };
      const said: string[] = [];
      await installService(ctx, (line) => said.push(line));
      const written = await readFile(platform === 'darwin' ? plistFile(ctx.home) : unitFile(ctx.home), 'utf8');
      for (const [name, value] of Object.entries(settings)) expect(written, name).toContain(`${name}${platform === 'darwin' ? '</key>\n    <string>' : '='}${value}`);
      for (const name of Object.keys(session)) expect(written, name).not.toContain(name);
      for (const value of ['11111111-2222', 'inbox-made-up', '47401', '47402', 'session_made_up', 'cse_made_up', 'versions/2.1.318']) expect(written).not.toContain(value);
      expect(said.join('\n')).not.toMatch(/CLAUDE/);
    });
  }
});

describe('credentials in the installing shell', () => {
  it('are left out of a service by their value too: headers, and addresses with a user name or password', () => {
    const { kept, secrets } = serviceEnvironment({
      PATH: '/bin',
      ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: sk-ant-gateway-SECRET',
      HTTPS_PROXY: 'http://alice:Winter2026!@proxy.corp:3128',
      https_proxy: 'http://token@proxy.corp:3128',
      ANTHROPIC_BASE_URL: 'https://bob:hunter2@gateway.corp/',
      ALL_PROXY: 'socks5://proxy.corp:1080',
      NO_PROXY: 'localhost,.corp',
    });
    expect(kept).toEqual({ ALL_PROXY: 'socks5://proxy.corp:1080', NO_PROXY: 'localhost,.corp', PATH: '/bin' });
    expect(secrets.sort()).toEqual(['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'HTTPS_PROXY', 'https_proxy']);
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`never stay readable by others in a service file that was there before (${platform})`, async () => {
      const ctx = await context(platform, { env: { PATH: '/bin', HTTPS_PROXY: 'http://alice:Winter2026!@proxy.corp:3128' } });
      const file = platform === 'darwin' ? plistFile(ctx.home) : unitFile(ctx.home);
      await mkdir(path.dirname(file), { recursive: true });
      // A service made by hand, as the docs of 0.2 told people to.
      await writeFile(file, 'made by hand\n');
      await chmod(file, 0o644);
      await installService(ctx, () => {});
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, 'utf8')).not.toContain('Winter2026');
    });
  }
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
    // Time for ! commands to tidy up when launchd stops it, where launchd would give 5 seconds.
    expect(plist).toContain('<key>ExitTimeOut</key>\n  <integer>20</integer>');
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

describe('how long launchd waits for Pelican to stop', () => {
  it('is what launchctl says of the job that started it, launchd’s 5 seconds where unsaid, and nothing outside launchd', async () => {
    const ctx = await context('darwin', { env: { XPC_SERVICE_NAME: LABEL } });
    answers['launchctl print'] = { code: 0, stdout: `gui/501/${LABEL} = {\n\tactive count = 1\n\texit timeout = 20\n\tpid = 4242\n}\n` };
    expect(await launchdExitTimeout(ctx)).toBe(20);
    expect(calls).toEqual([`launchctl print gui/501/${LABEL}`]);
    answers['launchctl print'] = { code: 113 };
    expect(await launchdExitTimeout(ctx)).toBe(LAUNCHD_EXIT_TIMEOUT_S);
    // A terminal, an app, Linux, no job: launchd does not stop it.
    calls = [];
    for (const [platform, env] of [['darwin', { XPC_SERVICE_NAME: '0' }], ['darwin', { XPC_SERVICE_NAME: 'application.com.apple.Terminal.1234.1235' }], ['darwin', {}], ['linux', { XPC_SERVICE_NAME: LABEL }]] as const) {
      expect(await launchdExitTimeout(await context(platform, { env }))).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });
});

describe('a stop from systemd', () => {
  it('is a SIGTERM to Pelican started by systemd as a service, which asked its ! commands too', async () => {
    const ctx = await context('linux');
    const service = { INVOCATION_ID: '8d2e3c' };
    expect(askedBySystemd('SIGTERM', service, () => 'systemd')).toBe(true);
    // Ctrl+C, a terminal's Pelican (which may have the variable from a terminal that is a service), kill by hand.
    expect(askedBySystemd('SIGINT', service, () => 'systemd')).toBe(false);
    expect(askedBySystemd('SIGTERM', service, () => 'zsh')).toBe(false);
    expect(askedBySystemd('SIGTERM', {}, () => 'systemd')).toBe(false);
    // The unit Pelican writes keeps systemd's default, which signals every process of the service.
    expect(systemdUnit(ctx)).not.toMatch(/KillMode/);
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
