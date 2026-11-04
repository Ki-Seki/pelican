import { Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { api } from '../lib/api';

/** Shown when the server has a password set and this browser is not signed in. */
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(undefined);
    api.login(password)
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
        <p className="mt-1 text-center text-[13.5px] text-muted">Enter the password set with <code className="font-mono text-[12.5px]">pelican password</code>.</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          className="mt-6 block h-11 w-full rounded-xl border border-line bg-panel px-3.5 text-[16px] outline-none focus:border-fg"
        />
        {error && <div className="mt-2 text-[13px] text-danger">{error}</div>}
        <button type="submit" disabled={busy || !password} className="mt-3 flex h-11 w-full items-center justify-center rounded-xl bg-fg text-[15px] font-medium text-bg disabled:opacity-40">
          {busy ? <Loader2 className="size-4 animate-spin" /> : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
