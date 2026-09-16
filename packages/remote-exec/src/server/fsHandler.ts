import { constants } from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { OsFsErrors, toHostFsError } from '@moonshot-ai/agent-core-v2/os/interface/hostFsErrors';

import { RpcError, RpcErrorCode } from '#/protocol/errors';
import {
  FS_READ_DIRECTORY_MAX_ENTRIES,
  FS_READ_FILE_MAX_BYTES,
  FS_READ_FILE_WHOLE_MAX_BYTES,
  type FsCanonicalizeResult,
  type FsGetMetadataResult,
  type FsReadDirectoryResult,
  type FsReadFileResult,
} from '#/protocol/methods';

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
  if (!isAbsolute(value)) {
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

export function optionalInteger(
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

export function fsDomainError(error: unknown, ctx: { path: string; op: string }): RpcError {
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
  async readFile(rawParams: unknown): Promise<FsReadFileResult> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    const offset = optionalInteger(params, 'offset', 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const maxBytes = optionalInteger(params, 'maxBytes', 1, FS_READ_FILE_MAX_BYTES);
    const followSymlinks = optionalBoolean(params, 'followSymlinks') ?? true;
    try {
      const flags = followSymlinks ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
      const handle = await open(path, flags);
      try {
        const size = (await handle.stat()).size;
        const length = maxBytes ?? size - offset;
        if (length > FS_READ_FILE_WHOLE_MAX_BYTES) {
          throw new RpcError(
            RpcErrorCode.InvalidRequest,
            `fs/readFile without maxBytes is limited to ${FS_READ_FILE_WHOLE_MAX_BYTES} bytes; use offset/maxBytes`,
          );
        }
        if (offset >= size) {
          return { dataBase64: '', eof: true };
        }
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        const data = buffer.subarray(0, bytesRead);
        return { dataBase64: data.toString('base64'), eof: offset + bytesRead >= size };
      } finally {
        await handle.close();
      }
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
    const followSymlinks = optionalBoolean(params, 'followSymlinks') ?? true;
    const data = Buffer.from(dataBase64, 'base64');
    const noFollow = followSymlinks ? 0 : constants.O_NOFOLLOW;
    try {
      if (mode === 'truncate' && followSymlinks) {
        await writeFile(path, data);
      } else if (mode === 'append' && followSymlinks) {
        await appendFile(path, data);
      } else {
        const base =
          mode === 'truncate'
            ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
            : mode === 'append'
              ? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
              : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
        const handle = await open(path, base | noFollow);
        try {
          await handle.writeFile(data);
          if (mode === 'exclusive') await handle.sync();
        } finally {
          await handle.close();
        }
      }
      return EMPTY;
    } catch (error) {
      throw fsDomainError(error, { path, op: 'write' });
    }
  }

  async createDirectory(rawParams: unknown): Promise<typeof EMPTY> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    const recursive = optionalBoolean(params, 'recursive') ?? false;
    try {
      await mkdir(path, { recursive });
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
      const result = followSymlinks ? await stat(path) : await lstat(path);
      return {
        isDirectory: result.isDirectory(),
        isFile: result.isFile(),
        isSymlink: result.isSymbolicLink(),
        size: result.size,
        createdAtMs: result.birthtimeMs,
        modifiedAtMs: result.mtimeMs,
      };
    } catch (error) {
      throw fsDomainError(error, { path, op: 'stat' });
    }
  }

  async canonicalize(rawParams: unknown): Promise<FsCanonicalizeResult> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    try {
      return { path: await realpath(path) };
    } catch (error) {
      throw fsDomainError(error, { path, op: 'realpath' });
    }
  }

  async readDirectory(rawParams: unknown): Promise<FsReadDirectoryResult> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return {
        entries: entries.slice(0, FS_READ_DIRECTORY_MAX_ENTRIES).map((entry) => ({
          fileName: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        })),
      };
    } catch (error) {
      throw fsDomainError(error, { path, op: 'readdir' });
    }
  }

  async remove(rawParams: unknown): Promise<typeof EMPTY> {
    const params = requireParams(rawParams);
    const path = requireAbsolutePath(params, 'path');
    const recursive = optionalBoolean(params, 'recursive') ?? false;
    const force = optionalBoolean(params, 'force') ?? false;
    try {
      await rm(path, { recursive, force });
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
      await rename(from, to);
      return EMPTY;
    } catch (error) {
      throw fsDomainError(error, { path: from, op: 'rename' });
    }
  }
}
