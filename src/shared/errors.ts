/**
 * Claude Code's errors (an API failure it noted in the conversation, or why a turn ended) in plain
 * words: what happened and what to do, without the API's JSON.
 */

type Kind = 'signed-out' | 'too-long' | 'credit' | 'limit' | 'overloaded' | 'api' | 'offline' | 'too-long-reply';

/** Claude Code's own codes for a failed API call (the SDK's SDKAssistantMessageError), where its words say no more. */
const CODES: Record<string, Kind> = {
  authentication_failed: 'signed-out',
  billing_error: 'credit',
  rate_limit: 'limit',
  overloaded: 'overloaded',
  server_error: 'api',
  max_output_tokens: 'too-long-reply',
};

/** What went wrong: from the words first, which say more (when a limit resets), else from the code. */
function kindOf(text: string, code?: string): Kind | undefined {
  const t = text.trim();
  if (/prompt is too long/i.test(t)) return 'too-long';
  if (/Not logged in|Please run \/login|Invalid API key|OAuth token (has )?expired|API Error: 401\b|authentication_failed/i.test(t)) return 'signed-out';
  if (/Credit balance is too low/i.test(t)) return 'credit';
  if (/^You['’]ve hit your (?:\w+ )?limit/i.test(t)) return 'limit';
  if (/\b529\b|overloaded/i.test(t)) return 'overloaded';
  if (/API Error: 5\d\d\b|"type":"api_error"|Internal server error/i.test(t)) return 'api';
  if (/API Error: (?:Request timed out|Connection error)|ECONNRESET|ETIMEDOUT|fetch failed/i.test(t)) return 'offline';
  if (/exceeded the \d+ output token maximum/i.test(t)) return 'too-long-reply';
  return code ? CODES[code] : undefined;
}

/**
 * The error in plain words, for the place it shows now (the turn that just failed, a
 * notification). Undefined for text that is not one of these; it is then shown as it is.
 * `code`: Claude Code's code for it, when it gave one.
 */
export function plainError(text: string, machine = 'your computer', code?: string): string | undefined {
  switch (kindOf(text, code)) {
    case 'too-long':
      return 'The conversation is too long for the model. Send /compact to shorten it, or start a new session.';
    case 'signed-out':
      return `Claude Code is not signed in on ${machine}. Run claude in a terminal there and sign in with /login.`;
    case 'credit':
      return 'The API account’s credit balance is too low. Add credits in the Claude Console.';
    case 'limit': {
      const resets = text.trim().match(/^You['’]ve hit your (?:\w+ )?limit\s*·\s*(resets [^\n]+)/i)?.[1];
      return `You have reached your usage limit.${resets ? ` It ${resets.trim().replace(/\.$/, '')}.` : ''}`;
    }
    case 'overloaded':
      return 'Anthropic’s API is overloaded. Try again in a moment.';
    case 'api':
      return 'Anthropic’s API had a problem. Try again in a moment.';
    case 'offline':
      return `Claude Code could not reach Anthropic’s API from ${machine}. Check its connection, then try again.`;
    default:
      return undefined;
  }
}

/**
 * The error as a line in the conversation, which stays there: what happened then, and for a
 * Claude Code that was signed out, what to do on the computer it runs on (it may be signed in by
 * the time the line is read).
 */
export function errorLine(text: string, machine = 'your computer', code?: string): string | undefined {
  if (kindOf(text, code) === 'signed-out') {
    return `Claude Code was not signed in on ${machine}, so Claude did not answer. Run claude in a terminal there and sign in with /login.`;
  }
  return plainError(text, machine, code);
}

const STOPPED: Record<Kind, string> = {
  'signed-out': 'not signed in',
  'too-long': 'conversation too long',
  credit: 'credit balance too low',
  limit: 'usage limit reached',
  overloaded: 'API overloaded',
  api: 'API error',
  offline: 'API out of reach',
  'too-long-reply': 'reply too long',
};

/**
 * What can be done about the error from here: shorten the conversation (/compact) when it is too
 * long for the model, else send the prompt again once the cause is gone.
 */
export const nextStep = (text: string, code?: string): 'compact' | 'retry' => (kindOf(text, code) === 'too-long' ? 'compact' : 'retry');

/** Why a turn ended on an error, in a few words for the session list ("not signed in"). */
export function stoppedBecause(text: string, code?: string): string {
  const kind = kindOf(text, code);
  return kind ? STOPPED[kind] : 'API error';
}
