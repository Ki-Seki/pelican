import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Check, ChevronRight, CircleDashed, Loader2, Pause, Square, TriangleAlert, Workflow as WorkflowIcon, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChatMessage, Workflow, WorkflowAgent, WorkflowPhase, WorkflowStatus } from '../../shared/protocol';
import { modelName } from '../../shared/usage';
import {
  AGENT_WORDS, agentCounts, type AgentStatus, agentTime, agentTokens, durationText, IDLE_MS, isLarge, isRunning, launchOf,
  type PhaseGroup, phaseGroups, STALLED_MS, statusWord, type TaskNotice, tokensText, workflowOf,
} from '../../shared/workflows';
import { api } from '../lib/api';
import { useSessionId } from '../lib/session-context';
import { useSessionView } from '../lib/store';
import { buildItems, outcomeOf, resultText, type ToolCall } from '../lib/turns';
import { fenced, resultMarkdown, revealWorkflow, useNow, useOnScreen, useRevealed, useWide } from '../lib/workflows';
import { Markdown } from './Markdown';
import { ToolCallView } from './ToolCall';

/** How a run ended, in the words of Claude Code's notice. */
const ENDED: Record<NonNullable<TaskNotice['status']>, WorkflowStatus> = { completed: 'completed', failed: 'failed', killed: 'killed', stopped: 'killed' };

/** A run Claude Code reported in full: its record, or an end nothing changes any more. */
const settled = (workflow: Workflow | undefined) => Boolean(workflow && (workflow.source === 'record' || !isRunning(workflow.status)));

/**
 * What the card knows of the run: what this Pelican's Claude reports of it while it runs, else
 * what the run's own files say (asked again every few seconds while it runs and the card is on
 * screen), with how it ended as Claude Code wrote it into the conversation.
 */
function useRun(call: ToolCall, onScreen: boolean) {
  const sessionId = useSessionId();
  const live = useSessionView(sessionId).run?.workflows?.[call.id];
  const launch = launchOf(call.result);
  const launched = outcomeOf(call).kind === 'done' && Boolean(launch?.runId);
  const query = useQuery({
    queryKey: ['workflow', sessionId, call.id],
    queryFn: () => api.workflow(sessionId!, call.id),
    enabled: Boolean(sessionId) && launched && !live,
    staleTime: (q) => (settled(q.state.data) ? Infinity : 0),
    refetchInterval: (q) => (onScreen && !settled(q.state.data) ? 2500 : false),
    retry: 1,
  });
  // Its end just came into the conversation: the record follows it.
  const endedNow = call.ended && !call.ended.orphan ? call.ended.status : undefined;
  const refetch = query.refetch;
  useEffect(() => {
    if (endedNow && !live && launched) void refetch();
  }, [endedNow, live, launched, refetch]);
  // When this Pelican's Claude lets an ended run go, the card keeps it until the record is read.
  const kept = useRef<Workflow | undefined>(undefined);
  if (live) kept.current = live;
  return { live, launch, flow: live ?? query.data ?? kept.current, failed: query.isError && !query.data };
}

// ---- Small pieces -----------------------------------------------------------------------------

const AGENT_GLYPH: Record<AgentStatus, React.ReactNode> = {
  done: <Check className="size-3.5 shrink-0 text-live" aria-hidden />,
  failed: <X className="size-3.5 shrink-0 text-danger" aria-hidden />,
  blocked: <X className="size-3.5 shrink-0 text-wait" aria-hidden />,
  skipped: <X className="size-3.5 shrink-0 text-faint" aria-hidden />,
  stopped: <CircleDashed className="size-3.5 shrink-0 text-faint" aria-hidden />,
  queued: <CircleDashed className="size-3.5 shrink-0 text-faint" aria-hidden />,
  running: <span className="grid size-3.5 shrink-0 place-items-center" aria-hidden><span className="size-[7px] rounded-full bg-run" /></span>,
};

