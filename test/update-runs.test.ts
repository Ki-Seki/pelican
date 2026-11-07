// What an update would end, as read from the Claude processes Pelican runs (update.ts,
// runningHere): each open session's Claude, whether it works or waits for an answer, the messages
// queued for the end of its turn, its background work and the checks it scheduled. Pelican's
// open runs stand in here (runner.ts, openRuns); the list Settings makes of them is in
// update.test.ts.
import { describe, expect, it, vi } from 'vitest';

const open = vi.hoisted(() => ({ runs: [] as unknown[] }));
vi.mock('../src/server/runner', async (original) => ({ ...(await original<typeof import('../src/server/runner')>()), openRuns: () => open.runs }));

const { runningHere } = await import('../src/server/update');

/** A session's Claude as runner.ts keeps one, as far as what an update would end reads it. */
const run = (sessionId: string, busy: boolean, status: string, shown: Record<string, unknown> = {}, hasBackgroundTasks = false) => ({
  sessionId, cwd: `/w/${sessionId}`, busy, status: () => status, state: () => shown, hasBackgroundTasks,
});

describe('what an update would end, from the Claude processes Pelican runs', () => {
  it('is each of them: working, waiting for you, with messages queued, background work, checks, or work it shows no one', () => {
    const task = { id: 't1', description: 'npm run dev', type: 'local_bash' };
    open.runs = [
      run('working', true, 'running', { queued: [{ uuid: 'q1' }, { uuid: 'q2' }] }),
      run('waiting', true, 'waiting'),
      run('background', false, 'idle', { tasks: [task], scheduled: [{ id: 'c1' }] }),
      run('watching', false, 'idle', {}, true),
      run('idle', false, 'idle'),
    ];
    expect(runningHere.runs()).toEqual([
      { sessionId: 'working', cwd: '/w/working', busy: true, waiting: false, queued: 2, tasks: [], checks: 0, unseen: false },
      { sessionId: 'waiting', cwd: '/w/waiting', busy: true, waiting: true, queued: 0, tasks: [], checks: 0, unseen: false },
      { sessionId: 'background', cwd: '/w/background', busy: false, waiting: false, queued: 0, tasks: [task], checks: 1, unseen: false },
      { sessionId: 'watching', cwd: '/w/watching', busy: false, waiting: false, queued: 0, tasks: [], checks: 0, unseen: true },
      { sessionId: 'idle', cwd: '/w/idle', busy: false, waiting: false, queued: 0, tasks: [], checks: 0, unseen: false },
    ]);
    open.runs = [];
    expect(runningHere.runs()).toEqual([]);
  });
});
