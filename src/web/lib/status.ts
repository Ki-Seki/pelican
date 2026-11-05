import type { RunState, SessionStatus, SessionSummary } from '../../shared/protocol';

/**
 * What a session is doing, in words. `tasks`: background tasks and subagents still running in it
 * (and checks Claude stays running for), said between turns as "2 tasks".
 */
export function statusLabel(status: SessionStatus, runningIn?: string, tasks = 0): string {
  if (status === 'running') return 'Working';
  if (status === 'waiting') return runningIn ? `Needs you in ${runningIn}` : 'Needs you';
  if (status === 'live') return runningIn ? `Working in ${runningIn}` : 'Working elsewhere';
  if (tasks > 0) return tasks === 1 ? '1 task' : `${tasks} tasks`;
  return '';
}

/**
 * Another app has the session: open there and idle, at work on it there, or waiting there for an
 * answer only it can give. Its Claude holds the conversation as it last saw it.
 */
export type Elsewhere = { situation: 'open' | 'working' | 'waiting'; app: string };

/** What another app is doing with the session, unless Claude is at work or asking here. */
export function elsewhere(session: SessionSummary | undefined, run: RunState | undefined): Elsewhere | undefined {
  if (!session || (run && (run.busy || run.permissions.length > 0))) return undefined;
  if (session.status === 'waiting' && session.runningIn) return { situation: 'waiting', app: session.runningIn };
  if (session.status === 'live') return { situation: 'working', app: session.runningIn ?? 'another app' };
  if (session.status === 'idle' && session.openIn) return { situation: 'open', app: session.openIn };
  return undefined;
}

/** Each situation is explained once in a browser, by a tip that stays until it is closed. */
export const TIP_KEYS: Record<Elsewhere['situation'], string> = { open: 'open-elsewhere', working: 'working-elsewhere', waiting: 'waiting-elsewhere' };

export function elsewhereTip({ situation, app }: Elsewhere): string {
  if (situation === 'open') return `Also open in ${app}, which shows what you send here once you reopen the session there.`;
  if (situation === 'working') return `Claude is working on this session in ${app}. A message sent here starts a second Claude on the same conversation.`;
  return `Claude is waiting for an answer in ${app}; answer it there. A message sent here starts a second Claude on the same conversation.`;
}

/** While another app works or waits, the empty message box says what sending does. */
export function elsewherePlaceholder({ situation, app }: Elsewhere): string | undefined {
  if (situation === 'open') return undefined;
  const where = app === 'another app' ? undefined : app;
  return `${statusLabel(situation === 'waiting' ? 'waiting' : 'live', where)} · a message starts a second Claude`;
}