function PhaseGlyph({ status }: { status: PhaseGroup['status'] }) {
  if (status === 'done') return <Check className="size-3.5 shrink-0 text-live" aria-hidden />;
  if (status === 'failed') return <X className="size-3.5 shrink-0 text-danger" aria-hidden />;
  if (status === 'running') return <Loader2 className="size-3.5 shrink-0 animate-spin text-run motion-reduce:animate-none" aria-hidden />;
  return <CircleDashed className="size-3.5 shrink-0 text-faint" aria-hidden />;
}

function StatusGlyph({ status }: { status: WorkflowStatus }) {
  if (status === 'running') {
    return (
      <span className="relative flex size-1.5 shrink-0" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-run opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-1.5 rounded-full bg-run" />
      </span>
    );
  }
  if (status === 'completed') return <Check className="size-3 shrink-0 text-live" aria-hidden />;
  if (status === 'failed') return <X className="size-3 shrink-0 text-danger" aria-hidden />;
  if (status === 'paused') return <Pause className="size-3 shrink-0 text-wait" aria-hidden />;
  return <Square className="size-2.5 shrink-0 text-faint" aria-hidden />;
}

/** Desktop's grid: a cell per agent, done faint, running in the accent, stalled amber, failed red, queued or stopped an outline. */
const CELL = {
  done: 'bg-faint/35',
  running: 'bg-run animate-pulse motion-reduce:animate-none',
  stalled: 'bg-wait',
  failed: 'bg-danger',
  pending: 'border border-faint/50',
} as const;

const MAX_CELLS = 160;

function Cells({ agents, status, now }: { agents: WorkflowAgent[]; status: WorkflowStatus; now: number }) {
  const counts = agentCounts(agents, status, now);
  if (counts.total === 0) return null;
  // Past the grid's size, each kind keeps its share of the cells.
  const scale = counts.total > MAX_CELLS ? MAX_CELLS / counts.total : 1;
  const n = (value: number) => (value > 0 ? Math.max(1, Math.round(value * scale)) : 0);
  const cells: Array<keyof typeof CELL> = [
    ...Array<keyof typeof CELL>(n(counts.done)).fill('done'),
    ...Array<keyof typeof CELL>(n(counts.running - counts.stalled)).fill('running'),
    ...Array<keyof typeof CELL>(n(counts.stalled)).fill('stalled'),
    ...Array<keyof typeof CELL>(n(counts.failed)).fill('failed'),
    ...Array<keyof typeof CELL>(n(counts.queued + counts.stopped)).fill('pending'),
  ];
  const label = `${counts.done} of ${counts.total} agents done, ${counts.running - counts.stalled} running, ${counts.stalled} stalled, ${counts.failed} failed`;
  return (
    <span role="img" aria-label={label} className="mt-2 flex flex-wrap gap-[3px]">
      {cells.map((kind, i) => <span key={i} className={`size-1.5 rounded-[1.5px] ${CELL[kind]}`} style={kind === 'running' ? { animationDelay: `${(i * 0.37) % 2}s` } : undefined} />)}
    </span>
  );
}

/** A long text that folds to a few lines, with Desktop's Show details. */
function Folded({ text, className = '', lines = 3 }: { text: string; className?: string; lines?: number }) {
  const [all, setAll] = useState(false);
  const long = text.split('\n').length > lines || text.length > lines * 90;
  return (
    <div className={className}>
      <div className={`whitespace-pre-wrap break-words ${long && !all ? (lines <= 2 ? 'line-clamp-2' : 'line-clamp-3') : ''}`}>{text}</div>
      {long && (
        <button type="button" aria-expanded={all} onClick={() => setAll((v) => !v)} className="mt-0.5 text-[12px] text-faint hover:text-fg">
          {all ? 'Hide details' : 'Show details'}
        </button>
      )}
    </div>
  );
}

/**
 * Under the phases: the script, highlighted, and what it returned, one at a time, and Stop while
 * this Pelican's Claude runs it.
 */
