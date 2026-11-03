import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import {
  appendFile,
  lstat,
  open,
  readFile,
  readdir,
  mkdir,
  realpath as nodeRealpath,
  rename as nodeRename,
  rm,
  stat as nodeStat,
  writeFile,
} from 'node:fs/promises';
import ignore from 'ignore';

import { decodeTextWithErrors, readUtf8Lines, type TextDecodeErrors } from '#/_base/execEnv/decodeText';

import {
  type HostDirEntry,
  type HostFileHead,
  type HostFileStat,
  type HostWalkOptions,
  type HostWalkVisitor,
  IHostFileSystem,
} from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors, toHostFsError } from '#/os/interface/hostFsErrors';

const READ_CHUNK_SIZE = 64 * 1024;
const WALK_MAX_DEPTH = 64;

export async function walkDirectoryTree(
  fs: Pick<IHostFileSystem, 'readdir'>,
  root: string,
  options: HostWalkOptions,
  visit: HostWalkVisitor,
): Promise<{ readonly truncated: boolean }> {
  const matcher = options.ignore === undefined ? undefined : ignore({ allowRelativePaths: true }).add(options.ignore);
  const expired = (): boolean => options.deadlineMs !== undefined && Date.now() >= options.deadlineMs;
  const walkDirectory = async (relDir: string, depth: number): Promise<boolean> => {
    if (depth > WALK_MAX_DEPTH) return true;
    if (expired()) return false;
    let entries: readonly HostDirEntry[];
    try {
      entries = await fs.readdir(relDir === '' ? root : join(root, relDir));
    } catch (error) {
      if (error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_DIRECTORY_TOO_LARGE) throw error;
      return true;
    }
    for (const entry of entries) {
      const path = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const isDir = entry.isDirectory && entry.isSymbolicLink !== true;
      if (matcher?.ignores(isDir ? `${path}/` : path) === true) continue;
      if (expired()) return false;
      const kind = entry.isSymbolicLink === true ? 'symlink' : isDir ? 'directory' : 'file';
      if (await visit({ path, kind }) === false) return false;
      if (isDir && !await walkDirectory(path, depth + 1)) return false;
    }
    return true;
  };
  return { truncated: !await walkDirectory('', 0) };
}

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
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors; preserveBOM?: boolean },
  ): Promise<string> {
    try {
      if (options === undefined) {
        return await readFile(path, 'utf8');
      }
      const encoding = options.encoding ?? 'utf-8';
      const errors = options.errors ?? 'strict';
      return decodeTextWithErrors(await readFile(path), encoding, errors, options.preserveBOM);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    try {
      await writeFile(path, data, 'utf8');
    } catch (error) {
      throw toHostFsError(error, { path, op: 'write' });
    }
  }

  async appendText(path: string, data: string): Promise<void> {
    try {
      await appendFile(path, data, 'utf8');
    } catch (error) {
      throw toHostFsError(error, { path, op: 'append' });
    }
  }

  async appendBytes(path: string, data: Uint8Array): Promise<void> {
    try {
      await appendFile(path, data);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'append' });
    }
  }

  async readFileHead(path: string, maxBytes: number): Promise<HostFileHead> {
    const stat = await this.stat(path);
    return { stat, bytes: stat.isFile ? await this.readBytes(path, maxBytes) : new Uint8Array() };
  }

  async readBytes(path: string, n?: number, offset = 0): Promise<Uint8Array> {
    try {
      if (n === undefined && offset === 0) {
        const buf = await readFile(path);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
      const fh = await open(path, 'r');
      try {
        const length = n ?? Math.max(0, (await fh.stat()).size - offset);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch (error) {
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  async writeBytes(path: string, data: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
    try {
      await writeFile(path, data);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'write' });
    }
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string> {
    try {
      const encoding = options?.encoding ?? 'utf-8';
      const errors = options?.errors ?? 'strict';

      if (!isUtf8Encoding(encoding)) {
        const content = decodeTextWithErrors(await readFile(path), encoding, errors);
        yield* splitLinesKeepingTerminator(content);
        return;
      }

      yield* readUtf8Lines(createReadStream(path, { highWaterMark: READ_CHUNK_SIZE }), errors);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'read' });
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
      throw toHostFsError(error, { path, op: 'create' });
    }
  }

  async stat(path: string): Promise<HostFileStat> {
    try {
      const s = await nodeStat(path);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtimeMs: s.mtimeMs,
        ino: s.ino,
        mode: s.mode & 0o7777,
      };
    } catch (error) {
      throw toHostFsError(error, { path, op: 'stat' });
    }
  }

  async lstat(path: string): Promise<HostFileStat> {
    try {
      const s = await lstat(path);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtimeMs: s.mtimeMs,
        ino: s.ino,
        mode: s.mode & 0o7777,
      };
    } catch (error) {
      throw toHostFsError(error, { path, op: 'lstat' });
    }
  }

  async readdir(path: string): Promise<readonly HostDirEntry[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((d) => ({
        name: d.name,
        isFile: d.isFile(),
        isDirectory: d.isDirectory(),
        isSymbolicLink: d.isSymbolicLink(),
      }));
    } catch (error) {
      throw toHostFsError(error, { path, op: 'readdir' });
    }
  }

  async walk(path: string, options: HostWalkOptions, visit: HostWalkVisitor): Promise<{ readonly truncated: boolean }> {
    return walkDirectoryTree(this, path, options, visit);
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    try {
      await mkdir(path, { recursive: options?.recursive ?? false });
    } catch (error) {
      throw toHostFsError(error, { path, op: 'mkdir' });
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      throw toHostFsError(error, { path, op: 'remove' });
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await nodeRename(from, to);
    } catch (error) {
      throw toHostFsError(error, { path: from, op: 'rename' });
    }
  }

  async realpath(path: string): Promise<string> {
    try {
      return await nodeRealpath(path);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'realpath' });
    }
  }
}
