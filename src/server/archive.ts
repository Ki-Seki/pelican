import { sessionSet } from './session-sets.js';

/**
 * Sessions put away from the list. Only Pelican keeps this, in its state folder: the transcripts
 * are not touched, so every Claude Code app still has the session, and unarchiving is instant.
 */
const archive = sessionSet('archived.json', 'the archive starts empty');

/** The archived session ids, for the list. */
export const archivedIds = archive.ids;

/** Archives or unarchives; writes go one at a time, each with the whole list as it is then. */
export const setArchived = archive.set;
