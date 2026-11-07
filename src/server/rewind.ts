import type { RewindFilesResult } from '@anthropic-ai/claude-agent-sdk';

import type { Attachment, RewindCheck, RewindDone, RewindRestore } from '../shared/protocol.js';
import { FIRST_MESSAGE, NOT_HERE, NOTHING_TO_UNDO, REWIND_BUSY } from '../shared/rewind.js';
import { splitFiles } from '../web/lib/turns.js';
import { findUpload, removeUpload, saveUpload } from './files.js';
import { type PromptPlace, promptPlace } from './history.js';
import { liveProcesses } from './live.js';
import { cutOf, endCut, keepCut, liveCut } from './rewound.js';
import { changing, ensureRun, getRun, oneAtATime, restartAt, type SessionRun } from './runner.js';
import { shownMessages } from './sessions.js';
import { isSideChat } from './side-chat.js';
import { rawEntry, rawImages, transcriptPath } from './transcripts.js';

/** A rewind that cannot be done, and the status to answer with. */
export class RewindRefusal extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}

const SIDE_CHAT = 'A side chat changes nothing; rewind the session itself.';
const CHANGED = 'Can’t rewind to this message: the conversation has more after it than its own turn (another app or a background task added to it), so nothing was rewound.';

/** Claude Desktop's words for code that would not go back, with Claude Code's reason when it gives one. */
const notRestored = (reason?: string) => `Couldn’t restore the code from this point.${reason?.trim() ? ` ${reason.trim()}` : ' Try again.'}`;

/** The session, and the prompt in the conversation as it reads now (up to any cut): or why not. */
async function located(sessionId: string, prompt: string): Promise<{ file: string; place: PromptPlace }> {
  if (await isSideChat(sessionId)) throw new RewindRefusal(SIDE_CHAT, 409);
  if (getRun(sessionId)?.busy) throw new RewindRefusal(REWIND_BUSY, 409);
  const file = await transcriptPath(sessionId);
  if (!file) throw new RewindRefusal('No such session', 404);
  const [place, { messages }] = await Promise.all([promptPlace(file, prompt), shownMessages(sessionId)]);
  if (!place || !messages.some((m) => m.uuid === prompt)) throw new RewindRefusal(NOT_HERE, 404);
  return { file, place };
}

/**
 * Why the conversation cannot go back to before the prompt here, if it cannot: then only its code
 * can. Another app holding the session keeps the conversation as it is, as Claude Desktop does.
 */
async function conversationStays(sessionId: string, place: PromptPlace): Promise<string | undefined> {
  if (!place.before) return FIRST_MESSAGE;
  if (place.compacted) return 'The conversation was compacted after this message, so it can no longer go back to before it.';
  const other = (await liveProcesses()).get(sessionId);
  if (other) return `The session is open in ${other.app ?? 'another app'} too, so only its code can go back here.`;
  // Starting Claude again would end them.
  if (getRun(sessionId)?.hasBackgroundTasks) return 'Claude has work running in the background here, which starting it again would stop. Stop it first.';
  return undefined;
}

const codeOf = (result: RewindFilesResult): Pick<RewindDone, 'files' | 'insertions' | 'deletions'> => ({
  files: result.filesChanged ?? [],
  insertions: result.insertions ?? 0,
  deletions: result.deletions ?? 0,
});

/**
 * Puts the files back as they were before the prompt, from Claude Code's copies. What went back is
 * what its dry run says just before, as Claude Code's own rewind reports no more than whether it
 * did, and what it skipped.
 */
async function restoreCode(run: SessionRun, prompt: string): Promise<RewindDone> {
  const check = await run.rewindFiles(prompt, true);
  if (!check.canRewind) throw new RewindRefusal(notRestored(check.error), 409);
  // Its dry run may say yes where the copy is gone since (Claude Code clears old ones): then it throws.
  const result = await run.rewindFiles(prompt, false).catch((error: Error) => {
    throw new RewindRefusal(notRestored(error.message), 409);
  });
  if (!result.canRewind) throw new RewindRefusal(notRestored(result.error), 409);
  return { ...codeOf(check), ...(result.skippedLinks ? { skipped: result.skippedLinks } : {}) };
}

/**
 * A rewind, its check, or Undo rewind, once nothing else changes the session's Claude (runner.ts,
 * oneAtATime): while a message is on its way or another rewind is under way, Desktop's words, as
 * while Claude works.
 */
function alone<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  if (changing(sessionId)) return Promise.reject(new RewindRefusal(REWIND_BUSY, 409));
  return oneAtATime(sessionId, work);
}

/** What Rewind to here can put back for this prompt: the files, by Claude Code's dry run, and whether the conversation can go back too. */
export function checkRewind(sessionId: string, prompt: string): Promise<RewindCheck> {
  return alone(sessionId, async () => {
    const { place } = await located(sessionId, prompt);
    const stays = await conversationStays(sessionId, place);
    const run = await ensureRun(sessionId);
    if (run.busy) throw new RewindRefusal(REWIND_BUSY, 409);
    const result = await run.rewindFiles(prompt, true);
    // No copy kept of the files before it (another app wrote the turn without checkpoints): only the conversation.
    const code = result.canRewind ? codeOf(result) : { files: [], insertions: 0, deletions: 0 };
    return { files: code.files ?? [], insertions: code.insertions ?? 0, deletions: code.deletions ?? 0, ...(stays ? { conversationStays: stays } : {}) };
  });
}

