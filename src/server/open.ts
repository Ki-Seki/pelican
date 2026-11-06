import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';

/**
 * Opens a regular file to read. A named pipe or a device in its place is refused without waiting:
 * opening a pipe blocks one of Node's few file threads until something writes to it, and a few
 * such opens would stall every file read of the server.
 */
export async function openRegular(file: string): Promise<FileHandle> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Not a regular file');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** How much of a file is read at a time for a response. */
const CHUNK = 64 * 1024;

/**
 * `length` bytes of an open file from `start`, as a response body: exactly those, however the file
 * changes meanwhile. A file that grows sends no more than the response said it would; one cut short
 * breaks the response off, so it never ends as if whole with fewer bytes than it said. The file is
 * closed once read, on an error, and when the reader goes away.
 */
export function exactBytes(handle: FileHandle, start: number, length: number): ReadableStream<Uint8Array> {
  let at = start;
  let left = length;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void handle.close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (left > 0) return;
      close();
      controller.close();
    },
    async pull(controller) {
      try {
        const chunk = new Uint8Array(Math.min(left, CHUNK));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, at);
        if (bytesRead === 0) throw new Error('The file got shorter while it was sent');
        at += bytesRead;
        left -= bytesRead;
        controller.enqueue(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
        if (left > 0) return;
        close();
        controller.close();
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel: close,
  });
}
