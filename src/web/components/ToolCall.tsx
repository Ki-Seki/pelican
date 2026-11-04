import { CheckCircle2, ChevronRight, Circle, CircleDot, Loader2 } from 'lucide-react';
import { memo, useMemo, useState } from 'react';

import { describeTool, todosOf, type ToolSummary } from '../lib/tools';
import { resultImages, resultText, type ToolCall } from '../lib/turns';
import { Diff, diffStats } from './Diff';
import { Markdown } from './Markdown';

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
  const long = text.length > 1800 || text.split('\n').length > 24;
  return (
    <div>
      <pre
        className={`overflow-x-auto rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words ${failed ? 'text-danger' : 'text-muted'} ${long && !all ? 'max-h-72 overflow-y-hidden' : ''}`}
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
      {images.map((image, i) =>
        image.omitted || image.source.type !== 'base64' ? (
          <div key={i} className="rounded-md bg-chip px-2 py-1 text-[11px] text-faint">Image not shown</div>
        ) : (
          <img
            key={i}
            alt=""
            className="max-h-64 max-w-full rounded-lg border border-line"
            src={`data:${image.source.media_type};base64,${image.source.data}`}
          />
        ),
      )}
    </div>
  );
}

function Detail({ call }: { call: ToolCall }) {
  const output = resultText(call.result);
  const failed = call.result?.is_error;
  const edits = editsOf(call);
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
    case 'Task':
      return (
        <div className="space-y-2">
          {str(call.input.prompt) && (
            <details className="rounded-lg border border-line bg-panel px-3 py-2 text-[13px]">
              <summary className="cursor-pointer text-faint">Instructions</summary>
              <Markdown text={str(call.input.prompt)} className="mt-2 text-[13px]" />
            </details>
          )}
          {call.result && <Markdown text={output} className="text-[14px]" />}
        </div>
      );
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

export const ToolCallView = memo(function ToolCallView({ call, cwd, running }: { call: ToolCall; cwd?: string; running: boolean }) {
  const [open, setOpen] = useState(false);
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
  if (call.name === 'AskUserQuestion' && call.result) return <QuestionsAnswered call={call} />;
  if (call.name === 'ExitPlanMode' && str(call.input.plan)) return <PlanCard call={call} />;

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
      {open && (
        <div className="animate-fade mt-1 mb-2 ml-5.5">
          {summary.note && <div className="mb-1.5 text-[12px] text-faint">{summary.note}</div>}
          <Detail call={call} />
        </div>
      )}
    </div>
  );
});
