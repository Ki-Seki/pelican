// Rewind to here's words that the server and the demo both say (server/rewind.ts, web/lib/demo.ts).

/** Rewinding restarts Claude, which would stop it mid-turn: in Claude Desktop's words. */
export const REWIND_BUSY = 'Rewind is unavailable while Claude is working.';

/** Nothing comes before a conversation's first message for its Claude to start again from. */
export const FIRST_MESSAGE = 'It is the conversation’s first message: Fork from here starts it again in a new session.';

/** A message the conversation, as it reads now, does not hold. */
export const NOT_HERE = 'That message is not in this conversation.';

/** Undo rewind after the next message: in Claude Desktop's words. */
export const NOTHING_TO_UNDO = 'Undo rewind works until you send your next message.';
