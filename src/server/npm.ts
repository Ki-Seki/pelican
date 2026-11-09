import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Running npm, for what Pelican installs: an update of itself (update.ts) and Anthropic's Agent SDK
 * (agent-sdk.ts). Always the npm of the Node running Pelican, run with that Node, with the user's
 * own npm settings and nothing an earlier npm left in the environment.
 */

/** What a program said, and how it ended: -1 where it could not run, or took too long. */
export type Ran = { code: number; stdout: string; stderr: string };

/** npm: the program, and the arguments before npm's own. */
export type Npm = { file: string; args: string[] };

/**
 * The npm of the Node running Pelican, run with that Node: npm-cli.js where Node's installers put
 * it (beside `bin`, as the official installer, Homebrew, nvm, fnm and Volta do), or what the `npm`
 * beside `node` links to. Not the first npm on PATH, which may be another Node's, with another
 * global folder.
 */
export function npmBeside(execPath: string, platform: NodeJS.Platform = process.platform): Npm | undefined {
  const bin = path.dirname(execPath);
  const clis = [path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const cli of clis) if (existsSync(cli)) return { file: execPath, args: [path.normalize(cli)] };
  try {
    const linked = realpathSync(path.join(bin, platform === 'win32' ? 'npm.cmd' : 'npm'));
    if (linked.endsWith('npm-cli.js')) return { file: execPath, args: [linked] };
  } catch {
    // No npm beside it.
  }
  return undefined;
}

/** The environment npm runs with: Pelican's, with nothing an earlier npm left of its own run (npx, npm start). */
export function npmEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!/^npm_(lifecycle_|package_|command$|execpath$|node_execpath$)/i.test(name)) kept[name] = value;
  return kept;
}

const quoted = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * A word of a shell command, quoted when it needs to be. A path under the home folder keeps its ~
 * outside the quotes (`~/'my projects/pelican'`), as the shell expands only a bare one.
 */
export function shellWord(word: string): string {
  if (/^[\w./:@%+=,-]+$/.test(word)) return word;
  if (word === '~' || /^~\/[\w./:@%+=,-]*$/.test(word)) return word;
  if (word.startsWith('~/')) return `~/${quoted(word.slice(2))}`;
  return quoted(word);
}

/** The first line of a text, cut at `max` characters, with … where something was left out. */
export const clipped = (text: string, max = 80) => {
  const line = text.split('\n')[0]!.trim();
  return line.length > max || text.includes('\n') ? `${line.slice(0, max).trimEnd()}…` : line;
};

/** The end of what a program printed, for saying why it failed: its last lines, at most 600 characters. */
export function tail(ran: Ran): string {
  const lines = `${ran.stderr}\n${ran.stdout}`.split('\n').map((line) => line.trimEnd()).filter((line) => line && !/^npm (notice|warn)/i.test(line));
  const text = lines.slice(-6).join('\n');
  return (text.length > 600 ? `…${text.slice(-600)}` : text) || (ran.code === -1 ? 'it could not run, or took too long' : `exit code ${ran.code}`);
}

/**
 * What npm said went wrong, in a line: its error's code and first words (`ECONNREFUSED: request to
 * … failed`), without its stack, its fields, its advice and where its log is.
 */
export function npmSaid(ran: Ran): string {
  const said = `${ran.stderr}\n${ran.stdout}`.split('\n').flatMap((line) => {
    const match = /^npm (?:error|ERR!)(?: (.*))?$/.exec(line.trimEnd());
    return match ? [match[1] ?? ''] : [];
  });
  const code = said.map((line) => /^code (\S+)$/.exec(line)?.[1]).find(Boolean);
  const message = said.find((line) => line && !/^\s/.test(line) && !/^(code|syscall|errno|path|dest|signal|command|cwd) /.test(line)
    && !/^[{}]$/.test(line) && !/^(A complete log|If you are behind a proxy|In most cases|'?proxy'? config)/.test(line));
  if (!code && !message) return tail(ran);
  return clipped([code, message?.replace(/^(notarget|404|403|401) +/, '').trim()].filter(Boolean).join(': '), 400);
}
