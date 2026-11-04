import { CircleHelp, ClipboardList, Loader2, ShieldQuestion } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { PermissionDecision, PermissionRequest } from '../../shared/protocol';
import { api } from '../lib/api';
import { describeTool } from '../lib/tools';
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

function Button({ children, onClick, kind = 'secondary', disabled }: { children: React.ReactNode; onClick: () => void; kind?: 'primary' | 'secondary' | 'quiet'; disabled?: boolean }) {
  const settled = useSettled();
  const style = kind === 'primary'
    ? 'bg-fg text-bg'
    : kind === 'secondary'
      ? 'border border-line bg-panel hover:bg-hover'
      : 'text-muted hover:bg-hover hover:text-fg';
  return (
    <button type="button" disabled={disabled} onClick={() => settled() && onClick()} className={`h-10 rounded-xl px-3.5 text-[14px] font-medium disabled:opacity-40 ${style}`}>
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

function ToolApproval({ sessionId, request, cwd }: { sessionId: string; request: PermissionRequest; cwd?: string }) {
  const { busy, error, decide } = useDecide(sessionId, request);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const summary = describeTool(request.toolName, request.input, cwd);
  const input = request.input;
  const edit = request.toolName === 'Edit'
    ? { before: str(input.old_string), after: str(input.new_string) }
    : request.toolName === 'Write' ? { before: '', after: str(input.content) } : undefined;

  return (
    <div>
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <ShieldQuestion className="size-4" />
        <span>Claude wants to {summary.verb.toLowerCase()}</span>
      </div>
      {summary.target && <div className="mt-1 font-mono text-[13px] break-all">{summary.target}</div>}
      {request.reason && <div className="mt-1 text-[12.5px] text-faint">{request.reason}</div>}
      <div className="mt-2 max-h-[34dvh] overflow-y-auto">
        {edit ? (
          <Diff before={edit.before} after={edit.after} maxLines={160} />
        ) : request.toolName === 'Bash' ? (
          <pre className="rounded-lg bg-chip px-3 py-2 font-mono text-[12.5px] whitespace-pre-wrap break-words">{str(input.command)}</pre>
        ) : (
          <pre className="rounded-lg bg-chip px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words text-muted">{JSON.stringify(input, null, 2)}</pre>
        )}
      </div>
      {denying ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            autoFocus
            placeholder="Tell Claude what to do instead (optional)"
            className="block w-full resize-none rounded-xl border border-line bg-bg px-3 py-2 text-[16px] outline-none"
          />
          <div className="flex gap-2">
            <Button kind="primary" disabled={busy} onClick={() => decide({ behavior: 'deny', message: reason })}>Deny</Button>
            <Button kind="quiet" onClick={() => setDenying(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button kind="primary" disabled={busy} onClick={() => decide({ behavior: 'allow' })}>Allow</Button>
          {request.canRemember && <Button disabled={busy} onClick={() => decide({ behavior: 'allow', remember: true })}>Always allow</Button>}
          <Button kind="quiet" disabled={busy} onClick={() => setDenying(true)}>Deny</Button>
        </div>
      )}
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
    </div>
  );
}

type Question = { question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> };

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
        {questions.map((q) => (
          <div key={q.question}>
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
              <input
                value={other[q.question] ?? ''}
                onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))}
                placeholder="Other…"
                className="block h-10 w-full rounded-xl border border-line bg-bg px-3 text-[16px] outline-none"
              />
            </div>
          </div>
        ))}
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

function PlanReview({ sessionId, request }: { sessionId: string; request: PermissionRequest }) {
  const { busy, error, decide } = useDecide(sessionId, request);
  const [feedback, setFeedback] = useState('');
  const [revising, setRevising] = useState(false);
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
            placeholder="What should change?"
            className="block w-full resize-none rounded-xl border border-line bg-bg px-3 py-2 text-[16px] outline-none"
          />
          <div className="flex gap-2">
            <Button kind="primary" disabled={busy || !feedback.trim()} onClick={() => decide({ behavior: 'deny', message: feedback })}>Send feedback</Button>
            <Button kind="quiet" onClick={() => setRevising(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button kind="primary" disabled={busy} onClick={() => decide({ behavior: 'allow', permissionMode: 'acceptEdits' })}>Approve · accept edits</Button>
          <Button disabled={busy} onClick={() => decide({ behavior: 'allow', permissionMode: 'default' })}>Approve · ask each step</Button>
          <Button kind="quiet" disabled={busy} onClick={() => setRevising(true)}>Keep planning</Button>
        </div>
      )}
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
    </div>
  );
}

export function PermissionCard({ sessionId, request, cwd }: { sessionId: string; request: PermissionRequest; cwd?: string }) {
  return (
    <div className="animate-fade mx-auto mb-2 max-w-3xl rounded-2xl border border-line bg-panel px-4 py-3 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
      {request.toolName === 'AskUserQuestion' ? (
        <Questions sessionId={sessionId} request={request} />
      ) : request.toolName === 'ExitPlanMode' ? (
        <PlanReview sessionId={sessionId} request={request} />
      ) : (
        <ToolApproval sessionId={sessionId} request={request} cwd={cwd} />
      )}
    </div>
  );
}
