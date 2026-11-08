import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * `pelican service`: keeps Pelican running, started at login and again if it stops, as a launchd
 * agent on macOS or a systemd user unit on Linux. The service gets the installing shell's PATH (a
 * login item's own is too thin to find Node, `npx` MCP servers or the tools `!` commands use) and
 * Pelican's and Claude Code's settings, never a secret, nor what a Claude Code session the command
 * runs in set for itself. Its output goes to a log, where Pelican prints no sign-in link.
 */

export const LABEL = 'io.github.ki-seki.pelican';
const UNIT = 'pelican.service';

export type Run = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export type ServiceContext = {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  user: string;
  /** Node and Pelican's own script, as the service starts them. */
  node: string;
  script: string;
  /** Flags for Pelican: --port, --host, --name, --no-auth. */
  args: string[];
  env: NodeJS.ProcessEnv;
  run: Run;
};

export const runCommand: Run = (command, args) => new Promise((resolve) => {
  execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 127) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code === 127 ? error.message : '')) });
  });
});

/** Variables the service carries over from the installing shell. */
const KEEP = /^(PATH|SHELL|LANG|LC_[A-Z]+|TZ|PELICAN_.+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_.+|ANTHROPIC_.+|AWS_PROFILE|AWS_REGION|CLOUD_ML_REGION|NODE_EXTRA_CA_CERTS|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy)$/;
/**
 * Never carried over, nor said: what Claude Code sets for one session or one process, in its own
 * environment and in what the session runs (`!` and Bash commands, hooks, MCP servers), and what
 * the app or IDE running Claude Code sets for it. Taken from inside a session, these would reach
 * every session the service's Pelican runs: the session's id, its inbox socket and its token, the
 * path of the claude that ran it, how it was started (cli, sdk-ts, claude-desktop), the agent it
 * runs as, a teammate's tmux, the IDE's port, the Agent SDK's options for one query, and what
 * Pelican tells the sessions it runs (claudeEnv, SIDE_CHAT_ENV). By name, as Claude Code's docs say
 * it sets them and as Claude Code 2.1.318 does; and by family: those Claude Code itself does not
 * carry to another computer (SESSION_, SDK_, HOST_, REMOTE, RELAUNCH_), Remote Control's (BRIDGE_)
 * and the desktop app's (DESKTOP_). Every other CLAUDE_CODE_* is a setting of yours, documented or
 * not (Claude Code reads hundreds, more with each release), and goes with the service.
 */
const PER_SESSION = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_AGENT', 'CLAUDE_CODE_TMUX_SESSION', 'CLAUDE_CODE_TMUX_PREFIX', 'CLAUDE_CODE_TMUX_PREFIX_CONFLICTS',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT', 'CLAUDE_CODE_QUESTION_EXTENDED',
  'CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS', 'CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES',
  'CLAUDE_CODE_ATTACHMENTS_BY_PATH', 'CLAUDE_CODE_RESUME_SOURCE_ALIVE',
]);
const PER_SESSION_FAMILY = /^CLAUDE_CODE_(SESSION_|SDK_|HOST_|REMOTE|RELAUNCH_|BRIDGE_|DESKTOP_)/;
const perSession = (name: string) => PER_SESSION.has(name) || PER_SESSION_FAMILY.test(name);
/**
 * Never written to a file: a service has no business holding them, and Claude Code keeps its own
 * sign-in. By name (a key, a token, headers such as ANTHROPIC_CUSTOM_HEADERS), or by value: an
 * address with a user name or a password in it (a proxy's `http://user:pass@host`). A count of
 * tokens is no token: CLAUDE_CODE_MAX_OUTPUT_TOKENS goes with the service.
 */
const SECRET = /KEY|TOKEN(?!S)|SECRET|PASSWORD|CREDENTIAL|HEADER/i;
const WITH_LOGIN = /[a-z][a-z0-9+.-]*:\/\/[^\s]*@/i;

