import { isAbsolute } from 'node:path';

import { type HostFileSystem, walkDirectoryTree } from '#/os/backends/node-local/hostFsService';
import type { HostFileStat } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors, toHostFsError } from '#/os/interface/hostFsErrors';

import { RpcError, RpcErrorCode } from '#/remote/protocol/errors';
import {
  FS_READ_DIRECTORY_MAX_ENTRIES,
  FS_READ_FILE_MAX_BYTES,
  FS_READ_FILE_WHOLE_MAX_BYTES,
  type FsCanonicalizeResult,
  type FsGetMetadataResult,
  type FsReadDirectoryResult,
  type FsReadFileResult,
  FS_WALK_DEFAULT_TIMEOUT_MS,
  FS_WALK_ENTRY_OVERHEAD_BYTES,
  FS_WALK_MAX_RESPONSE_BYTES,
  FS_WALK_MAX_TIMEOUT_MS,
  type FsWalkEntry,
  type FsWalkResult,
} from '#/remote/protocol/methods';

type Params = Record<string, unknown>;

export function requireParams(value: unknown): Params {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError(RpcErrorCode.InvalidParams, 'params must be an object');
  }
  return value as Params;
}

export function requireString(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError(RpcErrorCode.InvalidParams, `${name} must be a non-empty string`);
  }
  return value;
}

export function requireAbsolutePath(params: Params, name: string): string {
  const value = requireString(params, name);
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(value)) {
      throw new RpcError(RpcErrorCode.InvalidRequest, `${name} must be an absolute Windows drive path such as C:\\work`);
    }
  } else if (!isAbsolute(value)) {
    throw new RpcError(RpcErrorCode.InvalidRequest, `${name} must be an absolute path`);
  }
  return value;
}

export function optionalBoolean(params: Params, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new RpcError(RpcErrorCode.InvalidParams, `${name} must be a boolean`);
  }
  return value;
}

