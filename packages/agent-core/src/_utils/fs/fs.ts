/**
 * Low-level POSIX durability primitives.
 *
 * Two concerns that every durable write must handle:
 *   1. file *contents* — solved by `fh.sync()` after the write
 *   2. directory *entries* — solved by opening the parent directory and
 *      calling `fh.sync()` on the directory handle
 *
 * `fh.sync()` on a file does NOT guarantee that the directory entry
 * pointing at that file has been committed. On POSIX a crash between
 * the file-content fsync and the parent-directory fsync can leave the
 * file's bytes on disk with no visible name. The primary durable path
 * is POSIX; Windows is best-effort — NTFS's MoveFileEx commits the
 * dirent inside the file fsync, so a separate directory fsync is a
 * no-op (and EISDIR-fails on `open(dir, 'r')`).
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'pathe';

/**
 * Open a directory read-only and fsync it, then close. Used to make a
 * freshly-created or renamed file's directory entry durable.
 *
 * Windows: noop. `open(dir, 'r')` throws EISDIR, and NTFS commits the
 * dirent transaction inside the file fsync anyway — the separate dir
 * fsync would buy nothing even if we could issue it.
 */
export async function syncDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dirFh = await open(dirPath, 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}
/**
 * Synchronous variant of `syncDir`. Used by batched drain paths where a
 * single timer fire needs to be an atomic event-loop step. Windows
 * mirrors the async variant — noop.
 */
export function syncDirSync(dirPath: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/**
 * Write `content` to `filePath` atomically and durably:
 *   1. Write content to `<filePath>.tmp`, fsync it, close it.
 *   2. Rename `<filePath>.tmp` → `filePath` (atomic on POSIX).
 *   3. fsync the parent directory so the rename is durable.
 *
 * On any failure before the rename the `.tmp` file is removed so the
 * caller's directory is not left with a half-written leftover. A
 * failure *after* the rename (i.e. in the parent-directory fsync) is
 * surfaced to the caller — the content is already in place, but
 * durability is not guaranteed.
 */
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
    // Windows pre-unlink for MoveFileEx parity.
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
      // Best-effort cleanup of the `.tmp` file if we never got to the
      // rename. Swallow ENOENT because the file may not exist (open
      // itself failed) or may already have been unlinked.
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * atomicWrite — cross-platform atomic file replacement.
 *
 * Guarantees that readers never observe a half-written file:
 *   1. Write content to a uniquely-named temp file in the same directory.
 *   2. fsync the temp file so the bytes are durable.
 *   3. rename(tmp, target) — atomic on POSIX.
 *   4. On any failure before the rename, unlink the temp file (best effort).
 *
 * Does NOT fsync the parent directory; callers that need full POSIX
 * crash durability should `await syncDir(dirname(path))` after this call.
 *
 * NOT suitable for append-only paths (wire.jsonl). Those use
 * `JournalWriter.append()` which writes at the current file position.
 */

/**
 * fsync a file descriptor using the callback-based `fs.fsync`. We go
 * through the module namespace (`nodeFs.fsync`) rather than
 * `FileHandle.sync()` so vitest's `vi.spyOn(fs, 'fsync')` can
 * intercept the call for fault-injection tests.
 */
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

/**
 * Atomically write `content` to `filePath`. If the target already exists
 * it is replaced; if it does not exist it is created.
 *
 * @param filePath — absolute or relative path to the target file.
 * @param content  — string or binary payload to write.
 * @param _syncOverride — test seam: override the fsync implementation for
 *   fault injection. Production callers must never supply this.
 */
export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  _syncOverride?: (fd: number) => Promise<void>,
): Promise<void> {
  const hex = randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${hex}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await (_syncOverride ?? syncFd)(fh.fd);
    } finally {
      await fh.close();
    }
    // Windows `fs.rename` maps to MoveFileEx and fails with EPERM if
    // the target is held by another handle. Pre-unlinking
    // before the rename turns this into the POSIX-style "replace" case.
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
        /* ignore — file may not exist if open itself failed */
      }
    }
  }
}
