/**
 * `sessionExport` domain (L6) — bounded file source ownership.
 *
 * Opens one stable file handle, snapshots its current size, and exposes an
 * idempotent close operation shared by normal completion and failure cleanup.
 */

import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { resolve } from 'pathe';

export interface ZipSource {
  readonly stream: Readable;
  readonly size: number;
  readonly mtime: Date;
  readonly mode: number;
  readonly identity: ZipSourceIdentity;
  readonly sourcePath?: string;
  close(): Promise<void>;
}

export interface ZipSourceIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export async function openZipSource(source: string, signal?: AbortSignal): Promise<ZipSource> {
  const handle = await open(source, 'r');
  let stream: Readable | undefined;
  try {
    signal?.throwIfAborted();
    const file = await handle.stat({ bigint: true });
    if (!file.isFile()) throw new Error(`not a file: ${source}`);
    const size = Number(file.size);
    if (!Number.isSafeInteger(size)) throw new Error(`file is too large to export: ${source}`);
    signal?.throwIfAborted();
    stream =
      size === 0
        ? Readable.from([])
        : handle.createReadStream({
            autoClose: false,
            start: 0,
            end: size - 1,
            signal,
          });
    let closing: Promise<void> | undefined;
    return {
      stream,
      size,
      mtime: file.mtime,
      mode: Number(file.mode),
      identity: { device: file.dev, inode: file.ino },
      sourcePath: resolve(source),
      close: () => {
        closing ??= closeZipSource(stream!, handle);
        return closing;
      },
    };
  } catch (error) {
    stream?.destroy();
    await handle.close().catch(() => {});
    throw error;
  }
}

async function closeZipSource(stream: Readable, handle: FileHandle): Promise<void> {
  stream.destroy();
  await finished(stream, { cleanup: true }).catch(() => {});
  await handle.close();
}
