import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, LogOut } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import { type DefaultChange, SOURCE_LABEL, startModeFor } from '../../shared/defaults';
import { MODE_INFO, START_MODES } from '../../shared/modes';
import type { RunSettings, ServerInfo } from '../../shared/protocol';
import { qrSvg } from '../../shared/qr';
import { api, appBase, type AuthState } from '../lib/api';
import { defaultChange, fromDefaults, modelNote, modelSources, modeNote } from '../lib/defaults';
import { shortPath } from '../lib/format';
import { hasKeyboard, MOD } from '../lib/keyboard';
import { retried } from '../lib/load';
import type { NotificationState } from '../lib/notifications';
import { type Prefs, setPrefs, type Theme, usePrefs, VIEW_OPTIONS, type ViewMode } from '../lib/prefs';
import { ModelSheet, ModelSummary, ModeSheet, modelOf, SheetNote } from './ModelSheet';
import { usePlanLimits } from './PlanLimits';
import { Segmented, Sheet, SheetHeading, SheetOption, SheetToggle } from './Sheet';
import { showShortcuts } from './Shortcuts';
import { UpdateSection } from './UpdateSection';

// The usage page loads once Settings is open, not with it: Settings shows sooner on a slow link.
const loadUsage = () => import('./Usage');
const UsageSheet = lazy(() => retried(loadUsage).then((m) => ({ default: m.UsageSheet })));

const isLoopback = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host.startsWith('127.');

const PLAN: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };

const NOTIFICATION_HINT: Record<NotificationState, string> = {
  on: 'When Claude finishes or needs you',
  off: 'When Claude finishes or needs you',
  denied: 'Blocked in this browser’s site settings',
  unsupported: 'This browser cannot receive them here (it needs HTTPS or localhost)',
};

