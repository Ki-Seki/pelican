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
