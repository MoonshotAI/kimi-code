import {
  decodeTextWithErrors,
  readUtf8Lines,
  type TextDecodeErrors,
} from '#/_base/execEnv/decodeText';
import { splitLinesKeepingTerminator } from '#/_base/text/line-endings';
import type {
  HostDirEntry,
  HostFileStat,
  IHostFileSystem,
} from '#/os/interface/hostFileSystem';
import {
  HostFsError,
  OsFsErrors,
  type HostFsErrorCode,
} from '#/os/interface/hostFsErrors';

import { decodeBase64, encodeBase64 } from '#/remote/protocol/codec';
import { RpcError, RpcErrorCode } from '#/remote/protocol/errors';
import {
  FS_CANONICALIZE_METHOD,
  FS_CREATE_DIRECTORY_METHOD,
  FS_GET_METADATA_METHOD,
  FS_READ_DIRECTORY_METHOD,
  FS_READ_DIRECTORY_MAX_ENTRIES,
  FS_READ_FILE_MAX_BYTES,
  FS_READ_FILE_METHOD,
  FS_REMOVE_METHOD,
  FS_RENAME_METHOD,
  FS_WRITE_FILE_CHUNK_BYTES,
  FS_WRITE_FILE_METHOD,
  type FsGetMetadataResult,
  type FsReadDirectoryResult,
  type FsReadFileResult,
  type FsWriteMode,
} from '#/remote/protocol/methods';
import type { RemoteExecConnection } from './connection';
import { rpcDomainError } from './rpcDomainError';

const HOST_FS_CODES: ReadonlySet<string> = new Set(Object.values(OsFsErrors.codes));

