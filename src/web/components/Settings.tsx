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

      {(account || (limits && limits.length > 0)) && <SheetHeading>Account</SheetHeading>}
      {account && (
        <div className="px-3 pb-1 text-[13px] leading-relaxed text-muted">
          {account.email && <span className="text-fg">{account.email}</span>}
          {account.plan && <> · {PLAN[account.plan] ?? account.plan}</>}
          {account.organization && <div className="text-faint">{account.organization}</div>}
        </div>
      )}
      {limits?.map((limit) => (
        <div key={limit.type} className="px-3 py-1.5">
          <div className="flex items-baseline justify-between text-[13px]">
            <span>{LIMIT[limit.type] ?? limit.type}</span>
            <span className="text-[12px] text-faint">
              {typeof limit.utilization === 'number' ? `${Math.round(limit.utilization * 100)}%` : limit.status === 'rejected' ? 'Reached' : ''}
              {limit.resetsAt ? ` · resets ${untilTime(limit.resetsAt)}` : ''}
            </span>
          </div>
          {typeof limit.utilization === 'number' && (
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-chip">
              <div className={`h-full rounded-full ${limit.status === 'rejected' ? 'bg-danger' : limit.status === 'allowed_warning' ? 'bg-wait' : 'bg-fg/70'}`} style={{ width: `${Math.min(100, Math.round(limit.utilization * 100))}%` }} />
            </div>
          )}
        </div>
      ))}
      {account && (!limits || limits.length === 0) && <p className="px-3 text-[12px] leading-snug text-faint">Usage limits show up here after Claude has worked in Pelican.</p>}

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
 * This page's address as a QR code, for opening Pelican on a phone. With the
 * access token, the code also signs the phone in, so it shows only on a tap:
 * anyone who scans it can use Pelican as you.
 */
function PhoneCode({ open }: { open: boolean }) {
  const { data: auth } = useQuery<AuthState>({ queryKey: ['auth'], enabled: false });
  const token = auth?.mode === 'token';
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!open) setShown(false);
  }, [open]);
  const { data: access } = useQuery({ queryKey: ['access'], queryFn: api.access, enabled: open && token && shown, staleTime: Infinity });
  const link = token && access ? `${appBase.href}?token=${encodeURIComponent(access)}` : appBase.href;
  const hidden = token && !(shown && access);
  return (
    <div className="flex items-center gap-4 px-3 pb-1">
      {hidden ? (
        <button type="button" onClick={() => setShown(true)} className="grid size-28 shrink-0 place-items-center rounded-lg border border-dashed border-line text-[12.5px] text-muted hover:bg-hover hover:text-fg">
          Show code
        </button>
      ) : (
        <img src={qrImage(link)} alt="" className="size-28 shrink-0 rounded-lg border border-line bg-white p-1.5" />
      )}
      <p className="min-w-0 text-[13px] leading-relaxed text-muted">
        {token
          ? <>Scan with your phone’s camera to open Pelican there, signed in. Anyone who scans it can use Pelican as you.</>
          : <>Scan with your phone’s camera to open this page there.</>}
        <br />
        <span className="font-mono text-[12px] break-all text-faint">{appBase.href}</span>
      </p>
    </div>
  );
}
