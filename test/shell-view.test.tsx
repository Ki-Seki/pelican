// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, LiveShell } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';

Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });

const { buildItems } = await import('../src/web/lib/turns');
const { addShell, handleShellEvent, useLiveShells } = await import('../src/web/lib/shells');
const { socket } = await import('../src/web/lib/socket');
const { api } = await import('../src/web/lib/api');
const { MessageList } = await import('../src/web/components/MessageList');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const user = (uuid: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }], ...extra });

describe('a ! command in the conversation', () => {
  it('as Claude Code writes it, the command and its output in two messages, is one item', () => {
    const items = buildItems([
      user('c0', '<local-command-caveat>The command below was run directly in Claude Code…</local-command-caveat>', { meta: true }),
      user('c1', '<bash-input>npm test</bash-input>'),
      user('c2', '<bash-stdout>2 passed</bash-stdout><bash-stderr>warn: slow</bash-stderr>'),
    ]);
    expect(items).toEqual([{ kind: 'shell', key: 'c1', command: 'npm test', stdout: '2 passed', stderr: 'warn: slow' }]);
  });

  it('output with no command before it shows nothing', () => {
    expect(buildItems([user('c2', '<bash-stdout>stray</bash-stdout><bash-stderr></bash-stderr>')])).toEqual([]);
  });
});

const live = (extra: Partial<LiveShell> = {}): LiveShell => ({ id: 'run-1', command: 'npm test', startedAt: Date.now(), output: '', ...extra });

describe('the commands a page knows of', () => {
  function Probe({ sessionId }: { sessionId: string }) {
    return <div data-testid="ids">{useLiveShells(sessionId).map((s) => `${s.id}:${s.output}`).join(',')}</div>;
  }

  it('follow the server: the list, then the output as it comes', () => {
    render(<Probe sessionId="s1" />);
    act(() => handleShellEvent({ type: 'shells', sessionId: 's1', shells: [live()] }));
    act(() => handleShellEvent({ type: 'shell_output', sessionId: 's1', id: 'run-1', from: 0, text: 'PASS ' }));
    act(() => handleShellEvent({ type: 'shell_output', sessionId: 's1', id: 'run-1', from: 5, text: 'a.test.ts' }));
    expect(screen.getByTestId('ids').textContent).toBe('run-1:PASS a.test.ts');
  });

  it('ask for the whole list again when a piece is missing', () => {
    const refresh = vi.spyOn(socket, 'refresh').mockImplementation(() => {});
    act(() => handleShellEvent({ type: 'shells', sessionId: 's2', shells: [live({ output: 'abc' })] }));
    act(() => handleShellEvent({ type: 'shell_output', sessionId: 's2', id: 'run-1', from: 9, text: 'x' }));
    expect(refresh).toHaveBeenCalledWith('s2');
  });

  it('a command that ended before the answer to starting it came back stays gone', () => {
    render(<Probe sessionId="s3" />);
    act(() => handleShellEvent({ type: 'shells', sessionId: 's3', shells: [live({ id: 'quick' })] }));
    act(() => handleShellEvent({ type: 'shells', sessionId: 's3', shells: [] }));
    act(() => addShell('s3', live({ id: 'quick' })));
    expect(screen.getByTestId('ids').textContent).toBe('');
    act(() => addShell('s3', live({ id: 'slow' })));
    expect(screen.getByTestId('ids').textContent).toBe('slow:');
  });
});