export function SettingsSheet({
  open,
  onClose,
  info,
  notifications,
  onToggleNotifications,
  onSignOut,
  onOpenSession,
}: {
  open: boolean;
  onClose: () => void;
  info?: ServerInfo;
  notifications: NotificationState;
  onToggleNotifications: () => void;
  onSignOut: () => void;
  /** Opens a session from the usage page's list. */
  onOpenSession?: (id: string) => void;
}) {
  const prefs = usePrefs();
  const { data: models } = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 10 * 60_000, enabled: open });
  const { bars: planBars, windows, plan } = usePlanLimits(open);
  const account = models?.account;
  const [modelOpen, setModelOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  // There from the first time it is asked for, and loaded ahead of that while Settings is open: a
  // load that fails ahead is tried again when asked for, and only then says it did not load.
  const [usageUsed, setUsageUsed] = useState(false);
  if (usageOpen && !usageUsed) setUsageUsed(true);
  useEffect(() => {
    if (!open) setUsageOpen(false);
    else void loadUsage().catch(() => undefined);
  }, [open]);
  // What new sessions start with is Claude Code's settings (the user's own and managed ones, as a
  // session in no project folder reads them), shared with the terminal and Claude Desktop; a change
  // here goes into the user's file, as Claude Code's own /model, /effort, /fast and /config put it.
  const queryClient = useQueryClient();
  const { data: defaults, error: unread } = useQuery({ queryKey: ['defaults', ''], queryFn: () => api.defaults(), enabled: open, staleTime: 30_000, retry: false });
  const [pending, setPending] = useState<RunSettings>();
  const [problem, setProblem] = useState<string>();
  const start: RunSettings = pending ?? (defaults ? fromDefaults(defaults, models?.models) : { model: 'default' });
  const model = modelOf(models?.models, start);
  const mode = defaults ? startModeFor(defaults, model) : undefined;
  const save = (change: DefaultChange | undefined, next: RunSettings) => {
    if (!change) return;
    setPending(next);
    setProblem(undefined);
    api.saveDefault(change)
      .then((fresh) => {
        queryClient.setQueryData(['defaults', ''], fresh);
        // Each folder's new sessions start from these too.
        void queryClient.invalidateQueries({ queryKey: ['defaults'], predicate: (q) => q.queryKey[1] !== '' });
      })
      .catch((error: Error) => setProblem(error.message))
      .finally(() => setPending(undefined));
  };
  const file = defaults?.file;
  const where = file ? shortPath(file.path, info?.home) : '~/.claude/settings.json';
  // On this computer's own address, the phone needs another one: the server's, when it knows one.
  const onLoopback = isLoopback(location.hostname);
  const { data: phoneAddress } = useQuery({ queryKey: ['phone-address'], queryFn: api.phoneAddress, enabled: open && onLoopback && !info?.demo, staleTime: 60_000 });
  return (
    <Sheet open={open} onClose={onClose} title="Settings" done>
      <SheetHeading>Appearance</SheetHeading>
      <Segmented<Theme>
        value={prefs.theme}
        onChange={(theme) => setPrefs({ theme })}
        options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
      />

      {/* A session's own view is in its menu; this is the one the others open in. */}
      <SheetHeading>Sessions open in</SheetHeading>
      <Segmented<ViewMode>
        value={prefs.view}
        onChange={(view) => setPrefs({ view })}
        options={[...VIEW_OPTIONS]}
      />

      {/* Each session keeps its own model and mode; this is what new ones start with, from Claude Code's settings. */}
      <SheetHeading>New sessions start with</SheetHeading>
      <SheetOption
        label="Model"
        {...(defaults ? { description: modelSources(defaults, models?.models) } : {})}
        trailing={<span className="flex min-w-0 items-center gap-1 text-[13px] text-muted"><ModelSummary settings={start} models={models?.models} /><ChevronRight className="size-4 text-faint" /></span>}
        onSelect={() => setModelOpen(true)}
      />
      <SheetOption
        label="Mode"
        {...(defaults ? { description: SOURCE_LABEL[defaults.permissionMode.source] } : {})}
        trailing={<span className="flex min-w-0 items-center gap-1 text-[13px] text-muted">{mode ? MODE_INFO[mode].label : '…'}<ChevronRight className="size-4 text-faint" /></span>}
        onSelect={() => setModeOpen(true)}
      />
      {defaults && mode === 'bypassPermissions' && <SheetNote tone="warn">{modeNote(defaults, model)}</SheetNote>}
      <SheetNote>
        Claude Code’s own settings, which the terminal and Claude Desktop read too. A change here is saved in{' '}
        <span className="font-mono break-all">{where}</span>, as Claude Code’s /model, /effort, /fast and /config save it.
      </SheetNote>
      {file?.state === 'invalid' && (
        <SheetNote tone="warn">Claude Code skips this file and Pelican changes nothing in it: {file.problem}</SheetNote>
      )}
      {file?.state === 'skipped' && <SheetNote tone="warn">{file.problem} A change here still goes in, as Claude Code’s own do.</SheetNote>}
      {unread && <SheetNote tone="warn">Claude Code’s settings could not be read: {(unread as Error).message}</SheetNote>}

      <SheetHeading>Messages sent while Claude works</SheetHeading>
      <Segmented<Prefs['sendWhileBusy']>
        value={prefs.sendWhileBusy}
        onChange={(sendWhileBusy) => setPrefs({ sendWhileBusy })}
        options={[{ value: 'steer', label: 'Steer' }, { value: 'queue', label: 'Queue' }]}
      />
      <p className="px-3 pt-1 text-[12px] leading-snug text-faint">
        {prefs.sendWhileBusy === 'steer' ? 'Claude reads them at its next step.' : 'They are sent when the turn ends.'}
      </p>

      <SheetHeading>Enter key</SheetHeading>
      <Segmented<Prefs['enterToSend']>
        value={prefs.enterToSend}
        onChange={(enterToSend) => setPrefs({ enterToSend })}
        options={[{ value: 'auto', label: 'Auto' }, { value: 'always', label: 'Sends' }, { value: 'never', label: 'New line' }]}
      />
      {prefs.enterToSend === 'auto' && <p className="px-3 pt-1 text-[12px] leading-snug text-faint">Sends on a computer, a new line on a phone.</p>}
      {hasKeyboard() && <SheetOption label="Keyboard shortcuts" trailing={<span className="text-[13px] text-faint">{MOD} /</span>} onSelect={() => showShortcuts(true)} />}
      <div className="h-1.5" />
      <SheetToggle label="Suggest what to ask next" checked={prefs.suggestions} onChange={(suggestions) => setPrefs({ suggestions })} />

      {/* The demo sends nothing anywhere, notifications included. Where they cannot be turned on, the
          row says why and is not a control. */}
      {!info?.demo && (notifications === 'unsupported' || notifications === 'denied' ? (
        <div className="px-3 py-2.5">
          <div className="text-[15px]">Notifications</div>
          <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{NOTIFICATION_HINT[notifications]}</div>
        </div>
      ) : (
        <SheetToggle
          label="Notifications"
          description={NOTIFICATION_HINT[notifications]}
          checked={notifications === 'on'}
          onChange={onToggleNotifications}
        />
      ))}

      <SheetHeading>Account</SheetHeading>
      {account && (
        <div className="px-3 pb-1 text-[13px] leading-relaxed text-muted">
          {account.email && <span className="text-fg">{account.email}</span>}
          {account.plan && <> · {PLAN[account.plan] ?? account.plan}</>}
          {account.organization && <div className="text-faint">{account.organization}</div>}
        </div>
      )}
      {planBars}
      {account && windows === 0 && !plan?.extra && (
        <p className="px-3 text-[12px] leading-snug text-faint">{plan === null ? 'No plan limits apply to this account (an API key, Bedrock or Vertex).' : 'Usage limits show up here after Claude has worked in Pelican.'}</p>
      )}
      <SheetOption label="Usage and activity" trailing={<ChevronRight className="size-4 text-faint" />} onSelect={() => setUsageOpen(true)} />

      {!info?.demo && (
        <>
          <SheetHeading>On your phone</SheetHeading>
          {!onLoopback ? (
            <PhoneCode open={open} base={appBase.href} />
          ) : phoneAddress ? (
            <PhoneCode open={open} base={phoneAddress} />
          ) : (
            <p className="px-3 pb-1 text-[13px] leading-relaxed text-muted">
              This address works only on this computer. <code className="font-mono text-[12px]">pelican phone</code> in a terminal sets up your phone.
            </p>
          )}
        </>
      )}

      <SheetHeading>About</SheetHeading>
      <div className="px-3 pb-2 text-[13px] leading-relaxed text-muted">
        Pelican {info?.version ?? ''} on <span className="text-fg">{info?.machine ?? '…'}</span>
        {info?.demo && <> · demo</>}
        {info?.claudeCode?.version && (
          <>
            <br />
            Claude Code {info.claudeCode.version}
            {info.claudeCode.path && <> from <span className="font-mono text-[12px] break-all">{info.claudeCode.path}</span></>}
            {info.claudeCode.newer && (
              <>
                <br />
                Your <code className="font-mono text-[12px]">claude</code> is newer ({info.claudeCode.newer}):{' '}
                <a className="underline decoration-faint underline-offset-2" href="https://ki-seki.github.io/pelican/docs.html#update" target="_blank" rel="noreferrer">update Pelican</a> to get it
              </>
            )}
          </>
        )}
        <br />
        <a className="underline decoration-faint underline-offset-2" href="https://github.com/Ki-Seki/pelican" target="_blank" rel="noreferrer">github.com/Ki-Seki/pelican</a>
      </div>
      {/* A newer Pelican on npm, said here only; neither demo has one. */}
      {info && <UpdateSection open={open} demo={info.demo} />}
      {info?.auth && <SheetOption icon={<LogOut className="size-4" />} label="Sign out" danger onSelect={onSignOut} />}
      {/* Only what Claude Code keeps as a default: no Max effort and no Ultracode, which are a session's; never Bypass. */}
      <ModelSheet
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        title="New sessions start with"
        settings={{ ...start, permissionMode: undefined }}
        models={models?.models}
        onChange={(next) => save(defaultChange(start, next, defaults?.fast.perSession), next)}
        forNewSessions
        {...(defaults ? { defaults, note: modelNote(defaults, models?.models, start.model) } : {})}
        footer={problem && <SheetNote tone="warn">{problem}</SheetNote>}
      />
      <ModeSheet
        open={modeOpen}
        onClose={() => setModeOpen(false)}
        title="New sessions start with"
        offered={START_MODES}
        value={mode ?? 'default'}
        model={model}
        onPick={(permissionMode) => save({ permissionMode }, start)}
        {...(defaults ? { note: modeNote(defaults, model) } : {})}
        footer={problem && <SheetNote tone="warn">{problem}</SheetNote>}
      />
      {usageUsed && (
        <Suspense fallback={null}>
          <UsageSheet open={open && usageOpen} onClose={() => setUsageOpen(false)} limits={planBars} {...(onOpenSession ? { onOpenSession } : {})} />
        </Suspense>
      )}
    </Sheet>
  );
}

