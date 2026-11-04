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

/** Shown until this browser signs in: with the access token (the link Pelican printed) or the password. */
export function Login({ mode, onSignedIn }: { mode: AuthMode; onSignedIn: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const token = mode === 'token';

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
        <p className="mt-1 text-center text-[13.5px] leading-snug text-muted">
          {token
            ? <>Open the link Pelican printed when it started, or paste it here. <code className="font-mono text-[12.5px]">pelican token</code> prints it again.</>
            : <>Enter the password set with <code className="font-mono text-[12.5px]">pelican password</code>.</>}
        </p>
        <input
          type="password"
          autoFocus
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
