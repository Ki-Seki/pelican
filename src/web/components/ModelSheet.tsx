import { Loader2, Sparkles, Zap } from 'lucide-react';

import { MODE_INFO, type PermissionMode } from '../../shared/modes';
import type { ModelOption, RunSettings } from '../../shared/protocol';
import { EFFORT_LABELS, EFFORT_SHORT } from '../lib/prefs';
import { Segmented, Sheet, SheetHeading, SheetOption, SheetToggle } from './Sheet';

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

/** Model, effort, fast mode and Ultracode: for one session in its composer, or for new sessions in Settings. */
export function ModelSheet({
  open, onClose, title = 'Model', settings, models, onChange,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  settings: RunSettings;
  models: ModelOption[] | undefined;
  onChange: (settings: RunSettings) => void;
}) {
  const model = modelOf(models, settings);
  const efforts = model?.efforts ?? [];
  const canUltra = efforts.includes('xhigh');
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
          onSelect={() => onChange({
            ...settings,
            model: m.value,
            effort: settings.effort && m.efforts.includes(settings.effort) ? settings.effort : undefined,
            fast: m.supportsFast ? settings.fast : false,
            ultracode: m.efforts.includes('xhigh') ? settings.ultracode : false,
            ...(settings.permissionMode === 'auto' && m.supportsAuto === false ? { permissionMode: 'default' as const } : {}),
          })}
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
      {model?.supportsFast && (
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
    </Sheet>
  );
}

/**
 * The permission modes to pick from: for one session in its composer, or for new sessions in
 * Settings. Auto shows only where the model has it. The mode in use is listed even when it is not
 * offered (Don't ask, which Claude Code's settings can give), so the list says where it is.
 */
export function ModeSheet({
  open, onClose, title = 'When Claude wants to act', offered, value, model, onPick,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  offered: readonly PermissionMode[];
  value: PermissionMode;
  model: ModelOption | undefined;
  onPick: (mode: PermissionMode) => void;
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
    </Sheet>
  );
}
