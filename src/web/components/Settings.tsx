import { Bell, LogOut } from 'lucide-react';

import type { ServerInfo } from '../../shared/protocol';
import type { NotificationState } from '../lib/notifications';
import { type Prefs, setPrefs, type Theme, usePrefs, type ViewMode } from '../lib/prefs';
import { Segmented, Sheet, SheetHeading, SheetOption, SheetToggle } from './Sheet';

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
