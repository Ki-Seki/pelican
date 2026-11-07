import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import type { SessionSummary } from '../../shared/protocol';
import { type Choice, copyText, entries, SESSION_ACTIONS, type SessionTarget } from '../lib/actions';
import { api, isDemoNote } from '../lib/api';
import { clockTime, dayLabel, isSessionId, resumeCommand } from '../lib/format';
import { hasKeyboard } from '../lib/keyboard';
import { STATIC_DEMO } from '../lib/static-demo';
import { ActionMenu, type MenuAnchor } from './ActionMenu';
import { Sheet } from './Sheet';

/** A problem with an action the menu has closed on: said where the page says such things. */
export type MenuProblem = { text: string; note: boolean };

/** Saves the session as Markdown, as Export does in Claude Desktop. */
export function exportSession(sessionId: string, title?: string): void {
  const link = document.createElement('a');
  link.href = api.exportUrl(sessionId);
  // The server names the file by the session's title; the site's saved one is named here, as it would.
  link.download = STATIC_DEMO ? `${(title ?? '').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'session'}.md` : '';
  document.body.append(link);
  link.click();
  link.remove();
}

/** "Started today, 10:41 AM · ID 7f3c2a10", and a way to copy the whole ID. */
function Started({ sessionId, at }: { sessionId: string; at?: number }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const day = at ? dayLabel(at) : '';
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate">
        {at ? `Started ${day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : day}, ${clockTime(at)} · ` : ''}ID <span className="font-mono">{isSessionId(sessionId) ? sessionId.slice(0, 8) : sessionId}</span>
      </span>
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy the session’s ID'}
        title="Copy ID"
        onClick={() => void copyText(sessionId).then((done) => setCopied(done))}
        className="relative -my-1 grid size-6 shrink-0 place-items-center rounded-md hover:bg-hover hover:text-fg after:absolute after:-inset-2"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** Rename, as /rename does: the title the session has everywhere Claude Code lists it. */
export function RenameSheet({ open, onClose, sessionId, title, onRenamed }: { open: boolean; onClose: () => void; sessionId: string; title: string; onRenamed: () => void }) {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MenuProblem>();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setValue(title);
    setError(undefined);
    // Selected, to type over it at once.
    requestAnimationFrame(() => field.current?.select());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const save = (e: FormEvent) => {
    e.preventDefault();
    const next = value.trim();
    if (!next || next === title) {
      onClose();
      return;
    }
    setBusy(true);
    setError(undefined);
    api.rename(sessionId, next)
      .then(() => {
        onRenamed();
        onClose();
      })
      .catch((err: Error) => setError({ text: err.message, note: isDemoNote(err) }))
      .finally(() => setBusy(false));
  };
  return (
    <Sheet open={open} onClose={onClose} title="Rename">
      <form onSubmit={save} className="px-2 pt-1 pb-3">
        <input
          ref={field}
          data-autofocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Session title"
          className="h-11 w-full rounded-xl border border-line bg-bg px-3 text-[16px] outline-none focus:border-fg pointer-fine:h-10 pointer-fine:text-[15px]"
        />
        {error && <p className={`mt-2 px-1 text-[13px] leading-snug ${error.note ? 'text-muted' : 'text-danger'}`}>{error.text}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-full bg-chip px-4 text-[14px] pointer-fine:h-9">Cancel</button>
          <button type="submit" disabled={busy || !value.trim()} className="flex h-10 items-center rounded-full bg-fg px-4 text-[14px] font-medium text-bg disabled:opacity-40 pointer-fine:h-9">
            {busy ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** Delete asks first, in Desktop's words: the transcript goes for every Claude Code app. */
function DeleteSheet({ open, onClose, sessionId, onDeleted }: { open: boolean; onClose: () => void; sessionId: string; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MenuProblem>();
  useEffect(() => {
    if (open) setError(undefined);
  }, [open]);
  const remove = () => {
    setBusy(true);
    setError(undefined);
    api.remove(sessionId)
      .then(() => {
        onClose();
        onDeleted();
      })
      .catch((err: Error) => setError({ text: err.message, note: isDemoNote(err) }))
      .finally(() => setBusy(false));
  };
  return (
    <Sheet open={open} onClose={onClose} title="Delete this session?">
      <div className="px-3 pt-1 pb-3">
        <p className="text-[14px] leading-relaxed text-muted">Its transcript is removed from this computer, for every Claude Code app. This cannot be undone.</p>
        {error && <p className={`mt-2 text-[13px] leading-snug ${error.note ? 'text-muted' : 'text-danger'}`}>{error.text}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" data-autofocus onClick={onClose} className="h-10 rounded-full bg-chip px-4 text-[14px] pointer-fine:h-9">Cancel</button>
          <button type="button" disabled={busy} onClick={remove} className="flex h-10 items-center rounded-full bg-danger px-4 text-[14px] font-medium text-bg disabled:opacity-40 pointer-fine:h-9">
            {busy ? <Loader2 className="size-4 animate-spin" /> : 'Delete'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * One session's list of actions (lib/actions), from the open session's title ▾ or from its row in
 * the list: Rename · Pin · Side chat · Fork · Copy resume command · Export · Transcript view ·
 * Archive · Delete, the same everywhere. Under the title it has the session's keys and view, and
 * its start and ID at its foot; a row's, which may be another session's, has neither. Rename and
 * Delete ask in a sheet of their own once the menu has gone.
 */
export function SessionMenu({
  open, onClose, sessionId, session, from, at, lift, focusFirst, cwd, busy, view, header, onRename, onFork, onSideChat, onForked, onPin, onArchive, onRenamed, onDeleted, onProblem,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  session?: SessionSummary;
  from: 'title' | 'row';
  at?: MenuAnchor | null;
  /** On a phone, the row a long press opened it for. */
  lift?: Element | null;
  focusFirst?: boolean;
  cwd?: string;
  /** Claude works in it: Delete waits until it stops. */
  busy?: boolean;
  view?: Choice;
  /** Above the list, on a phone's title menu: the panes' tiles. */
  header?: ReactNode | ((pick: (run: () => void) => void) => ReactNode);
  /** Renames in a sheet of the caller's (the open session's, which /rename and ⌥⌘R open too). */
  onRename?: () => void;
  /** Forks as the caller does (the open session's, which /branch and ⌥⌘O do too). */
  onFork?: () => void;
  onSideChat?: () => void;
  onForked: (id: string) => void;
  onPin?: (pinned: boolean) => void;
  onArchive?: (archived: boolean) => void;
  onRenamed: () => void;
  onDeleted: () => void;
  onProblem: (problem: MenuProblem) => void;
}) {
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const title = session?.title ?? '';
  const target = useMemo<SessionTarget>(() => ({
    title,
    archived: Boolean(session?.archived),
    pinned: Boolean(session?.pinned),
    from,
    ...(busy ? { busy } : {}),
    ...(isSessionId(sessionId) ? { resume: resumeCommand(sessionId, cwd ?? session?.cwd) } : {}),
    rename: onRename ?? (() => setRenaming(true)),
    ...(session && onPin ? { pin: onPin } : {}),
    ...(onSideChat ? { sideChat: onSideChat } : {}),
    fork: onFork ?? (() => {
      api.fork(sessionId)
        .then((id) => {
          if (!id) return;
          void queryClient.invalidateQueries({ queryKey: ['sessions'] });
          onForked(id);
        })
        .catch((err: Error) => onProblem({ text: err.message, note: isDemoNote(err) }));
    }),
    export: () => exportSession(sessionId, title),
    ...(view ? { view } : {}),
    ...(session && onArchive ? { archive: onArchive } : {}),
    remove: () => setDeleting(true),
  }), [title, session, from, busy, sessionId, cwd, onRename, onFork, onPin, onSideChat, view, onArchive, queryClient, onForked, onProblem]);
  const list = entries(SESSION_ACTIONS, target, 'menu', hasKeyboard() ? 'pointer' : 'touch');
  return (
    <>
      <ActionMenu
        open={open}
        onClose={onClose}
        label={from === 'title' ? 'Session' : title || 'Session'}
        title={from === 'title' ? 'Session' : title || 'Session'}
        entries={list}
        at={at ?? null}
        keys={from === 'title'}
        focusFirst={Boolean(focusFirst)}
        {...(header ? { header } : {})}
        {...(from === 'title' ? { footer: <Started sessionId={sessionId} {...(session?.createdAt ? { at: session.createdAt } : {})} /> } : {})}
        {...(lift ? { lift } : {})}
      />
      <RenameSheet open={renaming} onClose={() => setRenaming(false)} sessionId={sessionId} title={title} onRenamed={onRenamed} />
      <DeleteSheet open={deleting} onClose={() => setDeleting(false)} sessionId={sessionId} onDeleted={onDeleted} />
    </>
  );
}
