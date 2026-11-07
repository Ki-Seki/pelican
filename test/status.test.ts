import { describe, expect, it } from 'vitest';

import type { RunState, SessionSummary } from '../src/shared/protocol';
import { elsewhere, elsewherePlaceholder, elsewhereTip, statusLabel, TIP_KEYS } from '../src/web/lib/status';

const session = (extra: Partial<SessionSummary>): SessionSummary =>
  ({ id: 's', title: 'Fix the login test', cwd: '/code/app', project: 'app', lastActivity: 0, status: 'idle', ...extra });
const run = (extra: Partial<RunState> = {}): RunState => ({ sessionId: 's', cwd: '/code/app', busy: false, settings: {}, permissions: [], partial: [], ...extra });

describe('a session another app has', () => {
  it('is working or waiting there, or open there, as the list says, also while Claude is idle here', () => {
    expect(elsewhere(session({ status: 'live', runningIn: 'the terminal' }), undefined)).toEqual({ situation: 'working', app: 'the terminal' });
    expect(elsewhere(session({ status: 'waiting', runningIn: 'Claude Desktop' }), run())).toEqual({ situation: 'waiting', app: 'Claude Desktop' });
    expect(elsewhere(session({ status: 'live' }), undefined)).toEqual({ situation: 'working', app: 'another app' });
    expect(elsewhere(session({ openIn: 'VS Code' }), run())).toEqual({ situation: 'open', app: 'VS Code' });
    expect(elsewhere(session({}), run())).toBeUndefined();
  });

  it('is not what the session shows while Claude works or asks here', () => {
    expect(elsewhere(session({ status: 'live', runningIn: 'the terminal' }), run({ busy: true }))).toBeUndefined();
    const asking = run({ permissions: [{ id: 'p', sessionId: 's', toolName: 'Bash', input: {}, createdAt: 0 }] });
    expect(elsewhere(session({ status: 'waiting', runningIn: 'the terminal' }), asking)).toBeUndefined();
    // Waiting with no app named is this app's own question, not another app's.
    expect(elsewhere(session({ status: 'waiting' }), undefined)).toBeUndefined();
  });

  it('says its state in the status words, explains each situation once, and the box says what sending does', () => {
    expect(statusLabel('waiting', 'the terminal')).toBe('Needs you in the terminal');
    expect(statusLabel('live', 'Claude Desktop')).toBe('Working in Claude Desktop');
    expect(new Set(Object.values(TIP_KEYS)).size).toBe(3);
    expect(TIP_KEYS.open).toBe('open-elsewhere');
    expect(elsewhereTip({ situation: 'open', app: 'Claude Desktop' })).toBe('Also open in Claude Desktop, which shows what you send here once you reopen the session there.');
    expect(elsewhereTip({ situation: 'waiting', app: 'the terminal' })).toMatch(/^Claude is waiting for an answer in the terminal; answer it there\. A message sent here starts a second Claude/);
    expect(elsewherePlaceholder({ situation: 'working', app: 'the terminal' })).toBe('Working in the terminal · a message starts a second Claude');
    expect(elsewherePlaceholder({ situation: 'waiting', app: 'Claude Desktop' })).toBe('Needs you in Claude Desktop · a message starts a second Claude');
    expect(elsewherePlaceholder({ situation: 'working', app: 'another app' })).toBe('Working elsewhere · a message starts a second Claude');
    expect(elsewherePlaceholder({ situation: 'open', app: 'Claude Desktop' })).toBeUndefined();
  });

  it('says background work between turns as in background: a task is Claude’s to-do list’s', () => {
    expect(statusLabel('idle', undefined, 1)).toBe('1 in background');
    expect(statusLabel('idle', undefined, 3)).toBe('3 in background');
    expect(statusLabel('idle')).toBe('');
    expect(statusLabel('running', undefined, 3)).toBe('Working');
  });
});