/** The environment written into the service, and the names left out because they look like secrets. */
export function serviceEnvironment(env: NodeJS.ProcessEnv): { kept: Record<string, string>; secrets: string[] } {
  const kept: Record<string, string> = {};
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    if (value === undefined || !KEEP.test(name) || perSession(name)) continue;
    if (SECRET.test(name) || WITH_LOGIN.test(value)) secrets.push(name);
    else kept[name] = value;
  }
  return { kept, secrets };
}

/** Written readable only by you, also over a file that was there before: writeFile's mode is for a new one only. */
async function writeOwn(file: string, text: string): Promise<void> {
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
}

export const plistFile = (home: string) => path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const unitFile = (home: string) => path.join(home, '.config', 'systemd', 'user', UNIT);
export const logFile = (home: string) => path.join(home, 'Library', 'Logs', 'pelican.log');

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * How long launchd waits for a job it stops before it ends it, when the job does not say: 5
 * seconds on macOS now (`exit timeout = 5` in `launchctl print`).
 */
export const LAUNCHD_EXIT_TIMEOUT_S = 5;
/**
 * How long Pelican's login item asks launchd to wait (ExitTimeOut) once it asks Pelican to stop:
 * long enough for `!` commands to tidy up (see SHUTDOWN_GRACE_MS) and for Pelican to end what is
 * left of them and exit.
 */
const EXIT_TIMEOUT_S = 20;

/** The launchd job that started this Pelican, by its label, if one did (see launchdExitTimeout). */
export function launchdJob(ctx: Pick<ServiceContext, 'platform' | 'env'>): string | undefined {
  const label = ctx.env.XPC_SERVICE_NAME;
  return ctx.platform === 'darwin' && label && label !== '0' && !label.startsWith('application.') ? label : undefined;
}

/**
 * How long launchd waits, once it asks this Pelican to stop, before it ends it, when a launchd job
 * started Pelican (the job's label is in XPC_SERVICE_NAME; a terminal says 0, an app application.…):
 * the job's exit timeout as `launchctl print` says it, else launchd's default. Undefined elsewhere.
 */
export async function launchdExitTimeout(ctx: Pick<ServiceContext, 'platform' | 'env' | 'uid' | 'run'>): Promise<number | undefined> {
  const label = launchdJob(ctx);
  if (!label) return undefined;
  const { code, stdout } = await ctx.run('launchctl', ['print', `gui/${ctx.uid}/${label}`]);
  const seconds = Number(/^\s*exit timeout = (\d+)$/m.exec(stdout)?.[1]);
  return code === 0 && seconds > 0 ? seconds : LAUNCHD_EXIT_TIMEOUT_S;
}

/** The launchd agent: started at login, started again when it stops with an error. */
export function launchdPlist(ctx: ServiceContext): string {
  const { kept } = serviceEnvironment(ctx.env);
  const strings = (values: string[]) => values.map((v) => `    <string>${xml(v)}</string>`).join('\n');
  const env = Object.entries(kept).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([ctx.node, ctx.script, ...ctx.args])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(ctx.home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ExitTimeOut</key>
  <integer>${EXIT_TIMEOUT_S}</integer>
  <key>StandardOutPath</key>
  <string>${xml(logFile(ctx.home))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile(ctx.home))}</string>
</dict>
</plist>
`;
}

/** A value for a unit file: quoted, with systemd's specifiers and variables kept literal. */
const unitQuote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;

/**
 * Whether the service manager asked every process of Pelican's service to end, its `!` commands
 * too, with the signal Pelican got: systemd stopping a unit sends SIGTERM to each process in it at
 * once (KillMode=control-group, its default, which the unit below keeps). Pelican, started by
 * systemd itself (its parent, and the INVOCATION_ID it gives a service), takes a SIGTERM as that.
 */
export function askedBySystemd(signal: NodeJS.Signals, env: NodeJS.ProcessEnv = process.env, parent: () => string | undefined = parentCommand): boolean {
  return signal === 'SIGTERM' && Boolean(env.INVOCATION_ID) && parent() === 'systemd';
}

/** The name of the program that started Pelican, where the system says it (Linux). */
function parentCommand(): string | undefined {
  try {
    return process.platform === 'linux' ? readFileSync(`/proc/${process.ppid}/comm`, 'utf8').trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The systemd user unit: started with the user's session (or at boot, with lingering on), again on failure. */
export function systemdUnit(ctx: ServiceContext): string {
  const { kept } = serviceEnvironment(ctx.env);
  const env = Object.entries(kept).map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`)}`).join('\n');
  return `[Unit]
