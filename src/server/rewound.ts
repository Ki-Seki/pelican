import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ChatMessage, Rewound } from '../shared/protocol.js';
import { config } from './config.js';
import { conversationEnd } from './history.js';
import { transcriptPath } from './transcripts.js';

/**
 * Where a session's conversation was rewound (Rewind to here), until its next message.
 *
 * Claude Code resumes the session at the last entry kept (the Agent SDK's resumeSessionAt) and
 * writes nothing of that until a message goes: the transcript stays whole, and Undo rewind only
 * has to resume it whole again. So the cut is Pelican's own record, in its state folder, as its
 * pins are: pages show the conversation up to it, and every Claude Pelican starts for the session
 * resumes there. It ends with the next message, once the transcript holds it, and as soon as the
 * conversation goes on in another app: what another app adds is never hidden.
 */
export type Cut = {
  /** The prompt the conversation went back to before: it and all after it are out of the conversation. */
  prompt: string;
  /** The last entry kept, where Claude Code resumes. */
  entry: string;
  /** The conversation's newest message when it was rewound: a newer one means it went on since. */
  end: string;
  /** When it was rewound, ms since epoch. */
  at: number;
  /** A message has gone since: Undo rewind is over, and the cut ends once the transcript holds that message. */
  spent?: true;
};

type Listener = (sessionId: string, rewound: Rewound | null) => void;
const listeners = new Set<Listener>();

/** Told whenever what pages show of a session's cut changes: a rewind, Undo, the next message, its end. */
export function whenCutChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What pages see of a cut: where it is and when it was made, until a message has gone. */
export const shownCut = (cut: Cut | undefined): Rewound | undefined => (cut && !cut.spent ? { prompt: cut.prompt, at: cut.at } : undefined);

const NAME = 'rewound.json';
const fileNow = () => path.join(config.stateDir, NAME);
let loaded: { file: string; cuts: Promise<Map<string, Cut>> } | undefined;
let writing: Promise<void> = Promise.resolve();

const text = (value: unknown) => (typeof value === 'string' && value.length > 0 && value.length < 200 ? value : undefined);

function cutFrom(value: unknown): Cut | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const prompt = text(raw.prompt);
  const entry = text(raw.entry);
  const end = text(raw.end);
  if (!prompt || !entry || !end || typeof raw.at !== 'number') return undefined;
  return { prompt, entry, end, at: raw.at, ...(raw.spent === true ? { spent: true as const } : {}) };
}

async function load(file: string): Promise<Map<string, Cut>> {
  let body: string;
  try {
    body = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  try {
    const cuts = (JSON.parse(body) as { cuts?: unknown }).cuts;
    const map = new Map<string, Cut>();
    for (const [id, value] of Object.entries(cuts && typeof cuts === 'object' ? cuts : {})) {
      const cut = cutFrom(value);
      if (cut) map.set(id, cut);
    }
    return map;
  } catch {
    // Not ours to throw away: kept beside; no conversation stays rewound.
    await rename(file, `${file}.bad-${Date.now()}`).catch(() => undefined);
    console.warn(`[pelican] ${NAME} could not be read; it was set aside and no conversation stays rewound`);
    return new Map();
  }
}

/** The cuts, read once for the state folder there is now (the demo moves to one of its own). */
function current(): { file: string; cuts: Promise<Map<string, Cut>> } {
  const file = fileNow();
  if (loaded?.file !== file) {
    const cuts = load(file).catch((error: Error) => {
      if (loaded?.cuts === cuts) loaded = undefined;
      throw error;
    });
    loaded = { file, cuts };
  }
  return loaded;
}

/** Writes all the cuts as they are now; writes go one at a time. */
function save(file: string, cuts: Map<string, Cut>): Promise<void> {
  const body = `${JSON.stringify({ cuts: Object.fromEntries(cuts) }, null, 2)}\n`;
  const write = writing.then(async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, body, { mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  writing = write.catch(() => undefined);
  return write;
}

/** Changes one session's cut, writes them all, and tells the pages what they now show. */
async function change(sessionId: string, next: Cut | undefined): Promise<void> {
  const { file, cuts: loading } = current();
  const cuts = await loading;
  const before = cuts.get(sessionId);
  if (next) cuts.set(sessionId, next);
  else if (!before) return;
  else cuts.delete(sessionId);
  try {
    await save(file, cuts);
  } catch (error) {
    if (before) cuts.set(sessionId, before);
    else cuts.delete(sessionId);
    throw error;
  }
  const shown = shownCut(next) ?? null;
  if (JSON.stringify(shown) === JSON.stringify(shownCut(before) ?? null)) return;
  for (const listener of listeners) listener(sessionId, shown);
}

/** The session's cut as recorded, whether or not the conversation has gone on since. */
export async function cutOf(sessionId: string): Promise<Cut | undefined> {
  if (config.demo) return undefined;
  return (await current().cuts).get(sessionId);
}

/** Records where the conversation was rewound. */
export const keepCut = (sessionId: string, cut: Cut): Promise<void> => change(sessionId, cut);

/** Forgets the cut: Undo rewind, or the conversation went on. */
export const endCut = (sessionId: string): Promise<void> => change(sessionId, undefined);

/** A message went to the Claude resumed at the cut: Undo rewind is over. */
export async function spendCut(sessionId: string): Promise<void> {
  const cut = await cutOf(sessionId);
  if (cut && !cut.spent) await change(sessionId, { ...cut, spent: true });
}

/**
 * The session's cut while the conversation is still as it was rewound: the transcript ends where
 * it ended then. Once it ends elsewhere (the next message is in it, or another app went on with
 * the conversation as the transcript has it) the cut is over and is forgotten.
 */
export async function liveCut(sessionId: string): Promise<Cut | undefined> {
  const cut = await cutOf(sessionId);
  if (!cut) return undefined;
  const file = await transcriptPath(sessionId);
  const end = file ? await conversationEnd(file) : undefined;
  if (end === cut.end) return cut;
  await endCut(sessionId);
  return undefined;
}

/** The conversation as it reads with a cut: the messages before its prompt. */
export function beforeCut(messages: ChatMessage[], cut: Cut | undefined): ChatMessage[] {
  if (!cut) return messages;
  const at = messages.findIndex((m) => m.uuid === cut.prompt || m.sourceUuid === cut.prompt);
  return at < 0 ? messages : messages.slice(0, at);
}

/** For tests: as a Pelican just started reads it. */
export function forgetCuts(): void {
  loaded = undefined;
}