function optionalInteger(
  params: Params,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RpcError(RpcErrorCode.InvalidParams, `${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function optionalStringArray(params: Params, name: string): readonly string[] | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RpcError(RpcErrorCode.InvalidParams, `${name} must be an array of strings`);
  }
  return value;
}

function toMetadata(stat: HostFileStat): FsGetMetadataResult {
  return {
    isDirectory: stat.isDirectory,
    isFile: stat.isFile,
    isSymlink: stat.isSymbolicLink ?? false,
    size: stat.size,
    modifiedAtMs: stat.mtimeMs ?? 0,
    mode: stat.mode,
  };
}

function fsDomainError(error: unknown, ctx: { path: string; op: string }): RpcError {
  const hostError = toHostFsError(error, ctx);
  const code =
    hostError.code === OsFsErrors.codes.OS_FS_NOT_FOUND
      ? RpcErrorCode.NotFound
      : hostError.code === OsFsErrors.codes.OS_FS_PERMISSION_DENIED
        ? RpcErrorCode.InvalidRequest
        : RpcErrorCode.InternalError;
  const data: Record<string, unknown> = { domainCode: hostError.code };
  if (hostError.details !== undefined) {
    Object.assign(data, hostError.details);
  }
  return new RpcError(code, hostError.message, data);
}

const EMPTY: Record<string, never> = {};

export class FsHandler {
  constructor(private readonly fs: HostFileSystem) {}

  async readFile(rawParams: unknown): Promise<FsReadFileResult> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    const offset = optionalInteger(params, 'offset', 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const maxBytes = optionalInteger(params, 'maxBytes', 1, FS_READ_FILE_MAX_BYTES);
    const includeMetadata = optionalBoolean(params, 'includeMetadata') ?? false;
    try {
      const stat = await this.fs.stat(path);
      const metadata = includeMetadata ? toMetadata(stat) : undefined;
      if (metadata !== undefined && !stat.isFile) {
        return { dataBase64: '', eof: true, metadata };
      }
      const { size } = stat;
      const length = maxBytes ?? size - offset;
      if (length > FS_READ_FILE_WHOLE_MAX_BYTES) {
        throw new RpcError(
          RpcErrorCode.InvalidRequest,
          `fs/readFile without maxBytes is limited to ${FS_READ_FILE_WHOLE_MAX_BYTES} bytes; use offset/maxBytes`,
        );
      }
      if (offset >= size) {
        return { dataBase64: '', eof: true, metadata };
      }
      const data = await this.fs.readBytes(path, Math.min(length, size - offset), offset);
      return { dataBase64: Buffer.from(data).toString('base64'), eof: offset + data.byteLength >= size, metadata };
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw fsDomainError(error, { path, op: 'read' });
    }
  }

  async writeFile(rawParams: unknown): Promise<typeof EMPTY> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    const dataBase64 = params['dataBase64'];
    if (typeof dataBase64 !== 'string') {
      throw new RpcError(RpcErrorCode.InvalidParams, 'dataBase64 must be a string');
    }
    const mode = params['mode'];
    if (mode !== 'truncate' && mode !== 'append' && mode !== 'exclusive') {
      throw new RpcError(RpcErrorCode.InvalidParams, 'mode must be truncate, append or exclusive');
    }
    const data = Buffer.from(dataBase64, 'base64');
    try {
      if (mode === 'truncate') {
        await this.fs.writeBytes(path, data);
      } else if (mode === 'append') {
        await this.fs.appendBytes(path, data);
      } else if (!(await this.fs.createExclusive(path, data))) {
        throw new HostFsError(OsFsErrors.codes.OS_FS_ALREADY_EXISTS, `${path} already exists`, {
          details: { path, op: 'create' },
        });
      }
      return EMPTY;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw fsDomainError(error, { path, op: 'write' });
    }
  }

  async createDirectory(rawParams: unknown): Promise<typeof EMPTY> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    const recursive = optionalBoolean(params, 'recursive') ?? false;
    try {
      await this.fs.mkdir(path, { recursive });
      return EMPTY;
    } catch (error) {
      throw fsDomainError(error, { path, op: 'mkdir' });
    }
  }

  async getMetadata(rawParams: unknown): Promise<FsGetMetadataResult> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    const followSymlinks = optionalBoolean(params, 'followSymlinks') ?? true;
    try {
      return toMetadata(followSymlinks ? await this.fs.stat(path) : await this.fs.lstat(path));
    } catch (error) {
      throw fsDomainError(error, { path, op: 'stat' });
    }
  }

  async canonicalize(rawParams: unknown): Promise<FsCanonicalizeResult> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    try {
      return { path: await this.fs.realpath(path) };
    } catch (error) {
      throw fsDomainError(error, { path, op: 'realpath' });
    }
  }

  async readDirectory(rawParams: unknown): Promise<FsReadDirectoryResult> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    try {
      const entries = await this.fs.readdir(path);
      return {
        entries: entries.slice(0, FS_READ_DIRECTORY_MAX_ENTRIES).map((entry) => ({
          fileName: entry.name,
          isDirectory: entry.isDirectory,
          isFile: entry.isFile,
          isSymlink: entry.isSymbolicLink ?? false,
        })),
        truncated: entries.length > FS_READ_DIRECTORY_MAX_ENTRIES,
      };
    } catch (error) {
      throw fsDomainError(error, { path, op: 'readdir' });
    }
  }

  async walk(rawParams: unknown): Promise<FsWalkResult> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    const ignore = optionalStringArray(params, 'ignore');
    const timeoutMs = optionalInteger(params, 'timeoutMs', 1, FS_WALK_MAX_TIMEOUT_MS) ?? FS_WALK_DEFAULT_TIMEOUT_MS;
    const entries: FsWalkEntry[] = [];
    let responseBytes = 0;
    const readdir = async (directory: string) => {
      const children = await this.fs.readdir(directory);
      if (children.length > FS_READ_DIRECTORY_MAX_ENTRIES) {
        throw new HostFsError(
          OsFsErrors.codes.OS_FS_DIRECTORY_TOO_LARGE,
          `readdir ${directory} exceeds the ${FS_READ_DIRECTORY_MAX_ENTRIES}-entry limit`,
          { details: { path: directory, op: 'readdir', limit: FS_READ_DIRECTORY_MAX_ENTRIES } },
        );
      }
      return children;
    };
    try {
      const { truncated } = await walkDirectoryTree({ readdir }, path, { ignore, deadlineMs: Date.now() + timeoutMs }, (entry) => {
        responseBytes += Buffer.byteLength(entry.path) + FS_WALK_ENTRY_OVERHEAD_BYTES;
        if (responseBytes > FS_WALK_MAX_RESPONSE_BYTES) return false;
        entries.push(entry);
      });
      return { entries, truncated };
    } catch (error) {
      throw fsDomainError(error, { path, op: 'readdir' });
    }
  }

  async remove(rawParams: unknown): Promise<typeof EMPTY> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    try {
      await this.fs.remove(path);
      return EMPTY;
    } catch (error) {
      throw fsDomainError(error, { path, op: 'remove' });
    }
  }

  async rename(rawParams: unknown): Promise<typeof EMPTY> {
    const params = requireParams(rawParams);
    const from = requireAbsolutePath(params, 'from');
    const to = requireAbsolutePath(params, 'to');
    try {
      await this.fs.rename(from, to);
      return EMPTY;
    } catch (error) {
      throw fsDomainError(error, { path: from, op: 'rename' });
    }
  }
}