Description=Pelican: Claude Code sessions from your phone

[Service]
ExecStart=${[ctx.node, ctx.script, ...ctx.args].map(unitQuote).join(' ')}
${env}
WorkingDirectory=%h
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** Why the service cannot be set up from here, if it cannot. */
export async function cannotInstall(ctx: ServiceContext): Promise<string | undefined> {
  if (ctx.platform === 'win32') return 'Not available on Windows. Run Pelican in WSL, next to Claude Code; there `pelican service install` sets up a systemd service.';
  if (ctx.platform !== 'darwin' && ctx.platform !== 'linux') return `Not available on ${ctx.platform}: start Pelican from your own login script.`;
  if (!ctx.script.endsWith('.js')) return 'Build Pelican first (npm run build), or install it with npm install -g pelican-cc.';
  // npx keeps its copy in a cache that may be cleared at any time, taking the service with it.
  if (/[\\/]_npx[\\/]/.test(ctx.script)) return 'Install Pelican first (npm install -g pelican-cc), then run `pelican service install`: the copy npx runs can be removed at any time.';
  if (ctx.platform === 'linux' && (await ctx.run('systemctl', ['--user', 'show-environment'])).code !== 0) {
    return 'systemd is not running for your user here, so there is no service to set up. Keep Pelican running in tmux or screen instead.';
  }
  return undefined;
}

const domain = (ctx: ServiceContext) => `gui/${ctx.uid}`;
const target = (ctx: ServiceContext) => `${domain(ctx)}/${LABEL}`;

async function failed(result: { code: number; stderr: string; stdout: string }, what: string): Promise<never> {
  throw new Error(`${what} failed: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`);
}

/** Writes the service and starts it; lines to print go to `say`. */
export async function installService(ctx: ServiceContext, say: (line: string) => void): Promise<void> {
  const problem = await cannotInstall(ctx);
  if (problem) throw new Error(problem);
  const { secrets } = serviceEnvironment(ctx.env);
  if (ctx.platform === 'darwin') {
    const file = plistFile(ctx.home);
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.dirname(logFile(ctx.home)), { recursive: true });
    await writeOwn(file, launchdPlist(ctx));
    // Loaded already (an earlier install): unload it first, so the new file applies.
    if ((await ctx.run('launchctl', ['print', target(ctx)])).code === 0) await ctx.run('launchctl', ['bootout', target(ctx)]);
    await ctx.run('launchctl', ['enable', target(ctx)]);
    const loaded = await ctx.run('launchctl', ['bootstrap', domain(ctx), file]);
    if (loaded.code !== 0) await failed(loaded, 'launchctl bootstrap');
    say(`Pelican runs as a login item now (${file}).`);
    say(`Its log: ${logFile(ctx.home)}`);
  } else {
    const file = unitFile(ctx.home);
    await mkdir(path.dirname(file), { recursive: true });
    await writeOwn(file, systemdUnit(ctx));
    for (const args of [['daemon-reload'], ['enable', UNIT], ['restart', UNIT]]) {
      const result = await ctx.run('systemctl', ['--user', ...args]);
      if (result.code !== 0) await failed(result, `systemctl --user ${args.join(' ')}`);
    }
    say(`Pelican runs as a systemd user service now (${file}).`);
    say('Its log: journalctl --user -u pelican');
    const linger = await ctx.run('loginctl', ['show-user', ctx.user, '--property=Linger']);
    if (linger.code === 0 && /Linger=no/.test(linger.stdout)) {
      say('It stops when you log out. To keep it running then, and to start it at boot: loginctl enable-linger');
    }
  }
  if (secrets.length > 0) say(`Left out of the service, as secrets: ${secrets.join(', ')}.`);
}

