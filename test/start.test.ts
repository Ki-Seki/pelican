import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../src/shared/protocol';
import { defaultStart, newSessionQuery } from '../src/web/lib/start';

const session = (id: string, cwd: string, lastActivity: number, more: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, title: id, cwd, project: cwd.split('/').at(-1)!, lastActivity, status: 'idle', ...more }) as SessionSummary;

describe('where + starts a session', () => {
  const sessions = [
    session('scratch', '/home/a/scratch/x', 900, { scratch: true }),
    session('temp', '/tmp/run', 800, { temp: true }),
    session('archived', '/code/old', 700, { archived: true }),
    session('web', '/code/web', 600),
    session('api', '/code/api', 500),
    session('web-older', '/code/web', 100),
  ];

  it('is the newest session’s folder, leaving out scratch, temporary and archived ones', () => {
    expect(defaultStart(sessions)).toEqual({ cwd: '/code/web' });
  });

  it('is the newest folder of the project the list shows', () => {
    expect(defaultStart(sessions, 'api')).toEqual({ cwd: '/code/api' });
    // A project with nothing to start in falls back to the newest folder anywhere.
    expect(defaultStart(sessions, 'old')).toEqual({ cwd: '/code/web' });
  });

  it('does not depend on the order the list comes in', () => {
    expect(defaultStart([...sessions].reverse())).toEqual({ cwd: '/code/web' });
  });

  it('is nowhere before the first session, so the folder is asked for', () => {
    expect(defaultStart([])).toBeUndefined();
    expect(defaultStart([session('s', '/home/a/scratch/y', 1, { scratch: true })])).toBeUndefined();
    expect(newSessionQuery(undefined)).toBe('?new');
  });

  it('becomes a route that keeps any folder name intact', () => {
    expect(newSessionQuery({ cwd: '/code/my app&co?x=1' })).toBe('?new&cwd=%2Fcode%2Fmy%20app%26co%3Fx%3D1');
    expect(new URLSearchParams(newSessionQuery({ cwd: '/code/my app&co?x=1' })).get('cwd')).toBe('/code/my app&co?x=1');
    expect(newSessionQuery({ scratch: true })).toBe('?new&scratch');
  });
});