export function toRemoteFsError(error: unknown): Error {
  if (!(error instanceof RpcError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const domain = rpcDomainError(error, HOST_FS_CODES);
  if (domain !== undefined) {
    return new HostFsError(domain.domainCode as HostFsErrorCode, error.message, {
      details: domain.details,
    });
  }
  const fallback =
    error.code === RpcErrorCode.NotFound
      ? OsFsErrors.codes.OS_FS_NOT_FOUND
      : OsFsErrors.codes.OS_FS_UNKNOWN;
  return new HostFsError(fallback, error.message, { details: { rpcCode: error.code } });
}

function isUtf8Encoding(encoding: BufferEncoding): boolean {
  return encoding === 'utf-8' || encoding === 'utf8';
}

export class RemoteFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly connection: RemoteExecConnection) {}

  private async call<T>(method: string, params: unknown): Promise<T> {
    try {
      return (await this.connection.call(method, params)) as T;
    } catch (error) {
      throw toRemoteFsError(error);
    }
  }

  private async readRange(path: string, offset: number, maxBytes?: number): Promise<FsReadFileResult> {
    return this.call<FsReadFileResult>(FS_READ_FILE_METHOD, { path, offset, maxBytes });
  }

  private async writeMode(path: string, data: Uint8Array, mode: FsWriteMode): Promise<void> {
    await this.call(FS_WRITE_FILE_METHOD, { path, dataBase64: encodeBase64(data), mode });
  }

  private async writeChunked(path: string, data: Uint8Array, mode: FsWriteMode): Promise<void> {
    if (data.byteLength <= FS_WRITE_FILE_CHUNK_BYTES) {
      await this.writeMode(path, data, mode);
      return;
    }
    for (let offset = 0; offset < data.byteLength; offset += FS_WRITE_FILE_CHUNK_BYTES) {
      await this.writeMode(path, data.subarray(offset, offset + FS_WRITE_FILE_CHUNK_BYTES), offset === 0 ? mode : 'append');
    }
  }

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string> {
    const bytes = await this.readBytes(path);
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return decodeTextWithErrors(buffer, options?.encoding ?? 'utf-8', options?.errors ?? 'strict');
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeChunked(path, Buffer.from(data, 'utf8'), 'truncate');
  }

  async appendText(path: string, data: string): Promise<void> {
    await this.writeChunked(path, Buffer.from(data, 'utf8'), 'append');
  }

  async readBytes(path: string, n?: number, offset = 0): Promise<Uint8Array> {
    if (n !== undefined) {
      const result = await this.readRange(path, offset, n);
      return decodeBase64(result.dataBase64);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.readChunks(path, offset)) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) {
      out.set(chunk, position);
      position += chunk.byteLength;
    }
    return out;
  }

  async writeBytes(path: string, data: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
    if (data instanceof Uint8Array) {
      await this.writeChunked(path, data, 'truncate');
      return;
    }
    let mode: FsWriteMode = 'truncate';
    const pending = new Uint8Array(FS_WRITE_FILE_CHUNK_BYTES);
    let pendingBytes = 0;
    for await (const chunk of data) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const length = Math.min(pending.byteLength - pendingBytes, chunk.byteLength - offset);
        pending.set(chunk.subarray(offset, offset + length), pendingBytes);
        pendingBytes += length;
        offset += length;
        if (pendingBytes === pending.byteLength) {
          await this.writeMode(path, pending, mode);
          mode = 'append';
          pendingBytes = 0;
        }
      }
    }
    if (pendingBytes > 0 || mode === 'truncate') {
      await this.writeMode(path, pending.subarray(0, pendingBytes), mode);
    }
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string> {
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    if (!isUtf8Encoding(encoding)) {
      const content = await this.readText(path, { encoding, errors });
      yield* splitLinesKeepingTerminator(content);
      return;
    }
    yield* readUtf8Lines(this.readChunks(path), errors);
  }

  private async *readChunks(path: string, offset = 0): AsyncGenerator<Uint8Array> {
    for (;;) {
      const result = await this.readRange(path, offset, FS_READ_FILE_MAX_BYTES);
      if (result.dataBase64.length === 0) return;
      const chunk = decodeBase64(result.dataBase64);
      yield chunk;
      offset += chunk.byteLength;
      if (result.eof) return;
    }
  }

  async createExclusive(path: string, data: Uint8Array): Promise<boolean> {
    try {
      await this.writeChunked(path, data, 'exclusive');
      return true;
    } catch (error) {
      if (error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_ALREADY_EXISTS) {
        return false;
      }
      throw error;
    }
  }

  private async metadata(path: string, followSymlinks: boolean): Promise<HostFileStat> {
    const result = await this.call<FsGetMetadataResult>(FS_GET_METADATA_METHOD, {
      path,
      followSymlinks,
    });
    return {
      isFile: result.isFile,
      isDirectory: result.isDirectory,
      isSymbolicLink: result.isSymlink,
      size: result.size,
      mtimeMs: result.modifiedAtMs,
      mode: result.mode,
    };
  }

  async stat(path: string): Promise<HostFileStat> {
    return this.metadata(path, true);
  }

  async lstat(path: string): Promise<HostFileStat> {
    return this.metadata(path, false);
  }

  async readdir(path: string): Promise<readonly HostDirEntry[]> {
    const result = await this.call<FsReadDirectoryResult>(FS_READ_DIRECTORY_METHOD, { path });
    if (result.truncated) {
      throw new HostFsError(
        OsFsErrors.codes.OS_FS_DIRECTORY_TOO_LARGE,
        `readdir ${path} exceeds the ${FS_READ_DIRECTORY_MAX_ENTRIES}-entry limit`,
        { details: { path, op: 'readdir', limit: FS_READ_DIRECTORY_MAX_ENTRIES } },
      );
    }
    return result.entries.map((entry) => ({
      name: entry.fileName,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
      isSymbolicLink: entry.isSymlink,
    }));
  }

  async mkdir(
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ): Promise<void> {
    await this.call(FS_CREATE_DIRECTORY_METHOD, {
      path,
      recursive: options?.recursive ?? false,
      mode: options?.mode,
    });
  }

  async remove(path: string): Promise<void> {
    await this.call(FS_REMOVE_METHOD, { path, recursive: true, force: true });
  }

  async realpath(path: string): Promise<string> {
    const result = await this.call<{ path: string }>(FS_CANONICALIZE_METHOD, { path });
    return result.path;
  }

  async rename(from: string, to: string): Promise<void> {
    await this.call(FS_RENAME_METHOD, { from, to });
  }
}
