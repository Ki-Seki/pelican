import type { ScheduledCheck } from '../shared/protocol.js';
import { conversationUpTo, transcriptRow } from './history.js';
import { oneLine } from './push.js';

/**
 * The checks Claude schedules in a session, as Claude Code keeps them: /loop and reminders. They
 * live in the session's Claude Code process, which fires them while it runs and ends them when it
 * ends. A check made with CronCreate repeats until CronDelete cancels it or Claude Code lets it go,
 * a week after it was made, or fires once, at its time; a self-paced /loop has one wake-up at a
 * time (ScheduleWakeup), and none once it stops. When Claude Code resumes a session, it schedules
 * again the checks its conversation made with CronCreate that it would still keep; a self-paced
 * /loop's wake-up it does not, in an app built on the Agent SDK.
 */

/** A check that fires once stays counted this long after it was due, in case it fires late. */
export const DUE_GRACE_MS = 10 * 60_000;

/**
 * Claude Code lets a repeating check go this long after it was made (CronCreate: "auto-expired
 * after 7 days"). That is its default: a setting of Anthropic's can make it otherwise, which
 * Pelican cannot read.
 */
export const RECURRING_MAX_AGE_MS = 7 * 24 * 3600_000;

const str = (value: unknown) => (typeof value === 'string' ? value : '');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A check, with when Claude Code lets it go when it repeats. */
export type MadeCheck = { check: ScheduledCheck; ends?: number };

/**
 * The check a CronCreate call made, `madeAt`, from what Claude asked and what Claude Code said it
 * scheduled: named by when it fires and what it runs; none when Claude Code named no job.
 */
export function cronCheck(input: Record<string, unknown>, output: Record<string, unknown>, madeAt: number): MadeCheck | undefined {
  const id = str(output.id);
  if (!id) return undefined;
  const prompt = str(input.prompt);
  const repeats = output.recurring !== false;
  const check: ScheduledCheck = {
    id,
    what: oneLine(`${str(output.humanSchedule) || str(input.cron)}${prompt ? `: ${prompt}` : ''}`, 100),
    ...(typeof output.nextFireAt === 'number' ? { next: output.nextFireAt } : {}),
    repeats,
  };
  return repeats ? { check, ends: madeAt + RECURRING_MAX_AGE_MS } : { check };
}

/**
 * The checks Claude Code schedules again as it resumes a session, read from the conversation it
 * resumes (up to `entry`, a rewind's cut, else up to its newest message), as Claude Code reads it:
 * each check a CronCreate call made, but not one a CronDelete call named, one that repeats and was
 * made a week ago or more, nor one that fires once and whose time has come. One kept in the folder
 * (durable) Claude Code runs from there instead, in the session's own process all the same. A
 * repeating one shows no time: Claude Code works out its next one afresh.
 */
export async function resumedChecks(file: string, entry?: string, now = Date.now()): Promise<MadeCheck[]> {
  const messages = await conversationUpTo(file, entry);
  const calls = new Map<string, { input: Record<string, unknown>; at: number }>();
  const deleted = new Set<string>();
  const answers: Array<{ call: string; row: string }> = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && message.role === 'assistant') {
        if (block.name === 'CronCreate') calls.set(block.id, { input: block.input, at: message.timestamp ?? now });
        else if (block.name === 'CronDelete' && typeof block.input.id === 'string') deleted.add(block.input.id);
      } else if (block.type === 'tool_result' && message.role === 'user' && block.is_error !== true && calls.has(block.tool_use_id)) {
        answers.push({ call: block.tool_use_id, row: message.uuid });
      }
    }
  }
  const kept: MadeCheck[] = [];
  for (const { call, row } of answers) {
    // What Claude Code scheduled is in what it recorded of the result, next to it in the row.
    const output = (await transcriptRow(file, row))?.toolUseResult;
    const { input, at } = calls.get(call)!;
    if (!isRecord(output) || typeof input.cron !== 'string' || typeof input.prompt !== 'string') continue;
    const made = cronCheck(input, output, at);
    if (!made || deleted.has(made.check.id)) continue;
    if (made.ends !== undefined) {
      if (made.ends <= now) continue;
      const { next: _again, ...check } = made.check;
      kept.push({ check, ends: made.ends });
    } else if (made.check.next !== undefined && made.check.next >= now) {
      kept.push(made);
    }
  }
  return kept;
}
