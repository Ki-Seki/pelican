import { Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { api, type AuthMode } from '../lib/api';

/** The token from what was pasted: the token itself, or the whole link Pelican printed. */
export function tokenFrom(text: string): string {
  const value = text.trim();
  try {
    return new URL(value).searchParams.get('token') ?? value;
  } catch {
    return value.replace(/^.*[?&]token=([^&#\s]+).*$/, '$1');
  }
}

/** Why the link or code that brought this browser here did not sign it in (the server says which). */
export function signInProblem(reason: string | null, mode: AuthMode): string | undefined {
  if (reason === 'code') return 'That code has expired or was used already. `pelican phone` shows a new one, and so does Settings on a signed-in device.';
  if (reason !== 'link') return undefined;
  return mode === 'password'
    ? 'A password is set, so links do not sign in. Enter the password.'
    : 'That link no longer works: the access token was reset. `pelican token` prints the current one.';
}

/** Takes the reason out of the address once read, so a reload does not show it again. */
function takeReason(): string | null {
  const url = new URL(location.href);
  const reason = url.searchParams.get('signin');
  if (reason !== null) {
    url.searchParams.delete('signin');
    history.replaceState(history.state, '', url);
  }
  return reason;
}

const Code = ({ children }: { children: string }) => <code className="font-mono text-[12.5px]">{children}</code>;

/** Inline `code` in a sentence, for the few lines here. */
const withCode = (text: string) => text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : part));

/** Shown until this browser signs in: with the access token (the link Pelican printed) or the password. */
export function Login({ mode, onSignedIn }: { mode: AuthMode; onSignedIn: () => void }) {
  const [value, setValue] = useState('');
  const [problem] = useState(() => signInProblem(takeReason(), mode));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const token = mode === 'token';
  // A phone has no terminal: it signs in by scanning the code the computer shows.
  const [phone] = useState(() => window.matchMedia('(pointer: coarse)').matches);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(undefined);
    api.login(token ? { token: tokenFrom(value) } : { password: value })
      .then(onSignedIn)
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };

  return (
    <div className="app-height flex items-center justify-center px-6">
      <form onSubmit={submit} className="w-full max-w-xs">
        <img src="./icon.svg" alt="" className="mx-auto size-12 rounded-2xl" />
        <h1 className="mt-4 text-center text-[20px] font-semibold tracking-tight">Pelican</h1>
        {problem && <p role="alert" className="mt-3 text-center text-[13.5px] leading-snug text-danger">{withCode(problem)}</p>}
        <p className="mt-1 text-center text-[13.5px] leading-snug text-muted">
          {!token
            ? <>Enter the password set with <Code>pelican password</Code>.</>
            : phone
              ? <>Scan the code <Code>pelican phone</Code> shows on your computer, or paste the link here.</>
              : <>Open the link Pelican printed when it started, or paste it here. <Code>pelican token</Code> prints it again.</>}
        </p>
        <input
          type="password"
          autoFocus={!phone || !token}
          autoComplete={token ? 'off' : 'current-password'}
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={token ? 'Link or access token' : 'Password'}
          aria-label={token ? 'Link or access token' : 'Password'}
          className="mt-6 block h-11 w-full rounded-xl border border-line bg-panel px-3.5 text-[16px] outline-none focus:border-fg"
        />
        {error && <div className="mt-2 text-[13px] text-danger">{error}</div>}
        <button type="submit" disabled={busy || !value.trim()} className="mt-3 flex h-11 w-full items-center justify-center rounded-xl bg-fg text-[15px] font-medium text-bg disabled:opacity-40">
          {busy ? <Loader2 className="size-4 animate-spin" /> : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
