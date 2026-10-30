import { join, relative, sep } from 'node:path';

import ignore from 'ignore';

import type { HostDirEntry, HostWalkOptions, HostWalkResult } from './hostFileSystem';
import { HostFsError, OsFsErrors } from './hostFsErrors';

export const HOST_WALK_MAX_DEPTH = 64;
export const HOST_WALK_MAX_DIRECTORIES = 10_000;
export const HOST_WALK_MAX_ENTRIES = 100_000;
export const HOST_WALK_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const HOST_WALK_MAX_IGNORE_BYTES = 1024 * 1024;
export const HOST_WALK_DEFAULT_TIMEOUT_MS = 55_000;
export const HOST_WALK_MAX_TIMEOUT_MS = 60_000;
export const HOST_WALK_MAX_DIRECTORY_ENTRIES = 50_000;

interface HostWalkerFs {
  readdir(path: string): Promise<readonly HostDirEntry[]>;
}

interface HostWalkPath {
  readonly separator: string;
  join(...paths: readonly string[]): string;
  relative(from: string, to: string): string;
}

interface HostWalkHooks {
  readonly path?: HostWalkPath;
  readonly serializeError?: (path: string, error: Error) => unknown;
}

export async function walkHostDirectory(
  fs: HostWalkerFs,
  root: string,
  options: HostWalkOptions,
  hooks: HostWalkHooks = {},
  readDirectory: (path: string) => Promise<readonly HostDirEntry[]> = fs.readdir.bind(fs),
): Promise<HostWalkResult> {
  validateLimit('maxDepth', options.maxDepth, 0, HOST_WALK_MAX_DEPTH);
  validateLimit('maxDirectories', options.maxDirectories, 1, HOST_WALK_MAX_DIRECTORIES);
  validateLimit('maxEntries', options.maxEntries, 1, HOST_WALK_MAX_ENTRIES);
  validateLimit('maxResponseBytes', options.maxResponseBytes, 1, HOST_WALK_MAX_RESPONSE_BYTES);
  if (options.deadlineMs !== undefined && !Number.isFinite(options.deadlineMs)) {
    throw new RangeError('deadlineMs must be finite');
  }
  const matcher = options.ignore === undefined ? undefined : ignore().add(options.ignore);
  const serializeError = hooks.serializeError ?? ((_path, error) => ({
    name: error.name,
    message: error.message,
  }));
  const pathApi = hooks.path ?? { join, relative, separator: sep };
  const deadlineMs = options.deadlineMs ?? Date.now() + HOST_WALK_DEFAULT_TIMEOUT_MS;
  const entries: HostDirEntry[] = [];
  const errors: { path: string; error: Error }[] = [];
  const pending = [{ path: root, depth: 0 }];
  let responseBytes = 64;
  let truncated = false;
  for (let index = 0; index < pending.length && !truncated; index += 1) {
    if (Date.now() >= deadlineMs) {
      truncated = true;
      break;
    }
    const { path: directory, depth } = pending[index]!;
    let children: readonly HostDirEntry[];
    try {
      children = await readDirectory(directory);
      if (children.length > HOST_WALK_MAX_DIRECTORY_ENTRIES) {
        throw new HostFsError(
          OsFsErrors.codes.OS_FS_DIRECTORY_TOO_LARGE,
          `readdir ${directory} exceeds the ${HOST_WALK_MAX_DIRECTORY_ENTRIES}-entry limit`,
          { details: { path: directory, op: 'readdir', limit: HOST_WALK_MAX_DIRECTORY_ENTRIES } },
        );
      }
    } catch (error) {
      const errorBytes = Buffer.byteLength(JSON.stringify({
        path: directory,
        error: serializeError(directory, asError(error)),
      })) + 1;
      if (responseBytes + errorBytes > options.maxResponseBytes) {
        truncated = true;
        break;
      }
      responseBytes += errorBytes;
      errors.push({ path: directory, error: asError(error) });
      continue;
    }
    for (const child of children) {
      if (Date.now() >= deadlineMs) {
        truncated = true;
        break;
      }
      const path = pathApi.join(directory, child.name);
      const isDir = child.isDirectory && child.isSymbolicLink !== true;
      const relPath = pathApi.relative(root, path).split(pathApi.separator).join('/');
      if (matcher?.ignores(isDir ? `${relPath}/` : relPath) === true) continue;
      const entryBytes = Buffer.byteLength(JSON.stringify({ ...child, name: path })) + 1;
      if (entries.length >= options.maxEntries || responseBytes + entryBytes > options.maxResponseBytes) {
        truncated = true;
        break;
      }
      responseBytes += entryBytes;
      entries.push({ ...child, name: path });
      if (isDir && depth < options.maxDepth) {
        if (pending.length >= options.maxDirectories) {
          truncated = true;
          break;
        }
        pending.push({ path, depth: depth + 1 });
      }
    }
  }
  return { entries, errors, truncated, responseBytes };
}

function validateLimit(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
