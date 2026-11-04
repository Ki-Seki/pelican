import { useQuery } from '@tanstack/react-query';
import { ArrowUp, AtSign, ChevronDown, FileText, Folder, Loader2, Paperclip, Slash, Sparkles, Square, X, Zap } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

import type { Attachment, Command, ModelOption, PermissionMode, RunSettings } from '../../shared/protocol';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';
import { EFFORT_LABELS, EFFORT_SHORT, enterSends, PERMISSION_MODES } from '../lib/prefs';
import { Segmented, Sheet, SheetHeading, SheetOption, SheetToggle } from './Sheet';

type Upload = { key: string; name: string; size: number; preview?: string; attachment?: Attachment; error?: string };

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

/** What the text before the caret asks to complete: a slash command at the start, or an @ mention. */
type Trigger = { kind: 'command' | 'file'; query: string; start: number; end: number };

function findTrigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const command = before.match(/^\/([\w:.-]*)$/);
  if (command) return { kind: 'command', query: command[1]!, start: 0, end: caret };
  const mention = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (mention) return { kind: 'file', query: mention[1]!, start: caret - mention[1]!.length - 1, end: caret };
  return undefined;
}

type Suggestion = { key: string; label: string; detail?: string; insert: string; icon: 'command' | 'file' | 'folder' };

