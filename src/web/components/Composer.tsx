import { ArrowUp, ChevronDown, FileText, Loader2, Paperclip, Square, X, Zap } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from 'react';

import type { Attachment, ModelOption, PermissionMode, RunSettings } from '../../shared/protocol';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';
import { EFFORT_LABELS, EFFORT_SHORT, PERMISSION_MODES } from '../lib/prefs';
import { Sheet, SheetOption } from './Sheet';

type Upload = { key: string; name: string; size: number; preview?: string; attachment?: Attachment; error?: string };

const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

/** Phone photos are large; send at most 2048 px on the long side. */
async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/** A composer setting. Never a solid pill: the send button is the only solid control in the row. */
function Chip({ children, onClick, tone = 'plain', label }: { children: React.ReactNode; onClick: () => void; tone?: 'plain' | 'warn'; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] whitespace-nowrap ${tone === 'warn' ? 'bg-wait/12 text-wait' : 'text-muted hover:bg-hover hover:text-fg'}`}
    >
      {children}
    </button>
  );
}

function Segmented({ options, value, onChange }: { options: Array<{ value: string | undefined; label: string; title?: string }>; value: string | undefined; onChange: (value: string | undefined) => void }) {
  return (
    <div className="grid auto-cols-fr grid-flow-col gap-1 px-3 pb-1">
      {options.map((option) => (
        <button
          key={option.value ?? '*'}
          type="button"
          title={option.title}
          onClick={() => onChange(option.value)}
          className={`h-9 min-w-0 rounded-full px-1 text-[13.5px] ${option.value === value ? 'bg-fg text-bg' : 'bg-chip text-muted hover:text-fg'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Composer({
  busy,
  settings,
  onSettings,
  models,
  onSend,
  onStop,
  placeholder = 'Message Claude',
  autoFocus,
}: {
  busy: boolean;
  settings: RunSettings;
  onSettings: (settings: RunSettings) => void;
  models: ModelOption[] | undefined;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sheet, setSheet] = useState<'model' | 'mode' | undefined>();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const model = models?.find((m) => m.value === (settings.model ?? 'default')) ?? models?.[0];
  const efforts = model?.efforts ?? [];
  const mode = PERMISSION_MODES.find((m) => m.value === (settings.permissionMode ?? 'default')) ?? PERMISSION_MODES[0]!;
  const uploading = uploads.some((u) => !u.attachment && !u.error);
  const canSend = (text.trim().length > 0 || uploads.some((u) => u.attachment)) && !uploading;

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus && !coarsePointer()) area.current?.focus();
  }, [autoFocus]);

  const addFiles = (files: FileList | File[]) => {
    for (const original of Array.from(files)) {
      const key = crypto.randomUUID();
      const preview = original.type.startsWith('image/') ? URL.createObjectURL(original) : undefined;
      setUploads((list) => [...list, { key, name: original.name, size: original.size, ...(preview ? { preview } : {}) }]);
      void shrinkImage(original)
        .then((file) => api.upload(file))
        .then((attachment) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, attachment, size: attachment.size } : u))))
        .catch((error: Error) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, error: error.message } : u))));
    }
  };

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), uploads.flatMap((u) => (u.attachment ? [u.attachment] : [])));
    setText('');
    for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview);
    setUploads([]);
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    }
  };

  const set = (patch: Partial<RunSettings>) => onSettings({ ...settings, ...patch });

  return (
    <div className="pb-safe shrink-0 px-3 pt-1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="mx-auto max-w-3xl rounded-[22px] border border-line bg-panel shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
        {uploads.length > 0 && (
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-3 pt-3">
            {uploads.map((u) => (
              <div key={u.key} className="relative shrink-0">
                {u.preview ? (
                  <img alt={u.name} src={u.preview} className="size-16 rounded-xl border border-line object-cover" />
                ) : (
                  <div className="flex h-16 w-36 flex-col justify-center gap-0.5 rounded-xl border border-line px-2.5">
                    <div className="flex items-center gap-1.5 text-[12.5px]"><FileText className="size-3.5 shrink-0" /><span className="truncate">{u.name}</span></div>
                    <div className="text-[11px] text-faint">{formatBytes(u.size)}</div>
                  </div>
                )}
                {!u.attachment && !u.error && <div className="absolute inset-0 grid place-items-center rounded-xl bg-panel/60"><Loader2 className="size-4 animate-spin" /></div>}
                {u.error && <div className="absolute inset-0 grid place-items-center rounded-xl bg-panel/80 px-1 text-center text-[10px] text-danger">{u.error}</div>}
                <button
                  type="button"
                  aria-label={`Remove ${u.name}`}
                  className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-fg text-bg"
                  onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          value={text}
          rows={1}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarsePointer()) {
              e.preventDefault();
              submit();
            }
          }}
          className="block max-h-[40dvh] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[16px] leading-6 outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <button
            type="button"
            aria-label="Attach files"
            className="grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"
            onClick={() => picker.current?.click()}
          >
            <Paperclip className="size-[18px]" />
          </button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }} />
          {/* Model, effort and speed share one chip, so the row fits a phone; it scrolls with a fade if not. */}
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-3 [mask-image:linear-gradient(to_right,black_calc(100%-14px),transparent)]">
            <Chip label="Model, effort and speed" onClick={() => setSheet('model')}>
              <span className="max-w-28 truncate">{model?.value === 'default' ? 'Default' : (model?.label ?? 'Model')}</span>
              {settings.effort && <span className="text-faint">· {EFFORT_SHORT[settings.effort] ?? settings.effort}</span>}
              {model?.supportsFast && settings.fast && <Zap className="size-3.5 fill-current text-wait" aria-label="Fast mode on" />}
              <ChevronDown className="size-3.5 opacity-60" />
            </Chip>
            <Chip label="Permission mode" tone={mode.value === 'bypassPermissions' ? 'warn' : 'plain'} onClick={() => setSheet('mode')}>
              {mode.short}
              <ChevronDown className="size-3.5 opacity-60" />
            </Chip>
          </div>
          {busy && !canSend ? (
            <button type="button" aria-label="Stop" onClick={onStop} className="grid size-9 shrink-0 place-items-center rounded-full bg-fg text-bg">
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={submit}
              className="grid size-9 shrink-0 place-items-center rounded-full bg-fg text-bg transition-opacity disabled:opacity-25"
            >
              <ArrowUp className="size-[18px]" />
            </button>
          )}
        </div>
      </div>

      <Sheet open={sheet === 'model'} onClose={() => setSheet(undefined)} title="Model" done>
        {efforts.length > 0 && (
          <>
            <div className="px-3 pt-1 pb-2 text-[12px] text-faint">Reasoning effort</div>
            <Segmented
              value={settings.effort}
              onChange={(effort) => set({ effort })}
              options={[
                { value: undefined, label: 'Default', title: 'What Claude Code uses for this model' },
                ...efforts.map((e) => ({ value: e, label: EFFORT_SHORT[e] ?? e, title: EFFORT_LABELS[e] ?? e })),
              ]}
            />
          </>
        )}
        {model?.supportsFast && (
          <button
            type="button"
            onClick={() => set({ fast: !settings.fast })}
            className="mt-2 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-hover"
            role="switch"
            aria-checked={Boolean(settings.fast)}
          >
            <Zap className={`size-4 shrink-0 ${settings.fast ? 'fill-current text-wait' : 'text-faint'}`} />
            <div className="min-w-0 flex-1">
              <div className="text-[15px]">Fast mode</div>
              <div className="mt-0.5 text-[12.5px] text-muted">Faster output, billed at a higher rate</div>
            </div>
            <span className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${settings.fast ? 'bg-fg' : 'bg-line'}`}>
              <span className={`absolute top-0.5 size-5 rounded-full bg-bg shadow transition-transform ${settings.fast ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
            </span>
          </button>
        )}
        <div className="px-3 pt-3 pb-1 text-[12px] text-faint">Model</div>
        {!models && <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-faint" /></div>}
        {models?.map((m) => (
          <SheetOption
            key={m.value}
            label={m.label}
            description={m.description}
            selected={m.value === model?.value}
            onSelect={() => {
              const effort = settings.effort && m.efforts.includes(settings.effort) ? settings.effort : undefined;
              onSettings({ ...settings, model: m.value, effort, fast: m.supportsFast ? settings.fast : false });
            }}
          />
        ))}
      </Sheet>

      <Sheet open={sheet === 'mode'} onClose={() => setSheet(undefined)} title="When Claude wants to act">
        {PERMISSION_MODES.map((m) => (
          <SheetOption key={m.value} label={m.label} description={m.description} selected={m.value === mode.value} onSelect={() => {
            set({ permissionMode: m.value as PermissionMode });
            setSheet(undefined);
          }} />
        ))}
      </Sheet>
    </div>
  );
}
