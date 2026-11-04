import { spawn } from 'node:child_process';
import os from 'node:os';
import { parseArgs } from 'node:util';

import pkg from '../../package.json' with { type: 'json' };
import { config } from './config.js';
import { listensLocally } from './security.js';

const DOCS = 'https://ki-seki.github.io/pelican/docs.html';

const HELP = `Pelican ${pkg.version}: your Claude Code sessions, from any browser.

Usage
  pelican [options]           Start the server
  pelican token               Print the link that signs a browser in
  pelican token --reset       Make a new access token; old links stop working
  pelican password            Sign in with a password instead of the token
  pelican password --off      Remove the password; the token signs in again

Options
  -p, --port <port>           Port to listen on (default 7860, or PELICAN_PORT)
  -H, --host <address>        Address to listen on (default 127.0.0.1, or PELICAN_HOST)
      --name <name>           Name shown for this machine (default: its host name)
      --no-auth               Ask no one to sign in. Only when something in front
                              of Pelican already authenticates.
      --demo                  Show made-up sessions; nothing runs
      --open                  Open the browser
  -v, --version               Print the version
  -h, --help                  Show this help

Pelican runs Claude Code, and so commands, as you. It listens on 127.0.0.1, and
every browser signs in, with the access token in the link Pelican prints or
with your password. To use it from your phone, see ${DOCS}#phone
`;

/** Reads a line from the terminal without echoing it. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error('Run `pelican password` in a terminal, or pipe the password in with --stdin.'));
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

async function passwordCommand(off: boolean, stdin: boolean): Promise<void> {
  const { clearPassword, loadAuth, setPassword } = await import('./auth.js');
  await loadAuth();
  if (off) {
    await clearPassword();
    console.log('Password removed: browsers sign in with the access token again (`pelican token`). Restart Pelican to apply.');
    return;
  }
  const password = stdin ? await readStdin() : await askHidden('New password: ');
  if (password.length < 8) throw new Error('Use at least 8 characters.');
  if (!stdin && (await askHidden('Repeat it: ')) !== password) throw new Error('The two did not match.');
  await setPassword(password);
  console.log(`Password saved in ${config.configDir}. Restart Pelican to apply; signed-in browsers are signed out.`);
}

/** The link with the access token, for this computer's own address. */
const tokenLink = (base: string, token: string) => `${base}?token=${token}`;

async function tokenCommand(reset: boolean): Promise<void> {
  const { accessToken, authMode, loadAuth, resetToken } = await import('./auth.js');
  await loadAuth();
  if (reset) {
    await resetToken();
    console.log('New access token made. Restart Pelican to apply; browsers signed in with the old one are signed out.');
  }
  if (authMode() === 'password') {
    console.log('A password is set, so browsers sign in with it. `pelican password --off` goes back to the token.');
    return;
  }
  const token = accessToken();
  if (token) console.log(tokenLink(`http://localhost:${config.port}/`, token));
}

function openBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => {}).unref();
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'H' },
      name: { type: 'string' },
      'no-auth': { type: 'boolean' },
      demo: { type: 'boolean' },
      open: { type: 'boolean' },
      off: { type: 'boolean' },
      reset: { type: 'boolean' },
      stdin: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void console.log(pkg.version);
  if (positionals[0] === 'password') return passwordCommand(Boolean(values.off), Boolean(values.stdin));
  if (positionals[0] === 'token') return tokenCommand(Boolean(values.reset));
  if (positionals.length > 0) throw new Error(`Unknown command: ${positionals.join(' ')}. See pelican --help.`);

  if (values.port) config.port = Number(values.port);
  if (values.host) config.host = values.host;
  if (values.name) config.machine = values.name;
  if (values['no-auth']) config.auth = 'none';
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) throw new Error(`Not a port: ${values.port}`);

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
  const { accessToken, authMode, loadAuth } = await import('./auth.js');
  await loadAuth();

  const { startServer } = await import('./server.js');
  const { url } = await startServer();
  const shown = url.replace('://127.0.0.1:', '://localhost:');
  const token = accessToken();
  const mode = authMode();
  const open = token ? tokenLink(shown, token) : shown;
  const protection = config.demo ? 'demo: made-up sessions, nothing runs'
    : mode === 'password' ? 'browsers sign in with your password'
      : mode === 'token' ? 'the link signs a browser in (`pelican token` prints it again)'
        : local ? 'no sign-in (--no-auth)' : 'no sign-in (--no-auth): anyone who reaches this address can run commands as you';
  console.log(`\n  Pelican ${pkg.version} · ${config.machine}\n  ${open}\n  ${protection}\n`);
  if (!config.webDir) console.log('  The web app is not built: run `npm run build` (or use `npm run dev`).\n');
  // Listening beyond this computer: the address a phone on the same network can open, as a QR code.
  if (!local) {
    const { qrTerminal } = await import('./qr.js');
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    const base = config.host === '0.0.0.0' || config.host === '::' ? (lan ? `http://${lan.address}:${config.port}/` : undefined) : url;
    const phone = base && token ? tokenLink(base, token) : base;
    if (phone) console.log(`  On your phone: ${phone}\n\n${qrTerminal(phone).replace(/^/gm, '  ')}\n`);
  } else if (!config.demo) {
    console.log(`  From your phone: ${DOCS}#phone\n`);
  }
  if (values.open) openBrowser(open);
}

main().catch((error: Error) => {
  console.error(`pelican: ${error.message}`);
  process.exit(1);
});
