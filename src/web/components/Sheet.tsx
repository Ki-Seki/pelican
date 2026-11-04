import { Check } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';

/** A bottom sheet on phones, a centered panel on wider screens. */
export function Sheet({ open, onClose, title, children, done }: { open: boolean; onClose: () => void; title: string; children: ReactNode; done?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" onClick={onClose}>
      <div className="animate-fade absolute inset-0 bg-black/30" />
      <div
        role="dialog"
        aria-label={title}
        className="animate-sheet pb-safe relative flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl border border-line bg-panel shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-4 pt-2 pb-1">
          <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-line sm:hidden" />
          <div className="flex min-h-8 items-center">
            <div className="flex-1 text-[13px] font-medium text-muted">{title}</div>
            {done && (
              <button type="button" onClick={onClose} className="-my-1 h-8 rounded-full px-3 text-[14px] font-medium hover:bg-hover">
                Done
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto px-2 pb-2">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function SheetHeading({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-4 pb-1.5 text-[12px] text-faint first:pt-1">{children}</div>;
}

export function SheetOption({
  label,
  description,
  selected,
  onSelect,
  trailing,
  danger,
  icon,
}: {
  label: ReactNode;
  description?: ReactNode;
  selected?: boolean;
  onSelect: () => void;
  trailing?: ReactNode;
  danger?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-hover ${selected ? 'bg-hover' : ''} ${danger ? 'text-danger' : ''}`}
    >
      {icon && <span className="grid size-5 shrink-0 place-items-center text-muted">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="text-[15px]">{label}</div>
        {description && <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{description}</div>}
      </div>
      {trailing}
      {selected && <Check className="size-4 shrink-0" />}
    </button>
  );
}

/** A setting that is on or off. */
export function SheetToggle({
  label,
  description,
  checked,
  onChange,
  icon,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-hover"
    >
      {icon && <span className="grid size-5 shrink-0 place-items-center">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="text-[15px]">{label}</div>
        {description && <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{description}</div>}
      </div>
      <span className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? 'bg-fg' : 'bg-line'}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-bg shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}

/** A row of mutually exclusive choices that share the width. */
export function Segmented<T extends string | undefined>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid auto-cols-fr grid-flow-col gap-1 px-3 pb-1">
      {options.map((option) => (
        <button
          key={option.value ?? '*'}
          type="button"
          title={option.title}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`h-9 min-w-0 rounded-full px-1 text-[13.5px] ${option.value === value ? 'bg-fg text-bg' : 'bg-chip text-muted hover:text-fg'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
