import type { Attachment, ImageBlock, ScheduledCheck } from '../../shared/protocol';
import { api } from './api';
import { type Item, withFiles } from './turns';

/** What the conversation offers to do next where something failed or is still to come. */

type Prompt = Extract<Item, { kind: 'user' }>;

/**
 * The prompt whose turn ended on the error line at `at`, to send again: Claude carries on from
 * what it did of the turn. None when the turn answered a `!` command, or the conversation was
 * compacted since.
 */
export function promptBefore(items: Item[], at: number): Prompt | undefined {
  for (let i = at - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === 'user') return item.pending ? undefined : item;
    if (item.kind === 'shell' || item.kind === 'compact') return undefined;
  }
  return undefined;
}

const pictureSrc = (image: ImageBlock) => (image.source.type === 'base64' ? `data:${image.source.media_type};base64,${image.source.data}` : image.source.url);

/**
 * A prompt as it was sent, to send again: its words, the files it named, and its pictures, read
 * back from the conversation and uploaded anew (a prompt holds them, not their uploads).
 */
export async function resend(prompt: Prompt): Promise<{ text: string; attachments: Attachment[] }> {
  if (prompt.command) return { text: `${prompt.command.name} ${prompt.command.args}`.trim(), attachments: [] };
  const attachments = await Promise.all(prompt.images.filter((image) => !image.omitted).map(async (image, i) => {
    const blob = await fetch(pictureSrc(image)).then((response) => {
      if (!response.ok) throw new Error('A picture of that prompt is gone; send it again yourself.');
      return response.blob();
    });
    // As the server said it, else as the conversation holds it.
    const type = blob.type.startsWith('image/') ? blob.type : image.source.type === 'base64' ? image.source.media_type : 'image/png';
    return api.upload(new File([blob], `image-${i + 1}.${type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`, { type }));
  }));
  return { text: withFiles(prompt.text, prompt.files), attachments };
}

/**
 * What asks Claude to cancel a check it scheduled, in Claude Code's terms: a loop stops (no next
 * wake-up), a scheduled task is cancelled by its id (CronDelete). As in the CLI it is Claude's to
 * cancel, and it does so in the conversation, where it can be seen.
 */
export const cancelCheck = (check: ScheduledCheck): string => (check.id === 'wakeup'
  ? `Stop the loop (${check.what}).`
  : `Cancel the scheduled task ${check.id} (${check.what}).`);
