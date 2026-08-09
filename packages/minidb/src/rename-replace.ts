// src/rename-replace.ts
//
// `fs.rename(src, dst)` with Windows replace-open-destination semantics.
//
// Windows, unlike POSIX, refuses to rename over a destination that ANY
// process still holds open (no delete sharing by default): libuv returns
// EPERM. Transient openers — co-process readers doing a split-second
// readFile/stat, antivirus, file indexers — come and go within single-digit
// milliseconds, so on Windows the caller-side facility retries EPERM with
// jitter before giving up. POSIX renames over open files directly and never
// takes the retry path.

import fs from 'node:fs/promises';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RenameReplaceOptions {
  /** Max EPERM retries before the error propagates (Windows only). */
  retries?: number;
  /** Base delay between retries in ms (a like-sized random jitter is added). */
  baseDelayMs?: number;
}

export async function renameReplace(src: string, dst: string, opts: RenameReplaceOptions = {}): Promise<void> {
  if (process.platform !== 'win32') return fs.rename(src, dst);
  const retries = opts.retries ?? 100;
  const base = opts.baseDelayMs ?? 20;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(src, dst);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= retries) throw e;
      await sleep(base + Math.floor(Math.random() * (base + 10)));
    }
  }
}
