import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { api } from '../lib/api';
import { untilTime } from '../lib/format';

const LIMIT: Record<string, string> = {
  five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus limit', seven_day_sonnet: 'Weekly Sonnet limit', overage: 'Extra usage',
};

type Bar = { key: string; label: string; utilization?: number; resetsAt?: number; status?: 'allowed' | 'allowed_warning' | 'rejected'; detail?: string };

const money = (cents: number, currency = 'USD') => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
};

/** One limit: what it is, how full (a bar when known), and when it starts over. */
export function UsageBar({ bar }: { bar: Bar }) {
  const percent = typeof bar.utilization === 'number' ? Math.round(bar.utilization * 100) : undefined;
  const over = bar.status === 'rejected' || (percent !== undefined && percent >= 100);
  const near = bar.status === 'allowed_warning' || (percent !== undefined && percent >= 80);
  return (
    <div className="px-3 py-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="min-w-0 truncate">{bar.label}</span>
        <span className="shrink-0 text-[12px] text-faint">
          {[bar.detail, percent !== undefined ? `${percent}%` : over ? 'Reached' : undefined, bar.resetsAt ? `resets ${untilTime(bar.resetsAt)}` : undefined].filter(Boolean).join(' · ')}
        </span>
      </div>
      {percent !== undefined && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-chip">
          <div className={`h-full rounded-full ${over ? 'bg-danger' : near ? 'bg-wait' : 'bg-fg/70'}`} style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * The plan's limits, as bars: claude.ai's own figures when there are any, else what Claude Code
 * reported during turns here. Settings, Usage and Context show them; `windows` says whether any
 * are known, `plan` what claude.ai said (null: no plan applies).
 */
export function usePlanLimits(enabled: boolean): { bars: ReactNode | undefined; windows: number; plan: Awaited<ReturnType<typeof api.planUsage>> | undefined } {
  const { data: limits } = useQuery({ queryKey: ['usage'], queryFn: api.usage, enabled });
  const { data: plan } = useQuery({ queryKey: ['usage-plan'], queryFn: api.planUsage, enabled, staleTime: 60_000 });
  const windows: Bar[] = plan && plan.windows.length > 0
    ? plan.windows.map((w) => ({ key: w.type, label: w.label ?? LIMIT[w.type] ?? w.type, utilization: w.utilization, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) }))
    : (limits ?? []).filter((l) => !(plan?.extra && l.type === 'overage')).map((l) => ({
      key: l.type, label: LIMIT[l.type] ?? l.type, status: l.status,
      ...(typeof l.utilization === 'number' ? { utilization: l.utilization } : {}),
      ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}),
    }));
  const bars = windows.length > 0 || plan?.extra ? (
    <>
      {windows.map((bar) => <UsageBar key={bar.key} bar={bar} />)}
      {plan?.extra && (
        plan.extra.enabled ? (
          <UsageBar
            bar={{
              key: 'extra',
              label: 'Extra usage this month',
              ...(typeof plan.extra.utilization === 'number' ? { utilization: plan.extra.utilization } : {}),
              ...(typeof plan.extra.usedCents === 'number' ? {
                detail: typeof plan.extra.limitCents === 'number'
                  ? `${money(plan.extra.usedCents, plan.extra.currency)} of ${money(plan.extra.limitCents, plan.extra.currency)}`
                  : `${money(plan.extra.usedCents, plan.extra.currency)} spent`,
              } : {}),
            }}
          />
        ) : (
          <div className="flex items-baseline justify-between px-3 py-1.5 text-[13px]"><span>Extra usage</span><span className="text-[12px] text-faint">Off</span></div>
        )
      )}
    </>
  ) : undefined;
  return { bars, windows: windows.length, plan };
}
