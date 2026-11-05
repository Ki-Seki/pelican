import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Keeps the computer from sleeping while Claude works, so a turn started from the phone is not cut
 * off when the computer would idle to sleep, and the phone finds Pelican when it comes back. The
 * system's own tools hold the assertion and release it when Pelican exits, even if it crashes:
 * `caffeinate -i -w <pid>` on macOS, `systemd-inhibit` around `tail --pid` on Linux. A closed
 * laptop lid still sleeps, unless the computer is on power with a display attached.
 */

export type Holder = { command: string; args: string[] };

/** The command that holds the computer awake for as long as it runs; none where there is no such tool. */
export function holderFor(platform: NodeJS.Platform, pid: number): Holder | undefined {
  if (platform === 'darwin') return { command: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'linux') {
    return {
      command: 'systemd-inhibit',
      args: ['--what=idle:sleep', '--who=Pelican', '--why=Claude is working', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'],
    };
  }
  return undefined;
}

/** What is needed of the process that holds the computer awake. */
export type Held = {
  kill: () => unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
};
export type Spawner = (command: string, args: string[]) => Held;

const defaultSpawn: Spawner = (command, args) => {
  const child: ChildProcess = spawn(command, args, { stdio: 'ignore' });
  child.unref();
  return child;
};

/**
 * Watches whether Claude is working, and holds the computer awake while it is.
 * `working` is asked every `everyMs`; the holder starts and stops with it.
 */
export function keepAwake({
  working,
  platform = process.platform,
  pid = process.pid,
  everyMs = 15_000,
  spawner = defaultSpawn,
}: {
  working: () => boolean | Promise<boolean>;
  platform?: NodeJS.Platform;
  pid?: number;
  everyMs?: number;
  spawner?: Spawner;
}): { check: () => Promise<void>; stop: () => void } {
  const holder = holderFor(platform, pid);
  let held: Held | undefined;
  // A tool that is missing, or that may not hold the computer awake here, is not tried again.
  let failed = !holder;

  const release = () => {
    held?.kill();
    held = undefined;
  };

  const check = async () => {
    if (failed) return;
    const busy = await Promise.resolve(working()).catch(() => false);
    if (busy && !held) {
      const child = spawner(holder!.command, holder!.args);
      held = child;
      child.on('error', () => {
        failed = true;
        if (held === child) held = undefined;
      });
      child.on('exit', (code) => {
        if (held !== child) return;
        held = undefined;
        // Exiting by itself, without being released: it could not hold the computer awake.
        if (code !== 0 && code !== null) failed = true;
      });
    } else if (!busy && held) {
      release();
    }
  };

  const timer = setInterval(() => void check(), everyMs);
  timer.unref();
  process.on('exit', release);
  return {
    check,
    stop: () => {
      clearInterval(timer);
      process.off('exit', release);
      release();
    },
  };
}
