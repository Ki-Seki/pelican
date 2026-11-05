import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

/**
 * The Pelican running on this computer, for the commands that talk to it (`pelican token`,
 * `pelican phone`): they find its port without being told, and tell it apart from another Pelican,
 * or another server, behind an address.
 */

/** This server, told apart from any other: not a secret, it only says "the same one". */
export const instance = randomBytes(9).toString('base64url');

export type Running = { pid: number; port: number; host: string; url: string; instance: string; version: string };

const file = () => path.join(config.stateDir, 'server.json');

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Notes this server as the one running, until it exits. */
export async function recordRunning(info: Omit<Running, 'pid' | 'instance'>): Promise<void> {
  const written = file();
  const record: Running = { pid: process.pid, instance, ...info };
  await mkdir(path.dirname(written), { recursive: true, mode: 0o700 });
  await writeFile(written, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  process.on('exit', () => {
    // Only our own note: another Pelican may have started since and written its own.
    try {
      if ((JSON.parse(readFileSync(written, 'utf8')) as Partial<Running>).pid === process.pid) rmSync(written, { force: true });
    } catch {
      // Gone already.
    }
  });
}

/** The Pelican that last started with this state folder, if it still runs. */
export async function runningServer(): Promise<Running | undefined> {
  try {
    const record = JSON.parse(await readFile(file(), 'utf8')) as Running;
    if (typeof record.pid !== 'number' || typeof record.port !== 'number' || typeof record.url !== 'string') return undefined;
    return alive(record.pid) ? record : undefined;
  } catch {
    return undefined;
  }
}
