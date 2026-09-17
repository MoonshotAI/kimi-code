import {
  decodeTextWithErrors,
  readUtf8Lines,
  type TextDecodeErrors,
} from '@moonshot-ai/agent-core-v2/_base/execEnv/decodeText';
import type {
  HostDirEntry,
  HostFileStat,
  IHostFileSystem,
} from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import {
  HostFsError,
  OsFsErrors,
  type HostFsErrorCode,
} from '@moonshot-ai/agent-core-v2/os/interface/hostFsErrors';

import { decodeBase64, encodeBase64 } from '#/protocol/codec';
import { RpcError, RpcErrorCode } from '#/protocol/errors';
import {
  FS_CANONICALIZE_METHOD,
  FS_CREATE_DIRECTORY_METHOD,
  FS_GET_METADATA_METHOD,
  FS_READ_DIRECTORY_METHOD,
  FS_READ_FILE_MAX_BYTES,
  FS_READ_FILE_METHOD,
  FS_REMOVE_METHOD,
  FS_RENAME_METHOD,
  FS_WRITE_FILE_METHOD,
  type FsGetMetadataResult,
  type FsReadDirectoryResult,
  type FsReadFileResult,
  type FsWriteMode,
} from '#/protocol/methods';
import type { RemoteExecConnection } from './connection';

const HOST_FS_CODES: ReadonlySet<string> = new Set(Object.values(OsFsErrors.codes));

// Rebuilds the fs domain error from the RPC error instead of leaking the raw
// numeric code: the executor attaches data.domainCode, the numeric code is
// only the coarse fallback bucket.
export function toRemoteFsError(error: unknown): Error {
  if (!(error instanceof RpcError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const data = error.data;
  const domainCode =
    data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)['domainCode']
      : undefined;
  if (typeof domainCode === 'string' && HOST_FS_CODES.has(domainCode)) {
    return new HostFsError(domainCode as HostFsErrorCode, error.message, {
      details: data as Record<string, unknown>,
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

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string> {
    const result = await this.call<FsReadFileResult>(FS_READ_FILE_METHOD, { path });
    const buffer = Buffer.from(result.dataBase64, 'base64');
    return decodeTextWithErrors(buffer, options?.encoding ?? 'utf-8', options?.errors ?? 'strict');
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeMode(path, Buffer.from(data, 'utf8'), 'truncate');
  }

  async appendText(path: string, data: string): Promise<void> {
    await this.writeMode(path, Buffer.from(data, 'utf8'), 'append');
  }

  async readBytes(path: string, n?: number, offset = 0): Promise<Uint8Array> {
    const result = await this.readRange(path, offset, n);
    return decodeBase64(result.dataBase64);
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    await this.writeMode(path, data, 'truncate');
  }

  async appendBytes(path: string, data: Uint8Array): Promise<void> {
    await this.writeMode(path, data, 'append');
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

  private async *readChunks(path: string): AsyncGenerator<Uint8Array> {
    let offset = 0;
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
      await this.writeMode(path, data, 'exclusive');
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
    return result.entries.map((entry) => ({
      name: entry.fileName,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
    }));
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    await this.call(FS_CREATE_DIRECTORY_METHOD, { path, recursive: options?.recursive ?? false });
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
