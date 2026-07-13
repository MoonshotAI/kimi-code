// src/lockfile.ts
//
// A small exclusive file lock using O_EXCL creation. Used to prevent two
// processes from opening the same database directory for writing (which would
// corrupt it). A lock is considered stale and is taken over only when the
// recorded owner PID is no longer alive — never merely because it is old.

import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';

export class LockError extends Error {
  readonly code = 'ELOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

function pidAlive(pid: unknown): boolean {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Track held locks so we can release them on process exit as a safety net.
const HELD = new Set<LockFile>();
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('beforeExit', () => {
    for (const lock of HELD) lock.releaseSync();
  });
}

export class LockFile {
  readonly path: string;
  held = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Try to acquire the lock. Returns true if acquired, false if held by a live process. */
  async acquire(): Promise<boolean> {
    try {
      const fh = await fs.open(this.path, 'wx'); // O_CREAT | O_EXCL | O_WRONLY
      await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
      await fh.close();
      this.markHeld();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (await this.isStale()) {
      await fs.unlink(this.path).catch(() => {});
      return this.acquire();
    }
    return false;
  }

  private async isStale(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const { pid } = JSON.parse(raw) as { pid?: number };
      return !pidAlive(pid);
    } catch {
      return true;
    }
  }

  private markHeld(): void {
    this.held = true;
    HELD.add(this);
    hookExit();
  }

  async release(): Promise<void> {
    if (!this.held) return;
    await fs.unlink(this.path).catch(() => {});
    this.held = false;
    HELD.delete(this);
  }

  /** Best-effort sync release for the exit hook. */
  releaseSync(): void {
    if (!this.held) return;
    try {
      unlinkSync(this.path);
    } catch {
      /* ignore */
    }
    this.held = false;
    HELD.delete(this);
  }
}
