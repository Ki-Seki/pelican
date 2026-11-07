import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import type { McpServer } from '../../shared/protocol';
import { api } from '../lib/api';
import { shellQuote } from '../lib/format';
import { Sheet } from './Sheet';

const MCP_DOT: Record<McpServer['status'], string> = { connected: 'bg-live', pending: 'bg-wait', 'needs-auth': 'bg-wait', failed: 'bg-danger', disabled: 'bg-line' };
const MCP_LABEL: Record<McpServer['status'], string> = { connected: 'Connected', pending: 'Connecting', 'needs-auth': 'Needs sign-in', failed: 'Failed', disabled: 'Off' };

/** The session's MCP servers, as the + menu counts them: "1 of 2 on". */
export const useMcpServers = (sessionId: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: ['mcp', sessionId], queryFn: () => api.mcp(sessionId!), enabled: enabled && Boolean(sessionId), staleTime: 15_000 });

/** How many of a session's servers are on (connected), of all it has: none when it has none. */
export function mcpCount(servers: readonly McpServer[] | undefined): string | undefined {
  if (!servers || servers.length === 0) return undefined;
  return `${servers.filter((server) => server.status === 'connected').length} of ${servers.length} on`;
}

/**
 * Where a server that needs signing in is signed in to. A session Pelican runs has no /mcp panel to
 * do it in, so, as Claude Code's docs say, it is done in a terminal on the computer, or for a
 * claude.ai connector in claude.ai; then Reconnect picks it up, or the next start of Claude here.
 */
function SignInHint({ server, machine, live }: { server: McpServer; machine?: string; live: boolean }) {
  const then = live ? ', then Reconnect' : '';
  if (server.scope === 'claudeai') {
    return <>Connect it at <a href="https://claude.ai/customize/connectors" target="_blank" rel="noreferrer" className="underline decoration-faint underline-offset-2 hover:text-fg">claude.ai/customize/connectors</a>{then}.</>;
  }
  return <>Sign in with <span className="font-mono text-muted">claude mcp login {shellQuote(server.name)}</span> in a terminal on {machine || 'the computer'}{then}.</>;
}

/**
 * The session's MCP servers and whether they work; while Claude runs here, each can be turned off
 * or reconnected. Opened where tools are added: the message box's +, and /mcp.
 */
export function McpSheet({ open, onClose, sessionId, machine }: { open: boolean; onClose: () => void; sessionId: string; machine?: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useMcpServers(sessionId, open);
  // Servers can be turned on and off only in a Claude process running here.
  const live = Boolean(data?.live);
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const change = (name: string, patch: { enabled?: boolean; reconnect?: boolean }) => {
    setBusy(name);
    setProblem(undefined);
    api.setMcp(sessionId, name, patch)
      .then((result) => queryClient.setQueryData(['mcp', sessionId], { servers: result.servers, live: true }))
      .catch((err: Error) => setProblem(err.message))
      .finally(() => setBusy(undefined));
  };
  const [showAll, setShowAll] = useState(false);
  const servers = data?.servers ?? [];
  const order: McpServer['status'][] = ['failed', 'connected', 'pending', 'disabled', 'needs-auth'];
  const sorted = [...servers].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name));
  const signIn = sorted.filter((server) => server.status === 'needs-auth');
  const shown = showAll ? sorted : sorted.filter((server) => server.status !== 'needs-auth');
  const count = mcpCount(servers);
  return (
    <Sheet open={open} onClose={onClose} title={count ? `MCP servers · ${count}` : 'MCP servers'} done>
      {isLoading && <div className="flex justify-center px-3 py-4 text-faint"><Loader2 className="size-4 animate-spin" /></div>}
      {error && <p className="px-3 py-2 text-[13px] text-danger">{(error as Error).message}</p>}
      {data && servers.length === 0 && <p className="px-3 py-3 text-[13.5px] text-muted">This session has no MCP servers. Add one with <span className="font-mono text-[12.5px]">claude mcp add</span> in a terminal on {machine || 'the computer'}.</p>}
      {problem && <p className="px-3 pb-1 text-[13px] text-danger">{problem}</p>}
      {shown.map((server) => (
        <div key={server.name} className="flex items-center gap-3 rounded-xl px-3 py-2">
          <span className={`size-2 shrink-0 rounded-full ${MCP_DOT[server.status]}`} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px]">{server.name}</div>
            <div className="truncate text-[12px] text-muted">
              {MCP_LABEL[server.status]}{server.tools > 0 ? ` · ${server.tools} tools` : ''}{server.scope ? ` · ${server.scope}` : ''}{server.error ? ` · ${server.error}` : ''}
            </div>
            {server.status === 'needs-auth' && <div className="mt-0.5 text-[12px] leading-snug break-words text-faint"><SignInHint server={server} live={live} {...(machine ? { machine } : {})} /></div>}
          </div>
          {busy === server.name ? <Loader2 className="size-4 animate-spin text-faint" /> : live && (
            server.status === 'failed' || server.status === 'needs-auth' ? (
              <button type="button" className="h-10 shrink-0 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg pointer-fine:h-8" onClick={() => change(server.name, { reconnect: true })}>Reconnect</button>
            ) : (
              <button type="button" className="h-10 shrink-0 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg pointer-fine:h-8" onClick={() => change(server.name, { enabled: server.status === 'disabled' })}>
                {server.status === 'disabled' ? 'Turn on' : 'Turn off'}
              </button>
            )
          )}
        </div>
      ))}
      {!showAll && signIn.length > 0 && (
        <button type="button" onClick={() => setShowAll(true)} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] text-muted hover:bg-hover pointer-fine:min-h-9">
          <span className="size-2 shrink-0 rounded-full bg-wait" />
          {signIn.length} more need signing in
        </button>
      )}
      {data && !data.live && data.servers.length > 0 && <p className="px-3 pt-0.5 pb-1 text-[12px] leading-snug text-faint">They can be turned on or off once Claude runs here.</p>}
    </Sheet>
  );
}
