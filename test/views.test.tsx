// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ChatMessage } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';

Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });

const { migrateViews, nextView, VIEW_OPTIONS, viewMode, viewsFor } = await import('../src/web/lib/prefs');
const { MessageList } = await import('../src/web/components/MessageList');

afterEach(cleanup);

describe('the transcript views', () => {
  it('are Claude Desktop’s, in its order', () => {
    expect(VIEW_OPTIONS.map((o) => o.label)).toEqual(['Normal', 'Thinking', 'Verbose']);
  });

  it('keep what was picked before, Summary opening in Normal as Desktop does', () => {
    const before = {
      view: 'summary', sessionViews: { a: 'verbose', b: 'summary', c: 'normal', d: 'nonsense' },
    } as unknown as Parameters<typeof migrateViews>[0];
    const after = migrateViews(before);
    expect(after.view).toBe('normal');
    // A session now in the default view follows the default again.
    expect(after.sessionViews).toEqual({ a: 'verbose' });
    expect(migrateViews({ ...before, view: 'verbose' } as never).sessionViews).toEqual({ b: 'normal', c: 'normal', d: 'normal' });
    expect(viewMode(undefined)).toBe('normal');
  });

  it('offer Thinking once Claude has thought in the session, and Ctrl+O steps through what is offered', () => {
    expect(viewsFor(false, 'normal').map((o) => o.value)).toEqual(['normal', 'verbose']);
    expect(viewsFor(false, 'thinking').map((o) => o.value)).toEqual(['normal', 'thinking', 'verbose']);
    expect(viewsFor(true, 'normal').map((o) => o.value)).toEqual(['normal', 'thinking', 'verbose']);
    expect(nextView('normal', true)).toBe('thinking');
    expect(nextView('thinking', true)).toBe('verbose');
    expect(nextView('verbose', true)).toBe('normal');
    expect(nextView('normal', false)).toBe('verbose');
    expect(nextView('verbose', false)).toBe('normal');
  });
});

const at = Date.now() - 60_000;
const messages: ChatMessage[] = [
  { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Why is the export slow?' }], timestamp: at },
  {
    uuid: 'a1',
    role: 'assistant',
    blocks: [
      { type: 'thinking', thinking: 'The owners lookup runs once per row.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/export.py' } },
    ],
    timestamp: at + 1000,
  },
  { uuid: 'r1', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'def export_rows(batch):' }], timestamp: at + 2000 },
  { uuid: 'a2', role: 'assistant', blocks: [{ type: 'text', text: 'Each row asks for its owner on its own.' }], timestamp: at + 3000 },
];
const view: SessionView = { messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false };

describe('a conversation', () => {
  it('in Normal: the steps on one line each and the reply whole, without Claude’s thinking', () => {
    render(<MessageList sessionId="s" view={view} mode="normal" />);
    expect(screen.getByText('Each row asks for its owner on its own.')).toBeTruthy();
    expect(screen.getByText('export.py')).toBeTruthy();
    expect(screen.queryByText('The owners lookup runs once per row.')).toBeNull();
    expect(screen.queryByText('Thought')).toBeNull();
    expect(screen.queryByText('def export_rows(batch):')).toBeNull();
  });

  it('in Thinking: the same, with the thinking open', () => {
    render(<MessageList sessionId="s" view={view} mode="thinking" />);
    expect(screen.getByText('The owners lookup runs once per row.')).toBeTruthy();
    expect(screen.queryByText('def export_rows(batch):')).toBeNull();
  });

  it('in Verbose: every step open too', () => {
    render(<MessageList sessionId="s" view={view} mode="verbose" />);
    expect(screen.getByText('The owners lookup runs once per row.')).toBeTruthy();
    expect(screen.getByText(/def export_rows\(batch\):/)).toBeTruthy();
  });
});
