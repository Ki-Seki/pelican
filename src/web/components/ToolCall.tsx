import { CheckCircle2, ChevronRight, Circle, CircleDot, FileText, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { memo, useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api';
import { duration } from '../lib/format';
import { useSessionId } from '../lib/session-context';
import { useSessionView } from '../lib/store';
import { describeTool, todosOf, type ToolSummary } from '../lib/tools';
import { buildItems, resultImages, resultText, type ToolCall } from '../lib/turns';
import { Diff, diffStats } from './Diff';
import { openImage } from './Lightbox';
import { PreviewCard } from './Preview';
import { loadsInPlace, Markdown } from './Markdown';

const str = (value: unknown) => (typeof value === 'string' ? value : '');

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

function Output({ text, failed }: { text: string; failed?: boolean }) {
  const [all, setAll] = useState(false);
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
        <button type="button" className="mt-1 text-[12px] text-faint hover:text-fg" onClick={() => setAll((v) => !v)}>
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
          <button key={i} type="button" onClick={() => openImage(src)}>
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
    <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-h-9 w-full items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-left text-[13px]">
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
  const files = call.name === 'Artifact' ? [str(call.input.file_path)].filter(Boolean) : (Array.isArray(call.input.files) ? (call.input.files as unknown[]).filter((f): f is string => typeof f === 'string') : []);
  const caption = str(call.input.caption) || str(call.input.description);
  const link = resultText(call.result).match(/https:\/\/claude\.ai\/[^\s)"']+/)?.[0];
  // Shown in place unless Claude meant them as attachments to save.
  const render = call.name === 'Artifact' || str(call.input.display) !== 'attach';
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

function Detail({ call, cwd }: { call: ToolCall; cwd?: string }) {
  const output = resultText(call.result);
  const failed = call.result?.is_error;
  const edits = editsOf(call);
  const file = str(call.input.file_path);
  if (call.name === 'Write' && PREVIEWABLE.test(file) && !failed) {
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
    case 'Bash':
    case 'PowerShell':
      return (
        <div className="space-y-2">
          <pre className="overflow-x-auto rounded-lg bg-chip px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words">
            <span className="select-none text-faint">$ </span>
            {str(call.input.command)}
          </pre>
          {call.result && <Output text={output} failed={failed} />}
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
          {call.result && <Markdown text={output.replace(/\n*agentId:[\s\S]*$/, '')} className="text-[14px]" />}
        </div>
      );
    }
    default:
      return (
        <div className="space-y-2">
          {call.result ? (
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

function QuestionsAnswered({ call }: { call: ToolCall }) {
  const questions = Array.isArray(call.input.questions) ? (call.input.questions as Array<Record<string, unknown>>) : [];
  const answers = (call.input.answers ?? {}) as Record<string, string>;
  const output = resultText(call.result);
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2.5 text-[13.5px]">
      {questions.map((q, i) => (
        <div key={i} className={i > 0 ? 'mt-2' : ''}>
          <div className="text-muted">{str(q.question)}</div>
          {answers[str(q.question)] && <div className="mt-0.5 font-medium">{answers[str(q.question)]}</div>}
        </div>
      ))}
      {questions.length === 0 && output && <div className="text-muted">{output}</div>}
    </div>
  );
}

function PlanCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const plan = str(call.input.plan);
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
      <div className="mb-1 text-[12px] text-faint">Plan</div>
      <div className={open ? '' : 'max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'}>
        <Markdown text={plan} className="text-[14px]" />
      </div>
      <button type="button" className="mt-1 text-[12px] text-faint hover:text-fg" onClick={() => setOpen((v) => !v)}>
        {open ? 'Show less' : 'Show the whole plan'}
      </button>
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
        <span className="shrink-0 font-mono text-[12px] text-fg/85">{name}</span>
        {/* Right-to-left so a long folder loses its start, not its end; the marks keep the slashes in place. */}
        {dir && <span className="min-w-0 truncate font-mono text-[11px] text-faint" dir="rtl">{`\u200e${dir}\u200e`}</span>}
      </span>
    );
  }
  return <span className={`min-w-0 truncate ${summary.prose ? '' : 'font-mono text-[12px]'}`}>{target}</span>;
}

export const ToolCallView = memo(function ToolCallView({ call, cwd, running, defaultOpen = false }: { call: ToolCall; cwd?: string; running: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const summary = describeTool(call.name, call.input, cwd);
  const failed = Boolean(call.result?.is_error);
  const stats = useMemo(() => {
    const edits = editsOf(call);
    if (edits.length === 0) return undefined;
    return edits.reduce((acc, e) => {
      const s = diffStats(e.before, e.after);
      return { added: acc.added + s.added, removed: acc.removed + s.removed };
    }, { added: 0, removed: 0 });
  }, [call]);

  if (call.name === 'TodoWrite') return <TodoList input={call.input} />;
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
  const pending = !call.result;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex min-h-8 w-full items-center gap-2 rounded-md py-1 text-left text-[13px] text-muted hover:text-fg"
        aria-expanded={open}
      >
        <Icon className={`size-3.5 shrink-0 ${failed ? 'text-danger' : ''}`} />
        <span className="shrink-0 text-fg/80">{summary.verb}</span>
        {summary.target && <ToolTarget summary={summary} />}
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="shrink-0 font-mono text-[11px]">
            {stats.added > 0 && <span className="text-add">+{stats.added}</span>}
            {stats.removed > 0 && <span className="ml-1 text-del">−{stats.removed}</span>}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
          {pending && running && <Loader2 className="size-3.5 animate-spin text-faint" />}
          {failed && <span className="text-[11px] text-danger">failed</span>}
          <ChevronRight className={`size-3.5 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        </span>
      </button>
      {pending && running && (call.name === 'Agent' || call.name === 'Task') && <AgentProgress toolUseId={call.id} />}
      {open && (
        <div className="animate-fade mt-1 mb-2 ml-5.5">
          {summary.note && <div className="mb-1.5 text-[12px] text-faint">{summary.note}</div>}
          <Detail call={call} cwd={cwd} />
        </div>
      )}
    </div>
  );
});
