/**
 * Low-level filesystem helpers — durable file-write primitives (atomic writes
 * plus file and directory fsync), stat classification shared by watchers, and
 * the stat-tuple comparison shared by every stat-only staleness check.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import type { Stats } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'pathe';

/**
 * True for directory entries that are neither a regular file, a directory,
 * nor a symlink (unix sockets, fifos, devices). File watchers must skip
 * these: chokidar attaches `fs.watch` to every scanned entry and that call
 * throws `UNKNOWN` on special files.
 */
export function isSpecialFileStat(stats: Stats | undefined): boolean {
  return stats !== undefined && !stats.isFile() && !stats.isDirectory() && !stats.isSymbolicLink();
}

/**
 * The (`ino`, `mtimeMs`, `size`) tuple identifying one on-disk revision of a
 * file — the comparison unit of every stat-only staleness check (write-path
 * fencing, storage-watch fingerprints, read/edit TOCTOU revalidation).
 * `ino`/`mtimeMs` are optional because not every stat source supplies them.
 */
export interface FileStatTuple {
  readonly ino?: number;
  readonly mtimeMs?: number;
  readonly size: number;
}

/**
 * Tuple equality tolerant of a missing stat (`undefined`): two missing
 * tuples are equal, exactly one missing is not.
 */
export function fileStatTuplesEqual(
  a: FileStatTuple | undefined,
  b: FileStatTuple | undefined,
): boolean {
  return a?.ino === b?.ino && a?.mtimeMs === b?.mtimeMs && a?.size === b?.size;
}

export async function syncDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dirFh = await open(dirPath, 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}

export function syncDirSync(dirPath: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function writeFileAtomicDurable(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const tmpPath = filePath + '.tmp';
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (process.platform === 'win32') {
      try {
        await unlink(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
    }
    await rename(tmpPath, filePath);
    renamed = true;
    await syncDir(dirname(filePath));
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
      }
    }
  }
}

function syncFd(fd: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    nodeFs.fsync(fd, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  _syncOverride?: (fd: number) => Promise<void>,
  mode?: number,
): Promise<void> {
  const hex = randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${hex}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w', mode);
    try {
      await fh.writeFile(content);
      await (_syncOverride ?? syncFd)(fh.fd);
    } finally {
      await fh.close();
    }
    if (process.platform === 'win32') {
      try {
        await unlink(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
    }
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
      }
    }
  }
}
