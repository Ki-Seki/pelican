import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import pkg from '../../package.json' with { type: 'json' };
import { config } from './config.js';
import { askLocal, callable, pelicanAt, reachable, thisPelican } from './local.js';
import { listensLocally } from './security.js';

const DOCS = 'https://ki-seki.github.io/pelican/docs.html';
const DOCS_PHONE = 'https://ki-seki.github.io/pelican/docs/phone.html';

/** The name this was started by: `pelican-cc` where another program owns `pelican`. */
const NAME = /^pelican-cc(\.js)?$/.test(path.basename(process.argv[1] ?? '')) ? 'pelican-cc' : 'pelican';

const HELP = `Every Claude Code session on your computer, on your phone.
No wrapper, no relay, no account.

Usage
  ${NAME} [options]             Start Pelican
  ${NAME} phone [address]       Show a QR code that opens Pelican on your phone, signed in
  ${NAME} token                 Print the link that signs a browser in
  ${NAME} token --reset         Make a new access token; old links stop working
  ${NAME} password              Sign in with a password instead of the token
  ${NAME} password --stdin      The same, reading the password from standard input
  ${NAME} password --off        Remove the password; the token signs in again
  ${NAME} service install       Keep Pelican running: start it at login, and again if it stops
  ${NAME} service status        Also: restart, uninstall
  ${NAME} login                 Sign Claude Code in, when it is not

Options
  -p, --port <port>           Port to listen on (default 7860, or PELICAN_PORT)
  -H, --host <address>        Address to listen on (default 127.0.0.1, or PELICAN_HOST)
      --name <name>           Name shown for this machine (default: its host name)
      --no-auth               Ask no one to sign in. Only when something in front
                              of Pelican already authenticates.
      --no-terminal           Offer no terminal; ! commands still run
      --demo                  Show made-up sessions; nothing runs
      --open                  Open the browser
  -v, --version               Print the versions of Pelican and the Claude Code it runs
  -h, --help                  Show this help

Environment
  PELICAN_PUBLIC_URL          The address your phone uses, when it is not this computer's own
  PELICAN_KEEP_AWAKE=0        Let the computer sleep while Claude works
  PELICAN_CLAUDE_PATH         Run this Claude Code instead of the one Pelican brings

Pelican ${pkg.version} runs Claude Code, and so commands, as you. It listens on 127.0.0.1,
and every browser signs in, with the link Pelican prints or with your password.
More: ${DOCS}
`;

/** A mistake in how the command was typed: said plainly, with exit code 2. */
class UsageError extends Error {}

const OPTIONS = {
  port: { type: 'string', short: 'p' },
  host: { type: 'string', short: 'H' },
  name: { type: 'string' },
  'no-auth': { type: 'boolean' },
  'no-terminal': { type: 'boolean' },
  demo: { type: 'boolean' },
  open: { type: 'boolean' },
  off: { type: 'boolean' },
  reset: { type: 'boolean' },
  stdin: { type: 'boolean' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** How many single-character edits turn one word into the other. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

function parse() {
  try {
    return parseArgs({ allowPositionals: true, options: OPTIONS });
  } catch (error) {
    const message = (error as Error).message;
    const unknown = /Unknown option '(-{1,2}[^']+)'/.exec(message)?.[1];
    if (unknown) {
      const name = unknown.replace(/^-+/, '');
      const near = Object.keys(OPTIONS).find((option) => distance(option, name) <= 2);
      throw new UsageError(`unknown option ${unknown}${near ? ` (did you mean --${near}?)` : ''}. See ${NAME} --help.`);
    }
    const missing = /Option '(?:-\w, )?(--[\w-]+)[^']*' argument missing/.exec(message)?.[1];
    if (missing) throw new UsageError(`${missing} needs a value. See ${NAME} --help.`);
    throw new UsageError(`${message} See ${NAME} --help.`);
  }
}