function Footer({ script, result, stop, stopping }: { script?: string; result?: string; stop?: () => void; stopping: boolean }) {
  const [shown, setShown] = useState<'script' | 'result'>();
  const tab = (which: 'script' | 'result', title: string) => (
    <button type="button" aria-expanded={shown === which} onClick={() => setShown((v) => (v === which ? undefined : which))} className="flex min-h-8 items-center gap-1.5 text-[12.5px] text-muted hover:text-fg">
      <ChevronRight className={`size-3.5 text-faint transition-transform ${shown === which ? 'rotate-90' : ''}`} aria-hidden />
      {title}
    </button>
  );
  return (
    <div className="border-t border-line px-3 py-1">
      <div className="flex items-center gap-4">
        {script && tab('script', 'Script')}
        {result && tab('result', 'Result')}
        {stop && (
          <button type="button" aria-label="Stop this workflow" disabled={stopping} onClick={stop} className="relative ml-auto h-8 shrink-0 rounded-full px-3 text-[12.5px] text-muted after:absolute after:-inset-y-1.5 after:inset-x-0 hover:bg-hover hover:text-fg disabled:opacity-50">
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      {shown === 'script' && script && <div className="animate-fade max-h-[28rem] overflow-y-auto pb-1"><Markdown text={fenced(script, 'js')} className="text-[13px]" /></div>}
      {shown === 'result' && result && <div className="animate-fade max-h-[28rem] overflow-y-auto pb-1"><Markdown text={resultMarkdown(result)} className="text-[13px]" /></div>}
    </div>
  );
}

/** A disclosure: an agent's prompt. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex min-h-8 items-center gap-1.5 text-[12.5px] text-muted hover:text-fg">
        <ChevronRight className={`size-3.5 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        {title}
      </button>
      {open && <div className="animate-fade mt-1 mb-1">{children}</div>}
    </div>
  );
}

const join = (parts: Array<string | false | undefined | null>) => parts.filter(Boolean).join(' · ');

// ---- An agent ------------------------------------------------------------------------------------

/** What the CLI says on an agent's row, after its name: how far it got, or why it did not. */
function agentNote(agent: WorkflowAgent, status: AgentStatus, now: number): string | undefined {
  if (status === 'failed' || status === 'blocked') return agent.error;
  if (status === 'skipped') return 'Skipped by user';
  if (status === 'queued') return agent.queuedAt !== undefined ? `Queued · waiting ${durationText(now - agent.queuedAt)}` : 'Queued';
  if (status === 'running') {
    const idle = agent.lastProgressAt !== undefined && now - agent.lastProgressAt > IDLE_MS ? `idle ${durationText(now - agent.lastProgressAt).replace(/ \d+s$/, '')}` : undefined;
    const doing = agent.lastToolName ? join([agent.lastToolName, agent.lastToolSummary]) : undefined;
    return join([idle, doing]) || undefined;
  }
  return undefined;
}

/** Its pages of messages: the newest, asked again while it runs, and earlier ones as asked for. */
function useAgentMessages(sessionId: string, callId: string, agentId: string, running: boolean, onScreen: boolean) {
  const [earlier, setEarlier] = useState<{ messages: ChatMessage[]; offset: number } | undefined>();
  const [loading, setLoading] = useState(false);
  const latest = useQuery({
    queryKey: ['workflow-agent', sessionId, callId, agentId],
    queryFn: () => api.workflowAgent(sessionId, callId, agentId),
    staleTime: running ? 0 : 60_000,
    refetchInterval: running && onScreen ? 3000 : false,
  });
  const page = latest.data;
  // The earlier pages read so far, joined to the newest where they meet.
  const messages = useMemo(() => {
    if (!page) return [];
    if (!earlier) return page.messages;
    const seen = new Set(page.messages.map((m) => m.uuid));
    return [...earlier.messages.filter((m) => !seen.has(m.uuid)), ...page.messages];
  }, [page, earlier]);
  const offset = earlier?.offset ?? page?.offset ?? 0;
  const older = async () => {
    if (loading || offset === 0) return;
    setLoading(true);
    try {
      const before = await api.workflowAgent(sessionId, callId, agentId, offset);
      setEarlier((had) => ({ messages: [...before.messages, ...(had?.messages ?? [])], offset: before.offset }));
    } finally {
      setLoading(false);
    }
  };
  return { page, messages, offset, older, loading, error: latest.error as Error | null };
}

/** An agent opened: its state and figures, what it was asked, the steps it took, and what it returned. */
function AgentDetail({ agent, status, callId, cwd, onScreen, now }: { agent: WorkflowAgent & { status: AgentStatus }; status: AgentStatus; callId: string; cwd?: string; onScreen: boolean; now: number }) {
  const sessionId = useSessionId();
  const running = status === 'running' || status === 'queued';
  const pages = useAgentMessages(sessionId ?? '', callId, agent.agentId ?? '', running, onScreen);
  const steps = useMemo(() => buildItems(pages.messages).flatMap((item) => (item.kind === 'assistant' ? item.parts : [])).filter((part) => part.kind === 'tool'), [pages.messages]);
  // The CLI's agent card: its state, model, type and isolation, and what its row does not say.
  const head = join([
    AGENT_WORDS[status],
    agent.model && `${modelName(agent.model)}${agent.fallbackModel && agent.fallbackModel !== agent.model ? ` → ${modelName(agent.fallbackModel)}` : ''}`,
    agent.agentType,
    agent.isolation,
    agent.toolCalls ? `${agent.toolCalls} tool ${agent.toolCalls === 1 ? 'call' : 'calls'}` : undefined,
    agent.cached && 'from resume journal',
    (agent.attempt ?? 1) > 1 && `attempt ${agent.attempt}${agent.lastAttemptReason ? ` (${agent.lastAttemptReason.replace('-', ' ')})` : ''}`,
  ]);
  const prompt = pages.page?.prompt ?? agent.promptPreview;
  const result = pages.page?.result ?? agent.resultPreview;
  const outcome = status === 'done' ? (result ? undefined : '(empty)')
    : status === 'running' ? 'Still running…'
      : status === 'queued' ? 'Waiting for an agent slot.'
        : status === 'stopped' ? 'The workflow stopped before this agent finished.'
          : status === 'skipped' ? 'Skipped by user.'
            : undefined;
  return (
    <div className="animate-fade mb-2 ml-[22px] space-y-1.5 text-[12.5px]">
      <div className="text-faint">{head}</div>
      {prompt && (
        <Section title="Prompt">
          <Folded text={prompt} lines={8} className="rounded-lg bg-chip px-3 py-2 text-[12.5px] leading-relaxed text-muted" />
        </Section>
      )}
      {agent.agentId && (
        <div className="rounded-lg border border-line bg-bg px-2.5 py-1">
          <div className="flex min-h-7 items-center gap-1.5 text-faint">
            <span>{pages.page ? `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}${pages.offset > 0 ? ' so far shown' : ''}` : 'Steps'}</span>
            {(!pages.page && !pages.error) || pages.loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {pages.offset > 0 && (
              <button type="button" onClick={() => void pages.older()} className="ml-auto text-[12px] hover:text-fg">Show earlier steps</button>
            )}
          </div>
          {pages.error && <div className="pb-1 text-danger">{pages.error.message}</div>}
          {pages.page && steps.length === 0 && <div className="pb-1 text-faint">No tool calls yet.</div>}
          {steps.map((part) => (part.kind === 'tool' ? <ToolCallView key={part.key} call={part.call} cwd={cwd} running={running} /> : null))}
        </div>
      )}
      {(result || outcome || agent.error) && (
        <div>
          <div className="mb-0.5 text-faint">Outcome</div>
          {status === 'done' && result ? (
            <div className="max-h-80 overflow-y-auto"><Markdown text={resultMarkdown(result)} className="text-[13px]" /></div>
          ) : agent.error && (status === 'failed' || status === 'blocked') ? (
            <Folded text={agent.error} className="font-mono text-[12px] text-danger" />
          ) : (
            <div className="text-muted">{outcome}</div>
          )}
        </div>
      )}
    </div>
  );
}

function AgentRow({ agent, callId, cwd, wide, open, onToggle, onScreen, now }: {
  agent: WorkflowAgent & { status: AgentStatus }; callId: string; cwd?: string; wide: boolean; open: boolean; onToggle: () => void; onScreen: boolean; now: number;
}) {
  const status = agent.status;
  const time = agentTime(agent, now);
  const note = agentNote(agent, status, now);
  const stalled = status === 'running' && agent.lastProgressAt !== undefined && now - agent.lastProgressAt > STALLED_MS;
  const figures = join([
    wide && agent.model && modelName(agent.model),
    wide && agent.toolCalls ? `${agent.toolCalls} tools` : undefined,
    agent.tokens ? `${tokensText(agent.tokens)} tok` : undefined,
    time !== undefined ? durationText(time) : undefined,
  ]);
  return (
    <li>
      <button type="button" aria-expanded={open} onClick={onToggle} className="group flex min-h-8 w-full items-center gap-2 rounded-md py-1 text-left text-[13px] hover:text-fg">
        <span title={AGENT_WORDS[status]} className="contents">{AGENT_GLYPH[status]}</span>
        <span className="sr-only">{AGENT_WORDS[status]}:</span>
        <span className={`min-w-0 flex-1 truncate ${status === 'stopped' || status === 'skipped' || status === 'queued' ? 'text-muted' : 'text-fg/90'}`}>{agent.label}</span>
        {figures && <span className="shrink-0 text-[11.5px] text-faint tabular-nums">{figures}</span>}
        <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {note && !open && (
        <div className={`-mt-1 mb-1 ml-[22px] truncate text-[12px] ${status === 'failed' ? 'text-danger' : status === 'blocked' ? 'text-wait' : stalled ? 'text-wait' : 'text-faint'}`}>{note}</div>
      )}
      {open && <AgentDetail agent={agent} status={status} callId={callId} {...(cwd ? { cwd } : {})} onScreen={onScreen} now={now} />}
    </li>
  );
}

// ---- Phases ------------------------------------------------------------------------------------

const EMPTY_PHASE: Partial<Record<WorkflowStatus, string>> = {
  running: 'No agents have started yet',
  paused: 'No agents have started yet',
  completed: 'No agents ran in this phase',
  failed: 'Failed before any agents started',
};

function PhaseRow({ group, status, open, onToggle, children }: { group: PhaseGroup; status: WorkflowStatus; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const total = group.agents.length;
  if (total === 0) {
    return (
      <li className="flex min-h-9 items-center gap-2 text-[13px]">
        <PhaseGlyph status="pending" />
        <span className="min-w-0 truncate"><span className="text-muted">{group.title}</span><span className="text-[12.5px] text-faint"> · {EMPTY_PHASE[status] ?? 'Stopped before any agents started'}</span></span>
      </li>
    );
  }
  return (
    <li>
      <button type="button" aria-expanded={open} onClick={onToggle} className="group flex min-h-9 w-full items-center gap-2 text-left text-[13px] hover:text-fg">
        <PhaseGlyph status={group.status} />
        <span className="min-w-0 truncate">
          <span className="font-medium text-fg/90">{group.title}</span>
          <span className="text-[12.5px] text-faint tabular-nums"> · {group.done} of {total} done</span>
          {group.failed > 0 && <span className="text-[12.5px] text-danger tabular-nums"> · {group.failed} failed</span>}
        </span>
        <ChevronRight className={`ml-auto size-3.5 shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="animate-fade pb-1 pl-[22px]">
          {group.detail && <div className="-mt-1 mb-1 text-[12px] text-faint">{group.detail}</div>}
          <ul>{children}</ul>
        </div>
      )}
    </li>
  );
}

/**
 * The phases in order, each a line ("Review · 3 of 5 done") that opens into its agents. On a
 * computer the phase at work is open; in Verbose, all are. Later phases nothing has started in
 * fold into one line, Up next, as in Desktop; once the run ended, those it never got to say so.
 */
function Phases({ flow, status, callId, cwd, wide, verbose, onScreen, now }: {
  flow: Pick<Workflow, 'phases' | 'agents'>; status: WorkflowStatus; callId: string; cwd?: string; wide: boolean; verbose: boolean; onScreen: boolean; now: number;
}) {
  const groups = useMemo(() => phaseGroups({ phases: flow.phases, agents: flow.agents, status }), [flow.phases, flow.agents, status]);
  const [phasesOpen, setPhasesOpen] = useState<Record<string, boolean>>({});
  const [agentsOpen, setAgentsOpen] = useState<Record<number, boolean>>({});
  const last = groups.findLastIndex((g) => g.agents.length > 0);
  const shown = groups.slice(0, last + 1);
  const later = groups.slice(last + 1);
  const running = isRunning(status);
  return (
    <div className="px-3 py-1">
      <ul aria-label="Phases">
        {shown.map((group) => {
          const open = phasesOpen[group.title] ?? (verbose || (wide && group.status === 'running'));
          return (
            <PhaseRow key={group.title} group={group} status={status} open={open} onToggle={() => setPhasesOpen((all) => ({ ...all, [group.title]: !open }))}>
              {group.agents.map((agent) => (
                <AgentRow
                  key={agent.index}
                  agent={agent}
                  callId={callId}
                  {...(cwd ? { cwd } : {})}
                  wide={wide}
                  open={Boolean(agentsOpen[agent.index])}
                  onToggle={() => setAgentsOpen((all) => ({ ...all, [agent.index]: !all[agent.index] }))}
                  onScreen={onScreen}
                  now={now}
                />
              ))}
            </PhaseRow>
          );
        })}
      </ul>
      {later.length > 0 && (
        <div className="flex min-h-9 items-center gap-2 text-[13px] text-faint">
          <CircleDashed className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{running ? 'Up next' : 'Not run'}: {later.map((g) => g.title).join(', ')}</span>
        </div>
      )}
    </div>
  );
}

/** The script's own phases, with what each is for, before any agent ran: the plan Claude Code asked about. */
function Plan({ phases }: { phases: WorkflowPhase[] }) {
  return (
    <ol className="space-y-1 px-3 py-2 text-[13px]">
      {phases.map((phase, i) => (
        <li key={i} className="flex gap-2">
          <span className="w-3.5 shrink-0 text-right text-faint tabular-nums">{i + 1}.</span>
          <span className="min-w-0"><span className="text-fg/90">{phase.title}</span>{phase.detail && <span className="text-muted"> — {phase.detail}</span>}</span>
        </li>
      ))}
    </ol>
  );
}

// ---- The card ------------------------------------------------------------------------------------

/** Where a call stands before its run is known: on its way, refused, cut short, or never launched. */
function callState(call: ToolCall, running: boolean, live: Workflow | undefined): { word: string; error?: string; spin?: boolean } | undefined {
  const outcome = outcomeOf(call);
  if (live) return undefined;
  if (outcome.kind === 'pending') return running ? { word: 'Starting workflow', spin: true } : { word: 'Not launched' };
  if (outcome.kind === 'denied') return { word: 'Cancelled' };
  if (outcome.kind === 'stopped') return { word: 'Interrupted' };
  if (outcome.kind === 'failed') return { word: 'Not launched', error: resultText(call.result).replace(/^\s*<tool_use_error>|<\/tool_use_error>\s*$/g, '').trim() };
  return undefined;
}

/**
 * A Workflow call, as Claude Code shows a workflow: its name and description, how it stands
 * (running and for how long, or how it ended) with its agents and tokens, and, opened, its phases,
 * each with its agents, the script, and what it returned. Live where this Pelican runs the session;
 * otherwise from the run's own files, asked again while it runs.
 */
export function WorkflowCard({ call, cwd, running, defaultOpen = false }: { call: ToolCall; cwd?: string; running: boolean; defaultOpen?: boolean }) {
  const sessionId = useSessionId();
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const onScreen = useOnScreen(element);
  const wide = useWide();
  const { live, launch, flow, failed } = useRun(call, onScreen);
  const own = useMemo(() => workflowOf(call.input), [call.input]);
  const before = callState(call, running, live);
  const ended = call.ended && !call.ended.orphan ? call.ended : undefined;
  const status: WorkflowStatus | undefined = before ? undefined
    : live?.status ?? (ended?.status ? ENDED[ended.status] : undefined) ?? flow?.status ?? (call.ended?.orphan || failed ? 'stopped' : undefined);
  const now = useNow(Boolean(status && isRunning(status) && onScreen));
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (status && !isRunning(status)) setStopping(false);
  }, [status]);

  const reveal = useCallback(() => {
    setOpen(true);
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => element?.scrollIntoView?.({ block: 'start', behavior: still ? 'auto' : 'smooth' }));
  }, [element]);
  useRevealed(call.id, reveal);

  const name = flow?.name ?? launch?.name ?? own.name;
  const description = own.description ?? flow?.description ?? launch?.summary;
  const agents = flow?.agents ?? [];
  const phases = flow && flow.phases.length > 0 ? flow.phases : own.meta?.phases ?? [];
  const counts = agentCounts(agents, status ?? 'running', now);
  const total = agents.length || ended?.usage?.agents || 0;
  const done = agents.length > 0 ? counts.done : ended?.usage?.done ?? 0;
  const tokens = flow?.totalTokens ?? (agents.length > 0 ? agentTokens(agents) : undefined) ?? ended?.usage?.tokens;
  const elapsed = status && isRunning(status)
    ? (flow?.startedAt !== undefined ? Math.max(0, now - flow.startedAt) : undefined)
    : flow?.durationMs ?? ended?.usage?.durationMs;
  const error = flow?.error ?? ended?.error;
  const result = flow?.result ?? ended?.result;
  const script = typeof call.input.script === 'string' ? call.input.script : flow?.script;
  const stoppable = Boolean(live && isRunning(live.status) && live.taskId && sessionId);

  // Claude Code's line under the call: "Completed in 6m 1s · 4 agents · 412.3k tokens", and its
  // list's "2/4 agents" for a run still going or cut short.
  const agentsText = total > 0 ? (status === 'completed' ? `${total} ${total === 1 ? 'agent' : 'agents'}` : `${done}/${total} agents`) : undefined;
  const line = (status
    ? [
      stopping && status === 'running' ? 'Stopping…' : status === 'completed' && elapsed !== undefined ? `Completed in ${durationText(elapsed)}` : statusWord(status),
      status !== 'completed' && elapsed !== undefined ? durationText(elapsed) : undefined,
      agentsText,
      tokens ? `${tokensText(tokens)} tokens` : undefined,
    ]
    : [before?.word]).filter((part): part is string => Boolean(part));

  const stop = () => {
    if (!live?.taskId || !sessionId) return;
    setStopping(true);
    api.stopTask(sessionId, live.taskId).catch(() => setStopping(false));
  };

  return (
    <section ref={setElement} id={`workflow-${call.id}`} aria-label={`Workflow${name ? ` ${name}` : ''}`} className="my-1.5 scroll-mt-3 overflow-hidden rounded-xl border border-line bg-panel">
      <button
        type="button"
        aria-expanded={open}
        aria-label={[`Workflow${name ? ` ${name}` : ''}`, description, line.join(', ')].filter(Boolean).join('. ')}
        onClick={() => setOpen((v) => !v)}
        className="relative flex w-full items-start gap-2.5 px-3 pt-2.5 pb-2.5 text-left"
      >
        <WorkflowIcon className="mt-[3px] size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5 pr-5">
            <span className="shrink-0 text-[13px] font-medium text-fg">Workflow</span>
            {name && <span className="min-w-0 truncate font-mono text-[12px] text-muted">{name}</span>}
          </span>
          {description && <span className="mt-0.5 line-clamp-2 block text-[13.5px] leading-snug text-fg/85">{description}</span>}
          {line.length > 0 && (
            // Its parts wrap whole on a narrow screen, never cut off.
            <span className={`mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] leading-[18px] tabular-nums ${status === 'failed' || before?.error ? 'text-danger' : 'text-faint'}`}>
              {status ? <StatusGlyph status={status} /> : before?.spin ? <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {line.map((part, i) => (
                <span key={i} className="flex items-center gap-x-1.5 whitespace-nowrap">
                  {i > 0 && <span aria-hidden className="opacity-70">·</span>}
                  {part}
                </span>
              ))}
            </span>
          )}
          {status && isRunning(status) && agents.length > 0 && <Cells agents={agents} status={status} now={now} />}
        </span>
        <ChevronRight className={`absolute top-[13px] right-3 size-3.5 text-faint transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
      </button>
      {open && (
        <div className="animate-fade border-t border-line">
          {before?.error && <Folded text={before.error} className="mx-3 mt-2.5 font-mono text-[12px] text-danger" />}
          {status === 'failed' && error && <Folded text={error} className="mx-3 mt-2.5 rounded-lg bg-chip px-3 py-2 font-mono text-[12px] text-danger" />}
          {call.resumedBy && (
            <button type="button" onClick={() => revealWorkflow(call.resumedBy!)} className="mx-3 mt-2 flex min-h-8 items-center gap-1.5 text-[12.5px] text-muted hover:text-fg">
              <ArrowUp className="size-3.5 rotate-180 text-faint" aria-hidden />
              Resumed in a later call
            </button>
          )}
          {!call.resumedBy && agents.length > 0 && status ? (
            <Phases flow={{ phases, agents }} status={status} callId={call.id} {...(cwd ? { cwd } : {})} wide={wide} verbose={defaultOpen} onScreen={onScreen} now={now} />
          ) : phases.length > 0 ? (
            <Plan phases={phases} />
          ) : null}
          {status && isRunning(status) && isLarge(total, tokens ?? 0) && (
            <div className="mx-3 mb-1 flex items-center gap-1.5 text-[12.5px] text-wait">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              Larger than most workflows
            </div>
          )}
          {(script || result || stoppable) && <Footer script={script} result={result} stop={stoppable ? stop : undefined} stopping={stopping} />}
        </div>
      )}
    </section>
  );
}

/** A workflow's end, in the conversation where Claude Code said it: a line naming it that leads to its card. */
export function WorkflowEnded({ toolUseId, name, status, durationMs }: { toolUseId: string; name?: string; status?: TaskNotice['status']; durationMs?: number }) {
  const word = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped';
  return (
    <button type="button" onClick={() => revealWorkflow(toolUseId)} title="Show the workflow" className="flex min-h-7 max-w-full items-center gap-2 text-left text-[13px] text-muted hover:text-fg">
      <WorkflowIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        Workflow {name && <span className="font-mono text-[12px]">{name}</span>} <span className={status === 'failed' ? 'text-danger' : ''}>{word}</span>
        {durationMs !== undefined && <>{' '}<span className="text-faint tabular-nums">· {durationText(durationMs)}</span></>}
      </span>
      <ArrowUp className="size-3.5 shrink-0 text-faint" aria-hidden />
    </button>
  );
}
