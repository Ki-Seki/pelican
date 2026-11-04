import { useQuery } from '@tanstack/react-query';
import { Bell, LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ServerInfo } from '../../shared/protocol';
import { qrSvg } from '../../shared/qr';
import { api, appBase, type AuthState } from '../lib/api';
import { untilTime } from '../lib/format';
import type { NotificationState } from '../lib/notifications';
import { type Prefs, setPrefs, type Theme, usePrefs, type ViewMode } from '../lib/prefs';
import { Segmented, Sheet, SheetHeading, SheetOption, SheetToggle } from './Sheet';

const isLoopback = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host.startsWith('127.');

const PLAN: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
const LIMIT: Record<string, string> = {
  five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus limit', seven_day_sonnet: 'Weekly Sonnet limit', overage: 'Extra usage',
};

const NOTIFICATION_HINT: Record<NotificationState, string> = {
  on: 'When Claude finishes a turn or needs you, on this device',
  off: 'When Claude finishes a turn or needs you, on this device',
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
}: {
  open: boolean;
  onClose: () => void;
  info?: ServerInfo;
  notifications: NotificationState;
  onToggleNotifications: () => void;
  onSignOut: () => void;
}) {
  const prefs = usePrefs();
  const { data: models } = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 10 * 60_000, enabled: open });
  const { data: limits } = useQuery({ queryKey: ['usage'], queryFn: api.usage, enabled: open });
  const { data: plan } = useQuery({ queryKey: ['usage-plan'], queryFn: api.planUsage, enabled: open, staleTime: 60_000 });
  // claude.ai's own figures when there are any; else what Claude Code reported during turns here.
  const windows: Bar[] = plan && plan.windows.length > 0
    ? plan.windows.map((w) => ({ key: w.type, label: w.label ?? LIMIT[w.type] ?? w.type, utilization: w.utilization, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) }))
    : (limits ?? []).filter((l) => !(plan?.extra && l.type === 'overage')).map((l) => ({
      key: l.type, label: LIMIT[l.type] ?? l.type, status: l.status,
      ...(typeof l.utilization === 'number' ? { utilization: l.utilization } : {}),
      ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}),
    }));
  const account = models?.account;
  return (
    <Sheet open={open} onClose={onClose} title="Settings" done>
      <SheetHeading>Appearance</SheetHeading>
      <Segmented<Theme>
        value={prefs.theme}
        onChange={(theme) => setPrefs({ theme })}
        options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
      />

      <SheetHeading>Conversations open in</SheetHeading>
      <Segmented<ViewMode>
        value={prefs.view}
        onChange={(view) => setPrefs({ view })}
        options={[
          { value: 'summary', label: 'Summary', title: 'Your prompts and Claude’s replies' },
          { value: 'normal', label: 'Normal', title: 'Replies with the steps folded' },
          { value: 'verbose', label: 'Verbose', title: 'Every step open' },
        ]}
      />
      <p className="px-3 pt-1 text-[12px] leading-snug text-faint">
        {prefs.view === 'summary' ? 'Only your prompts and Claude’s replies.' : prefs.view === 'verbose' ? 'Every tool call open, with its command and output.' : 'Claude’s replies, with the steps between them folded.'}
      </p>

      <SheetHeading>While Claude is working</SheetHeading>
      <Segmented<Prefs['sendWhileBusy']>
        value={prefs.sendWhileBusy}
        onChange={(sendWhileBusy) => setPrefs({ sendWhileBusy })}
        options={[{ value: 'steer', label: 'Steer' }, { value: 'queue', label: 'Queue' }]}
      />
      <p className="px-3 pt-1 text-[12px] leading-snug text-faint">
        {prefs.sendWhileBusy === 'steer' ? 'A new message reaches Claude at its next step, like typing in the terminal.' : 'A new message waits for the turn to end, then starts the next one.'} Each message can still go the other way: tap the word next to Send.
      </p>
      <SheetToggle
        label="Suggest what to ask next"
        description="After a turn, Claude Code’s guess at your next prompt; tap it to use it"
        checked={prefs.suggestions}
        onChange={(suggestions) => setPrefs({ suggestions })}
      />

      <SheetHeading>Enter key</SheetHeading>
      <Segmented<Prefs['enterToSend']>
        value={prefs.enterToSend}
        onChange={(enterToSend) => setPrefs({ enterToSend })}
        options={[{ value: 'auto', label: 'Auto' }, { value: 'always', label: 'Sends' }, { value: 'never', label: 'New line' }]}
      />
      <p className="px-3 pt-1 text-[12px] leading-snug text-faint">Auto: Enter sends on a computer and starts a new line on a phone. Shift+Enter always starts a new line.</p>

      <SheetHeading>Session list</SheetHeading>
      <Segmented<Prefs['listGroup']>
        value={prefs.listGroup}
        onChange={(listGroup) => setPrefs({ listGroup })}
        options={[{ value: 'time', label: 'By time' }, { value: 'project', label: 'By project' }]}
      />
      <div className="h-1.5" />
      <Segmented<Prefs['listDensity']>
        value={prefs.listDensity}
        onChange={(listDensity) => setPrefs({ listDensity })}
        options={[{ value: 'detailed', label: 'Detailed' }, { value: 'compact', label: 'Compact' }]}
      />
      <SheetToggle
        label="Show temporary sessions"
        description="Runs in the system temp folder, usually started by another session. The Temporary filter always shows them."
        checked={prefs.showTemporary}
        onChange={(showTemporary) => setPrefs({ showTemporary })}
      />
      <SheetToggle
        label="Show side chats"
        description="Claude Desktop’s side chats: a copy of a session with a question or two of their own. A search always finds them."
        checked={prefs.showSideChats}
        onChange={(showSideChats) => setPrefs({ showSideChats })}
      />

      {/* The demo sends nothing anywhere, notifications included. */}
      {!info?.demo && (
        <>
          <SheetHeading>Notifications</SheetHeading>
          {notifications === 'unsupported' || notifications === 'denied' ? (
            <SheetOption icon={<Bell className="size-4" />} label="Notifications" description={NOTIFICATION_HINT[notifications]} onSelect={() => {}} />
          ) : (
            <SheetToggle
              icon={<Bell className="size-4 text-muted" />}
              label="Notifications"
              description={NOTIFICATION_HINT[notifications]}
              checked={notifications === 'on'}
              onChange={onToggleNotifications}
            />
          )}
        </>
      )}

      {(account || windows.length > 0 || plan?.extra) && <SheetHeading>Account</SheetHeading>}
      {account && (
        <div className="px-3 pb-1 text-[13px] leading-relaxed text-muted">
          {account.email && <span className="text-fg">{account.email}</span>}
          {account.plan && <> · {PLAN[account.plan] ?? account.plan}</>}
          {account.organization && <div className="text-faint">{account.organization}</div>}
        </div>
      )}
      {windows.map((bar) => <UsageBar key={bar.key} bar={bar} />)}
      {plan?.extra && (
        plan.extra.enabled ? (
          <UsageBar
            bar={{
              key: 'extra',
              label: 'Extra usage this month',
              ...(typeof plan.extra.utilization === 'number' ? { utilization: plan.extra.utilization } : {}),
              ...(typeof plan.extra.usedCents === 'number' ? {
                detail: typeof plan.extra.limitCents === 'number'
                  ? `${money(plan.extra.usedCents, plan.extra.currency)} of ${money(plan.extra.limitCents, plan.extra.currency)}`
                  : `${money(plan.extra.usedCents, plan.extra.currency)} spent`,
              } : {}),
            }}
          />
        ) : (
          <div className="flex items-baseline justify-between px-3 py-1.5 text-[13px]"><span>Extra usage</span><span className="text-[12px] text-faint">Off</span></div>
        )
      )}
      {account && windows.length === 0 && !plan?.extra && (
        <p className="px-3 text-[12px] leading-snug text-faint">{plan === null ? 'No plan limits apply to this account (an API key, Bedrock or Vertex).' : 'Usage limits show up here after Claude has worked in Pelican.'}</p>
      )}

      {!info?.demo && (
        <>
          <SheetHeading>On your phone</SheetHeading>
          {isLoopback(location.hostname) ? (
            <p className="px-3 pb-1 text-[13px] leading-relaxed text-muted">
              This address works on this computer only. To use Pelican on your phone, reach this computer through Tailscale, an SSH tunnel or a proxy, then open that address here and scan its code. <a className="underline decoration-faint underline-offset-2" href="https://ki-seki.github.io/pelican/docs.html#phone" target="_blank" rel="noreferrer">How</a>
            </p>
          ) : (
            <PhoneCode open={open} />
          )}
        </>
      )}

      <SheetHeading>About</SheetHeading>
      <div className="px-3 pb-2 text-[13px] leading-relaxed text-muted">
        Pelican {info?.version ?? ''} on <span className="text-fg">{info?.machine ?? '…'}</span>
        {info?.demo && <> · demo</>}
        <br />
        <a className="underline decoration-faint underline-offset-2" href="https://github.com/Ki-Seki/pelican" target="_blank" rel="noreferrer">github.com/Ki-Seki/pelican</a>
      </div>
      {info?.auth && <SheetOption icon={<LogOut className="size-4" />} label="Sign out" danger onSelect={onSignOut} />}
    </Sheet>
  );
}