/** Reads a line from the terminal without echoing it. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error(`Run \`${NAME} password\` in a terminal, or pipe the password in with --stdin.`));
      return;
    }
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

// A running Pelican notices a new token or password within a second (auth.ts): no restart.
async function passwordCommand(off: boolean, stdin: boolean): Promise<void> {
  const { clearPassword, loadAuth, setPassword } = await import('./auth.js');
  await loadAuth();
  if (off) {
    await clearPassword();
    console.log(`Password removed: browsers sign in with the access token again (\`${NAME} token\`).`);
    return;
  }
  const password = stdin ? await readStdin() : await askHidden('New password: ');
  if (password.length < 8) throw new Error('Use at least 8 characters.');
  if (!stdin && (await askHidden('Repeat it: ')) !== password) throw new Error('The two did not match.');
  await setPassword(password);
  console.log(`Password saved in ${config.configDir}. Browsers signed in before are signed out.`);
}

/** The link with the access token, for this computer's own address. */
const tokenLink = (base: string, token: string) => `${base}?token=${token}`;

/** An address for a host Pelican listens on: localhost, unless it listens on one other address only. */
function addressFor(host: string, port: number): string {
  const name = ['0.0.0.0', '::', '127.0.0.1', 'localhost', '::1'].includes(host) ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${name}:${port}/`;
}

/**
 * The Pelican a command is about: the one running with this state folder, unless a port was given;
 * otherwise the port and host of the settings.
 */
async function target(portGiven: boolean): Promise<{ port: number; host: string; running: boolean }> {
  const { runningServer } = await import('./running.js');
  const running = portGiven ? undefined : await runningServer();
  return running ? { port: running.port, host: running.host, running: true } : { port: config.port, host: config.host, running: false };
}

async function tokenCommand(reset: boolean, portGiven: boolean): Promise<void> {
  const { accessToken, authMode, loadAuth, resetToken } = await import('./auth.js');
  await loadAuth();
  if (authMode() === 'none') {
    console.log('Sign-in is off (--no-auth or PELICAN_AUTH=none), so there is no access token.');
    return;
  }
  if (reset) {
    await resetToken();
    console.log('New access token made: links and browsers signed in with the old one stop working.');
  }
  if (authMode() === 'password') {
    console.log(`A password is set, so browsers sign in with it. \`${NAME} password --off\` goes back to the token.`);
    return;
  }
  const token = accessToken();
  const { port, host } = await target(portGiven);
  if (token) console.log(tokenLink(addressFor(host, port), token));
}

/**
 * `pelican phone`: a QR code that opens Pelican on the phone, signed in with a one-time code that
 * the running Pelican makes. It talks only to the Pelican this account started (the note in the
 * state folder names it, local.ts), and asks for each code with a proof made with the secret the
 * server signs with, good for that one request and a minute (auth.ts): never a cookie, and no
 * token or password goes anywhere.
 */
