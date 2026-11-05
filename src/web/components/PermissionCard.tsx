import { CircleHelp, ClipboardList, ExternalLink, Loader2, Plug, ShieldQuestion, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { revealHidden } from '../../shared/hidden';
import { MODE_INFO, type PermissionMode } from '../../shared/modes';
import type { PermissionDecision, PermissionRequest } from '../../shared/protocol';
import { workflowOf } from '../../shared/workflows';
import { api } from '../lib/api';
import { describeTool } from '../lib/tools';
import { fenced } from '../lib/workflows';
import { Diff } from './Diff';
import { Markdown } from './Markdown';

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * Whether a click on an approval is meant for it. For a moment after the card appears, and after
 * the page comes back into view, clicks are let through to nothing: a double click begun on
 * another site (which opened this page under the pointer) must not approve anything.
 */
function useSettled(ms = 500): () => boolean {
  const since = useRef(performance.now());
  useEffect(() => {
    const reset = () => {
      since.current = performance.now();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') reset();
    };
    window.addEventListener('focus', reset);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', reset);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return () => performance.now() - since.current >= ms;
}

function Button({ children, onClick, kind = 'secondary', disabled, wrap }: {
  children: React.ReactNode;
  onClick: () => void;
  kind?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
  /** A label that may run long (what "always" saves): it wraps instead of overflowing. */
  wrap?: boolean;
}) {
  const settled = useSettled();
  const style = kind === 'primary'
    ? 'bg-fg text-bg'
    : kind === 'secondary'
      ? 'border border-line bg-panel hover:bg-hover'
      : 'text-muted hover:bg-hover hover:text-fg';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => settled() && onClick()}
      className={`rounded-xl px-3.5 text-[14px] font-medium disabled:opacity-40 ${wrap ? 'min-h-10 max-w-full py-2 text-left leading-snug' : 'h-10'} ${style}`}
    >
      {children}
    </button>
  );
}

function useDecide(sessionId: string, request: PermissionRequest) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const decide = (decision: PermissionDecision) => {
    setBusy(true);
    setError(undefined);
    api.decide(sessionId, request.id, decision).catch((e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };
  return { busy, error, decide };
}

/** "Claude wants to run …", in Claude Code's own words when it gave them. */
function headline(request: PermissionRequest, cwd: string | undefined): string {
  if (request.title) return request.title;
  if (request.toolName === 'EnterPlanMode') return 'Claude wants to plan before it changes anything';
  if (request.toolName === 'Workflow') return 'Claude wants to run a dynamic workflow';
  const { verb } = describeTool(request.toolName, request.input, cwd);
  const plain = ['Read', 'Edit', 'Write', 'Run', 'Search', 'Find', 'Fetch', 'Search the web', 'Edit notebook'].includes(verb);
  return `Claude wants to ${plain ? verb.toLowerCase() : `use ${verb}`}`;
}

/**
 * A workflow asked about as Claude Code asks: its phases, what running it costs, and its script a
 * tap away.
 */
function WorkflowAsk({ input }: { input: Record<string, unknown> }) {
  const [raw, setRaw] = useState(false);
  const { name, meta } = workflowOf(input);
  const script = str(input.script);
  const phases = meta?.phases ?? [];
  return (
    <div className="space-y-2 text-[13px]">
      {name && <div className="font-mono text-[12px] text-muted">{revealHidden(name).text}</div>}
      {phases.length > 0 && (
        <div>
          <div className="text-muted">This dynamic workflow will spin up multiple subagents across the following phases:</div>
          <ol className="mt-1 space-y-0.5">
            {phases.map((phase, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-3.5 shrink-0 text-right text-faint tabular-nums">{i + 1}.</span>
                <span className="min-w-0">{revealHidden(phase.title).text}{phase.detail && <span className="text-muted"> — {revealHidden(phase.detail).text}</span>}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="text-[12.5px] leading-snug text-faint">
        Dynamic workflows can use a lot of tokens quickly by running many subagents in parallel, which counts against your usage limit. Stop a running workflow at any time from its card.
      </div>
      {script && (
        <div>
          <button type="button" aria-expanded={raw} onClick={() => setRaw((v) => !v)} className="text-[12.5px] text-faint hover:text-fg">{raw ? 'Hide raw script' : 'View raw script'}</button>
          {raw && <Markdown text={fenced(revealHidden(script).text, 'js')} className="mt-1 text-[13px]" />}
        </div>
      )}
    </div>
  );
}

function ToolApproval({ sessionId, request, cwd }: { sessionId: string; request: PermissionRequest; cwd?: string }) {
  const { busy, error, decide } = useDecide(sessionId, request);
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState('');
  const summary = describeTool(request.toolName, request.input, cwd);
  const input = request.input;
  const edit = request.toolName === 'Edit'
    ? { before: str(input.old_string), after: str(input.new_string) }
    : request.toolName === 'Write' ? { before: '', after: str(input.content) } : undefined;
  const command = request.toolName === 'Bash' || request.toolName === 'PowerShell' ? revealHidden(str(input.command)) : undefined;
  const target = summary.target ? revealHidden(summary.target) : undefined;
  const workflow = request.toolName === 'Workflow';
  const raw = !edit && !command && !workflow && Object.keys(input).length > 0 ? revealHidden(JSON.stringify(input, null, 2)) : undefined;
  // Text from Claude Code, a command or an MCP server can hide characters too; so can what "always" saves.
  const [head, about, server, always] = [headline(request, cwd), request.description, request.server, request.always].map((text) => (text ? revealHidden(text) : undefined));
  // A workflow's script shows apart, but what hides in it is warned of all the same.
  const asked = workflow ? revealHidden(JSON.stringify(input)) : undefined;
  const hidden = [command, target, raw, asked, head, about, server, always].some((text) => text?.hidden);

  const allow = <Button kind={request.defaultToNo ? 'secondary' : 'primary'} disabled={busy} onClick={() => decide({ behavior: 'allow' })}>Allow</Button>;
  const deny = <Button kind={request.defaultToNo ? 'primary' : 'quiet'} disabled={busy} onClick={() => setDenying(true)}>Deny</Button>;
  return (
    <div>
      <div className="flex items-start gap-2 text-[13px] text-muted">
        <ShieldQuestion className="mt-px size-4 shrink-0" />
        <span>{head!.text}</span>
      </div>
      {request.agent && <div className="mt-0.5 text-[12.5px] text-faint">From {request.agent === 'a subagent' ? 'a subagent' : `the ${request.agent} agent`}</div>}
      {server && <div className="mt-0.5 text-[12.5px] text-faint">A tool of the MCP server {server.text}</div>}
      {about && <div className="mt-1 text-[12.5px] leading-snug text-muted">{about.text}</div>}
      {/* Claude's few words on a command, above it; a command's own first line would only repeat it. */}
      {target && (summary.prose || !command) && <div className={`mt-1 text-[13px] ${summary.prose ? '' : 'font-mono break-all'}`}>{target.text}</div>}
      {request.reason && <div className="mt-1 text-[12.5px] text-faint">{request.reason}</div>}
      <div className="mt-2 max-h-[34dvh] overflow-y-auto">
        {edit ? (
          <Diff before={edit.before} after={edit.after} maxLines={160} />
        ) : workflow ? (
          <WorkflowAsk input={input} />
        ) : command ? (
          <pre className="rounded-lg bg-chip px-3 py-2 font-mono text-[12.5px] whitespace-pre-wrap break-words">{command.text}</pre>
        ) : raw ? (
          <pre className="rounded-lg bg-chip px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words text-muted">{raw.text}</pre>
        ) : null}
      </div>
      {hidden && (
        <div className="mt-2 flex items-start gap-1.5 text-[12.5px] leading-snug text-danger">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          This contains invisible or direction-changing characters, shown as ⟨U+…⟩. It may not do what it seems to.
        </div>
      )}
      {denying ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            autoFocus
            placeholder="What should Claude do instead? Leave empty to stop."
            className="block w-full resize-none rounded-xl border border-line bg-bg px-3 py-2 text-[16px] outline-none"
          />
          <div className="flex gap-2">
            <Button kind="primary" disabled={busy} onClick={() => decide({ behavior: 'deny', message: note })}>{note.trim() ? 'Send' : 'Deny'}</Button>
            <Button kind="quiet" onClick={() => setDenying(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {request.defaultToNo ? <>{deny}{allow}</> : <>{allow}{deny}</>}
          </div>
          {always && (
            <div className="mt-2 flex">
              <Button wrap disabled={busy} onClick={() => decide({ behavior: 'allow', remember: true })}>{always.text}</Button>
            </div>
          )}
        </>
      )}
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
    </div>
  );
}

type Question = { question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string; preview?: string }> };

function Questions({ sessionId, request }: { sessionId: string; request: PermissionRequest }) {
  const { busy, error, decide } = useDecide(sessionId, request);
  const questions = (Array.isArray(request.input.questions) ? request.input.questions : []) as Question[];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const toggle = (q: Question, label: string) => {
    setPicked((prev) => {
      const current = prev[q.question] ?? [];
      const next = q.multiSelect ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : [label];
      return { ...prev, [q.question]: next };
    });
  };

  const answers = Object.fromEntries(questions.map((q) => {
    const chosen = [...(picked[q.question] ?? [])];
    if (other[q.question]?.trim()) chosen.push(other[q.question]!.trim());
    return [q.question, chosen.join(', ')];
  }));
  const complete = questions.every((q) => answers[q.question]);

  return (
    <div>
      <div className="flex items-center gap-2 text-[13px] text-muted"><CircleHelp className="size-4" />Claude has {questions.length === 1 ? 'a question' : 'questions'}</div>
      <div className="mt-2 max-h-[46dvh] space-y-4 overflow-y-auto">
        {questions.map((q) => {
          // What Claude drew for the option picked last (a mockup, some code), as Claude Code shows it beside the list.
          const preview = (q.options ?? []).find((o) => o.label === (picked[q.question] ?? []).at(-1))?.preview;
          return (
            <div key={q.question}>
              {q.header && <div className="mb-0.5 text-[11px] font-medium tracking-wide text-faint uppercase">{q.header}</div>}
              <div className="text-[15px] leading-snug font-medium">{q.question}</div>
              <div className="mt-2 space-y-1.5">
                {(q.options ?? []).map((option) => {
                  const on = (picked[q.question] ?? []).includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => toggle(q, option.label)}
                      className={`block w-full rounded-xl border px-3 py-2 text-left ${on ? 'border-fg bg-hover' : 'border-line hover:bg-hover'}`}
                    >
                      <div className="text-[14.5px]">{option.label}</div>
                      {option.description && <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{option.description}</div>}
                    </button>
                  );
                })}
                {preview && (
                  <pre className="max-h-64 overflow-auto rounded-xl border border-line bg-bg px-3 py-2 font-mono text-[12px] leading-[1.5] whitespace-pre">{preview}</pre>
                )}
                <input
                  value={other[q.question] ?? ''}
                  onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))}
                  placeholder="Other…"
                  className="block h-10 w-full rounded-xl border border-line bg-bg px-3 text-[16px] outline-none"
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex gap-2">
        <Button kind="primary" disabled={busy || !complete} onClick={() => decide({ behavior: 'allow', updatedInput: { ...request.input, answers } })}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : 'Answer'}
        </Button>
        <Button kind="quiet" disabled={busy} onClick={() => decide({ behavior: 'deny', message: 'The user chose not to answer.' })}>Skip</Button>
      </div>
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
    </div>
  );
}

/**
 * A plan, approved the ways Claude Code offers: into the mode the session came from when that was
 * Bypass, else into Auto where the model has it, else accepting edits; or approving each edit.
 */
function PlanReview({ sessionId, request }: { sessionId: string; request: PermissionRequest }) {
  const { busy, error, decide } = useDecide(sessionId, request);
  const [feedback, setFeedback] = useState('');
  const [revising, setRevising] = useState(false);
  const first: PermissionMode = request.plan?.before === 'bypassPermissions' ? 'bypassPermissions' : request.plan?.auto ? 'auto' : 'acceptEdits';
  return (
    <div>
      <div className="flex items-center gap-2 text-[13px] text-muted"><ClipboardList className="size-4" />Claude's plan</div>
      <div className="mt-2 max-h-[42dvh] overflow-y-auto rounded-xl border border-line bg-bg px-3 py-2">
        <Markdown text={str(request.input.plan)} className="text-[14px]" />
      </div>
      {revising ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Tell Claude what to change"
            className="block w-full resize-none rounded-xl border border-line bg-bg px-3 py-2 text-[16px] outline-none"
          />
          <div className="flex gap-2">
            <Button kind="primary" disabled={busy || !feedback.trim()} onClick={() => decide({ behavior: 'deny', message: feedback })}>Send</Button>
            <Button kind="quiet" onClick={() => setRevising(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button kind="primary" disabled={busy} onClick={() => decide({ behavior: 'allow', permissionMode: first })}>Approve · {MODE_INFO[first].label}</Button>
          <Button disabled={busy} onClick={() => decide({ behavior: 'allow', permissionMode: 'default' })}>Approve · {MODE_INFO.default.label}</Button>
          <Button kind="quiet" disabled={busy} onClick={() => setRevising(true)}>Keep planning</Button>
        </div>
      )}
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
    </div>
  );
}

type Field = {
  key: string;
  label: string;
  hint?: string;
  required: boolean;
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'choice' | 'choices';
  options?: Array<{ value: string; label: string }>;
  format?: string;
};

/** The flat fields of the form an MCP server asks to fill in (the kinds MCP allows there). */
function fieldsOf(schema: Record<string, unknown> | undefined): Field[] {
  const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema?.required) ? (schema!.required as string[]) : []);
  const choicesOf = (p: Record<string, unknown>) => {
    if (Array.isArray(p.oneOf)) return (p.oneOf as Array<Record<string, unknown>>).map((o) => ({ value: str(o.const), label: str(o.title) || str(o.const) }));
    if (Array.isArray(p.enum)) {
      const names = Array.isArray(p.enumNames) ? (p.enumNames as unknown[]) : [];
      return (p.enum as unknown[]).map((v, i) => ({ value: String(v), label: str(names[i]) || String(v) }));
    }
    return undefined;
  };
  return Object.entries(properties).map(([key, p]) => {
    const items = (p.items ?? {}) as Record<string, unknown>;
    const options = p.type === 'array' ? choicesOf(items) : choicesOf(p);
    const kind: Field['kind'] = p.type === 'array' ? 'choices' : options ? 'choice'
      : p.type === 'boolean' ? 'boolean' : p.type === 'integer' ? 'integer' : p.type === 'number' ? 'number' : 'text';
    return {
      key,
      label: str(p.title) || key,
      ...(str(p.description) ? { hint: str(p.description) } : {}),
      required: required.has(key),
      kind,
      ...(options ? { options } : {}),
      ...(str(p.format) ? { format: str(p.format) } : {}),
    };
  });
}

const INPUT_TYPES: Record<string, string> = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' };

/** An MCP server asking for values or for a step in the browser, as Claude Code's dialog does. */
function Elicitation({ sessionId, request }: { sessionId: string; request: PermissionRequest }) {
  const { busy, error, decide } = useDecide(sessionId, request);
  const asked = request.elicitation!;
  const schema = asked.schema;
  const fields = fieldsOf(schema);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
    return Object.fromEntries(Object.entries(properties).flatMap(([key, p]) => (p.default !== undefined ? [[key, p.default]] : [])));
  });
  const set = (key: string, value: unknown) => setValues((prev) => ({ ...prev, [key]: value }));
  const filled = (value: unknown) => value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
  const complete = fields.every((f) => !f.required || filled(values[f.key]));
  const host = (() => {
    try {
      return asked.url ? new URL(asked.url).host : undefined;
    } catch {
      return undefined;
    }
  })();
  const submit = () => {
    const content: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.key];
      if (!filled(value)) continue;
      content[field.key] = field.kind === 'number' || field.kind === 'integer' ? Number(value) : value;
    }
    decide({ behavior: 'allow', updatedInput: content });
  };

  return (
    <div>
      <div className="flex items-start gap-2 text-[13px] text-muted">
        <Plug className="mt-px size-4 shrink-0" />
        <span>{request.title || `${asked.server} asks`}</span>
      </div>
      {request.description && <div className="mt-1 text-[12.5px] leading-snug text-muted">{request.description}</div>}
      <div className="mt-1.5 text-[14.5px] leading-snug whitespace-pre-wrap">{asked.message}</div>
      {asked.mode === 'url' ? (
        <>
          {asked.url && (
            <a href={asked.url} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1.5 text-[13.5px] underline decoration-faint underline-offset-2">
              <ExternalLink className="size-3.5" />Open {host ?? 'the page'}
            </a>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button kind="primary" disabled={busy || !asked.url} onClick={() => decide({ behavior: 'allow' })}>Done</Button>
            <Button kind="quiet" disabled={busy} onClick={() => decide({ behavior: 'deny' })}>Decline</Button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 max-h-[42dvh] space-y-3 overflow-y-auto">
            {fields.map((field) => field.kind === 'boolean' ? (
              <label key={field.key} className="flex items-start gap-2.5">
                <input type="checkbox" checked={values[field.key] === true} onChange={(e) => set(field.key, e.target.checked)} className="mt-0.5 size-5 shrink-0" />
                <span>
                  <span className="block text-[13px] font-medium">{field.label}</span>
                  {field.hint && <span className="block text-[12px] leading-snug text-muted">{field.hint}</span>}
                </span>
              </label>
            ) : (
              <label key={field.key} className="block">
                <div className="text-[13px] font-medium">
                  {field.label}
                  {!field.required && <span className="ml-1 font-normal text-faint">optional</span>}
                </div>
                {field.hint && <div className="text-[12px] leading-snug text-muted">{field.hint}</div>}
                {field.kind === 'choice' ? (
                  <select value={String(values[field.key] ?? '')} onChange={(e) => set(field.key, e.target.value || undefined)} className="mt-1 block h-10 w-full rounded-xl border border-line bg-bg px-3 text-[16px]">
                    <option value="">Choose…</option>
                    {field.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : field.kind === 'choices' ? (
                  <div className="mt-1 space-y-1">
                    {field.options?.map((o) => {
                      const list = Array.isArray(values[field.key]) ? (values[field.key] as string[]) : [];
                      return (
                        <span key={o.value} className="flex items-center gap-2 text-[14px]">
                          <input type="checkbox" checked={list.includes(o.value)} onChange={(e) => set(field.key, e.target.checked ? [...list, o.value] : list.filter((v) => v !== o.value))} className="size-4" />
                          {o.label}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <input
                    type={field.kind === 'number' || field.kind === 'integer' ? 'number' : INPUT_TYPES[field.format ?? ''] ?? 'text'}
                    {...(field.kind === 'integer' ? { step: 1 } : {})}
                    value={String(values[field.key] ?? '')}
                    onChange={(e) => set(field.key, e.target.value)}
                    className="mt-1 block h-10 w-full rounded-xl border border-line bg-bg px-3 text-[16px] outline-none"
                  />
                )}
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button kind="primary" disabled={busy || !complete} onClick={submit}>{busy ? <Loader2 className="size-4 animate-spin" /> : 'Send'}</Button>
            <Button kind="quiet" disabled={busy} onClick={() => decide({ behavior: 'deny' })}>Decline</Button>
          </div>
        </>
      )}
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
    </div>
  );
}

export function PermissionCard({ sessionId, request, cwd }: { sessionId: string; request: PermissionRequest; cwd?: string }) {
  return (
    <div className="animate-fade mx-auto mb-2 max-w-3xl rounded-2xl border border-line bg-panel px-4 py-3 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
      {request.elicitation ? (
        <Elicitation sessionId={sessionId} request={request} />
      ) : request.toolName === 'AskUserQuestion' ? (
        <Questions sessionId={sessionId} request={request} />
      ) : request.toolName === 'ExitPlanMode' ? (
        <PlanReview sessionId={sessionId} request={request} />
      ) : (
        <ToolApproval sessionId={sessionId} request={request} cwd={cwd} />
      )}
    </div>
  );
}
