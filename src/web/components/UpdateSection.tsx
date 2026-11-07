import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { Interruption, UpdateInfo, UpdateState } from '../../shared/update';
import { api } from '../lib/api';
import { CopyButton } from './Markdown';

/** States the page follows as they go, asking every so often. */
const MOVING = new Set<UpdateState['phase']>(['preparing', 'waiting', 'installing', 'checking', 'restarting']);
const FOLLOW_MS = 1500;

/** Where it is installed and how it starts again, for a line under Update. */
function howItGoes(info: UpdateInfo): string {
  const install = info.install!;
  const where = install.prefix ? `Installed with npm in ${install.prefix}` : 'Installed with npm';
  const again = {
    launchd: 'its login item starts it again',
    systemd: 'its systemd service starts it again',
    'in-place': 'it starts again in its terminal, by itself',
    'by-hand': 'then restart it yourself',
  }[install.restart];
  return `${where}: Pelican installs it, checks that it starts, and ${again}. Pages reconnect by themselves.`;
}

const KIND_WORD: Record<Interruption['kind'], string> = { session: 'Session', work: 'Background', terminal: 'Terminal', command: 'Command' };

/** What an update would end, one line each. */
function EndsList({ busy }: { busy: Interruption[] }) {
  return (
    <ul className="my-1.5 space-y-1">
      {busy.map((item, i) => (
        <li key={i} className="flex min-w-0 gap-2 text-[13px] leading-snug">
          <span className="w-[5.5rem] shrink-0 text-faint">{KIND_WORD[item.kind]}</span>
          <span className="min-w-0 flex-1">
            <span className="break-words text-fg">{item.title}</span>
            <span className="text-muted"> · {item.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What changed: the first paragraph, and all of it on a tap. */
function Changes({ text, version }: { text: string; version: string }) {
  const [all, setAll] = useState(false);
  // The heading names the version already shown; the first paragraph says what it is about.
  const body = text.replace(/^##[^\n]*\n+/, '');
  const first = body.split(/\n\s*\n/)[0] ?? '';
  return (
    <div className="mt-1.5">
      <div className={all ? 'max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-line px-3 py-2' : ''}>
        {/* Settings' size, not a reply's: headings and lists are sized from it. */}
        <div className="prose-chat" style={{ fontSize: 13 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>
            {all ? text : first}
          </ReactMarkdown>
        </div>
      </div>
      {body.trim() !== first.trim() && (
        <button type="button" onClick={() => setAll(!all)} aria-expanded={all} className="relative mt-1 text-[13px] text-muted underline decoration-faint underline-offset-2 after:absolute after:-inset-2 hover:text-fg">
          {all ? 'Show less' : `What’s new in ${version}`}
        </button>
      )}
    </div>
  );
}

const button = 'relative h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium after:absolute after:-inset-0.5 pointer-coarse:h-10 pointer-coarse:px-4 disabled:opacity-50';

/**
 * At the top of Settings: when npm's registry has a newer Pelican, says so quietly, with what changed,
 * and either Update (where Pelican can update itself) or the command to run instead, and why.
 * Before updating it lists what the restart would end, with Update now and Update when idle; then
 * it follows the update to the restart, after which the page loads the new version (useNewVersion).
 * Offline, or when the registry cannot be asked, it says nothing.
 */
export function UpdateSection({ open, demo }: { open: boolean; demo?: boolean }) {
  const queryClient = useQueryClient();
  // Opening Settings asks the registry again (at most every few minutes); after that, what the server has.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!open) setAsked(false);
  }, [open]);
  const { data: info } = useQuery({
    queryKey: ['update'],
    queryFn: () => api.update(!asked).finally(() => setAsked(true)),
    enabled: open && !demo,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => (query.state.data?.state && MOVING.has(query.state.data.state.phase) ? FOLLOW_MS : false),
    // While Pelican starts again it answers nothing: the last word stays.
    refetchIntervalInBackground: true,
  });
  const [asking, setAsking] = useState<Interruption[]>();
  const [problem, setProblem] = useState<string>();
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!open) {
      setAsking(undefined);
      setProblem(undefined);
    }
  }, [open]);

  const state = info?.state;
  if (demo || !info || (!info.latest && !state)) return null;
  const version = state?.version ?? info.latest!;
  const take = (next: Promise<UpdateInfo>) => {
    setSending(true);
    setProblem(undefined);
    next
      .then((fresh) => {
        queryClient.setQueryData(['update'], fresh);
        setAsking(undefined);
      })
      .catch((error: Error & { status?: number }) => setProblem(error.message))
      .finally(() => setSending(false));
  };
  const update = async () => {
    // What would end, as it is now: the list shown is the list confirmed.
    setProblem(undefined);
    let fresh: UpdateInfo;
    try {
      fresh = await api.update();
    } catch (error) {
      setProblem((error as Error).message);
      return;
    }
    queryClient.setQueryData(['update'], fresh);
    if (fresh.busy?.length) setAsking(fresh.busy);
    else take(api.startUpdate(version, 'now'));
  };

  return (
    <section aria-label="Update" className="mx-3 mt-1 mb-1 border-b border-line pb-3 text-[13px] leading-relaxed text-muted">
      {state?.phase === 'preparing' ? (
        <Line busy text={`Getting ${version} and checking that it starts. Nothing changes until it does.`} action={<button type="button" onClick={() => take(api.cancelUpdate())} disabled={sending} className={`${button} bg-chip`}>Cancel</button>} />
      ) : state?.phase === 'waiting' ? (
        <>
          <Line
            text={state.idleSince !== undefined ? `${version} is ready, and nothing runs: Pelican updates in a moment.` : `${version} is ready. Pelican updates once nothing has run for a minute.`}
            action={<button type="button" onClick={() => take(api.cancelUpdate())} disabled={sending} className={`${button} bg-chip`}>Cancel</button>}
          />
          {info.busy && info.busy.length > 0 && <><div className="mt-1 text-faint">Waiting for:</div><EndsList busy={info.busy} /></>}
        </>
      ) : state && (state.phase === 'installing' || state.phase === 'checking' || state.phase === 'restarting') ? (
        <Line busy text={state.phase === 'installing' ? `Installing ${version}…` : state.phase === 'checking' ? `Checking that ${version} starts…` : `Starting ${version}. This page reconnects by itself.`} />
      ) : state?.phase === 'installed' ? (
        <p className="text-fg">{state.note}</p>
      ) : (
        <>
          {state?.phase === 'failed' && (
            <div role="alert" className="mb-1.5">
              <p className="break-words text-danger">{state.error}</p>
              <p className="text-fg">Pelican {state.running} keeps running.</p>
            </div>
          )}
          {info.latest && (
            <>
              <div className="text-fg">Pelican {info.latest} is out.</div>
              {info.changes ? (
                <Changes text={info.changes} version={info.latest} />
              ) : info.notes ? (
                <a className="underline decoration-faint underline-offset-2" href={info.notes} target="_blank" rel="noreferrer">What’s new in {info.latest}</a>
              ) : null}
              {info.install?.self ? (
                asking ? (
                  <div className="mt-2 rounded-xl border border-line px-3 py-2">
                    <div className="text-fg">Updating restarts Pelican, which ends:</div>
                    <EndsList busy={asking} />
                    <div className="text-[12.5px] text-faint">Transcripts, files, pins, settings and drafts stay.</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" disabled={sending} onClick={() => take(api.startUpdate(version, 'now', true))} className={`${button} bg-danger text-bg`}>Update now</button>
                      <button type="button" disabled={sending} onClick={() => take(api.startUpdate(version, 'idle'))} className={`${button} bg-fg text-bg`}>Update when idle</button>
                      <button type="button" disabled={sending} onClick={() => setAsking(undefined)} className={`${button} bg-chip font-normal`}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button type="button" disabled={sending} onClick={() => void update()} className={`${button} mt-2 bg-fg text-bg`}>
                      {state?.phase === 'failed' ? 'Try again' : `Update to ${info.latest}`}
                    </button>
                    <p className="mt-1.5 text-[12.5px] leading-snug text-faint">{howItGoes(info)}</p>
                  </>
                )
              ) : info.install?.command ? (
                <div className="mt-2">
                  <div>To update, run this in a terminal{info.install.restart === 'launchd' || info.install.restart === 'systemd' ? ', then pelican service restart' : ', then restart Pelican'}:</div>
                  <div className="mt-1 flex items-start gap-1 rounded-lg bg-chip py-1 pr-1 pl-2.5">
                    <code className="min-w-0 flex-1 py-0.5 font-mono text-[12px] break-all text-fg">{info.install.command}</code>
                    <CopyButton text={info.install.command} />
                  </div>
                  {info.install.why && <p className="mt-1.5 text-[12.5px] leading-snug text-faint">{info.install.why}</p>}
                </div>
              ) : null}
            </>
          )}
          {problem && <p role="alert" className="mt-1.5 text-danger">{problem}</p>}
        </>
      )}
    </section>
  );
}

/** A line of where the update stands, with a spinner while it works, and what can be done. */
function Line({ text, busy, action }: { text: string; busy?: boolean; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5" role="status">
      {busy && <span aria-hidden className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-fg" />}
      <span className="min-w-0 flex-1 text-fg">{text}</span>
      {action}
    </div>
  );
}
