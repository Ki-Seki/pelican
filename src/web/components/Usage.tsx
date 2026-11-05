import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { costShown, costWords, tokenTotal, type UsagePoint, type UsageRange, type UsageSummary } from '../../shared/usage';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { compactNumber, dayText, highlights, longDayText, percent, periodWords, span, weekdayText } from '../lib/usage';
import { Segmented, Sheet, SheetHeading } from './Sheet';

const RANGES: Array<{ value: UsageRange; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
];

/**
 * Usage and activity across every Claude Code session on this computer, whichever app ran it, as
 * Claude Code counts it: tokens by kind, where they went, the days and sessions, and a few things
 * worth knowing. `limits`: the plan's limits, as Settings shows them; on a plan they matter most.
 */
export function UsageSheet({ open, onClose, limits, onOpenSession }: {
  open: boolean;
  onClose: () => void;
  limits?: ReactNode;
  onOpenSession?: (id: string) => void;
}) {
  const [range, setRange] = useState<UsageRange>('7d');
  const { data: models } = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 10 * 60_000, enabled: open });
  const query = useQuery({
    queryKey: ['usage-stats', range],
    queryFn: () => api.usageStats(range),
    enabled: open,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    // While the transcripts are first read, what is ready shows and the rest fills in.
    refetchInterval: (q) => (q.state.data && !q.state.data.progress.ready ? 1500 : false),
  });
  const summary = query.data;
  const showCost = costShown({ signedIn: models?.signedIn ?? null, plan: models?.account?.plan });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Usage and activity"
      done
      size="large"
      header={<div className="-mx-3 pt-1"><Segmented<UsageRange> value={range} onChange={setRange} options={RANGES} /></div>}
    >
      {limits && (
        <section>
          <SheetHeading>Plan limits</SheetHeading>
          {limits}
        </section>
      )}
      {!summary ? (
        query.isError ? (
          <p className="px-3 py-6 text-[13px] text-muted">{(query.error as Error).message}</p>
        ) : (
          <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>
        )
      ) : (
        // Another period loading keeps this one on screen, faded, so nothing jumps.
        <div className={`transition-opacity ${query.isPlaceholderData ? 'opacity-50' : ''}`}>
          <Figures summary={summary} showCost={showCost} onOpenSession={onOpenSession} />
        </div>
      )}
    </Sheet>
  );
}