describe('a running command', () => {
  const view = (messages: ChatMessage[]): SessionView => ({ messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false });

  it('shows its output and Stop, named for the command, which stops it', () => {
    const stop = vi.spyOn(api, 'stopShell').mockResolvedValue({ ok: true });
    act(() => handleShellEvent({ type: 'shells', sessionId: 's4', shells: [live({ output: 'Running 12 tests\n' })] }));
    render(<MessageList sessionId="s4" view={view([])} mode="normal" />);
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText(/Running 12 tests/)).toBeTruthy();
    // Not the turn's own Stop, by the message box: this one ends the command.
    fireEvent.click(screen.getByRole('button', { name: 'Stop npm test' }));
    expect(stop).toHaveBeenCalledWith('s4', 'run-1');
    expect(screen.getByRole('button', { name: 'Stopping npm test' })).toBeTruthy();
  });

  it('names a long or many-line command by its first line, cut short', () => {
    const command = `cat <<'EOF' > notes.txt\n${'x'.repeat(200)}\nEOF`;
    act(() => handleShellEvent({ type: 'shells', sessionId: 's7', shells: [live({ id: 'r7', command })] }));
    render(<MessageList sessionId="s7" view={view([])} mode="normal" />);
    expect(screen.getByRole('button', { name: "Stop cat <<'EOF' > notes.txt" })).toBeTruthy();
    cleanup();
    act(() => handleShellEvent({ type: 'shells', sessionId: 's8', shells: [live({ id: 'r8', command: `echo ${'y'.repeat(100)}` })] }));
    render(<MessageList sessionId="s8" view={view([])} mode="normal" />);
    expect(screen.getByRole('button', { name: `Stop echo ${'y'.repeat(54)}…` })).toBeTruthy();
  });

  it('gives way to its record, never both at once', () => {
    act(() => handleShellEvent({ type: 'shells', sessionId: 's5', shells: [live({ id: 'r5', output: 'ok\n', done: { code: 0 } })] }));
    const record = [user('r5', '<bash-input>npm test</bash-input>'), user('o5', '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>')];
    const { rerender } = render(<MessageList sessionId="s5" view={view(record)} mode="normal" />);
    expect(screen.getAllByText('npm test')).toHaveLength(1);
    act(() => handleShellEvent({ type: 'shells', sessionId: 's5', shells: [] }));
    rerender(<MessageList sessionId="s5" view={view(record)} mode="normal" />);
    expect(screen.getAllByText('npm test')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('once done and recorded, shows the end of a long output as it did while it ran, and Show all its start', () => {
    const lines = Array.from({ length: 40 }, (_, i) => ` ✓ src/test-${i + 1}.test.ts (3 tests)`);
    const output = `> vitest run\n${lines.join('\n')}\n\n Test Files  40 passed (40)\n      Tests  120 passed (120)`;
    const record = [user('r9', '<bash-input>npm test</bash-input>'), user('o9', `<bash-stdout>${output}</bash-stdout><bash-stderr></bash-stderr>`)];
    render(<MessageList sessionId="s9" view={view(record)} mode="normal" />);
    const shown = () => screen.getByText(/Tests 120 passed/).textContent ?? '';
    expect(shown()).toContain('src/test-40.test.ts');
    expect(shown()).not.toContain('> vitest run');
    expect(shown()).not.toContain('src/test-1.test.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(shown()).toContain('> vitest run');
    expect(shown()).toContain('src/test-1.test.ts (3 tests)');
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(shown()).not.toContain('> vitest run');
  });

  it('done while Claude works says it waits for the turn', () => {
    act(() => handleShellEvent({ type: 'shells', sessionId: 's6', shells: [live({ id: 'r6', done: { code: 1, waiting: true } })] }));
    render(<MessageList sessionId="s6" view={view([])} mode="normal" />);
    expect(screen.getByText('Exit code 1')).toBeTruthy();
    expect(screen.getByText('Goes into the conversation when Claude’s turn ends')).toBeTruthy();
  });

  it('once recorded, a long output Claude Code saved to a file shows its start, and Show all reads all of it from that file, a page at a time', async () => {
    const pages = [
      { text: `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')}\n`, from: 0, size: 400_000, next: 262_100 },
      { text: 'line 31\nTests 120 passed\n', from: 262_100, size: 400_000 },
    ];
    const read = vi.spyOn(api, 'savedOutput').mockImplementation(async (_id, _name, from) => pages.find((page) => page.from === from)!);
    const file = '/home/me/.claude/projects/-work/5e25f65d-1b8b-4490-a3d3-43540da07ef3/tool-results/b1b2gp6fw.txt';
    const persisted = `<persisted-output>\nOutput too large (390.6KB). Full output saved to: ${file}\n\nPreview (first 2KB):\nline 1\nline 2\n...\n</persisted-output>`;
    const record = [user('r10', '<bash-input>cat big.log</bash-input>'), user('o10', `<bash-stdout>${persisted}</bash-stdout><bash-stderr></bash-stderr>`)];
    render(<MessageList sessionId="s10" view={view(record)} mode="normal" />);
    // What Claude got: the start, and Claude Code's line saying where all of it is.
    const raw = { normalizer: (text: string) => text };
    expect(screen.getByText(/line 2\n\.\.\.\nOutput too large \(390\.6KB\)\. Full output saved to:/, raw)).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    // By the file's name alone; the server knows the session's folder.
    expect(read).toHaveBeenCalledWith('s10', 'b1b2gp6fw.txt', 0);
    expect(await screen.findByText(/^line 1\nline 2\nline 3\n[\s\S]*line 30$/, raw)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText(/line 30\nline 31\nTests 120 passed$/, raw)).toBeTruthy();
    expect(read).toHaveBeenLastCalledWith('s10', 'b1b2gp6fw.txt', 262_100);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says so when the saved copy is gone, and shows the start Claude got', async () => {
    vi.spyOn(api, 'savedOutput').mockRejectedValue(new Error('That output is no longer saved'));
    const persisted = '<persisted-output>\nOutput too large (39.1KB). Full output saved to: /x/tool-results/b1b2gp6fw.txt\n\nPreview (first 2KB):\nfirst line\n...\n</persisted-output>';
    render(<MessageList sessionId="s11" view={view([user('r11', '<bash-input>cat big.log</bash-input>'), user('o11', `<bash-stdout>${persisted}</bash-stdout><bash-stderr></bash-stderr>`)])} mode="normal" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(await screen.findByText('The saved output is gone; this is its start')).toBeTruthy();
    expect(screen.getByText(/first line/)).toBeTruthy();
  });

  it('that failed says so once recorded, quietly, where its live card said its exit code, as the record tells it', () => {
    const recorded = (output: string) => buildItems([user('c', '<bash-input>npm test</bash-input>'), user('o', output)])[0];
    // Claude Code's bash mode puts a failed command's output under stderr, with stdout empty, also when it printed nothing.
    expect(recorded('<bash-stdout></bash-stdout><bash-stderr>FAIL theme.test.ts\n</bash-stderr>')).toMatchObject({ stderr: 'FAIL theme.test.ts', ended: 'failed' });
    expect(recorded('<bash-stdout></bash-stdout><bash-stderr></bash-stderr>')).toMatchObject({ stdout: '', stderr: '', ended: 'failed' });
    expect(recorded('<bash-stdout></bash-stdout><bash-stderr>started\n\n(stopped after 30 minutes)</bash-stderr>')).toMatchObject({ ended: 'stopped' });
    // One that went well: its output, or Claude Code's word that it printed none.
    expect(recorded('<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>')).not.toHaveProperty('ended');
    expect(recorded('<bash-stdout>2 passed</bash-stdout><bash-stderr></bash-stderr>')).not.toHaveProperty('ended');
    // In one message with its command, as Claude Desktop writes it.
    expect(buildItems([user('d', '<bash-input>false</bash-input><bash-stdout></bash-stdout><bash-stderr></bash-stderr>')])[0]).toMatchObject({ ended: 'failed' });

    act(() => handleShellEvent({ type: 'shells', sessionId: 's13', shells: [live({ id: 'r13', output: 'FAIL\n', done: { code: 1 } })] }));
    const record = [user('r13', '<bash-input>npm test</bash-input>'), user('o13', '<bash-stdout></bash-stdout><bash-stderr>FAIL\n</bash-stderr>')];
    const { rerender } = render(<MessageList sessionId="s13" view={view(record)} mode="normal" />);
    expect(screen.getByText('Exit code 1')).toBeTruthy();
    act(() => handleShellEvent({ type: 'shells', sessionId: 's13', shells: [] }));
    rerender(<MessageList sessionId="s13" view={view(record)} mode="normal" />);
    expect(screen.queryByText('Exit code 1')).toBeNull();
    expect(screen.getByText('Failed')).toBeTruthy();
    cleanup();
    render(<MessageList sessionId="s14" view={view([user('r14', '<bash-input>npm run dev</bash-input>'), user('o14', '<bash-stdout></bash-stdout><bash-stderr>ready\n\n(stopped)</bash-stderr>')])} mode="normal" />);
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('that printed nothing shows the command alone; its record keeps Claude Code’s words for Claude', () => {
    const record = [user('r12', '<bash-input>touch a.txt</bash-input>'), user('o12', '<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>')];
    expect(buildItems(record)).toEqual([{ kind: 'shell', key: 'r12', command: 'touch a.txt', stdout: '', stderr: '' }]);
    // Its output came, though it shows nothing: a stray one after it is not its.
    expect(buildItems([...record, user('x12', '<bash-stdout>stray</bash-stdout><bash-stderr></bash-stderr>')])).toEqual(buildItems(record));
    const { container } = render(<MessageList sessionId="s12" view={view(record)} mode="normal" />);
    expect(screen.getByText('touch a.txt')).toBeTruthy();
    expect(screen.queryByText(/completed with no output/)).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
  });
});
