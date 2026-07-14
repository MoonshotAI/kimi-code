/**
 * `sessionExport` domain (L6) — export zip writer.
 *
 * Collects the session directory's regular files and writes a diagnostic zip
 * archive with a generated manifest plus optional extra entries. This module
 * owns the byte packaging detail; callers provide already-resolved paths.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { dirname, join, relative, resolve } from 'pathe';
import { ZipFile, type ReadStreamOptions } from 'yazl';

import { ErrorCodes, Error2 } from '#/errors';

import {
  openZipSource,
  type ZipSource,
  type ZipSourceIdentity,
} from './file-source';
import type { ExportSessionManifest } from './sessionExport';

export async function collectFilesRecursive(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted((a, b) => a.localeCompare(b));
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return [];
  }
}

export type ExtraZipEntry =
  | { readonly source: ZipSource; readonly target: string }
  | { readonly data: Buffer; readonly target: string };

export type SessionZipEntry = string | { readonly path: string; readonly source: ZipSource };

export async function writeExportZip(args: {
  readonly outputPath: string;
  readonly manifest: ExportSessionManifest;
  readonly sessionDir: string;
  readonly sessionFiles: readonly SessionZipEntry[];
  readonly extraEntries?: readonly ExtraZipEntry[];
  readonly signal?: AbortSignal;
  readonly maxArchiveBytes?: number;
}): Promise<readonly string[]> {
  const unusedSources = new Set<ZipSource>([
    ...args.sessionFiles.flatMap((entry) => (typeof entry === 'string' ? [] : [entry.source])),
    ...(args.extraEntries ?? []).flatMap((entry) =>
      'source' in entry ? [entry.source] : [],
    ),
  ]);
  const pendingOpens = new Set<Promise<void>>();
  let activeSource: ZipSource | undefined;
  let releaseActive: (() => void) | undefined;
  let closing = Promise.resolve();
  let output: Readable | undefined;
  let writing: Promise<void> | undefined;
  let stopped: Error | undefined;
  let failure: { readonly error: unknown } | undefined;
  let onAbort: (() => void) | undefined;
  let tempDir: string | undefined;

  const getStopError = (): Error | undefined => stopped;
  const stop = (error: Error): void => {
    stopped ??= error;
    releaseActive?.();
    if (output !== undefined && !output.destroyed) output.destroy(stopped);
  };
  const queueClose = (source: ZipSource): void => {
    const next = closing.catch(() => {}).then(() => source.close());
    closing = next;
    void next.catch((error: unknown) => {
      stop(asError(error));
    });
  };

  try {
    const conflictingSource = await findConflictingSource(args);
    if (conflictingSource !== undefined) {
      throw new Error2(
        ErrorCodes.SESSION_EXPORT_OUTPUT_CONFLICT,
        `Session export output conflicts with selected source "${conflictingSource}".`,
        { details: { outputPath: args.outputPath, source: conflictingSource } },
      );
    }
    await mkdir(dirname(args.outputPath), { recursive: true });
    args.signal?.throwIfAborted();
    tempDir = await mkdtemp(join(dirname(args.outputPath), '.kimi-session-export-'));
    const tempOutputPath = join(tempDir, 'archive.zip');

    const zip = new ZipFile() as LazyZipFile;
    output = zip.outputStream as unknown as Readable;
    zip.on('error', (error: Error) => {
      stop(error);
    });
    output.on('error', (error: Error) => {
      stop(error);
    });
    onAbort = (): void => {
      stop(abortReason(args.signal!));
    };
    args.signal?.addEventListener('abort', onAbort, { once: true });

    const destination = createWriteStream(tempOutputPath, { flags: 'wx' });
    writing =
      args.maxArchiveBytes === undefined
        ? pipeline(output, destination, { signal: args.signal })
        : pipeline(output, createArchiveLimit(args.maxArchiveBytes), destination, {
            signal: args.signal,
          });

    const activate = (source: ZipSource): Readable => {
      unusedSources.delete(source);
      activeSource = source;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        if (activeSource === source) activeSource = undefined;
        if (releaseActive === release) releaseActive = undefined;
        queueClose(source);
      };
      releaseActive = release;
      source.stream.once('end', release);
      source.stream.once('close', release);
      source.stream.once('error', (error: Error) => {
        release();
        zip.emit('error', error);
      });
      return source.stream;
    };

    const addLazySource = (
      target: string,
      options: Partial<ReadStreamOptions>,
      getSource: () => Promise<ZipSource>,
    ): void => {
      zip.addReadStreamLazy(target, options, (callback) => {
        const pending = (async (): Promise<void> => {
          try {
            await closing;
            if (stopped !== undefined) throw stopped;
            const source = await getSource();
            const stopError = getStopError();
            if (stopError !== undefined) {
              await source.close().catch(() => {});
              throw stopError;
            }
            callback(null, activate(source));
          } catch (error) {
            callback(asError(error));
          }
        })();
        pendingOpens.add(pending);
        void pending.then(
          () => pendingOpens.delete(pending),
          (error: unknown) => {
            pendingOpens.delete(pending);
            zip.emit('error', asError(error));
          },
        );
      });
    };

    zip.addBuffer(Buffer.from(JSON.stringify(args.manifest, null, 2), 'utf8'), 'manifest.json');

    for (const entry of args.sessionFiles) {
      const sourcePath = sessionEntryPath(entry);
      const target = relative(args.sessionDir, sourcePath).split(/[\\/]/).join('/');
      if (typeof entry === 'string') {
        addLazySource(target, {}, () => openZipSource(entry, args.signal));
      } else {
        addLazySource(
          target,
          { size: entry.source.size, mtime: entry.source.mtime, mode: entry.source.mode },
          async () => entry.source,
        );
      }
    }

    for (const extra of args.extraEntries ?? []) {
      if ('data' in extra) {
        zip.addBuffer(extra.data, extra.target);
      } else {
        addLazySource(
          extra.target,
          { size: extra.source.size, mtime: extra.source.mtime, mode: extra.source.mode },
          async () => extra.source,
        );
      }
    }

    zip.end();
    await writing;
    await Promise.allSettled(pendingOpens);
    await closing;
    if (onAbort !== undefined) {
      args.signal?.removeEventListener('abort', onAbort);
      onAbort = undefined;
    }
    args.signal?.throwIfAborted();
    await rename(tempOutputPath, args.outputPath);
  } catch (error) {
    failure = { error };
    stop(asError(error));
    await writing?.catch(() => {});
  } finally {
    if (onAbort !== undefined) args.signal?.removeEventListener('abort', onAbort);
    await Promise.allSettled(pendingOpens);
    releaseActive?.();
    for (const source of unusedSources) queueClose(source);
    unusedSources.clear();
    try {
      await closing;
    } catch (error) {
      failure ??= { error };
    }
    if (tempDir !== undefined) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        failure ??= { error };
      }
    }
  }

  if (failure !== undefined) throw failure.error;
  if (stopped !== undefined) throw stopped;
  return [
    'manifest.json',
    ...args.sessionFiles.map((entry) =>
      relative(args.sessionDir, sessionEntryPath(entry)).split(/[\\/]/).join('/'),
    ),
    ...(args.extraEntries ?? []).map((entry) => entry.target),
  ];
}

interface LazyZipFile extends ZipFile {
  addReadStreamLazy(
    target: string,
    options: Partial<ReadStreamOptions>,
    getReadStream: (
      callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void,
    ) => void,
  ): void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function createArchiveLimit(maxArchiveBytes: number): Transform {
  let archiveBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveBytes += chunk.length;
      if (archiveBytes > maxArchiveBytes) {
        callback(
          new Error2(
            ErrorCodes.SESSION_EXPORT_TOO_LARGE,
            `Session export exceeds the ${maxArchiveBytes} byte archive limit.`,
            { details: { archiveBytes, maxArchiveBytes } },
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

async function findConflictingSource(args: {
  readonly outputPath: string;
  readonly sessionFiles: readonly SessionZipEntry[];
  readonly extraEntries?: readonly ExtraZipEntry[];
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
  args.signal?.throwIfAborted();
  const outputPath = resolve(args.outputPath);
  for (const entry of args.sessionFiles) {
    const sourcePath = sessionEntryPath(entry);
    if (resolve(sourcePath) === outputPath) return sourcePath;
  }
  for (const entry of args.extraEntries ?? []) {
    if (
      'source' in entry &&
      entry.source.sourcePath !== undefined &&
      resolve(entry.source.sourcePath) === outputPath
    ) {
      return entry.target;
    }
  }

  const output = await statExisting(outputPath);
  if (output === undefined) return undefined;

  for (const entry of args.sessionFiles) {
    args.signal?.throwIfAborted();
    const input =
      typeof entry === 'string' ? await statExisting(entry) : entry.source.identity;
    if (input !== undefined && sameFile(output, input)) return sessionEntryPath(entry);
  }
  for (const entry of args.extraEntries ?? []) {
    args.signal?.throwIfAborted();
    if ('source' in entry && sameFile(output, entry.source.identity)) return entry.target;
  }
  return undefined;
}

async function statExisting(
  path: string,
): Promise<ZipSourceIdentity | undefined> {
  try {
    const file = await stat(path, { bigint: true });
    return { device: file.dev, inode: file.ino };
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return undefined;
  }
}

function sameFile(
  left: ZipSourceIdentity,
  right: ZipSourceIdentity,
): boolean {
  return (
    left.inode !== 0n &&
    right.inode !== 0n &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function sessionEntryPath(entry: SessionZipEntry): string {
  return typeof entry === 'string' ? entry : entry.path;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
