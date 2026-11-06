import { CheckCircle2, ChevronRight, Circle, CircleDot, FileText, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { memo, useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api';
import { duration } from '../lib/format';
import { useFileLink, usePathLinks } from '../lib/path-links';
import { useSessionId } from '../lib/session-context';
import { useSessionView } from '../lib/store';
import { describeTool, todosOf, type ToolSummary } from '../lib/tools';
import { answersOf, buildItems, cleanOutput, type Outcome, outcomeOf, resultImages, resultText, type ToolCall } from '../lib/turns';
import { Diff, diffStats } from './Diff';
import { openImage } from './Lightbox';
import { PreviewCard } from './Preview';
import { loadsInPlace, Markdown } from './Markdown';
import { STEP_LINK } from './PathLink';
import { WorkflowCard } from './WorkflowCard';

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** What you wrote when you turned something down, shown where it happened. */
function Note({ text }: { text: string }) {
  return <div className="border-l-2 border-line pl-3 text-[13.5px] leading-relaxed whitespace-pre-wrap text-muted">{text}</div>;
}

type Edit = { before: string; after: string };

/** The edits a file tool made, as before/after pairs. */
function editsOf(call: ToolCall): Edit[] {
  const input = call.input;
  if (call.name === 'Edit') return [{ before: str(input.old_string), after: str(input.new_string) }];
  if (call.name === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Array<Record<string, unknown>>).map((e) => ({ before: str(e.old_string), after: str(e.new_string) }));
  }
  if (call.name === 'Write') return [{ before: '', after: str(input.content) }];
  return [];
}

function Output({ text: raw, failed }: { text: string; failed?: boolean }) {
  const [all, setAll] = useState(false);
  const text = useMemo(() => cleanOutput(raw), [raw]);
  if (!text.trim()) return <div className="text-[12px] text-faint">No output</div>;
  const long = text.length > 1200 || text.split('\n').length > 14;
  return (
    <div>
      <pre
        className={`overflow-x-auto rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words ${failed ? 'text-danger' : 'text-muted'} ${long && !all ? 'max-h-56 overflow-y-hidden [mask-image:linear-gradient(to_bottom,black_80%,transparent)]' : ''}`}
      >
        {text}
      </pre>
      {long && (
        <button type="button" aria-expanded={all} className="mt-1 text-[12px] text-faint hover:text-fg" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function Images({ call }: { call: ToolCall }) {
  const images = resultImages(call.result);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image, i) => {
        const source = image.source;
        const src = source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url;
        if (image.omitted || !loadsInPlace(src)) {
          return <div key={i} className="rounded-md bg-chip px-2 py-1 text-[11px] text-faint">Image not shown</div>;
        }
        return (
          <button key={i} type="button" aria-label="Open image" onClick={() => openImage(src)}>
            <img alt="" loading="lazy" decoding="async" className="max-h-64 max-w-full rounded-lg border border-line" src={src} />
          </button>
        );
      })}
    </div>
  );
}

/** One file Claude sent: a picture, a page, a document, or just its name. */
function SentFile({ path, open: startOpen }: { path: string; open: boolean }) {
  const sessionId = useSessionId();
  const [open, setOpen] = useState(startOpen);
  const name = path.split('/').pop() ?? path;
  const kind = /\.(png|jpe?g|gif|webp)$/i.test(name) ? 'image' : /\.(html?|svg)$/i.test(name) ? 'page' : /\.(md|markdown)$/i.test(name) ? 'doc' : 'file';
  const { data, error, isLoading } = useQuery({
    queryKey: ['sent', sessionId, path],
    queryFn: () => api.sent(sessionId!, path),
    enabled: open && Boolean(sessionId),
    staleTime: 60_000,
  });
  const chip = (
    <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex min-h-9 w-full items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-left text-[13px]">
      <FileText className="size-4 shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{name}</span>
      {isLoading ? <Loader2 className="size-3.5 animate-spin text-faint" /> : <ChevronRight className={`size-3.5 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />}
    </button>
  );
  if (!open) return chip;
  if (error) return <div>{chip}<div className="mt-1 text-[12px] text-danger">{(error as Error).message}</div></div>;
  if (!data) return chip;
  if (kind === 'image' && data.image) {
    return (
      <button type="button" onClick={() => openImage(data.image)} className="block">
        <img src={data.image} alt={name} className="max-h-96 max-w-full rounded-lg border border-line" />
      </button>
    );
  }
  if (kind === 'page' && data.text !== undefined) return <PreviewCard source={{ kind: /\.svg$/i.test(name) ? 'svg' : 'html', code: data.text, title: name }} label={name} />;
  if (kind === 'doc' && data.text !== undefined) {
    return <div>{chip}<div className="mt-1 rounded-lg border border-line bg-bg px-3 py-2"><Markdown text={data.text} className="text-[14px]" /></div></div>;
  }
  return <div>{chip}{data.text !== undefined && <div className="mt-1"><Output text={data.text} /></div>}</div>;
}

/** Files Claude handed over (SendUserFile, Artifact), shown the way Claude Desktop shows them. */
function SentFiles({ call }: { call: ToolCall }) {
  // What Claude Code delivered, at the paths it checked; never the paths Claude asked for.
  const delivered = call.result?.delivered;
  const files = call.name === 'Artifact' ? [str(call.input.file_path)].filter(Boolean) : (delivered?.files ?? []).map((file) => file.path);
  const caption = delivered?.caption ?? (str(call.input.caption) || str(call.input.description));
  const link = resultText(call.result).match(/https:\/\/claude\.ai\/[^\s)"']+/)?.[0];
  // Shown in place unless Claude meant them as attachments to save.
  const render = call.name === 'Artifact' || (delivered?.display ?? str(call.input.display)) !== 'attach';
  return (
    <div className="my-1 space-y-1.5">
      {caption && <div className="text-[13px] text-muted">{caption}</div>}
      {files.map((file) => <SentFile key={file} path={file} open={render} />)}
      {link && <a href={link} target="_blank" rel="noreferrer" className="inline-flex text-[12.5px] text-faint underline decoration-faint underline-offset-2 hover:text-fg">Open the published page</a>}
    </div>
  );
}

/** What a subagent did, from its own transcript: its tool calls, opened on request. */
function AgentSteps({ agentId, cwd }: { agentId: string; cwd?: string }) {
  const sessionId = useSessionId();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['subagent', sessionId, agentId],
    queryFn: () => api.subagent(sessionId!, agentId),
    enabled: open && Boolean(sessionId),
    staleTime: 60_000,
  });
  const steps = useMemo(() => buildItems(data ?? []).flatMap((item) => (item.kind === 'assistant' ? item.parts : [])).filter((part) => part.kind === 'tool'), [data]);
  if (!sessionId) return null;
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px]">
      <button type="button" className="flex min-h-7 w-full items-center gap-1.5 text-left text-faint hover:text-fg" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        {open && data ? `${steps.length} steps` : 'Steps it took'}
        {open && isLoading && <Loader2 className="size-3.5 animate-spin" />}
      </button>
      {open && error && <div className="py-1 text-[12px] text-danger">{(error as Error).message}</div>}
      {open && data && steps.length === 0 && <div className="py-1 text-[12px] text-faint">No steps were recorded.</div>}
      {open && steps.map((part) => (part.kind === 'tool' ? <ToolCallView key={part.key} call={part.call} cwd={cwd} running={false} /> : null))}
    </div>
  );
}

/** What a running subagent is doing, as Claude Code reports it: its summary or last tool, its steps, its time. */
function AgentProgress({ toolUseId }: { toolUseId: string }) {
  const report = useSessionView(useSessionId()).run?.progress?.[toolUseId];
  if (!report) return null;
  const steps = report.toolUses ? `${report.toolUses} ${report.toolUses === 1 ? 'step' : 'steps'}` : undefined;
  const parts = [report.summary ?? report.lastTool, steps, report.durationMs ? duration(report.durationMs) : undefined].filter(Boolean);
  if (parts.length === 0) return null;
  return <div className="-mt-1 mb-1 ml-5.5 truncate text-[12px] text-faint">{parts.join(' · ')}</div>;
}

/** A page or a picture Claude wrote, worth seeing rendered rather than as code. */
const PREVIEWABLE = /\.(html?|svg)$/i;

function Detail({ call, cwd, outcome }: { call: ToolCall; cwd?: string; outcome: Outcome }) {
  // A call that never ran (refused) or was cut short gave back only a note to Claude, which the
  // row already shows: what is left to see is what it would have done.
  const ran = outcome.kind === 'done' || outcome.kind === 'failed';
  const failed = outcome.kind === 'failed';
  const output = ran ? resultText(call.result) : '';
  const edits = editsOf(call);
  const file = str(call.input.file_path);
  if (call.name === 'Write' && PREVIEWABLE.test(file) && (outcome.kind === 'done' || outcome.kind === 'pending')) {
    const name = file.split('/').pop() ?? file;
    return <PreviewCard source={{ kind: /\.svg$/i.test(file) ? 'svg' : 'html', code: str(call.input.content), title: name }} label={name} />;
  }
  if (edits.length > 0 && !failed) {
    return (
      <div className="space-y-2">
        {edits.map((edit, i) => <Diff key={i} before={edit.before} after={edit.after} />)}
      </div>
    );
  }
  switch (call.name) {
    case 'TodoWrite':
      return <TodoList input={call.input} />;
    case 'Bash':
    case 'PowerShell':
      return (
        <div className="space-y-2">
          <pre className="overflow-x-auto rounded-lg bg-chip px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words">
            <span className="select-none text-faint">$ </span>
            {str(call.input.command)}
          </pre>
          {ran && <Output text={output} failed={failed} />}
        </div>
      );
    case 'Agent':
    case 'Task': {
      const agentId = output.match(/agentId:\s*([\w-]+)/)?.[1];
      return (
        <div className="space-y-2">
          {str(call.input.prompt) && (
            <details className="rounded-lg border border-line bg-panel px-3 py-2 text-[13px]">
              <summary className="cursor-pointer text-faint">Instructions</summary>
              <Markdown text={str(call.input.prompt)} className="mt-2 text-[13px]" />
            </details>
          )}
          {agentId && <AgentSteps agentId={agentId} cwd={cwd} />}
          {ran && <Markdown text={output.replace(/\n*agentId:[\s\S]*$/, '')} className="text-[14px]" />}
        </div>
      );
    }
    default:
      return (
        <div className="space-y-2">
          {ran ? (
            <>
              <Output text={output} failed={failed} />
              <Images call={call} />
            </>
          ) : (
            <Output text={JSON.stringify(call.input, null, 2)} />
          )}
        </div>
      );
  }
}

export function TodoList({ input }: { input: Record<string, unknown> }) {
  const todos = todosOf(input);
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
      <div className="mb-1.5 text-[12px] text-faint">
        Tasks · {done}/{todos.length}
      </div>
      <ul className="space-y-1">
        {todos.map((todo, i) => (
          <li key={i} className="flex items-start gap-2 text-[13.5px] leading-snug">
            {todo.status === 'completed' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-live" />
            ) : todo.status === 'in_progress' ? (
              <CircleDot className="mt-0.5 size-4 shrink-0 text-run" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-faint" />
            )}
            <span className={todo.status === 'completed' ? 'text-faint line-through' : ''}>
              {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Claude's questions with what you answered: the answers live in the text Claude Code gave back, not in the call. */
function QuestionsAnswered({ call }: { call: ToolCall }) {
  const questions = Array.isArray(call.input.questions) ? (call.input.questions as Array<Record<string, unknown>>) : [];
  const outcome = outcomeOf(call);
  const output = resultText(call.result);
  const answers = outcome.kind === 'done' ? answersOf(questions.map((q) => str(q.question)), output) : {};
  // Words typed in place of picking, for all the questions at once.
  const response = outcome.kind === 'done' ? output.match(/^The user responded: ([\s\S]*)$/)?.[1] : undefined;
  const answered = Boolean(response) || Object.values(answers).some((a) => a.answer || a.notes);
  return (
    <div className="my-1.5 rounded-xl border border-line bg-panel px-3 py-2.5 text-[13.5px]">
      {questions.map((q, i) => {
        const answer = answers[str(q.question)];
        return (
          <div key={i} className={i > 0 ? 'mt-2' : ''}>
            <div className="text-muted">{str(q.question)}</div>
            {answer?.answer && <div className="mt-0.5 font-medium">{answer.answer}</div>}
            {answer?.notes && <div className="mt-0.5 whitespace-pre-wrap text-muted">{answer.notes}</div>}
          </div>
        );
      })}
      {response && <div className="mt-2 font-medium whitespace-pre-wrap">{response}</div>}
      {questions.length === 0 && output && <div className="text-muted">{output}</div>}
      {questions.length > 0 && !answered && <div className="mt-2 text-faint">{outcome.kind === 'stopped' ? 'Interrupted' : 'Not answered'}</div>}
      {outcome.kind === 'denied' && outcome.note && <div className="mt-1.5"><Note text={outcome.note} /></div>}
    </div>
  );
}

const PLAN_STATUS: Partial<Record<Outcome['kind'], string>> = { done: 'Approved', denied: 'Sent back', stopped: 'Interrupted' };

function PlanCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const plan = str(call.input.plan);
  const outcome = outcomeOf(call);
  const status = PLAN_STATUS[outcome.kind];
  return (
    <div className="my-1.5 rounded-xl border border-line bg-panel px-3 py-2.5">
      <div className="mb-1 text-[12px] text-faint">Plan{status ? ` · ${status}` : ''}</div>
      <div className={open ? '' : 'max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'}>
        <Markdown text={plan} className="text-[14px]" />
      </div>
      <button type="button" aria-expanded={open} className="mt-1 text-[12px] text-faint hover:text-fg" onClick={() => setOpen((v) => !v)}>
        {open ? 'Show less' : 'Show the whole plan'}
      </button>
      {outcome.kind === 'denied' && outcome.note && <div className="mt-2"><Note text={outcome.note} /></div>}
    </div>
  );
}

/** A tool's target: a file name with its folder dimmed, a command in mono, or a plain description. */
export function ToolTarget({ summary }: { summary: ToolSummary }) {
  const target = summary.target ?? '';
  if (summary.path) {
    const cut = target.lastIndexOf('/');
    const name = cut >= 0 ? target.slice(cut + 1) : target;
    const dir = cut > 0 ? target.slice(0, cut) : '';
    return (
      <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
        {/* The folder gives way first; a name longer than the row then ends in an ellipsis, never cut off. */}
        <span className="min-w-0 truncate font-mono text-[12px] text-fg/85">{name}</span>
        {/* Right-to-left so a long folder loses its start, not its end; the marks keep the slashes in place. */}
        {dir && <span className="min-w-0 shrink-[1000] truncate font-mono text-[11px] text-faint" dir="rtl">{`\u200e${dir}\u200e`}</span>}
      </span>
    );
  }
  return <span className={`min-w-0 truncate ${summary.prose ? '' : 'font-mono text-[12px]'}`}>{target}</span>;
}

/** The file a step read or changed, and the line to open it at: where a Read began, where an edit's change is. */
function useStepFile(call: ToolCall) {
  const lines = usePathLinks()?.lines;
  const file = FILE_TOOLS.has(call.name) ? str(call.input.file_path) || str(call.input.notebook_path) : '';
  const offset = typeof call.input.offset === 'number' ? call.input.offset : undefined;
  const line = call.name === 'Read' ? offset : lines?.[call.id];
  return useFileLink(file || undefined, line && line > 0 ? line : undefined);
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export const ToolCallView = memo(function ToolCallView({ call, cwd, running, defaultOpen = false }: { call: ToolCall; cwd?: string; running: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const summary = describeTool(call.name, call.input, cwd);
  const outcome = outcomeOf(call);
  const fileLink = useStepFile(call);
  const stats = useMemo(() => {
    const edits = editsOf(call);
    if (edits.length === 0) return undefined;
    return edits.reduce((acc, e) => {
      const s = diffStats(e.before, e.after);
      return { added: acc.added + s.added, removed: acc.removed + s.removed };
    }, { added: 0, removed: 0 });
  }, [call]);

  if (call.name === 'TodoWrite' && !call.sameTasks) return <div className="my-1.5"><TodoList input={call.input} /></div>;
  // A workflow, as Claude Code shows one: its phases and agents, never its script's first line.
  if (call.name === 'Workflow') return <WorkflowCard call={call} {...(cwd ? { cwd } : {})} running={running} defaultOpen={defaultOpen} />;
  // Files and visuals only from calls that ran: a call Claude only wrote (one no app answered, or
  // one that failed) shows as a step, with its input as text.
  const ran = Boolean(call.result && !call.result.is_error);
  if (ran && (call.name === 'SendUserFile' || (call.name === 'Artifact' && str(call.input.file_path) && (!call.input.action || call.input.action === 'publish')))) return <SentFiles call={call} />;
  // Claude Desktop's visuals (diagrams, charts, small tools): drawn in place, as Desktop shows them.
  if (ran && /(^|__)show_widget$/.test(call.name) && str(call.input.widget_code)) {
    const code = str(call.input.widget_code);
    return (
      <div className="my-1">
        <PreviewCard source={{ kind: /^\s*<svg/i.test(code) ? 'svg' : 'html', code, widget: true, ...(str(call.input.title) ? { title: str(call.input.title) } : {}) }} label={str(call.input.title).replace(/_/g, ' ') || 'Visual'} />
      </div>
    );
  }
  if (call.name === 'AskUserQuestion' && call.result) return <QuestionsAnswered call={call} />;
  // While it waits for approval, the approval card shows the plan; the transcript only notes it.
  if (call.name === 'ExitPlanMode' && str(call.input.plan) && call.result) return <PlanCard call={call} />;

  const Icon = summary.icon;
  const failed = outcome.kind === 'failed';
  // A refused or interrupted edit changed nothing, whatever it meant to change.
  const changed = stats && (outcome.kind === 'done' || outcome.kind === 'pending') && (stats.added > 0 || stats.removed > 0);
  const row = (target: React.ReactNode) => (
    <>
      <Icon className={`size-3.5 shrink-0 ${failed ? 'text-danger' : ''}`} />
      <span className="shrink-0 text-fg/80">{summary.verb}</span>
      {target}
      {changed && (
        <span className="shrink-0 font-mono text-[11px]">
          {stats.added > 0 && <span className="text-add">+{stats.added}</span>}
          {stats.removed > 0 && <span className="ml-1 text-del">−{stats.removed}</span>}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
        {outcome.kind === 'pending' && running && <Loader2 className="size-3.5 animate-spin text-faint" />}
        {failed && <span className="text-[11px] text-danger">failed</span>}
        {outcome.kind === 'denied' && <span className="text-[11px] text-faint">denied</span>}
        {outcome.kind === 'stopped' && <span className="text-[11px] text-faint">interrupted</span>}
        <ChevronRight className={`size-3.5 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </span>
    </>
  );
  return (
    <div>
      {fileLink ? (
        // The file's name opens it, as a path does in Claude Desktop; the rest of the row still
        // opens the step (its toggle lies under the whole row, the name's link above it). On a
        // touch screen the row is a finger tall and the name takes taps over all of its height.
        <div className="group relative flex min-h-8 w-full items-center gap-2 rounded-md py-1 text-[13px] text-muted hover:text-fg pointer-coarse:min-h-11">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`${summary.verb} ${summary.target ?? ''}`.trim()} className="absolute inset-0 rounded-md" />
          {row(
            <a href={fileLink.href} onClick={fileLink.onClick} title={`Open ${fileLink.path}`} className={`relative z-[1] flex min-w-0 ${STEP_LINK} pointer-coarse:self-stretch pointer-coarse:items-center pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1`}>
              <ToolTarget summary={summary} />
            </a>,
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group flex min-h-8 w-full items-center gap-2 rounded-md py-1 text-left text-[13px] text-muted hover:text-fg"
          aria-expanded={open}
        >
          {row(summary.target && <ToolTarget summary={summary} />)}
        </button>
      )}
      {outcome.kind === 'pending' && running && (call.name === 'Agent' || call.name === 'Task') && <AgentProgress toolUseId={call.id} />}
      {outcome.kind === 'denied' && outcome.note && <div className="mb-1.5 ml-5.5"><Note text={outcome.note} /></div>}
      {open && (
        <div className="animate-fade mt-1 mb-2 ml-5.5">
          {summary.note && <div className="mb-1.5 text-[12px] text-faint">{summary.note}</div>}
          <Detail call={call} cwd={cwd} outcome={outcome} />
        </div>
      )}
    </div>
  );
});