function useSuggestions(trigger: Trigger | undefined, cwd: string | undefined): { items: Suggestion[]; loading: boolean } {
  const [fileQuery, setFileQuery] = useState('');
  useEffect(() => {
    if (trigger?.kind !== 'file') return;
    const timer = setTimeout(() => setFileQuery(trigger.query), 120);
    return () => clearTimeout(timer);
  }, [trigger?.kind, trigger?.query]);

  const commands = useQuery({
    queryKey: ['commands', cwd],
    queryFn: () => api.commands(cwd!),
    enabled: Boolean(cwd) && trigger?.kind === 'command',
    staleTime: 10 * 60_000,
  });
  const files = useQuery({
    queryKey: ['files', cwd, fileQuery],
    queryFn: () => api.files(cwd!, fileQuery),
    enabled: Boolean(cwd) && trigger?.kind === 'file',
    staleTime: 30_000,
  });

  return useMemo(() => {
    if (!trigger) return { items: [], loading: false };
    if (trigger.kind === 'command') {
      const q = trigger.query.toLowerCase();
      const list = (commands.data ?? [])
        .filter((c: Command) => !q || c.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, 8)
        .map((c) => ({ key: c.name, label: `/${c.name}`, detail: c.argumentHint ? `${c.argumentHint} · ${c.description}` : c.description, insert: `/${c.name} `, icon: 'command' as const }));
      return { items: list, loading: commands.isLoading };
    }
    const list = (files.data ?? []).slice(0, 8).map((path) => ({
      key: path,
      label: path.replace(/\/$/, '').split('/').pop() + (path.endsWith('/') ? '/' : ''),
      detail: path,
      insert: `@${path}${path.endsWith('/') ? '' : ' '}`,
      icon: path.endsWith('/') ? ('folder' as const) : ('file' as const),
    }));
    return { items: list, loading: files.isLoading };
  }, [trigger, commands.data, commands.isLoading, files.data, files.isLoading]);
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
  cwd,
  draft,
  disabled,
}: {
  busy: boolean;
  settings: RunSettings;
  onSettings: (settings: RunSettings) => void;
  models: ModelOption[] | undefined;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Folder of the session, for / commands and @ files. */
  cwd?: string;
  /** Text to put in the box, e.g. a prompt being edited, or one that failed to send; a new `key` puts it in again. */
  draft?: { text: string; key: number };
  disabled?: boolean;
}) {
  const [text, setText] = useState(draft?.text ?? '');
  const [caret, setCaret] = useState(0);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sheet, setSheet] = useState<'model' | 'mode' | undefined>();
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const model = models?.find((m) => m.value === (settings.model ?? 'default')) ?? models?.[0];
  const efforts = model?.efforts ?? [];
  const canUltra = efforts.includes('xhigh');
  const modes = PERMISSION_MODES.filter((m) => m.value !== 'auto' || model?.supportsAuto !== false);
  const mode = PERMISSION_MODES.find((m) => m.value === (settings.permissionMode ?? 'default')) ?? PERMISSION_MODES[0]!;
  const uploading = uploads.some((u) => !u.attachment && !u.error);
  const canSend = !disabled && (text.trim().length > 0 || uploads.some((u) => u.attachment)) && !uploading;

  const trigger = useMemo(() => {
    const found = findTrigger(text, caret);
    return found && `${found.kind}:${found.start}` !== dismissed ? found : undefined;
  }, [text, caret, dismissed]);
  const { items: suggestions, loading: suggesting } = useSuggestions(trigger, cwd);
  const showSuggestions = Boolean(trigger) && (suggestions.length > 0 || suggesting);

  useEffect(() => setHighlight(0), [trigger?.kind, trigger?.query]);

  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(draft.text.length, draft.text.length);
      setCaret(draft.text.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.key]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus && !window.matchMedia('(pointer: coarse)').matches) area.current?.focus();
  }, [autoFocus]);

  const addFiles = (files: FileList | File[]) => {
    for (const original of Array.from(files)) {
      const key = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
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
    setCaret(0);
    for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview);
    setUploads([]);
  };

  const accept = (suggestion: Suggestion) => {
    if (!trigger) return;
    const next = text.slice(0, trigger.start) + suggestion.insert + text.slice(trigger.end);
    const at = trigger.start + suggestion.insert.length;
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        accept(suggestions[highlight] ?? suggestions[0]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (trigger) setDismissed(`${trigger.kind}:${trigger.start}`);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && enterSends()) {
      e.preventDefault();
      submit();
    }
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
    <div className="pb-safe relative shrink-0 px-3 pt-1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {showSuggestions && (
        <div className="animate-fade absolute right-3 bottom-full left-3 z-20 mx-auto mb-1 max-w-3xl overflow-hidden rounded-2xl border border-line bg-panel shadow-xl" role="listbox">
          {suggesting && suggestions.length === 0 && <div className="flex justify-center py-3"><Loader2 className="size-4 animate-spin text-faint" /></div>}
          {suggestions.map((s, i) => {
            const Icon = s.icon === 'command' ? Slash : s.icon === 'folder' ? Folder : FileText;
            return (
              <button
                key={s.key}
                type="button"
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => accept(s)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${i === highlight ? 'bg-hover' : ''}`}
              >
                <Icon className="size-3.5 shrink-0 text-faint" />
                <span className="shrink-0 font-mono text-[13px]">{s.label}</span>
                {s.detail && <span className="min-w-0 truncate text-[12px] text-faint">{s.detail}</span>}
              </button>
            );
          })}
        </div>
      )}
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
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setDismissed(undefined);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          className="block max-h-[40dvh] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[16px] leading-6 outline-none placeholder:text-faint disabled:opacity-50"
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
              {canUltra && settings.ultracode && <Sparkles className="size-3.5 text-run" aria-label="Ultracode on" />}
              {model?.supportsFast && settings.fast && <Zap className="size-3.5 fill-current text-wait" aria-label="Fast mode on" />}
              <ChevronDown className="size-3.5 opacity-60" />
            </Chip>
            <Chip label="Permission mode" tone={mode.value === 'bypassPermissions' ? 'warn' : 'plain'} onClick={() => setSheet('mode')}>
              {mode.short}
              <ChevronDown className="size-3.5 opacity-60" />
            </Chip>
            {cwd && !text && (
              <Chip label="Mention a file" onClick={() => {
                setText('@');
                setCaret(1);
                requestAnimationFrame(() => {
                  area.current?.focus();
                  area.current?.setSelectionRange(1, 1);
                });
              }}>
                <AtSign className="size-3.5" />
              </Chip>
            )}
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
            description="Faster output, billed at a higher rate"
            checked={Boolean(settings.fast)}
            onChange={(fast) => set({ fast })}
          />
        )}
        {canUltra && (
          <SheetToggle
            icon={<Sparkles className={`size-4 ${settings.ultracode ? 'text-run' : 'text-faint'}`} />}
            label="Ultracode"
            description="Claude plans and runs its work as workflows of parallel agents, on top of any effort level"
            checked={Boolean(settings.ultracode)}
            onChange={(ultracode) => set({ ultracode })}
          />
        )}
        <SheetHeading>Model</SheetHeading>
        {!models && <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-faint" /></div>}
        {models?.map((m) => (
          <SheetOption
            key={m.value}
            label={m.label}
            description={m.description}
            selected={m.value === model?.value}
            onSelect={() => {
              const effort = settings.effort && m.efforts.includes(settings.effort) ? settings.effort : undefined;
              onSettings({
                ...settings,
                model: m.value,
                effort,
                fast: m.supportsFast ? settings.fast : false,
                ultracode: m.efforts.includes('xhigh') ? settings.ultracode : false,
                permissionMode: settings.permissionMode === 'auto' && m.supportsAuto === false ? 'default' : settings.permissionMode,
              });
            }}
          />
        ))}
      </Sheet>

      <Sheet open={sheet === 'mode'} onClose={() => setSheet(undefined)} title="When Claude wants to act">
        {modes.map((m) => (
          <SheetOption key={m.value} label={m.label} description={m.description} selected={m.value === mode.value} onSelect={() => {
            set({ permissionMode: m.value as PermissionMode });
            setSheet(undefined);
          }} />
        ))}
      </Sheet>
    </div>
  );
}