/** A prompt as it goes back to the message box; `saved`, the uploads made for it (its pictures, saved again). */
type Back = { text: string; attachments: Attachment[]; saved: Attachment[] };

/**
 * A prompt's words and files as it was sent, for the message box: its pictures saved as uploads
 * again, and the files it attached that are uploads here still.
 */
export async function promptBack(file: string, uuid: string): Promise<Back> {
  const content = (await rawEntry(file, uuid))?.content;
  const typed = typeof content === 'string'
    ? content
    : Array.isArray(content) ? (content as Array<{ type?: unknown; text?: unknown }>).flatMap((b) => (b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n\n') : '';
  const { text, files } = splitFiles(typed);
  const saved: Attachment[] = [];
  for (const [i, image] of (await rawImages(file, uuid)).entries()) {
    if (image.type !== 'base64') continue;
    const ext = image.mediaType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    saved.push(await saveUpload(new File([Buffer.from(image.data, 'base64')], `image-${i + 1}.${ext}`, { type: image.mediaType })));
  }
  const kept: Attachment[] = [];
  for (const sent of files) {
    const upload = sent.id ? await findUpload(sent.id) : undefined;
    if (upload) kept.push(upload);
  }
  return { text, attachments: [...saved, ...kept], saved };
}

/** The pictures saved again for a prompt that does not go back to the box after all. */
const discard = (back: Back) => Promise.all(back.saved.map((a) => removeUpload(a.id).catch(() => undefined)));

/**
 * Rewind to here, as Claude Code's /rewind and Claude Desktop's do it: back to before one of your
 * prompts, with its three choices (Desktop's words; the CLI says Restore code and conversation,
 * Restore conversation, Restore code).
 *
 * - The code goes back from Claude Code's own copies of the files (file checkpointing,
 *   rewindFiles): what Claude changed after the prompt is undone; changes made through shell
 *   commands are not, and commits stay.
 * - The conversation goes back by starting the session's Claude again from the entry just before
 *   the prompt (resumeSessionAt), the prompt's words and files going back to the message box, as in
 *   Claude Code. Claude Code writes nothing of it until the next message, so the transcript stays
 *   whole and Undo rewind resumes it whole again until then (rewound.ts keeps the cut). Dropping
 *   one turn, Claude Code checks that nothing else would go with it (resumeDropsTurn); when it
 *   refuses, the session's Claude is resumed as the conversation read before, as the Agent SDK
 *   asks, and nothing is rewound.
 * - Both: the conversation first, then the code; should the code not go back, the conversation is
 *   as it was again (whole, or at an earlier rewind's cut), so a rewind is all or nothing.
 *
 * One at a time with what else changes the session's Claude: a message sent meanwhile from another
 * page goes to the Claude the rewind leaves, once it is done.
 */
export function rewindTo(sessionId: string, prompt: string, choice: RewindRestore): Promise<RewindDone> {
  return alone(sessionId, () => rewind(sessionId, prompt, choice));
}

async function rewind(sessionId: string, prompt: string, choice: RewindRestore): Promise<RewindDone> {
  const { file, place } = await located(sessionId, prompt);
  if (choice === 'code') {
    const run = await ensureRun(sessionId);
    if (run.busy) throw new RewindRefusal(REWIND_BUSY, 409);
    return restoreCode(run, prompt);
  }
  const stays = await conversationStays(sessionId, place);
  if (stays) throw new RewindRefusal(stays, 409);
  // The conversation as it reads now, which a rewind that does not happen leaves as it is: up to an
  // earlier rewind's cut, or whole.
  const earlier = await liveCut(sessionId);
  const now = earlier ? { entry: earlier.entry } : undefined;
  // Read before anything changes: what goes back in the box.
  const back = await promptBack(file, prompt);
  // Only the prompt's own turn goes: Claude Code checks that, so nothing it did not show goes too.
  const at = { entry: place.before!, ...(place.later === 0 ? { dropsTurn: prompt } : {}) };
  let run;
  try {
    run = await restartAt(sessionId, at, now);
  } catch (error) {
    await discard(back);
    throw error;
  }
  if (!run) {
    await discard(back);
    throw new RewindRefusal(CHANGED, 409);
  }
  let code: RewindDone = {};
  if (choice === 'both') {
    try {
      code = await restoreCode(run, prompt);
    } catch (error) {
      // Nothing is rewound: the session's Claude has the conversation as it read before again.
      await restartAt(sessionId, now).catch(() => undefined);
      await discard(back);
      throw error instanceof RewindRefusal ? error : new RewindRefusal(notRestored((error as Error).message), 409);
    }
  }
  await keepCut(sessionId, { prompt, entry: at.entry, end: place.end, at: Date.now() });
  return { ...code, prompt: { text: back.text, attachments: back.attachments } };
}

/**
 * Undo rewind: the messages the rewind took out come back, the session's Claude resumed whole (the
 * files stay as they are), until the next message, as in Claude Desktop.
 */
export function undoRewind(sessionId: string): Promise<void> {
  return alone(sessionId, async () => {
    const cut = await cutOf(sessionId);
    if (!cut || cut.spent) throw new RewindRefusal(NOTHING_TO_UNDO, 409);
    const run = getRun(sessionId);
    if (run?.busy) throw new RewindRefusal(REWIND_BUSY, 409);
    // A Claude resumed at the cut would carry the next message on from there: it starts again, whole,
    // before the pages are told, so nothing sent meanwhile goes after the cut.
    if (run) await restartAt(sessionId);
    await endCut(sessionId);
  });
}