const qrImage = (text: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(text))}`;

/**
 * This page's address as a QR code, for opening Pelican on a phone. When browsers sign in,
 * the code carries a one-time sign-in code instead of the token or the password: it works
 * once, within two minutes, so it shows only on a tap.
 */
function PhoneCode({ open }: { open: boolean }) {
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
  const link = live ? `${appBase.href}?code=${encodeURIComponent(code.value)}` : appBase.href;
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
        {signsIn
          ? <>Scan with your phone’s camera to open Pelican there, signed in. The code works once, for two minutes.</>
          : <>Scan with your phone’s camera to open this page there.</>}
        <br />
        <span className="font-mono text-[12px] break-all text-faint">{appBase.href}</span>
        {error && <><br /><span className="text-danger">{error}</span></>}
      </p>
    </div>
  );
}

type Bar = { key: string; label: string; utilization?: number; resetsAt?: number; status?: 'allowed' | 'allowed_warning' | 'rejected'; detail?: string };

const money = (cents: number, currency = 'USD') => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
};

/** One limit: what it is, how full (a bar when known), and when it starts over. */
function UsageBar({ bar }: { bar: Bar }) {
  const percent = typeof bar.utilization === 'number' ? Math.round(bar.utilization * 100) : undefined;
  const over = bar.status === 'rejected' || (percent !== undefined && percent >= 100);
  const near = bar.status === 'allowed_warning' || (percent !== undefined && percent >= 80);
  return (
    <div className="px-3 py-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="min-w-0 truncate">{bar.label}</span>
        <span className="shrink-0 text-[12px] text-faint">
          {[bar.detail, percent !== undefined ? `${percent}%` : over ? 'Reached' : undefined, bar.resetsAt ? `resets ${untilTime(bar.resetsAt)}` : undefined].filter(Boolean).join(' · ')}
        </span>
      </div>
      {percent !== undefined && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-chip">
          <div className={`h-full rounded-full ${over ? 'bg-danger' : near ? 'bg-wait' : 'bg-fg/70'}`} style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      )}
    </div>
  );
}
