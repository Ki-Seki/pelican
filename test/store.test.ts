// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, MessagesPage, RunState } from '../src/shared/protocol';
import { api } from '../src/web/lib/api';
import { socket } from '../src/web/lib/socket';
import { addLocalMessage, getView, handleEvent, loadLatest, merge, syncRun } from '../src/web/lib/store';

const text = (uuid: string, body: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ uuid, role: 'user', blocks: [{ type: 'text', text: body }], ...extra });
const page = (messages: ChatMessage[]): MessagesPage => ({ messages, total: messages.length, offset: 0 });
const run = (sessionId: string, extra: Partial<RunState> = {}): RunState =>
  ({ sessionId, cwd: '/w', busy: true, settings: {}, permissions: [], partial: [], ...extra });
const uuids = (sessionId: string) => getView(sessionId).messages.map((m) => m.uuid);

afterEach(() => vi.restoreAllMocks());

describe('merging messages', () => {
  it('confirms a local copy, never the other way round, also under the id the transcript gave it', () => {
    const local = text('m1', 'hi', { pending: true });
    const confirmed = text('m1', 'hi', { timestamp: 1 });
    expect(merge([local], [confirmed])).toEqual([confirmed]);
    expect(merge([confirmed], [local])).toEqual([confirmed]);
    const steered = text('t1', 'hi', { steered: true, sourceUuid: 'm1' });
    expect(merge([text('m0', 'before'), local], [steered])).toEqual([text('m0', 'before'), steered]);
    expect(merge([steered], [text('m1', 'again', { pending: true })])).toEqual([steered]);
  });
});

describe('loading the newest page', () => {
  it('keeps what the page cannot know yet: newer messages from the socket and unsent local ones', async () => {
    const id = 'session-load';
    const first = [text('u1', 'one', { timestamp: 1 }), text('a1', 'two', { timestamp: 2 })];
    vi.spyOn(api, 'messages').mockResolvedValue(page(first));
    await loadLatest(id);
    expect(uuids(id)).toEqual(['u1', 'a1']);
    handleEvent({ type: 'message', sessionId: id, message: text('a2', 'three', { timestamp: 3 }) });
    addLocalMessage(id, text('p1', 'mine', { pending: true, timestamp: 4 }));
    // A page read before a2 arrived.
    await loadLatest(id);
    expect(uuids(id)).toEqual(['u1', 'a1', 'a2', 'p1']);
  });
});

describe('a session’s run', () => {
  it('follows the socket: whole states, then appended text; a copy that does not match asks again', async () => {
    const id = 'session-run';
    addLocalMessage(id, text('u1', 'go'));
    handleEvent({ type: 'run', state: run(id, { partial: [{ type: 'text', text: 'Hel' }] }) });
    handleEvent({ type: 'partial', sessionId: id, appends: [{ index: 0, from: 3, text: 'lo' }] });
    expect(getView(id).run?.partial).toEqual([{ type: 'text', text: 'Hello' }]);
    const refresh = vi.spyOn(socket, 'refresh');
    handleEvent({ type: 'partial', sessionId: id, appends: [{ index: 0, from: 99, text: '!' }] });
    expect(getView(id).run?.partial).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(refresh).toHaveBeenCalledWith(id);
  });

  it('is cleared when the server says none runs, and the transcript is read again', async () => {
    const id = 'session-gone';
    addLocalMessage(id, text('u1', 'go'));
    handleEvent({ type: 'run', state: run(id) });
    const messages = vi.spyOn(api, 'messages').mockResolvedValue(page([text('u1', 'go'), text('a1', 'done')]));
    handleEvent({ type: 'run', sessionId: id, state: null });
    expect(getView(id).run).toBeUndefined();
    expect(messages).toHaveBeenCalledWith(id);
  });

  it('takes a page load’s word only until the socket has answered', () => {
    const id = 'session-sync';
    addLocalMessage(id, text('u1', 'go'));
    syncRun(id, run(id));
    expect(getView(id).run?.busy).toBe(true);
    vi.spyOn(api, 'messages').mockResolvedValue(page([]));
    syncRun(id, null);
    expect(getView(id).run).toBeUndefined();
    handleEvent({ type: 'run', state: run(id) });
    // A page load read before the socket answered says no run: the socket knows better.
    syncRun(id, null);
    expect(getView(id).run?.busy).toBe(true);
  });
});
