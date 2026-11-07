import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import type { RunState } from '../../shared/protocol';
import { cacheShare, costShown, costWords, tokenTotal } from '../../shared/usage';
import { api } from '../lib/api';
import { compactNumber, percent } from '../lib/usage';
import { Popover } from './ActionMenu';
import { usePlanLimits } from './PlanLimits';
import { Sheet } from './Sheet';

type Context = NonNullable<RunState['context']>;

const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

/** How full the context window is, as Claude Code's /context says it: a ring that warns as it fills. */
export function ContextRing({ context, quiet, onClick, ref }: {
  context: Context;
  /** On a phone below 60%: faint, and no number. */
  quiet: boolean;
  onClick: (ring: HTMLButtonElement) => void;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const full = Math.max(0, Math.min(100, context.percent));
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const tone = full >= 90 ? 'text-danger' : full >= 75 ? 'text-wait' : quiet ? 'text-faint' : 'text-muted';
  return (
    <button
      ref={ref}
      type="button"
      onClick={(e) => onClick(e.currentTarget)}
      data-context-ring
      aria-label={`Context ${full}% full`}
      aria-haspopup="dialog"
      title={`Context: ${kTokens(context.tokens)} of ${kTokens(context.max)} tokens`}
      className={`relative flex h-9 shrink-0 items-center gap-1 rounded-full px-1.5 text-[12px] tabular-nums after:absolute after:-inset-y-1 after:inset-x-0 hover:bg-hover ${tone} ${quiet ? 'opacity-70' : ''}`}
    >
      <svg viewBox="0 0 18 18" className="size-[18px] -rotate-90">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line)" strokeWidth="2.5" />
        <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(full / 100) * circumference} ${circumference}`} />
      </svg>
      {!quiet && <span>{full}%</span>}
    </button>
  );
}

function Meter({ value }: { value: number }) {
  const tone = value >= 90 ? 'bg-danger' : value >= 75 ? 'bg-wait' : 'bg-fg/70';
  return (
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-chip">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

const Rule = () => <div className="mx-3 my-1.5 h-px bg-line" />;

/**
 * Context, from the ring by Send (or /context): how full the window is, with Compact; what this
 * session used, as Claude Code counts it; the plan's limits; and the way to Usage and activity.
 */
function ContextBody({ sessionId, context, onCompact, onUsage, open, sheet }: {
  sessionId: string;
  context?: Context;
  onCompact?: () => void;
  onUsage?: () => void;
  open: boolean;
  sheet: boolean;
}) {
  const { data: usage } = useQuery({ queryKey: ['session-usage', sessionId], queryFn: () => api.sessionUsage(sessionId), enabled: open, staleTime: 10_000 });
  const { data: models } = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 10 * 60_000, enabled: open });
  const { bars } = usePlanLimits(open);
  const total = usage ? tokenTotal(usage.tokens) : 0;
  const share = usage ? cacheShare(usage.tokens) : undefined;
  const cost = usage?.cost && costShown({ signedIn: models?.signedIn ?? null, plan: models?.account?.plan }) ? costWords(usage.cost.usd) : undefined;
  const totals = total > 0 ? [`${compactNumber(total)} tokens`, share !== undefined ? `${percent(share)} from cache` : '', cost ?? ''].filter(Boolean).join(' · ') : undefined;
  const full = context ? Math.max(0, Math.min(100, context.percent)) : undefined;
  const parts: ReactNode[] = [];
  if (context && full !== undefined) {
    parts.push(
      <div key="window" className="px-3 pt-1.5 pb-1">
        <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
          {sheet ? <span>{kTokens(context.tokens)} of {kTokens(context.max)} tokens</span> : <span className="font-medium">Context</span>}
          <span className="shrink-0 text-[12.5px] text-faint tabular-nums">{sheet ? `${full}% full` : `${full}% · ${kTokens(context.tokens)} of ${kTokens(context.max)} tokens`}</span>
        </div>
        <Meter value={full} />
        {onCompact && (
          <div className="mt-2.5 flex justify-end">
            <button type="button" onClick={onCompact} className="h-10 rounded-full bg-chip px-4 text-[14px] hover:bg-hover pointer-fine:h-8 pointer-fine:text-[13px]">Compact</button>
          </div>
        )}
      </div>,
    );
  }
  if (totals) {
    parts.push(
      <div key="session" className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-[13.5px]">
        <span className="shrink-0">This session</span>
        <span className="min-w-0 text-right text-[12.5px] text-faint">{totals}</span>
      </div>,
    );
  }
  if (bars) parts.push(<div key="plan">{bars}</div>);
  return (
    <div className={sheet ? 'pb-1' : 'w-[min(380px,calc(100vw-16px))] p-1.5'}>
      {parts.map((part, i) => <div key={i}>{i > 0 && <Rule />}{part}</div>)}
      {onUsage && (
        <>
          {parts.length > 0 && <Rule />}
          <button type="button" onClick={onUsage} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-[13.5px] text-muted hover:bg-hover hover:text-fg pointer-fine:min-h-9">
            <span className="min-w-0 flex-1">Usage and activity</span>
            <ChevronRight className="size-4 shrink-0 text-faint" />
          </button>
        </>
      )}
    </div>
  );
}

/** Context: a popover at the ring on a computer, a sheet on a phone. */
export function ContextPanel({ open, onClose, at, sheet, ...body }: {
  open: boolean;
  onClose: () => void;
  at: Element | null;
  sheet: boolean;
  sessionId: string;
  context?: Context;
  onCompact?: () => void;
  onUsage?: () => void;
}) {
  if (sheet) {
    return (
      <Sheet open={open} onClose={onClose} title="Context">
        <ContextBody {...body} open={open} sheet />
      </Sheet>
    );
  }
  return (
    <Popover open={open} onClose={onClose} at={at} label="Context">
      <ContextBody {...body} open={open} sheet={false} />
    </Popover>
  );
}