async function phoneCommand(given: string | undefined, portGiven: boolean): Promise<void> {
  const { findPhoneAddress, checkAddress, setupHint, tailnetHere, tailnetHint } = await import('./phone.js');
  const asked = portGiven ? config.port : undefined;
  const local = await thisPelican(asked);
  if (!local) {
    const port = asked ?? (await target(false)).port;
    // Something answers there, but not as the Pelican of these settings: it is asked nothing more.
    if (await pelicanAt(callable(config.host, port))) {
      throw new Error(`What answers on port ${port} is not the Pelican started with these settings. Run \`${NAME} phone\` with the settings it runs with (PELICAN_STATE_DIR, PELICAN_CONFIG_DIR).`);
    }
    throw new Error(`Pelican is not running on port ${port}. Start it with \`${NAME}\` (or keep it running with \`${NAME} service install\`), then run \`${NAME} phone\` again.`);
  }
  const { running } = local;
  const search = await findPhoneAddress(running.port, running.host, given);
  if (!search.address) {
    console.log(setupHint(search, running.port, NAME).join('\n'));
    console.log(`More: ${DOCS_PHONE}`);
    process.exitCode = 1;
    return;
  }
  const address = search.address;
  const problem = await checkAddress(address.url, running.instance);
  if (problem) throw new Error(problem);
  const { commandProof, loadAuth } = await import('./auth.js');
  await loadAuth();
  const mint = async (): Promise<string | null> => {
    // Found again each time: a Pelican started again since is another server, with another id.
    const now = await thisPelican(running.port);
    if (!now) throw new Error(`Pelican is no longer running on port ${running.port}.`);
    if (now.mode === 'none') return null;
    const proof = commandProof('POST', '/api/access/code', now.running.instance);
    const response = await askLocal(now.running.url, 'access/code', { method: 'POST', headers: { 'X-Pelican-Proof': proof } });
    if (response.status === 401) throw new Error('This Pelican keeps its sign-in in another folder (PELICAN_CONFIG_DIR): run this command with the same settings it runs with.');
    if (!response.ok) throw new Error(`Pelican did not make a code (${response.status}).`);
    return ((await response.json()) as { code: string | null }).code;
  };
  // A tailnet's address opens only on its devices: say so where the phone is not on it yet.
  const onTailnet = address.from === 'tailscale serve' || new URL(address.url).hostname.endsWith('.ts.net');
  await showPhone(address, mint, onTailnet ? tailnetHint(await tailnetHere(), running.port) : []);
}

/** Prints the phone's QR code, and a new one each time Enter is pressed (on a terminal). */
async function showPhone(address: import('./phone.js').PhoneAddress, mint: () => Promise<string | null>, notes: string[] = []): Promise<void> {
  const { phoneBlock } = await import('./phone.js');
  const code = await mint();
  process.stdout.write(`\n${phoneBlock(address, code)}${notes.length > 0 ? `\n${notes.join('\n')}\n` : ''}`);
  if (!code || !process.stdin.isTTY || !process.stdout.isTTY) return;
  process.stdout.write('  Press Enter for a new code, Ctrl-C to stop.\n');
  let expiry: NodeJS.Timeout | undefined;
  const later = () => {
    clearTimeout(expiry);
    expiry = setTimeout(() => process.stdout.write('  That code has expired. Press Enter for a new one.\n'), 120_000);
  };
  later();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', () => {
    void mint().then((next) => {
      process.stdout.write(`\n${phoneBlock(address, next)}  Press Enter for a new code, Ctrl-C to stop.\n`);
      later();
    }, (error: Error) => {
      console.error(`${NAME}: ${error.message}`);
      process.exit(1);
    });
  });
  process.stdin.on('end', () => process.exit(0));
  await new Promise<never>(() => {});
}

/** The flags a service starts Pelican with: those given to `pelican service install`. */
function serviceFlags(values: ReturnType<typeof parse>['values']): string[] {
  return [
    ...(values.port ? ['--port', values.port] : []),
    ...(values.host ? ['--host', values.host] : []),
    ...(values.name ? ['--name', values.name] : []),
    ...(values['no-auth'] ? ['--no-auth'] : []),
    ...(values['no-terminal'] ? ['--no-terminal'] : []),
  ];
}

