// src/lockfile.ts
//
// A small exclusive file lock using O_EXCL creation. Used to prevent two
// processes from opening the same database directory for writing (which would
// corrupt it). A lock is considered stale and is taken over only when the
// recorded owner PID is no longer alive — never merely because it is old.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
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
// Distinct sidecar names per acquire attempt: two lock users in the same
// process (e.g. independent shard pools) must never share a tmp/bid/watch
// path, or one user's cleanup would delete the other's in-flight file.
let sidecarSeq = 0;
const nextSidecarSeq = (): number => ++sidecarSeq;
let exitHooked = false;
// Co-bidders all replace the stale corpse within the same wave (they woke on
// the same event); the settle pause before the winner claims the lock must
// outlast that wave so the last bidder to land is unambiguous. A fixed value
// (even a generous one) loses on shared CI runners that deschedule a bidder
// for hundreds of milliseconds inside its own atomic-op sequence, so the
// settle is ADAPTIVE: it scales with how long our own takeover attempt took
// (4x the wall clock of inspect+writeBid+rename — a stalled machine stalls
// every bidder), floored at 60ms and capped at 2s so a healthy takeover stays
// fast. Residual (bounded-delay, inherent to file-based takeover): a bidder
// whose writeBid is delayed past the winner's final verify can still
// double-win — the bid-file sweep at verification shrinks this window to
// "competitor had not even started writing their bid yet", which requires a
// full-attempt+settle-sized skew and is effectively a process-level pause.
const TAKEOVER_SETTLE_BASE_MS = 60;
const TAKEOVER_SETTLE_MAX_MS = 2_000;
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
    // Register a "watch" BEFORE touching the lock: every contender is visible
    // to every other for its whole attempt, regardless of where the scheduler
    // stalls it. (Settle-window heuristics alone could not survive a bidder
    // descheduled before its bid write on a shard-parallel CI runner — see the
    // takeover loop below; a stalled contender is only in the way, not
    // invisible.)
    const watch = `${this.path}.watch-${process.pid}-${nextSidecarSeq()}`;
    await fs.writeFile(watch, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    try {
      await this.reapDeadWatches();

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
      // the corpse with our bid.
      //
      // Windows cannot rename over a destination while ANY process holds it
      // open (co-racers reading/stat'ing the corpse make the rename EPERM), so
      // the rename is retried with jitter. Crucially, each retry re-inspects
      // the corpse first: a blind retry loop could land our bid seconds late,
      // OVERWRITING an already-verified winner's lock line and double-holding
      // (exactly the failure this loop is careful not to reintroduce).
      const bid = `${this.path}.bid-${process.pid}-${nextSidecarSeq()}`;
      const attemptStart = Date.now();
      try {
        await fs.writeFile(bid, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        for (let attempt = 0; ; attempt++) {
          // The corpse must still be there and dead. A competitor who landed
          // wins by being alive in the file now — back off instead of
          // overwriting their lock. (Unconditional, not just win32: the same
          // overwrite hazard exists on POSIX when a co-bidder is descheduled
          // between its first inspect and its rename.)
          const gate = await this.inspect();
          if (gate === null || gate.alive || gate.mine) {
            await fs.unlink(bid).catch(() => {});
            return false;
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

      // Adaptive settle: scale with how long our own attempt took (a stalled
      // machine stalls every bidder), floored and capped (see the constants).
      const elapsedMs = Date.now() - attemptStart;
      let settleMs = Math.min(TAKEOVER_SETTLE_MAX_MS, Math.max(TAKEOVER_SETTLE_BASE_MS, elapsedMs * 4));
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        const cur = await this.inspect();
        if (cur === null || !cur.mine) return false;
        // Any live foreign watch means a contender is still in flight (its
        // registration precedes its whole attempt): wait for its loop to
        // finish instead of claiming on stale evidence. This is the check
        // that makes exactly-one a construction, not a timing bet.
        if (!(await this.hasLiveForeignWatch())) break;
        settleMs = Math.min(TAKEOVER_SETTLE_MAX_MS, settleMs * 2);
      }
      this.markHeld();
      return true;
    } finally {
      await fs.unlink(watch).catch(() => {});
    }
  }

  /** Delete watch registrations whose owner pid is no longer alive. */
  private async reapDeadWatches(): Promise<void> {
    const dir = path.dirname(this.path);
    const prefix = `${path.basename(this.path)}.watch-`;
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!f.startsWith(prefix)) continue;
      const pid = Number(f.slice(prefix.length).split('-')[0]);
      if (Number.isInteger(pid) && pid !== process.pid && !pidAlive(pid)) {
        await fs.unlink(path.join(dir, f)).catch(() => {});
      }
    }
  }

  /** True when any OTHER process's liveness watch exists (reaping dead ones on sight). */
  private async hasLiveForeignWatch(): Promise<boolean> {
    const dir = path.dirname(this.path);
    const prefix = `${path.basename(this.path)}.watch-`;
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!f.startsWith(prefix)) continue;
      const pid = Number(f.slice(prefix.length).split('-')[0]);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      if (pidAlive(pid)) return true;
      await fs.unlink(path.join(dir, f)).catch(() => {});
    }
    return false;
  }

  /** Atomic create-if-absent publish: tmp write + hard link (EEXIST-safe). */
  private async tryCreate(): Promise<boolean> {
    const tmp = `${this.path}.tmp-${process.pid}-${nextSidecarSeq()}`;
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
    const tmp = `${this.path}.tmp-${process.pid}-${nextSidecarSeq()}`;
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
