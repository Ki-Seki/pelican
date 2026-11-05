// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, McpServer, RunState } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';

Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });
// The page's own address, as in a browser.
Object.assign(globalThis, { location: new URL('http://localhost:7860/') });

const { nextStep } = await import('../src/shared/errors');
const { buildItems } = await import('../src/web/lib/turns');
const { cancelCheck, promptBefore, resend } = await import('../src/web/lib/next-steps');
const { api } = await import('../src/web/lib/api');
const { MessageList } = await import('../src/web/components/MessageList');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const user = (uuid: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }], ...extra });
const apiError = (uuid: string, text: string, error?: string): ChatMessage => ({ uuid, role: 'assistant', blocks: [{ type: 'text', text }], apiError: true, ...(error ? { error } : {}) });
const reply = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'assistant', blocks: [{ type: 'text', text }] });
const view = (messages: ChatMessage[], run?: RunState): SessionView => ({ messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false, ...(run ? { run } : {}) });

describe('an API error the conversation ends on', () => {
  it('is too long for the model: the way on is /compact; anything else: send the prompt again', () => {
    expect(nextStep('Prompt is too long: 210000 tokens > 200000 maximum')).toBe('compact');
    expect(nextStep('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}')).toBe('retry');
    expect(nextStep('', 'authentication_failed')).toBe('retry');
  });

  it('offers Retry, which sends its prompt again', () => {
    const onRetry = vi.fn();
    render(<MessageList sessionId="s" view={view([user('u1', 'Profile the export'), apiError('e1', 'API Error: 529 overloaded', 'overloaded')])} mode="normal" onRetry={onRetry} onCompact={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'user', key: 'u1', text: 'Profile the export' }));
  });

  it('too long, offers Compact', () => {
    const onCompact = vi.fn();
    render(<MessageList sessionId="s" view={view([user('u1', 'Go on'), apiError('e1', 'Prompt is too long')])} mode="normal" onRetry={vi.fn()} onCompact={onCompact} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    expect(onCompact).toHaveBeenCalled();
  });

  it('offers nothing once the conversation went on, or while Claude works', () => {
    const later = [user('u1', 'Go on'), apiError('e1', 'API Error: 529 overloaded'), user('u2', 'Try again'), reply('a2', 'Done.')];
    const { unmount } = render(<MessageList sessionId="s" view={view(later)} mode="normal" onRetry={vi.fn()} onCompact={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    unmount();
    const busy: RunState = { sessionId: 's', cwd: '/p', busy: true, settings: {}, permissions: [], partial: [] };
    render(<MessageList sessionId="s" view={view([user('u1', 'Go on'), apiError('e1', 'API Error: 529 overloaded')], busy)} mode="normal" onRetry={vi.fn()} onCompact={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('after a ! command Claude answered, sends nothing in its place', () => {
    const items = buildItems([user('u1', 'Fix it'), user('c1', '<bash-input>npm test</bash-input>'), user('c2', '<bash-stdout>1 failed</bash-stdout><bash-stderr></bash-stderr>'), apiError('e1', 'API Error: 529 overloaded')]);
    expect(promptBefore(items, items.length - 1)).toBeUndefined();
    const plain = buildItems([user('u1', 'Fix it'), reply('a1', 'Looking.'), apiError('e1', 'API Error: 529 overloaded')]);
    expect(promptBefore(plain, plain.length - 1)).toMatchObject({ key: 'u1' });
  });
});

describe('sending a prompt again', () => {
  it('sends its words and the files it named, and a command as a command', async () => {
    const [prompt] = buildItems([user('u1', 'Summarize this\n\nAttached files:\n- /home/me/.local/state/pelican/uploads/0a1b2c3d-0000-4000-8000-000000000001/notes.txt (notes.txt)')]);
    expect(await resend(prompt as never)).toEqual({
      text: 'Summarize this\n\nAttached files:\n- /home/me/.local/state/pelican/uploads/0a1b2c3d-0000-4000-8000-000000000001/notes.txt (notes.txt)',
      attachments: [],
    });
    const [command] = buildItems([user('c1', '<command-name>/review</command-name><command-args>main</command-args>')]);
    expect(await resend(command as never)).toEqual({ text: '/review main', attachments: [] });
  });

  it('sends its pictures again, read back from the conversation', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    });
    const upload = vi.spyOn(api, 'upload').mockImplementation(async (file: File) => ({ id: 'up1', name: file.name, mime: file.type, size: file.size, path: '/tmp/up1' }));
    const [prompt] = buildItems([{ uuid: 'u1', role: 'user', blocks: [{ type: 'image', source: { type: 'url', url: 'api/sessions/s/images/u1/0' } }, { type: 'text', text: 'Why is this red?' }] }]);
    const again = await resend(prompt as never);
    expect(fetched).toEqual(['api/sessions/s/images/u1/0']);
    const file = upload.mock.calls[0]![0];
    expect([file.name, file.type]).toEqual(['image-1.png', 'image/png']);
    expect(again).toMatchObject({ text: 'Why is this red?', attachments: [{ id: 'up1' }] });
    vi.unstubAllGlobals();
  });
});

describe('cancelling a check Claude scheduled', () => {
  it('asks Claude, in Claude Code’s terms', () => {
    expect(cancelCheck({ id: '3f9a2c1b', what: 'Every 10 minutes: check the deploy', repeats: true })).toBe('Cancel the scheduled task 3f9a2c1b (Every 10 minutes: check the deploy).');
    expect(cancelCheck({ id: 'wakeup', what: 'check whether CI passed', repeats: false })).toBe('Stop the loop (check whether CI passed).');
  });
});

describe('the session menu', async () => {
  const { SessionMenu } = await import('../src/web/components/SessionMenu');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
  const run = (extra: Partial<RunState>): RunState => ({ sessionId: 's', cwd: '/p', busy: false, settings: {}, permissions: [], partial: [], ...extra });
  const menu = (props: { run?: RunState; servers?: McpServer[]; live?: boolean }) => {
    vi.spyOn(api, 'mcp').mockResolvedValue({ servers: props.servers ?? [], live: props.live ?? false });
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionMenu open onClose={() => {}} sessionId="s" machine="laptop" {...(props.run ? { run: props.run } : {})} onRenamed={() => {}} onForked={() => {}} onDeleted={() => {}} />
      </QueryClientProvider>,
    );
  };

  it('says what the session has cost, as an estimate, where Claude Code counts it', () => {
    menu({ run: run({ costUsd: 1.8432 }) });
    expect(screen.getByText('Session cost')).toBeTruthy();
    expect(screen.getByText('$1.84 (estimate)')).toBeTruthy();
  });

  it('says nothing of cost where a subscription pays', () => {
    menu({ run: run({}) });
    expect(screen.queryByText('Session cost')).toBeNull();
  });

  it('says where to sign in to a server that needs it', async () => {
    menu({ servers: [{ name: 'linear', status: 'needs-auth', tools: 0, scope: 'project' }, { name: 'Gmail', status: 'needs-auth', tools: 0, scope: 'claudeai' }], live: true });
    fireEvent.click(await screen.findByText('2 more need signing in'));
    expect(screen.getByText('claude mcp login linear')).toBeTruthy();
    expect(screen.getAllByText(/in a terminal on laptop, then Reconnect/)).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'claude.ai/customize/connectors' })).toBeTruthy();
  });
});
