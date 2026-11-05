import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { type Held, holderFor, keepAwake } from '../src/server/awake';

/** A stand-in for caffeinate or systemd-inhibit: started and stopped, never run. */
function fakeSpawner() {
  const started: Array<{ command: string; args: string[]; killed: boolean; child: EventEmitter }> = [];
  const spawner = (command: string, args: string[]): Held => {
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
    const entry = { command, args, killed: false, child };
    child.kill = () => {
      entry.killed = true;
      child.emit('exit', null);
      return true;
    };
    started.push(entry);
    return child;
  };
  return { started, spawner };
}

describe('keeping the computer awake', () => {
  it('uses the system’s own tool, tied to Pelican’s process so a crash releases it', () => {
    expect(holderFor('darwin', 42)).toEqual({ command: 'caffeinate', args: ['-i', '-w', '42'] });
    expect(holderFor('linux', 42)?.args).toEqual(['--what=idle:sleep', '--who=Pelican', '--why=Claude is working', '--mode=block', 'tail', '--pid=42', '-f', '/dev/null']);
    expect(holderFor('win32', 42)).toBeUndefined();
  });

  it('holds while Claude works and lets go when it stops', async () => {
    let working = false;
    const { started, spawner } = fakeSpawner();
    const awake = keepAwake({ working: () => working, platform: 'darwin', pid: 7, everyMs: 60_000, spawner });
    await awake.check();
    expect(started).toHaveLength(0);
    working = true;
    await awake.check();
    await awake.check();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ command: 'caffeinate', args: ['-i', '-w', '7'], killed: false });
    working = false;
    await awake.check();
    expect(started[0]!.killed).toBe(true);
    working = true;
    await awake.check();
    expect(started).toHaveLength(2);
    awake.stop();
    expect(started[1]!.killed).toBe(true);
  });

  it('stops trying where the tool is missing or may not hold the computer', async () => {
    const { started, spawner } = fakeSpawner();
    const awake = keepAwake({ working: () => true, platform: 'linux', pid: 7, everyMs: 60_000, spawner });
    await awake.check();
    started[0]!.child.emit('exit', 1);
    await awake.check();
    expect(started).toHaveLength(1);
    awake.stop();
    const nothing = keepAwake({ working: () => true, platform: 'win32', everyMs: 60_000, spawner });
    await nothing.check();
    expect(started).toHaveLength(1);
    nothing.stop();
  });
});