async function serviceCommand(action: string, flags: string[]): Promise<void> {
  const service = await import('./service.js');
  const { runningServer } = await import('./running.js');
  const ctx = service.thisComputer(flags);
  const say = (line: string) => console.log(line);
  if (action === 'install') {
    const problem = await service.cannotInstall(ctx);
    if (problem) throw new Error(problem);
    // Another Pelican on the same port would take it, and the service would stop at once.
    const running = await runningServer();
    const state = await service.serviceState(ctx);
    if (running && running.port === config.port && running.pid !== state.pid) {
      throw new Error(`Pelican is already running here (pid ${running.pid}, port ${running.port}). Stop it, then run \`${NAME} service install\` again.`);
    }
    await service.installService(ctx, say);
    await afterStart(ctx, running?.pid);
  } else if (action === 'uninstall') {
    await service.uninstallService(ctx, say);
  } else if (action === 'restart') {
    const before = (await runningServer())?.pid;
    await service.restartService(ctx, say);
    await afterStart(ctx, before);
  } else {
    const state = await service.serviceState(ctx);
    if (!state.installed) {
      say(`Pelican is not set up as a service. \`${NAME} service install\` keeps it running.`);
      return;
    }
    // Where the service listens is what it was installed with, which the note its process left
    // says; the shell's own settings only when there is no such note.
    const running = await runningServer();
    const ours = running && state.pid !== undefined && running.pid === state.pid ? running : undefined;
    const answering = Boolean(await pelicanAt(ours?.url ?? callable(config.host, config.port)));
    const address = ours ? addressFor(ours.host, ours.port) : addressFor(config.host, config.port);
    say(state.running ? `Running${state.pid ? ` (pid ${state.pid})` : ''}${answering ? `, at ${address}` : ', but not answering yet'}.` : `Not running${state.lastExit ? ` (last exit: ${state.lastExit})` : ''}.`);
    say(ctx.platform === 'darwin' ? `Log: ${service.logFile(ctx.home)}` : 'Log: journalctl --user -u pelican');
  }
}

/**
 * Once a service (re)starts: wait until it answers, then say how to sign in, as at a start in a
 * terminal. It is the Pelican whose note is not the one from before (`before`, the process it
 * replaced), wherever it listens; the link with the token is shown only for it.
 */
async function afterStart(ctx: import('./service.js').ServiceContext, before: number | undefined): Promise<void> {
  let found: Awaited<ReturnType<typeof thisPelican>>;
  for (let i = 0; i < 40 && !found; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pelican = await thisPelican();
    if (pelican && pelican.running.pid !== before) found = pelican;
  }
  const { logFile } = await import('./service.js');
  if (!found) {
    console.log(`Pelican has not answered yet. See ${ctx.platform === 'darwin' ? logFile(ctx.home) : 'journalctl --user -u pelican'}, or \`${NAME} service status\`.`);
    return;
  }
  const { accessToken, loadAuth } = await import('./auth.js');
  await loadAuth();
  const address = addressFor(found.running.host, found.running.port);
  // The link with the token goes to a terminal only, never into a pipe or a log.
  const token = found.mode === 'token' && process.stdout.isTTY ? accessToken() : undefined;
  const signIn = found.mode === 'token' && !token ? `\n  \`${NAME} token\` prints the link that signs a browser in` : '';
  console.log(`\n  ${token ? tokenLink(address, token) : address}${signIn}\n  On your phone: \`${NAME} phone\`\n`);
}

/** One line with every version a bug report needs. */
async function versionLine(): Promise<string> {
  const { claudeCodeInfo, sdkPackage } = await import('./claude-code.js');
  const code = await claudeCodeInfo();
  const claude = code.missing ? 'not found' : `${code.version ?? '?'}${code.path ? ` (${code.path})` : ''}`;
  return `${pkg.version} (Pelican) · Claude Code ${claude} · Agent SDK ${sdkPackage().version ?? '?'} · Node ${process.version} · ${process.platform}-${process.arch}`;
}

/**
 * Opens Pelican in the browser. The link with the token is never put on a command line, where
 * other accounts could read it: on macOS a page only you can read redirects to it (and is
 * removed); elsewhere, where a browser may not open such a page, Pelican opens to its sign-in.
 */
async function openPelican(address: string, token: string | undefined): Promise<void> {
  if (!token || process.platform !== 'darwin') {
    openBrowser(address);
    return;
  }
  const file = path.join(config.configDir, 'open.html');
  try {
    await mkdir(config.configDir, { recursive: true, mode: 0o700 });
    await rm(file, { force: true });
    const link = tokenLink(address, token);
    await writeFile(file, `<!doctype html><meta http-equiv="refresh" content="0;url=${link}"><a href="${link}">Open Pelican</a>\n`, { mode: 0o600 });
    openBrowser(pathToFileURL(file).href);
    setTimeout(() => void rm(file, { force: true }), 30_000).unref();
  } catch {
    openBrowser(address);
  }
}

function openBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => {}).unref();
  } catch {
    // Opening a browser is a convenience; the address is printed above.
  }
}

/**
 * Something on the port already: the Pelican this account started (say so and stop), or another
 * program, which may answer as Pelican does. That is an error, so a service starts again and gets
 * the port back once the other program lets go of it.
 */
async function portTaken(): Promise<void> {
  const pelican = await thisPelican(config.port);
  if (pelican) {
    console.log(`Pelican is already running at ${addressFor(pelican.running.host, pelican.running.port)}. \`${NAME} token\` prints the link that signs you in.`);
    return;
  }
  throw new Error(`Port ${config.port} is in use by another program. Start Pelican on another one: ${NAME} --port ${config.port === 65535 ? 7861 : config.port + 1} (or set PELICAN_PORT).`);
}

const within = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

async function main(): Promise<void> {
  const { values, positionals } = parse();
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void console.log(await versionLine());

  if (values.port) config.port = Number(values.port);
  if (values.host) config.host = values.host;
  if (values.name) config.machine = values.name;
  if (values['no-auth']) config.auth = 'none';
  if (values['no-terminal']) config.terminal = false;
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new UsageError(`Not a port: ${values.port ?? `${process.env.PELICAN_PORT} (PELICAN_PORT)`}`);
  }

  const [command, ...rest] = positionals;
  const most = (count: number, usage: string) => {
    if (rest.length > count) throw new UsageError(`${rest.slice(count).join(' ')}: one too many. Usage: ${NAME} ${usage}`);
  };
  switch (command) {
    case undefined:
      break;
    case 'help':
      most(0, 'help');
      return void process.stdout.write(HELP);
    case 'password':
      most(0, 'password [--stdin | --off]');
      return passwordCommand(Boolean(values.off), Boolean(values.stdin));
    case 'token':
      most(0, 'token [--reset]');
      return tokenCommand(Boolean(values.reset), Boolean(values.port));
    case 'phone':
      most(1, 'phone [address]');
      return phoneCommand(rest[0], Boolean(values.port));
    case 'login': {
      most(0, 'login');
      const { claudeLogin } = await import('./claude-code.js');
      process.exitCode = await claudeLogin();
      return;
    }
    case 'service':
      if (rest.length !== 1 || !['install', 'uninstall', 'restart', 'status'].includes(rest[0]!)) {
        throw new UsageError(`Usage: ${NAME} service install | uninstall | restart | status`);
      }
      return serviceCommand(rest[0]!, serviceFlags(values));
    default:
      throw new UsageError(`Unknown command: ${command}. See ${NAME} --help.`);
  }

  if (process.platform === 'win32') console.warn('pelican: Pelican is untested on Windows. It works best in WSL, next to Claude Code there.');

  // --no-auth, or PELICAN_AUTH=none, is an explicit choice; the demo asks no one to sign in on its own.
  const noAuth = config.auth === 'none';
  if (values.demo) {
    config.demo = true;
    const { prepareDemo } = await import('./demo.js');
    await prepareDemo();
    if (!values.name) config.machine = 'demo';
  }

  const local = listensLocally(config.host);
  if (config.demo) {
    // The demo holds nothing private, but it signs no one in: beyond this computer only when asked to.
    if (!local && !noAuth) throw new Error('The demo signs no one in, so it listens on 127.0.0.1 only. Pass --no-auth to show it on your network.');
    config.auth = 'none';
  }
  const { accessToken, authMode, issueCode, loadAuth } = await import('./auth.js');
  await loadAuth();

  const { configWarnings } = await import('./config.js');
  for (const warning of configWarnings) console.warn(`pelican: ${warning}`);

  const { startServer } = await import('./server.js');
  let url: string;
  try {
    ({ url } = await startServer());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return portTaken();
    throw error;
  }
  // Where it really listens (`localhost` may be ::1), so the commands that talk to it reach it.
  const { recordRunning } = await import('./running.js');
  await recordRunning({ port: config.port, host: config.host, url: reachable(url), version: pkg.version }).catch(() => undefined);
  // Whether a newer Pelican is out, asked of npm's registry once a day; Settings says so, quietly.
  if (!config.demo) (await import('./update.js')).watchForUpdates();

  const shown = url.replace('://127.0.0.1:', '://localhost:');
  const token = accessToken();
  const mode = authMode();
  // The link with the token is a standing key: shown on a terminal, never written to a log
  // (a service's output file, the journal). `pelican token` prints it on demand.
  const interactive = Boolean(process.stdout.isTTY);
  const open = token && interactive ? tokenLink(shown, token) : shown;
  const protection = config.demo ? 'demo: made-up sessions, nothing runs'
    : mode === 'password' ? 'browsers sign in with your password'
      : mode === 'token' ? (interactive ? `the link signs a browser in (\`${NAME} token\` prints it again)` : `browsers sign in with the link \`${NAME} token\` prints`)
        : local ? 'no sign-in (--no-auth)' : 'no sign-in (--no-auth): anyone who reaches this address can run commands as you';

  const { checkNewerClaude, claudeCodeInfo, claudeCodeLine, claudeSignIn, newerClaudeLine } = await import('./claude-code.js');
  const { findPhoneAddress, phoneBlock } = await import('./phone.js');
  const nothing: import('./phone.js').PhoneSearch = {};
  const [code, signIn, search, newer] = await Promise.all([
    claudeCodeInfo(),
    config.demo ? undefined : within(claudeSignIn(), 4000, undefined),
    config.demo && local ? nothing : within(findPhoneAddress(config.port, config.host), 4000, nothing),
    within(checkNewerClaude(), 4000, undefined),
  ]);
  const claude = config.demo ? '' : `\n  ${claudeCodeLine(code, signIn, `${NAME} login`)}${newer ? `\n  ${newerClaudeLine(newer)}` : ''}`;
  console.log(`\n  Pelican ${pkg.version} · ${config.machine}\n  ${open}\n  ${protection}${claude}\n`);
  if (!config.webDir) console.log('  The web app is not built: run `npm run build` (or use `npm run dev`).\n');

  // The phone: a QR code with a one-time code (never the token) where the address is known. Shown
  // once: the terminal is never read here, or a Pelican started in the background (`pelican &`)
  // would be stopped by the terminal (SIGTTIN). `pelican phone` makes a new code, on Enter too.
  if (search.address && interactive) {
    const code = mode === 'none' ? null : issueCode();
    process.stdout.write(`${phoneBlock(search.address, code)}${code ? `  A new one: \`${NAME} phone\`\n` : ''}\n`);
  } else if (search.address) {
    console.log(`  On your phone: ${search.address.url}\n`);
  } else if (!config.demo) {
    console.log(`  On your phone: \`${NAME} phone\`\n`);
  }

  if (!config.demo && config.keepAwake) {
    const [{ keepAwake }, { anyRunBusy }, { liveProcesses }] = await Promise.all([import('./awake.js'), import('./runner.js'), import('./live.js')]);
    // Claude working here, or in another app on this computer (not one waiting there for an answer).
    keepAwake({
      working: async () => anyRunBusy() || [...(await liveProcesses()).values()].some((p) => p.busy && !(p as { waiting?: boolean }).waiting),
    });
  }
  if (values.open) await openPelican(shown, token);
}

main().catch((error: Error) => {
  console.error(`${NAME}: ${error.message}`);
  process.exit(error instanceof UsageError ? 2 : 1);
});