function Figures({ summary, showCost, onOpenSession }: { summary: UsageSummary; showCost: boolean; onOpenSession?: ((id: string) => void) | undefined }) {
  const total = tokenTotal(summary.tokens);
  const { progress } = summary;
  const notes = highlights(summary);
  if (total === 0 && summary.activity.sessions === 0 && progress.ready) {
    return <p className="px-3 py-8 text-center text-[14px] text-muted">{summary.range === 'all' ? 'No Claude Code activity on this computer yet.' : `No Claude Code activity ${periodWords(summary.range, summary)}.`}</p>;
  }
  return (
    <>
      {!progress.ready && (
        <p className="px-3 pt-3 text-[12.5px] text-faint">
          Reading transcripts: {progress.read.toLocaleString('en')} of {progress.files.toLocaleString('en')}
        </p>
      )}
      <div className="px-3 pt-4">
        <div className="text-[48px] leading-none font-semibold tracking-tight">{compactNumber(total)}</div>
        <div className="mt-2 text-[13px] text-muted">tokens {periodWords(summary.range, summary)}</div>
        {showCost && summary.cost && <div className="mt-1 text-[13px] text-muted">{costWords(summary.cost.usd, summary.cost.without)}</div>}
      </div>
      <dl className="mx-3 mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Tile label="Input" value={compactNumber(summary.tokens.input)} />
        <Tile label="Output" value={compactNumber(summary.tokens.output)} />
        <Tile label="Cache write" value={compactNumber(summary.tokens.cacheWrite)} />
        <Tile label="Cache read" value={compactNumber(summary.tokens.cacheRead)} />
      </dl>

      {summary.series.points.length > 1 && <TokensChart unit={summary.series.unit} points={summary.series.points} />}

      <SheetHeading>{summary.activity.since ? `Activity since ${dayText(summary.activity.since)}` : 'Activity'}</SheetHeading>
      <dl className="mx-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Tile label="Sessions" value={summary.activity.sessions.toLocaleString('en')} />
        <Tile label="Active days" value={summary.activity.activeDays.toLocaleString('en')} sub={`of ${summary.activity.days.toLocaleString('en')}`} />
        <Tile label="Current streak" value={days(summary.activity.currentStreak)} />
        <Tile label="Longest streak" value={days(summary.activity.longestStreak)} />
        {summary.activity.longest && (
          <Tile
            label="Longest session"
            value={span(summary.activity.longest.ms)}
            sub={summary.activity.longest.title ?? `on ${new Date(summary.activity.longest.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`}
            wide
          />
        )}
      </dl>

      {notes.length > 0 && (
        <>
          <SheetHeading>Highlights</SheetHeading>
          <ul className="space-y-1.5 px-3">
            {notes.map((note) => (
              <li key={note} className="flex gap-2 text-[13.5px] leading-snug text-muted">
                <span aria-hidden className="mt-[0.55em] size-1 shrink-0 rounded-full bg-faint" />
                <span className="min-w-0">{note}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="grid sm:grid-cols-2 sm:gap-x-4">
        <Ranked title="Projects" total={total} rows={summary.projects.map((p) => ({ key: p.cwd, name: p.name, value: p.tokens, detail: `${p.sessions} ${p.sessions === 1 ? 'session' : 'sessions'}` }))} />
        <Ranked title="Models" total={total} rows={summary.models.map((m) => ({ key: m.model, name: m.name, value: m.tokens }))} />
        <Ranked title="Apps" total={total} rows={summary.apps.map((a) => ({ key: a.app, name: a.app, value: a.tokens, detail: `${a.sessions} ${a.sessions === 1 ? 'session' : 'sessions'}` }))} />
      </div>
      <Ranked
        title="Sessions that used the most"
        total={total}
        rows={summary.sessions.map((s) => ({
          key: s.id,
          name: s.title,
          value: s.tokens,
          detail: [s.project, s.app, relativeTime(s.at)].filter(Boolean).join(' · '),
          ...(onOpenSession ? { onOpen: () => onOpenSession(s.id) } : {}),
        }))}
      />

      <p className="px-3 pt-5 pb-2 text-[12px] leading-snug text-faint">
        From Claude Code’s transcripts on this computer, each reply counted once. Claude Code’s /stats counts each content block of a reply, so its totals are higher. Days are UTC dates, as in /stats.
      </p>
    </>
  );
}

const days = (n: number) => `${n.toLocaleString('en')} ${n === 1 ? 'day' : 'days'}`;

/** A figure with its name: the name small, the value plain and bigger. */
function Tile({ label, value, sub, wide }: { label: string; value: string; sub?: string | undefined; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? 'col-span-2 sm:col-span-1' : ''}`}>
      <dt className="text-[12px] text-faint">{label}</dt>
      <dd className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
        <span className="text-[17px] font-semibold">{value}</span>
        {sub && <span className="min-w-0 truncate text-[12px] text-faint">{sub}</span>}
      </dd>
    </div>
  );
}

type RankedRow = { key: string; name: string; value: number; detail?: string; onOpen?: () => void };

/** Parts of the whole, largest first, each with its share and a bar against the largest. */
function Ranked({ title, rows, total }: { title: string; rows: RankedRow[]; total: number }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const top = rows[0]!.value;
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <section className="min-w-0">
      <SheetHeading>{title}</SheetHeading>
      <ul>
        {shown.map((row) => {
          const body = (
            <>
              <div className="flex min-w-0 items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate text-[14px]">{row.name}</span>
                <span className="shrink-0 text-[13px] text-muted tabular-nums">{compactNumber(row.value)}</span>
                <span className="w-9 shrink-0 text-right text-[12px] text-faint tabular-nums">{total > 0 ? percent(row.value / total) : ''}</span>
              </div>
              {row.detail && <div className="truncate text-[12px] text-faint">{row.detail}</div>}
              <div className="mt-1 h-1 rounded-r-full bg-fg/70" style={{ width: `${top > 0 ? Math.max(0.5, (row.value / top) * 100) : 0}%` }} />
            </>
          );
          return (
            <li key={row.key}>
              {row.onOpen ? (
                <button type="button" onClick={row.onOpen} className="block w-full min-w-0 rounded-xl px-3 py-1.5 text-left hover:bg-hover">{body}</button>
              ) : (
                <div className="px-3 py-1.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length > 5 && (
        <button type="button" onClick={() => setAll(!all)} className="mx-1 h-9 rounded-full px-2 text-[13px] text-muted hover:text-fg">
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

const PLOT_H = 112;
const AXIS_H = 18;
const GUTTER = 36;
const READOUT_H = 20;

/** A round number at or above `max` for the top of the scale: 1, 2, 2.5 or 5 times a power of ten. */
function niceTop(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

/**
 * Tokens per day (or week) as columns, one shade, on a hairline scale. Pointing at a day, tapping
 * it, or moving along with the arrow keys reads it out above the columns; Table shows every value.
 */
function TokensChart({ unit, points }: { unit: 'day' | 'week'; points: UsagePoint[] }) {
  const [table, setTable] = useState(false);
  const [active, setActive] = useState<number>();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const titleId = useId();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [table]);
  useEffect(() => setActive(undefined), [points]);

  const n = points.length;
  const max = Math.max(...points.map((p) => p.tokens));
  const top = niceTop(max);
  const plotW = Math.max(0, width - GUTTER);
  const slot = n > 0 ? plotW / n : 0;
  const barW = Math.max(1, Math.min(24, slot - 2));
  const y = (value: number) => READOUT_H + PLOT_H - (value / top) * PLOT_H;
  const label = (p: UsagePoint) => (unit === 'week' ? `Week of ${dayText(p.day)}` : longDayText(p.day));
  const tallest = points.reduce((best, p, i) => (p.tokens > (points[best]?.tokens ?? -1) ? i : best), 0);
  const shownAt = active ?? (max > 0 ? tallest : undefined);
  const xOf = (i: number) => GUTTER + slot * i + slot / 2;

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - GUTTER) / slot);
    setActive(i >= 0 && i < n ? i : undefined);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const from = active ?? n - 1;
    const next = e.key === 'ArrowLeft' ? from - 1 : e.key === 'ArrowRight' ? from + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : undefined;
    // Esc first lets go of the day it reads out; the next one closes the sheet.
    if (e.key === 'Escape' && active !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      setActive(undefined);
      return;
    }
    if (next === undefined) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(n - 1, next)));
  };

  // Labels under the columns: every weekday when there is room, else a few dates, the first and last
  // set inside the edges so neither is cut off.
  const ticks: Array<{ i: number; text: string; anchor: 'start' | 'middle' | 'end' }> = [];
  if (unit === 'day' && n <= 7 && slot >= 26) {
    points.forEach((p, i) => ticks.push({ i, text: weekdayText(p.day), anchor: 'middle' }));
  } else if (n > 0) {
    const count = Math.min(n, width < 420 ? 3 : 4);
    for (let k = 0; k < count; k += 1) {
      const i = count === 1 ? n - 1 : Math.round((k * (n - 1)) / (count - 1));
      ticks.push({ i, text: dayText(points[i]!.day), anchor: k === 0 ? 'start' : k === count - 1 ? 'end' : 'middle' });
    }
  }
  const tickX = (t: (typeof ticks)[number]) => (t.anchor === 'start' ? GUTTER + slot * t.i + (slot - barW) / 2 : t.anchor === 'end' ? GUTTER + slot * t.i + (slot + barW) / 2 : xOf(t.i));

  const readout = shownAt === undefined ? undefined : points[shownAt];
  // Centred over its column, moved in only as far as it takes to stay inside the chart.
  const readoutBox = useRef<HTMLDivElement>(null);
  const [readoutW, setReadoutW] = useState(0);
  useLayoutEffect(() => setReadoutW(readoutBox.current?.offsetWidth ?? 0), [shownAt, active, width]);
  const readoutLeft = shownAt === undefined ? 0 : Math.max(GUTTER, Math.min(width - readoutW, xOf(shownAt) - readoutW / 2));

  return (
    <figure className="m-0 min-w-0" aria-labelledby={titleId}>
      <div className="flex items-baseline justify-between px-3 pt-5 pb-1.5">
        <figcaption id={titleId} className="text-[12px] text-faint">{unit === 'week' ? 'Tokens per week' : 'Tokens per day'}</figcaption>
        <button type="button" aria-pressed={table} onClick={() => setTable(!table)} className="-my-1 h-8 rounded-full px-2.5 text-[12.5px] text-muted hover:bg-hover hover:text-fg">
          {table ? 'Chart' : 'Table'}
        </button>
      </div>
      {table ? (
        <table className="mx-3 w-[calc(100%-1.5rem)] text-[13px]">
          <thead className="sr-only"><tr><th>{unit === 'week' ? 'Week' : 'Day'}</th><th>Tokens</th></tr></thead>
          <tbody>
            {[...points].reverse().map((p) => (
              <tr key={p.day} className="border-b border-line last:border-0">
                <td className="py-1.5 text-muted">{label(p)}</td>
                <td className="py-1.5 text-right tabular-nums">{p.tokens > 0 ? compactNumber(p.tokens) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div ref={box} className="relative mx-3 min-w-0 select-none">
          {width > 0 && (
            <svg
              width={width}
              height={READOUT_H + PLOT_H + AXIS_H}
              role="img"
              aria-label={`${unit === 'week' ? 'Tokens per week' : 'Tokens per day'}, ${label(points[0]!)} to ${label(points[n - 1]!)}; the most, ${compactNumber(max)}, ${unit === 'week' ? 'in the week of' : 'on'} ${dayText(points[tallest]!.day)}. Table lists every value.`}
              tabIndex={0}
              className="block touch-pan-y rounded-md outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
              onPointerMove={pick}
              onPointerDown={pick}
              onPointerLeave={(e) => {
                if (e.pointerType === 'mouse') setActive(undefined);
              }}
              onKeyDown={onKey}
              onBlur={() => setActive(undefined)}
            >
              {[0, top / 2, top].map((value) => (
                <g key={value}>
                  <line x1={GUTTER} x2={width} y1={y(value)} y2={y(value)} stroke="var(--line)" strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={GUTTER - 6} y={y(value)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--faint)" className="tabular-nums">{value === 0 ? '0' : compactNumber(value)}</text>
                </g>
              ))}
              {points.map((p, i) => {
                if (p.tokens <= 0) return null;
                const h = Math.max(1, (p.tokens / top) * PLOT_H);
                const x = GUTTER + slot * i + (slot - barW) / 2;
                const r = Math.min(4, barW / 2, h);
                const bottom = READOUT_H + PLOT_H;
                // Rounded at the top only: the column stands on the baseline.
                const d = `M${x},${bottom}V${bottom - h + r}Q${x},${bottom - h} ${x + r},${bottom - h}H${x + barW - r}Q${x + barW},${bottom - h} ${x + barW},${bottom - h + r}V${bottom}Z`;
                return <path key={p.day} d={d} fill="var(--fg)" opacity={active === undefined ? 0.72 : active === i ? 1 : 0.5} />;
              })}
              {ticks.map((t) => (
                <text key={`${t.i}-${t.text}`} x={tickX(t)} y={READOUT_H + PLOT_H + 13} textAnchor={t.anchor} fontSize={11} fill="var(--faint)">{t.text}</text>
              ))}
            </svg>
          )}
          {readout && (
            <div
              ref={readoutBox}
              role={active === undefined ? undefined : 'status'}
              className="pointer-events-none absolute top-0 max-w-full truncate text-[12px] leading-5 whitespace-nowrap"
              style={{ left: readoutLeft }}
            >
              <span className="font-medium tabular-nums">{compactNumber(readout.tokens)}</span>
              {active !== undefined && <span className="text-muted"> · {label(readout)}</span>}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