/** Stops the service and removes it. */
export async function uninstallService(ctx: ServiceContext, say: (line: string) => void): Promise<void> {
  if (ctx.platform === 'darwin') {
    const file = plistFile(ctx.home);
    const had = await stat(file).then(() => true, () => false);
    await ctx.run('launchctl', ['bootout', target(ctx)]);
    await rm(file, { force: true });
    say(had ? 'Pelican no longer runs as a login item.' : 'Pelican was not set up as a login item.');
  } else if (ctx.platform === 'linux') {
    const file = unitFile(ctx.home);
    const had = await stat(file).then(() => true, () => false);
    await ctx.run('systemctl', ['--user', 'disable', '--now', UNIT]);
    await rm(file, { force: true });
    await ctx.run('systemctl', ['--user', 'daemon-reload']);
    say(had ? 'Pelican no longer runs as a systemd user service.' : 'Pelican was not set up as a systemd user service.');
  } else {
    throw new Error((await cannotInstall(ctx)) ?? 'Not available here.');
  }
}

/** Starts the service again (after an update, or a change to its settings). */
export async function restartService(ctx: ServiceContext, say: (line: string) => void): Promise<void> {
  if (!(await serviceInstalled(ctx))) throw new Error('Pelican is not set up as a service: `pelican service install` sets it up.');
  const result = ctx.platform === 'darwin'
    ? await ctx.run('launchctl', ['kickstart', '-k', target(ctx)])
    : await ctx.run('systemctl', ['--user', 'restart', UNIT]);
  if (result.code !== 0) await failed(result, 'Restarting Pelican');
  say('Pelican is starting again.');
}

export async function serviceInstalled(ctx: ServiceContext): Promise<boolean> {
  const file = ctx.platform === 'darwin' ? plistFile(ctx.home) : ctx.platform === 'linux' ? unitFile(ctx.home) : undefined;
  return file ? stat(file).then(() => true, () => false) : false;
}

export type ServiceState = { installed: boolean; running: boolean; pid?: number; lastExit?: string };

/** Whether the service is set up and running, as launchd or systemd say. */
export async function serviceState(ctx: ServiceContext): Promise<ServiceState> {
  const installed = await serviceInstalled(ctx);
  if (!installed) return { installed, running: false };
  if (ctx.platform === 'darwin') {
    const { code, stdout } = await ctx.run('launchctl', ['print', target(ctx)]);
    if (code !== 0) return { installed, running: false };
    const pid = Number(/^\s*pid = (\d+)/m.exec(stdout)?.[1]);
    const lastExit = /^\s*last exit code = (.+)$/m.exec(stdout)?.[1]?.trim();
    return { installed, running: /^\s*state = running/m.test(stdout), ...(pid ? { pid } : {}), ...(lastExit ? { lastExit } : {}) };
  }
  const { stdout } = await ctx.run('systemctl', ['--user', 'show', UNIT, '--property=ActiveState,MainPID,ExecMainStatus']);
  const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(stdout)?.[1]?.trim();
  const pid = Number(value('MainPID'));
  const status = value('ExecMainStatus');
  return { installed, running: value('ActiveState') === 'active', ...(pid ? { pid } : {}), ...(status && status !== '0' ? { lastExit: status } : {}) };
}

/** `node` on PATH when it is the very Node running now: a stable path that survives a Node update. */
export function stableNode(execPath: string, pathValue: string | undefined): string {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of (pathValue ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      // Not there.
    }
  }
  return execPath;
}

/** The context for this computer and this Pelican. */
export function thisComputer(args: string[]): ServiceContext {
  let script = process.argv[1] ?? '';
  try {
    script = realpathSync(script);
  } catch {
    // Kept as given; cannotInstall says what is wrong with it.
  }
  return {
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    user: os.userInfo().username,
    node: stableNode(process.execPath, process.env.PATH),
    script,
    args,
    env: process.env,
    run: runCommand,
  };
}
