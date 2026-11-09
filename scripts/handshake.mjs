// Starts Claude Code through the Agent SDK as Pelican starts it, asks what it supports, and ends:
// nothing is sent to Claude, and Claude Code starts with a config folder of its own, empty, so it
// reads no settings and no sign-in of yours. The weekly "Claude Code updates" workflow runs it with
// the newest Claude Code, from its own installer, and the Agent SDK Pelican pins, fetched as
// Pelican fetches it (src/server/agent-sdk.ts), and says in its issue when the two do not start.
//   node scripts/handshake.mjs <folder npm installed the Agent SDK into> <claude>
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [prefix, claude] = process.argv.slice(2);
if (!prefix || !claude) {
  console.error('Usage: node scripts/handshake.mjs <folder npm installed the Agent SDK into> <claude>');
  process.exit(2);
}

const folder = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
const sdk = `Agent SDK ${manifest.version}`;

// Its own config folder and home, empty; and none of the settings this shell may carry for Claude Code.
const home = await mkdtemp(path.join(os.tmpdir(), 'pelican-handshake-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|ANTHROPIC_)/.test(name)));
Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') });
await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });

const version = await new Promise((resolve) => {
  execFile(claude, ['--version'], { env, timeout: 30_000 }, (error, stdout) => resolve(error ? undefined : /\d+\.\d+\.\d+/.exec(String(stdout))?.[0]));
});
const name = `Claude Code ${version ?? `at ${claude}, which says no version,`}`;

let q;
try {
  const { query } = await import(pathToFileURL(path.join(folder, manifest.main ?? 'sdk.mjs')).href);
  // A prompt that never comes: Claude Code starts, answers what it is asked, and sends no turn.
  const never = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  q = query({ prompt: never, options: { pathToClaudeCodeExecutable: claude, cwd: home, env, settingSources: [], persistSession: false } });
  const late = new Promise((_, reject) => setTimeout(() => reject(new Error('it did not answer in 60 seconds')), 60_000).unref());
  const [commands, models] = await Promise.race([Promise.all([q.supportedCommands(), q.supportedModels()]), late]);
  console.log(`${name} starts through ${sdk} as Pelican starts it: it lists ${commands.length} commands and ${models.length} models, and nothing was sent to Claude.`);
} catch (error) {
  console.log(`${name} does not start through ${sdk} as Pelican starts it: ${String(error?.message ?? error).trim()}`);
  process.exitCode = 1;
} finally {
  q?.close();
  await rm(home, { recursive: true, force: true });
}
