import { Check } from 'lucide-react';
import { type PointerEvent, type ReactNode, useId, useRef } from 'react';

import { Modal } from './Modal';

/** Dragged down past this, or flicked faster than this (px per ms), a sheet closes; else it springs back. */
const DISMISS_PX = 80;
const FLICK = 0.5;

/**
 * A bottom sheet on phones, a centered panel on wider screens: a modal dialog (see Modal). On a
 * phone its top can be dragged down to close it, as the sheets there can.
 */
export function Sheet({
  open, onClose, title, children, done, size = 'normal', header, behind, trailing,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  done?: boolean;
  /** Beside the title, at its end, outside it: a sheet's own way out (the side chat's ×), in place of Done. */
  trailing?: ReactNode;
  /** large: nearly the whole screen on a phone, wide on a computer, for reading files and diffs. */
  size?: 'normal' | 'large';
  /** Shown under the title, outside the scrolling part. */
  header?: ReactNode;
  /** Over the dimmed page and under the sheet: what a long press opened the sheet for, raised. */
  behind?: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // A tap outside closes it; the finger lifting from the long press that opened it is no tap.
  const tapped = useRef(false);
  const drag = useRef<{ id: number; startY: number; lastY: number; lastT: number; speed: number; dy: number; moving: boolean } | undefined>(undefined);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || window.matchMedia('(min-width: 640px)').matches) return;
    drag.current = { id: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, speed: 0, dy: 0, moving: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = panel.current;
    if (!d || d.id !== e.pointerId || !el) return;
    const dy = e.clientY - d.startY;
    if (!d.moving) {
      // A tap on Done stays a tap: only a move down starts a drag.
      if (dy < 6) return;
      d.moving = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (e.timeStamp > d.lastT) d.speed = (e.clientY - d.lastY) / (e.timeStamp - d.lastT);
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    d.dy = Math.max(0, dy);
    el.style.transition = 'none';
    el.style.transform = `translateY(${d.dy}px)`;
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = panel.current;
    drag.current = undefined;
    if (!d?.moving || !el) return;
    el.style.transition = '';
    // From where the finger left it, the sheet goes on down; else back up.
    if (e.type === 'pointerup' && (d.dy > DISMISS_PX || d.speed > FLICK)) onClose();
    else el.style.transform = '';
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId}>
      <div className="flex h-full w-full items-end justify-center sm:items-center sm:p-6">
        <div
          className="animate-fade absolute inset-0 bg-black/30 transition-opacity duration-200 group-data-closing/modal:opacity-0"
          onPointerDown={() => {
            tapped.current = true;
          }}
          onClick={() => {
            if (tapped.current) onClose();
            tapped.current = false;
          }}
        />
        {behind}
        <div
          ref={panel}
          className={`animate-sheet pb-safe relative flex w-full flex-col rounded-t-2xl border border-line bg-panel shadow-2xl transition-[translate,transform,opacity] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-closing/modal:translate-y-full motion-reduce:transition-none sm:rounded-2xl sm:group-data-closing/modal:translate-y-3 sm:group-data-closing/modal:opacity-0 ${size === 'large' ? 'h-[92%] max-w-3xl sm:h-[85%]' : 'max-h-[85%] max-w-md'}`}
        >
          <div className="shrink-0 px-4 pb-1">
            <div
              className="touch-none pt-2 select-none sm:touch-auto"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
            >
              <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-line sm:hidden" />
              <div className="flex min-h-8 items-center">
                <h2 id={titleId} className="min-w-0 flex-1 text-[13px] font-medium text-muted">{title}</h2>
                {trailing}
                {done && (
                  <button type="button" onClick={onClose} className="-my-1 h-8 rounded-full px-3 text-[14px] font-medium hover:bg-hover">
                    Done
                  </button>
                )}
              </div>
            </div>
            {header}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">{children}</div>
        </div>
      </div>
    </Modal>
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
      aria-pressed={selected}
      onClick={onSelect}
      data-autofocus={selected || undefined}
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
