/**
 * `hostFs` domain (L1) — `IHostFileSystem` implementation.
 *
 * Reads and writes files on the real local disk through `node:fs/promises`.
 * Bound at App scope.
 */

import { appendFile, lstat, open, readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { decodeTextWithErrors, type TextDecodeErrors } from '#/_base/execEnv/decodeText';

import { type HostDirEntry, type HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';

const READ_CHUNK_SIZE = 64 * 1024;

function isUtf8Encoding(encoding: BufferEncoding): boolean {
  return encoding === 'utf-8' || encoding === 'utf8';
}

function* splitLinesKeepingTerminator(text: string): Generator<string> {
  if (text.length === 0) return;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.codePointAt(i) === 0x0a) {
      yield text.slice(start, i + 1);
      start = i + 1;
    }
  }
  if (start < text.length) {
    yield text.slice(start);
  }
}

export class HostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string> {
    if (options === undefined) {
      return readFile(path, 'utf8');
    }
    const encoding = options.encoding ?? 'utf-8';
    const errors = options.errors ?? 'strict';
    return decodeTextWithErrors(await readFile(path), encoding, errors);
  }

  async writeText(path: string, data: string): Promise<void> {
    await writeFile(path, data, 'utf8');
  }

  async appendText(path: string, data: string): Promise<void> {
    await appendFile(path, data, 'utf8');
  }

  async readBytes(path: string, n?: number): Promise<Uint8Array> {
    if (n === undefined) {
      const buf = await readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    await writeFile(path, data);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string> {
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';

    if (!isUtf8Encoding(encoding)) {
      const content = decodeTextWithErrors(await readFile(path), encoding, errors);
      yield* splitLinesKeepingTerminator(content);
      return;
    }

    yield* this._readUtf8Lines(path, errors);
  }

  private async *_readUtf8Lines(
    path: string,
    errors: TextDecodeErrors,
  ): AsyncGenerator<string> {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(READ_CHUNK_SIZE);
      let pending: Buffer[] = [];
      let pendingOffset = 0;
      let fileOffset = 0;

      while (true) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        let lineStart = 0;

        for (let i = 0; i < chunk.length; i += 1) {
          const byte = chunk[i];
          if (byte !== 0x0a) continue;
          const piece = chunk.subarray(lineStart, i + 1);
          const lineOffset = pending.length === 0 ? fileOffset + lineStart : pendingOffset;
          const line = pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
          yield decodeTextWithErrors(line, 'utf-8', errors, lineOffset !== 0);
          pending = [];
          lineStart = i + 1;
        }

        if (lineStart < chunk.length) {
          const tail = Buffer.from(chunk.subarray(lineStart));
          if (pending.length === 0) pendingOffset = fileOffset + lineStart;
          pending.push(tail);
        }
        fileOffset += bytesRead;
      }

      if (pending.length > 0) {
        const line = Buffer.concat(pending);
        yield decodeTextWithErrors(line, 'utf-8', errors, pendingOffset !== 0);
      }
    } finally {
      await fh.close();
    }
  }

  async createExclusive(path: string, data: Uint8Array): Promise<boolean> {
    try {
      const fh = await open(path, 'wx');
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  async stat(path: string): Promise<HostFileStat> {
    // Non-following `lstat` so a symbolic link is reported as itself
    // (`isSymbolicLink: true`) rather than transparently resolved to its
    // target. Callers that confine paths lexically rely on this to avoid
    // escaping the workspace through a symlinked directory.
    const s = await lstat(path);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      size: s.size,
      mtimeMs: s.mtimeMs,
      ino: s.ino,
    };
  }

  async readdir(path: string): Promise<readonly HostDirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((d) => ({
      name: d.name,
      isFile: d.isFile(),
      isDirectory: d.isDirectory(),
      isSymbolicLink: d.isSymbolicLink(),
    }));
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    await mkdir(path, { recursive: options?.recursive ?? false });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostFileSystem,
  HostFileSystem,
  InstantiationType.Delayed,
  'hostFs',
);
