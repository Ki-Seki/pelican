/**
 * Claude Code's errors (an API failure it noted in the conversation, or why a turn ended) in plain
 * words: what happened and what to do, without the API's JSON. Undefined for text that is not one
 * of these; it is then shown as it is.
 */
export function plainError(text: string, machine = 'your computer'): string | undefined {
  const t = text.trim();
  if (/prompt is too long/i.test(t)) {
    return 'The conversation is too long for the model. Send /compact to shorten it, or start a new session.';
  }
  if (/Not logged in|Please run \/login|Invalid API key|OAuth token (has )?expired|API Error: 401\b|authentication_failed/i.test(t)) {
    return `Claude Code is not signed in on ${machine}. Run claude in a terminal there and sign in with /login.`;
  }
  if (/Credit balance is too low/i.test(t)) return 'The API account’s credit balance is too low. Add credits in the Claude Console.';
  const limit = t.match(/^You['’]ve hit your (?:\w+ )?limit(?:\s*·\s*(resets [^\n]+))?/i);
  if (limit) return `You have reached your usage limit.${limit[1] ? ` It ${limit[1].trim().replace(/\.$/, '')}.` : ''}`;
  if (/\b529\b|overloaded/i.test(t)) return 'Anthropic’s API is overloaded. Try again in a moment.';
  if (/API Error: 5\d\d\b|"type":"api_error"|Internal server error/i.test(t)) return 'Anthropic’s API had a problem. Try again in a moment.';
  if (/API Error: (?:Request timed out|Connection error)|ECONNRESET|ETIMEDOUT|fetch failed/i.test(t)) {
    return `Claude Code could not reach Anthropic’s API from ${machine}. Check its connection, then try again.`;
  }
  return undefined;
}
