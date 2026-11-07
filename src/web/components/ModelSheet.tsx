import { Loader2, Sparkles, Zap } from 'lucide-react';
import type { ReactNode } from 'react';

import { effortOf, isSavedEffort, type StartDefaults } from '../../shared/defaults';
import { MODE_INFO, type PermissionMode } from '../../shared/modes';
import type { ModelOption, RunSettings } from '../../shared/protocol';
import { EFFORT_LABELS, EFFORT_SHORT } from '../lib/prefs';
import { Segmented, Sheet, SheetHeading, SheetOption, SheetToggle } from './Sheet';

/** A line of small print in a sheet: where a value comes from, or what a pick does. */
export const SheetNote = ({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'warn' }) => (
  <p className={`px-3 pt-2 text-[12px] leading-snug ${tone === 'warn' ? 'text-wait' : 'text-faint'}`}>{children}</p>
);

export const modelOf = (models: ModelOption[] | undefined, settings: RunSettings): ModelOption | undefined =>
  models?.find((m) => m.value === (settings.model ?? 'default')) ?? models?.[0];

/** The model in a few words: its name, the effort, and icons for Ultracode and fast mode. */
export function ModelSummary({ settings, models }: { settings: RunSettings; models: ModelOption[] | undefined }) {
  const model = modelOf(models, settings);
  return (
    <>
      <span className="max-w-32 truncate">{model?.value === 'default' ? 'Default' : (model?.label ?? 'Model')}</span>
      {settings.effort && <span className="text-faint">{EFFORT_SHORT[settings.effort] ?? settings.effort}</span>}
      {model?.efforts.includes('xhigh') && settings.ultracode && <Sparkles className="size-3 text-faint" aria-label="Ultracode on" />}
      {model?.supportsFast && settings.fast && <Zap className="size-3 text-faint" aria-label="Fast mode on" />}
    </>
  );
}

/** What a pick in a session's model sheet does besides, and why one was not saved. */
export function SavedForNewSessions({ problem }: { problem?: string | undefined }) {
  return (
    <>
      <SheetNote>As in Claude Code, a model, an effort or fast mode picked here is saved for new sessions too. Max effort and Ultracode stay with this session.</SheetNote>
      {problem && <SheetNote tone="warn">{problem}</SheetNote>}
    </>
  );
}

/**
 * Model, effort, fast mode and Ultracode: for one session in its composer, or (`forNewSessions`) for
 * what new sessions start with, in Settings, which offers only what Claude Code keeps as a default:
 * no Max effort, which is for one session, and no Ultracode, which no command saves. `defaults`:
 * Claude Code's settings, which give a newly picked model its own effort, as /model does.
 */
export function ModelSheet({
  open, onClose, title = 'Model', settings, models, onChange, defaults, forNewSessions = false, note, footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  settings: RunSettings;
  models: ModelOption[] | undefined;
  onChange: (settings: RunSettings) => void;
  defaults?: StartDefaults;
  forNewSessions?: boolean;
  /** Where the values come from, when that is not plain. */
  note?: ReactNode;
  /** What a pick does besides, and anything that went wrong saving one. */
  footer?: ReactNode;
}) {
  const model = modelOf(models, settings);
  const efforts = (model?.efforts ?? []).filter((e) => !forNewSessions || isSavedEffort(e));
  const canUltra = !forNewSessions && (model?.efforts ?? []).includes('xhigh');
  const fastPerSession = forNewSessions && defaults?.fast.perSession;
  const set = (patch: Partial<RunSettings>) => onChange({ ...settings, ...patch });
  return (
    <Sheet open={open} onClose={onClose} title={title} done>
      {/* The model first: the effort levels, fast mode and Ultracode depend on it, as in Claude Code's /model. */}
      <SheetHeading>Model</SheetHeading>
      {!models && <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-faint" /></div>}
      {models?.map((m) => (
        <SheetOption
          key={m.value}
          label={m.label}
          description={m.description}
          selected={m.value === model?.value}
          onSelect={() => {
            if (m.value === model?.value) return;
            // The effort goes with the model, as in Claude Code: the one its settings keep for it.
            const effort = defaults ? effortOf(defaults, m.value, models).level : settings.effort;
            onChange({
              ...settings,
              model: m.value,
              effort: effort && m.efforts.includes(effort) ? effort : undefined,
              fast: m.supportsFast ? settings.fast : false,
              ultracode: m.efforts.includes('xhigh') ? settings.ultracode : false,
              ...(settings.permissionMode === 'auto' && m.supportsAuto === false ? { permissionMode: 'default' as const } : {}),
            });
          }}
        />
      ))}
      {efforts.length > 0 && (
        <>
          <SheetHeading>Reasoning effort</SheetHeading>
          <Segmented
            value={settings.effort}
            onChange={(effort) => set({ effort })}
            options={[
              { value: undefined, label: 'Default', title: 'What Claude Code uses for this model' },
              ...efforts.map((e) => ({ value: e as string | undefined, label: EFFORT_SHORT[e] ?? e, title: EFFORT_LABELS[e] ?? e })),
            ]}
          />
        </>
      )}
      {(model?.supportsFast || canUltra) && <div className="h-2" />}
      {model?.supportsFast && !fastPerSession && (
        <SheetToggle
          icon={<Zap className={`size-4 ${settings.fast ? 'fill-current text-wait' : 'text-faint'}`} />}
          label="Fast mode"
          description="Faster, billed at a higher rate"
          checked={Boolean(settings.fast)}
          onChange={(fast) => set({ fast })}
        />
      )}
      {canUltra && (
        <SheetToggle
          icon={<Sparkles className={`size-4 ${settings.ultracode ? 'text-run' : 'text-faint'}`} />}
          label="Ultracode"
          description="Works through parallel agents"
          checked={Boolean(settings.ultracode)}
          onChange={(ultracode) => set({ ultracode })}
        />
      )}
      {note && <SheetNote>{note}</SheetNote>}
      {footer}
    </Sheet>
  );
}

/**
 * The permission modes to pick from: for one session in its composer, or for new sessions in
 * Settings. Auto shows only where the model has it. The mode in use is listed even when it is not
 * offered (Don't ask, which Claude Code's settings can give), so the list says where it is.
 */
export function ModeSheet({
  open, onClose, title = 'When Claude wants to act', offered, value, model, onPick, note, footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  offered: readonly PermissionMode[];
  value: PermissionMode;
  model: ModelOption | undefined;
  onPick: (mode: PermissionMode) => void;
  /** Why it starts in this mode, when that is not plain. */
  note?: ReactNode;
  footer?: ReactNode;
}) {
  const available = offered.filter((m) => m !== 'auto' || model?.supportsAuto !== false);
  const modes = available.includes(value) ? available : [value, ...available];
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {modes.map((m) => (
        <SheetOption key={m} label={MODE_INFO[m].label} description={MODE_INFO[m].description} selected={m === value} onSelect={() => {
          if (available.includes(m)) onPick(m);
          onClose();
        }} />
      ))}
      {note && <SheetNote tone={value === 'bypassPermissions' ? 'warn' : 'plain'}>{note}</SheetNote>}
      {footer}
    </Sheet>
  );
}
