import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../src/shared/protocol';
import { fold } from '../src/web/lib/fold';

const session = (id: string, title: string, cwd = '/code/app', status: SessionSummary['status'] = 'idle', tasks?: number): SessionSummary =>
  ({ id, title, cwd, project: 'app', lastActivity: 0, createdAt: 0, status, sizeBytes: 0, ...(tasks ? { tasks } : {}) }) as SessionSummary;

describe('fold', () => {
  it('folds sessions with the same folder and title into the newest, keeping the order', () => {
    const entries = fold([session('a', 'Check the queue'), session('b', 'Fix a bug'), session('c', 'Check the queue '), session('d', 'Check the queue')]);
    expect(entries.map((e) => [e.session.id, e.earlier.map((s) => s.id)])).toEqual([['a', ['c', 'd']], ['b', []]]);
  });

  it('keeps apart sessions in other folders, and never folds one that is working or waiting', () => {
    const entries = fold([session('a', 'Check', '/code/app', 'running'), session('b', 'Check'), session('c', 'Check', '/code/other'), session('d', 'Check', '/code/app', 'waiting'), session('e', 'Check')]);
    expect(entries.map((e) => [e.session.id, e.earlier.map((s) => s.id)])).toEqual([['a', []], ['b', ['e']], ['c', []], ['d', []]]);
  });

  it('never folds one with background tasks still running between turns', () => {
    const entries = fold([session('a', 'Check', '/code/app', 'idle', 2), session('b', 'Check'), session('c', 'Check')]);
    expect(entries.map((e) => [e.session.id, e.earlier.map((s) => s.id)])).toEqual([['a', []], ['b', ['c']]]);
  });

  it('never folds a pinned one into another: it leads its own row, and the earlier ones fold into it', () => {
    const pinned = (s: SessionSummary): SessionSummary => ({ ...s, pinned: true });
    const entries = fold([session('a', 'Check'), session('b', 'Check'), pinned(session('c', 'Check')), session('d', 'Check'), session('e', 'Check')]);
    expect(entries.map((e) => [e.session.id, e.earlier.map((s) => s.id)])).toEqual([['a', ['b']], ['c', ['d', 'e']]]);
  });
});
