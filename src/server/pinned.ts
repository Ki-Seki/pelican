import { sessionSet } from './session-sets.js';

/**
 * Sessions kept at the top of the list. Pelican's own, in its state folder, as its archive is:
 * Claude Desktop keeps its pins for itself (it stores them as stars), and Pelican neither reads
 * nor writes them. A session is pinned or archived, never both (app.ts).
 */
const pins = sessionSet('pinned.json', 'no session is pinned');

/** The pinned session ids, for the list. */
export const pinnedIds = pins.ids;

/** Pins or unpins; writes go one at a time, each with the whole list as it is then. */
export const setPinned = pins.set;
