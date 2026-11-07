import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Search, Slash } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import type { SessionSummary } from '../../shared/protocol';
import { api } from '../lib/api';
import { type CommandItem, commandList, filtered, GROUP_NAMES, isClaudeCommand, useCommandState } from '../lib/commands';
import { hasKeyboard, keyText } from '../lib/keyboard';
import { Modal } from './Modal';
import { Sheet } from './Sheet';

let shown = false;
const listeners = new Set<() => void>();

/** Opens or closes the command menu: ⌘K, and + › Commands while the box holds words. */
export function showCommandMenu(open: boolean): void {
  shown = open;
  for (const listener of listeners) listener();
}
export const commandMenuShown = () => shown;

export function useCommandMenuShown(): boolean {
  const [open, setOpen] = useState(shown);
  useEffect(() => {
    const listener = () => setOpen(shown);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return open;
}

type Row = { kind: 'command'; item: CommandItem } | { kind: 'session'; session: SessionSummary };

/** A session found by its title, as the list's search finds it. */
const findsSession = (session: SessionSummary, q: string) => session.title.toLowerCase().includes(q) || session.project.toLowerCase().includes(q);

/**
 * The command menu (⌘K): the / list's items under a search field, by part, with their keys; a
 * session's name finds it too. Pelican's own items are done at once; one of Claude Code's goes in
 * the message box, for the words it may take.
 */
export function CommandMenu({ sessions, onOpenSession }: { sessions: readonly SessionSummary[]; onOpenSession: (id: string) => void }) {
  const open = useCommandMenuShown();
  const { items, context } = useCommandState();
  const { data: completions } = useQuery({
    queryKey: ['completions', context.cwd],
    queryFn: () => api.completions(context.cwd!),
    enabled: open && Boolean(context.cwd && context.putInBox),
    staleTime: 60_000,
  });
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [sheet] = useState(() => !hasKeyboard());
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setAt(0);
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const all = commandList(items, context.putInBox ? completions?.commands ?? [] : [], sheet ? 'touch' : 'pointer');
    const q = query.trim().toLowerCase();
    const found = filtered(all, q).map((item): Row => ({ kind: 'command', item }));
    const named = q ? sessions.filter((s) => !s.archived && findsSession(s, q)).slice(0, 6).map((session): Row => ({ kind: 'session', session })) : [];
    return [...found, ...named];
  }, [items, completions, context.putInBox, query, sessions, sheet]);
  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[id="${listId}-${at}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [at, listId]);

  const close = () => showCommandMenu(false);
  const pick = (row: Row) => {
    // Gone first, its entry in a phone's history with it, so what is picked finds the page as it was.
    flushSync(close);
    if (row.kind === 'session') onOpenSession(row.session.id);
    else if (isClaudeCommand(row.item)) context.putInBox?.(`/${row.item.name} `);
    else row.item.run('');
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length > 0) setAt((i) => (i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[at];
      if (row) pick(row);
    }
  };

  const search = (
    <div className="flex items-center gap-3 border-b border-line px-4">
      <Search className="size-4 shrink-0 text-faint" />
      <input
        ref={field}
        data-autofocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={rows[at] ? `${listId}-${at}` : undefined}
        aria-label="Type a command or search"
        placeholder="Type a command or search"
        className="h-13 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint"
      />
      {!sheet && <span aria-hidden className="shrink-0 text-[12px] text-faint">esc</span>}
    </div>
  );
  const body = (
    <div ref={list} id={listId} role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
      {rows.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-faint">Nothing matches</div>}
      {rows.map((row, i) => {
        const group = row.kind === 'session' ? 'Sessions' : GROUP_NAMES[row.item.group];
        const before = rows[i - 1];
        const heading = !before || (before.kind === 'session' ? 'Sessions' : GROUP_NAMES[before.item.group]) !== group ? group : undefined;
        const Icon = row.kind === 'session' ? MessageSquare : row.item.icon ?? Slash;
        const claude = row.kind === 'command' && isClaudeCommand(row.item);
        const key = row.kind === 'command' && row.item.key && !sheet ? keyText(row.item.key) : undefined;
        return (
          <div key={row.kind === 'session' ? `session:${row.session.id}` : row.item.id} role="presentation">
            {heading && <div role="presentation" className="px-3 pt-2.5 pb-1 text-[12px] text-faint">{heading}</div>}
            <button
              id={`${listId}-${i}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={i === at}
              onPointerMove={() => setAt(i)}
              onClick={() => pick(row)}
              className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] pointer-fine:min-h-9 ${i === at ? 'bg-hover' : ''}`}
            >
              <Icon className="size-4 shrink-0 text-faint" />
              {row.kind === 'session' ? (
                <>
                  <span className="min-w-0 truncate">{row.session.title}</span>
                  <span className="ml-auto shrink-0 text-[12px] text-faint">{row.session.project}</span>
                </>
              ) : claude ? (
                <>
                  <span className="shrink-0 font-mono text-[13px]">{row.item.label}</span>
                  {row.item.description && <span className="min-w-0 truncate text-[12.5px] text-faint">{row.item.description}</span>}
                </>
              ) : (
                <>
                  <span className="shrink-0">{row.item.label}</span>
                  {row.item.name && <span className="min-w-0 truncate font-mono text-[12.5px] text-faint">/{row.item.name}</span>}
                  {key && <span className="ml-auto shrink-0 pl-3 text-[12px] tracking-wide text-faint tabular-nums">{key}</span>}
                </>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
  if (sheet) {
    return (
      <Sheet open={open} onClose={close} title="Commands" size="large" header={<div className="-mx-4">{search}</div>}>
        {body}
      </Sheet>
    );
  }
  return (
    <Modal open={open} onClose={close} label="Command menu">
      <div className="flex h-full w-full items-start justify-center p-6 pt-[8vh]">
        <div className="animate-fade absolute inset-0 bg-black/20 transition-opacity duration-200 group-data-closing/modal:opacity-0" onClick={close} />
        <div className="animate-fade relative flex max-h-[min(640px,80vh)] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl transition-opacity duration-150 group-data-closing/modal:opacity-0">
          {search}
          {body}
        </div>
      </div>
    </Modal>
  );
}
