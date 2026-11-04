import { spawn } from 'node:child_process';
import os from 'node:os';
import { parseArgs } from 'node:util';

import pkg from '../../package.json' with { type: 'json' };
import { config } from './config.js';
import { listensLocally } from './security.js';

const HELP = `Pelican ${pkg.version}: your Claude Code sessions, from any browser.

Usage
  pelican [options]           Start the server
  pelican password            Set or change the password that protects it
  pelican password --off      Remove the password

Options
  -p, --port <port>           Port to listen on (default 7860, or PELICAN_PORT)
  -H, --host <address>        Address to listen on (default 127.0.0.1, or PELICAN_HOST)
      --name <name>           Name shown for this machine (default: its host name)
      --no-auth               Never ask for a password, also beyond this machine.
                              For when something in front authenticates.
      --demo                  Show made-up sessions; nothing runs
      --open                  Open the browser
  -v, --version               Print the version
  -h, --help                  Show this help

Pelican listens on 127.0.0.1 by default, so only this machine can reach it.
To use it from your phone, see https://github.com/Ki-Seki/pelican#use-it-from-your-phone
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
    console.log('Password removed. Pelican no longer asks for one; restart it to apply.');
    return;
  }
  const password = stdin ? await readStdin() : await askHidden('New password: ');
  if (password.length < 8) throw new Error('Use at least 8 characters.');
  if (!stdin && (await askHidden('Repeat it: ')) !== password) throw new Error('The two did not match.');
  await setPassword(password);
  console.log(`Password saved in ${config.configDir}. Restart Pelican to apply; signed-in browsers are signed out.`);
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
      stdin: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void console.log(pkg.version);
  if (positionals[0] === 'password') return passwordCommand(Boolean(values.off), Boolean(values.stdin));
  if (positionals.length > 0) throw new Error(`Unknown command: ${positionals.join(' ')}. See pelican --help.`);

  if (values.port) config.port = Number(values.port);
  if (values.host) config.host = values.host;
  if (values.name) config.machine = values.name;
  if (values['no-auth']) config.auth = 'none';
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) throw new Error(`Not a port: ${values.port}`);

  if (values.demo) {
    config.demo = true;
    const { prepareDemo } = await import('./demo.js');
    await prepareDemo();
    if (!values.name) config.machine = 'demo';
  }

  const { loadAuth, passwordSet } = await import('./auth.js');
  // The demo shows nothing private, so it never asks for this machine's password.
  if (!config.demo) await loadAuth();
  const local = listensLocally(config.host);
  if (!local && !passwordSet() && config.auth !== 'none' && !config.demo) {
    throw new Error([
      `Pelican would listen on ${config.host}, which other machines can reach, and no password is set.`,
      'Set one with `pelican password`, or pass --no-auth if something in front already authenticates.',
    ].join('\n'));
  }

  const { startServer } = await import('./server.js');
  const { url } = await startServer();
  const shown = url.replace('://127.0.0.1:', '://localhost:');
  const protection = config.demo ? 'demo: made-up sessions, nothing runs'
    : passwordSet() ? 'password required'
      : local ? 'no password: only this machine can reach it' : 'no password (--no-auth)';
  console.log(`\n  Pelican ${pkg.version} · ${config.machine}\n  ${shown}\n  ${protection}\n`);
  // Listening beyond this computer: the address a phone on the same network can open, as a QR code.
  if (!local) {
    const { qrTerminal } = await import('./qr.js');
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    const phone = config.host === '0.0.0.0' || config.host === '::' ? (lan ? `http://${lan.address}:${config.port}/` : undefined) : url;
    if (phone) console.log(`  On your phone: ${phone}\n\n${qrTerminal(phone).replace(/^/gm, '  ')}\n`);
  } else if (!config.demo) {
    console.log('  From your phone: https://ki-seki.github.io/pelican/docs.html#phone\n');
  }
  if (!config.webDir) console.log('  The web app is not built: run `npm run build` (or use `npm run dev`).\n');
  if (values.open) openBrowser(shown);
}

main().catch((error: Error) => {
  console.error(`pelican: ${error.message}`);
  process.exit(1);
});
