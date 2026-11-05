// A stand-in for the Anthropic Messages API on 127.0.0.1, for tests that run the Claude Code the
// Agent SDK bundles: it keeps every request it gets and answers each as the API would, streamed,
// with what the test says. Nothing reaches a real API.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type ContentBlock = { type: string; text?: string; content?: unknown; is_error?: boolean; tool_use_id?: string };
export type MessagesRequest = {
  model?: string;
  stream?: boolean;
  system?: Array<{ type: string; text?: string }> | string;
  tools?: Array<{ name: string }>;
  messages?: Array<{ role: string; content: string | ContentBlock[] }>;
};
/** What Claude says next: text, or a call to a tool. */
export type Reply = string | { tool: string; input: Record<string, unknown> };

export type StandIn = {
  /** Where Claude Code is to send its requests (ANTHROPIC_BASE_URL). */
  url: string;
  /** The Messages requests, oldest first. */
  requests: MessagesRequest[];
  close: () => Promise<void>;
};

export async function standInApi(reply: (request: MessagesRequest) => Reply = () => 'OK.'): Promise<StandIn> {
  const requests: MessagesRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method === 'POST' && url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (req.method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(url)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not in the stand-in' } }));
        return;
      }
      let body: MessagesRequest = {};
      try {
        body = JSON.parse(raw) as MessagesRequest;
      } catch {
        // Kept as an empty request.
      }
      requests.push(body);
      const answer = reply(body);
      const id = `msg_stand_in_${requests.length}`;
      const model = body.model ?? 'claude-opus-5-5';
      const usage = { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const block = typeof answer === 'string' ? { type: 'text', text: answer } : { type: 'tool_use', id: `toolu_stand_in_${requests.length}`, name: answer.tool, input: answer.input };
      const stop = typeof answer === 'string' ? 'end_turn' : 'tool_use';
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': id });
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': id });
      const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
      if (typeof answer === 'string') {
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } });
      } else {
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(answer.input) } });
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The text of a message, its blocks joined. */
export const textOf = (content: string | ContentBlock[] | undefined): string =>
  typeof content === 'string' ? content : (content ?? []).map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('\n');

/** Waits for `check` to hold, a tenth of a second at a time. */
export async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
