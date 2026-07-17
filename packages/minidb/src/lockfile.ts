// src/lockfile.ts
//
// A small exclusive file lock using O_EXCL creation. Used to prevent two
// processes from opening the same database directory for writing (which would
// corrupt it). A lock is considered stale and is taken over only when the
// recorded owner PID is no longer alive — never merely because it is old.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { renameReplace } from './rename-replace.js';

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
// Co-bidders all replace the stale corpse within the same microsecond-scale
// wave (they woke on the same event); this settle pause must outlast that wave
// so the last bidder to land is unambiguous before the winner claims the lock.
// Sized for heavily loaded CI machines, which can deschedule a bidder for tens
// of milliseconds inside its own atomic-op sequence. (Still a bounded-delay
// heuristic: a bidder stalled longer than the settle can still double-win —
// inherent to file-based takeover, mitigations live in the design notes.)
const TAKEOVER_SETTLE_MS = 50;
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

  /** Try to acquire the lock exactly once. Returns true when this call created
   *  the lock file, either directly or by winning a stale-lock takeover. Returns
   *  false whenever the lock was already held at attempt time — by a live owner
   *  or by a competing takeover. After observing a held lock this call never
   *  re-races: callers that want to wait retry acquire() at a higher level
   *  (see the cluster lock pool). */
  async acquire(): Promise<boolean> {
    if (await this.tryCreate()) return true;

    // The lock exists. Only a DEAD owner's lock may be taken over; everything
    // else (a live owner, or a takeover bid made by another racer in the
    // meantime) is respected.
    const seen = await this.inspect();
    if (seen === null || seen.alive) return false;

    // Takeover via atomic bid-replace, NOT unlink-then-create. Unlinking a
    // stale lock and then racing to re-create it left a window in which a
    // loser could delete the winner's just-linked file, after which several
    // processes all believed they held the lock. Rename atomically replaces
    // the corpse with our bid; after a settle window that outlasts any same-wave
    // co-bidder, the last bidder finds its own pid still in place and wins —
    // everyone else sees a live foreign lock and backs off.
    //
    // Windows cannot rename over a destination while ANY process holds it
    // open (co-racers reading/stat'ing the corpse make the rename EPERM), so
    // the rename is retried with jitter. Crucially, each retry re-inspects
    // the corpse first: a blind retry loop could land our bid seconds late,
    // OVERWRITING an already-verified winner's lock line and double-holding
    // (exactly the failure this loop is careful not to reintroduce).
    const bid = `${this.path}.bid-${process.pid}`;
    try {
      await fs.writeFile(bid, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      for (let attempt = 0; ; attempt++) {
        // The corpse must still be there and dead. A competitor who landed
        // wins by being alive in the file now — back off instead of
        // overwriting their lock.
        if (process.platform === 'win32') {
          const cur = await this.inspect();
          if (cur === null || cur.alive || cur.mine) {
            await fs.unlink(bid).catch(() => {});
            return false;
          }
        }
        try {
          await fs.rename(bid, this.path);
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          const epermRetryable =
            code === 'EPERM' && process.platform === 'win32' && attempt < 50;
          if (!epermRetryable) {
            await fs.unlink(bid).catch(() => {});
            // EEXIST races another creator; a persistent EPERM (Windows
            // retries exhausted) means some holder kept the path pinned —
            // either way the corpse could not be displaced this round, so
            // decline like a live lock and let callers retry higher up.
            if (code === 'EEXIST' || code === 'EPERM') return false;
            throw e;
          }
          await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)));
        }
      }
    } catch (e) {
      await fs.unlink(bid).catch(() => {});
      throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, TAKEOVER_SETTLE_MS));
    const cur = await this.inspect();
    if (cur === null || !cur.mine) return false;
    this.markHeld();
    return true;
  }

  /** Atomic create-if-absent publish: tmp write + hard link (EEXIST-safe). */
  private async tryCreate(): Promise<boolean> {
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      await fs.link(tmp, this.path);
      this.markHeld();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return false;
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  /** Read the lock file and decide its state. null = the file vanished. */
  private async inspect(): Promise<{ ino: number | bigint; alive: boolean; mine: boolean } | null> {
    let raw: string;
    let st: { ino: number | bigint };
    try {
      [raw, st] = await Promise.all([fs.readFile(this.path, 'utf8'), fs.stat(this.path)]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    let pid: number | undefined;
    try {
      pid = (JSON.parse(raw) as { pid?: number }).pid;
    } catch {
      pid = undefined; // unparsable content looks abandoned, same as a dead PID
    }
    return { ino: st.ino, alive: pidAlive(pid), mine: pid === process.pid };
  }

  private inspectSync(): { ino: number | bigint; alive: boolean; mine: boolean } | null {
    let raw: string;
    let st: { ino: number | bigint };
    try {
      raw = fsSync.readFileSync(this.path, 'utf8');
      st = fsSync.statSync(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    let pid: number | undefined;
    try {
      pid = (JSON.parse(raw) as { pid?: number }).pid;
    } catch {
      pid = undefined;
    }
    return { ino: st.ino, alive: pidAlive(pid), mine: pid === process.pid };
  }

  /** Refresh the lock timestamp (proves liveness to processes inspecting the
   *  lock file). No-op when the lock is not held. Uses write-tmp-then-rename
   *  so a crash mid-renew cannot leave a truncated, "stale-looking" lock file
   *  behind for a lock that is actually still owned. */
  async renew(): Promise<void> {
    if (!this.held) return;
    const tmp = `${this.path}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    // Windows: replacing our own lock can still clash with a co-process's
    // readFile/stat of it (EPERM) — the helper rides out such transients.
    await renameReplace(tmp, this.path, { retries: 20 });
  }

  private markHeld(): void {
    this.held = true;
    HELD.add(this);
    hookExit();
  }

  async release(): Promise<void> {
    if (!this.held) return;
    // Unlink ONLY the file this instance actually owns. The content at this
    // path may have been replaced since we acquired it (a supervisor re-plant a
    // dead-man's marker, a concurrent takeover…), and deleting such a file
    // would drop a lock that no longer belongs to us.
    const cur = await this.inspect();
    if (cur?.mine) await fs.unlink(this.path).catch(() => {});
    this.held = false;
    HELD.delete(this);
  }

  /** Best-effort sync release for the exit hook. */
  releaseSync(): void {
    if (!this.held) return;
    try {
      const cur = this.inspectSync();
      if (cur?.mine) fsSync.unlinkSync(this.path);
    } catch {
      /* ignore */
    }
    this.held = false;
    HELD.delete(this);
  }
}