const qrImage = (text: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(text))}`;

/**
 * Pelican's address for a phone as a QR code: this page's, or the one the server knows when this
 * page is on this computer's own address. When browsers sign in, the code carries a one-time
 * sign-in code instead of the token or the password: it works once, within two minutes, so it
 * shows only on a tap.
 */
function PhoneCode({ open, base }: { open: boolean; base: string }) {
  const { data: auth } = useQuery<AuthState>({ queryKey: ['auth'], enabled: false });
  const signsIn = auth?.mode === 'token' || auth?.mode === 'password';
  const [code, setCode] = useState<{ value: string; expires: number }>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) setCode(undefined);
  }, [open]);
  useEffect(() => {
    if (!code) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);
  const live = code && code.expires > now;
  const show = () => {
    setError(undefined);
    api.accessCode()
      .then((value) => {
        setNow(Date.now());
        setCode(value ? { value, expires: Date.now() + 115_000 } : undefined);
      })
      .catch((err: Error) => setError(err.message));
  };
  const link = live ? `${base}?code=${encodeURIComponent(code.value)}` : base;
  return (
    <div className="flex items-center gap-4 px-3 pb-1">
      {signsIn && !live ? (
        <button type="button" onClick={show} className="grid size-28 shrink-0 place-items-center rounded-lg border border-dashed border-line text-[12.5px] text-muted hover:bg-hover hover:text-fg">
          {code ? 'New code' : 'Show code'}
        </button>
      ) : (
        <img src={qrImage(link)} alt="" className="size-28 shrink-0 rounded-lg border border-line bg-white p-1.5" />
      )}
      <p className="min-w-0 text-[13px] leading-relaxed text-muted">
        {signsIn ? <>Scan to open Pelican on your phone, signed in. Works once, for two minutes.</> : <>Scan to open Pelican on your phone.</>}
        <br />
        <span className="font-mono text-[12px] break-all text-faint">{base}</span>
        {error && <><br /><span className="text-danger">{error}</span></>}
      </p>
    </div>
  );
}

