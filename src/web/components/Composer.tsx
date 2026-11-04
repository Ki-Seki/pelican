import { ArrowUp, ChevronDown, FileText, Loader2, Paperclip, Square, X, Zap } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from 'react';

import type { Attachment, ModelOption, PermissionMode, RunSettings } from '../../shared/protocol';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';
import { EFFORT_LABELS, PERMISSION_MODES } from '../lib/prefs';
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

function Chip({ children, onClick, active, label }: { children: React.ReactNode; onClick: () => void; active?: boolean; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] ${active ? 'bg-fg text-bg' : 'text-muted hover:bg-hover hover:text-fg'}`}
    >
      {children}
    </button>
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
  const [sheet, setSheet] = useState<'model' | 'effort' | 'mode' | undefined>();
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
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            <Chip label="Model" onClick={() => setSheet('model')}>
              <span className="max-w-32 truncate">{model?.value === 'default' ? 'Default' : (model?.label ?? 'Model')}</span>
              <ChevronDown className="size-3.5 opacity-60" />
            </Chip>
            {efforts.length > 0 && (
              <Chip label="Effort" onClick={() => setSheet('effort')}>
                {settings.effort ? EFFORT_LABELS[settings.effort] ?? settings.effort : 'Effort'}
                <ChevronDown className="size-3.5 opacity-60" />
              </Chip>
            )}
            {model?.supportsFast && (
              <Chip label="Fast mode" active={settings.fast} onClick={() => set({ fast: !settings.fast })}>
                <Zap className="size-3.5" />Fast
              </Chip>
            )}
            <Chip label="Permission mode" active={mode.value === 'bypassPermissions'} onClick={() => setSheet('mode')}>
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

      <Sheet open={sheet === 'model'} onClose={() => setSheet(undefined)} title="Model">
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
              setSheet(undefined);
            }}
          />
        ))}
      </Sheet>

      <Sheet open={sheet === 'effort'} onClose={() => setSheet(undefined)} title="Reasoning effort">
        <SheetOption label="Default" description="What Claude Code uses for this model" selected={!settings.effort} onSelect={() => {
          set({ effort: undefined });
          setSheet(undefined);
        }} />
        {efforts.map((effort) => (
          <SheetOption key={effort} label={EFFORT_LABELS[effort] ?? effort} selected={settings.effort === effort} onSelect={() => {
            set({ effort });
            setSheet(undefined);
          }} />
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
