// src/lockfile.ts
//
// A small exclusive file lock using atomic tmp+link creation, aligned with the
// repo's unified cross-process lock protocol (pid-only directory-lock mode —
// see agent-core-v2's `interface/crossProcessLock.ts`; the protocol is an
// on-disk contract, so this package inlines its own zero-dependency
// implementation).
//
// Invariants:
// - Token-guarded: every acquire writes a unique `lock_id`; the token is
//   compared after every winning create (read-back), on every settle
//   re-check, and before release/releaseSync unlink — a late operation never
//   deletes or mistakes a newer holder's lock.
// - A lock whose owner PID is alive is never taken over. Stale = dead PID, a
//   reused PID (processStartedAt identity mismatch), a payload without a
//   usable PID, or an empty/unparseable file older than the creation window
//   (a fresh one is "creating" → held; foreign publishers are not required to
//   write atomically — our own publishes are atomic tmp+link).
// - Takeover quarantines the corpse via rename to `db.lock.stale.<lock_id>`
//   (never delete+create, so a frozen creator resuming mid-window cannot be
//   clobbered and the takeover stays auditable), then re-creates via the
//   atomic link. A full re-inspect precedes every rename attempt so a live
//   winner is never quarantined.
// - Exactly one holder is a construction, not a timing bet: every contender
//   registers a liveness watch covering its whole attempt, and every creator
//   — direct or takeover — settles (adaptive backoff) until no live foreign
//   watch remains before claiming, so an in-flight co-racer always resolves
//   first.
//
// The correctness backstop is dead-PID takeover plus the token guard against
// deleting someone else's lock. The beforeExit hook is only a safety net (it
// never fires on SIGKILL) — the README documents takeover on dead PID as the
// recovery path.

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export class LockError extends Error {
  readonly code = 'ELOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

/** Milliseconds an empty/unparseable lock file counts as "creating" (held)
    rather than stale. Covers foreign publishers whose create and payload
    write are not atomic; our own publishes are atomic tmp+link. */
export const LOCK_CREATION_WINDOW_MS = 5000;

/** Test seam: every clock, pid, probe and token source is replaceable. */
export interface LockFileDeps {
  now?: () => number;
  selfPid?: number;
  probeProcess?: (pid: number) => { alive: boolean; processStartedAt?: string };
  /** Unique token of this acquire; compared on every guarded mutation. */
  newLockId?: () => string;
  /** Called exactly once when a held lock is replaced or disappears. */
  onLost?: () => void;
}

// Track held locks so we can release them on process exit as a safety net.
const HELD = new Set<LockFile>();
// Distinct sidecar names per acquire attempt: two lock users in the same
// process (e.g. independent shard pools) must never share a tmp/watch
// path, or one user's cleanup would delete the other's in-flight file.
let sidecarSeq = 0;
const nextSidecarSeq = (): number => ++sidecarSeq;
let exitHooked = false;
// Co-racers all move on the stale corpse within the same wave (they woke on
// the same event); the settle before any creator claims must outlast that
// wave so the last racer to land is unambiguous. A fixed value (even a
// generous one) loses on shared CI runners that deschedule a racer for
// hundreds of milliseconds inside its own atomic-op sequence, so the backoff
// is ADAPTIVE: it scales with how long our own takeover attempt took (a
// stalled machine stalls every racer), floored at 60ms and capped at 2s so a
// healthy takeover stays fast. Residual (bounded-delay, inherent to
// file-based takeover): a racer descheduled between its gate inspect and its
// quarantine rename can still rename-aside a fresh creator's lock — which is
// exactly why EVERY creator (direct or takeover) runs the watch settle
// before claiming: the thief is still inside its attempt, its watch keeps
// the victim settling, the victim sees its token gone from the file, and
// resolves without claiming.
const TAKEOVER_SETTLE_BASE_MS = 60;
const TAKEOVER_SETTLE_MAX_MS = 2_000;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('beforeExit', () => {
    for (const lock of HELD) lock.releaseSync();
  });
}

/** Opaque platform identity token for pid-reuse detection; compared by
    equality only, never parsed. Undefined when the platform cannot provide it
    or probing fails (conservative: degradation only *disables* takeover). */
function processStartedAtOf(pid: number): string | undefined {
  try {
    if (process.platform === 'darwin') {
      // e.g. `{ sec = 1759812345, usec = 123456 }`
      const out = execFileSync('sysctl', ['-n', 'kern.proc.starttime', String(pid)], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = /sec = (\d+), usec = (\d+)/.exec(out);
      return m ? `${m[1]}.${m[2]}` : undefined;
    }
    if (process.platform === 'linux') {
      // comm (field 2) may contain spaces/parens; field 22 (starttime) is the
      // 20th token (index 19) after the LAST ')'.
      const raw = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = raw.lastIndexOf(')');
      if (close === -1) return undefined;
      const rest = raw.slice(close + 1).trim().split(/\s+/);
      return rest.length > 19 ? rest[19] : undefined;
    }
  } catch {
    /* probing failure: no identity available */
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH: no such process (dead). EPERM: exists but another user (alive).
    // Any other failure is inconclusive — treat conservatively as alive.
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function defaultProbeProcess(pid: number): { alive: boolean; processStartedAt?: string } {
  const alive = pidAlive(pid);
  return { alive, processStartedAt: alive ? processStartedAtOf(pid) : undefined };
}

interface LockPayload {
  pid?: unknown;
  ts?: unknown;
  lock_id?: unknown;
  process_started_at?: unknown;
}

function tryParse(raw: string): LockPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as LockPayload) : undefined;
  } catch {
    return undefined;
  }
}

export class LockFile {
  readonly path: string;
  held = false;

  private lockId?: string;
  private startedAt?: string;
  private readonly now: () => number;
  private readonly selfPid: number;
  private readonly probeProcess: NonNullable<LockFileDeps['probeProcess']>;
  private readonly newLockId: () => string;
  private readonly onLost: (() => void) | undefined;

  constructor(path: string, deps: LockFileDeps = {}) {
    this.path = path;
    this.now = deps.now ?? Date.now;
    this.selfPid = deps.selfPid ?? process.pid;
    this.probeProcess = deps.probeProcess ?? defaultProbeProcess;
    this.newLockId = deps.newLockId ?? randomUUID;
    this.onLost = deps.onLost;
  }

  /** Try to acquire the lock exactly once. Returns true when this call created
   *  the lock file, either directly or by winning a stale-lock takeover. Returns
   *  false whenever the lock was already held at attempt time — by a live owner
   *  or by a competing takeover. After observing a held lock this call never
   *  re-races: callers that want to wait retry acquire() at a higher level
   *  (see the cluster lock pool). */
  async acquire(): Promise<boolean> {
    const lockId = this.newLockId();
    this.startedAt ??= processStartedAtOf(this.selfPid);
    // Register a "watch" BEFORE touching the lock: every contender is visible
    // to every other for its whole attempt, regardless of where the scheduler
    // stalls it. (Settle-window heuristics alone could not survive a racer
    // descheduled before its quarantine rename on a shard-parallel CI runner —
    // see the takeover loop below; a stalled contender is only in the way, not
    // invisible.)
    const watch = `${this.path}.watch-${process.pid}-${nextSidecarSeq()}`;
    await fs.writeFile(watch, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    try {
      await this.reapDeadWatches();

      if (await this.tryCreate(lockId)) {
        // A direct creator must settle exactly like a takeover winner (see
        // settleForForeignWatches): a co-racer that gate-inspected a corpse
        // before it vanished can still be descheduled between that inspect
        // and its quarantine rename, and its late rename would steal this
        // fresh lock AFTER our confirm — the historical "two processes
        // believe they hold the lock" failure the settle exists to prevent.
        if (!(await this.settleForForeignWatches(lockId, watch, TAKEOVER_SETTLE_BASE_MS))) {
          return false;
        }
        return await this.confirmCreated(lockId);
      }

      // The lock exists. Only a STALE owner's lock may be taken over;
      // everything else (a live owner, a takeover won by another racer in the
      // meantime) is respected.
      const seen = await this.inspect();
      if (seen === null || seen.alive) return false;

      // Takeover via quarantine-rename, NOT unlink-then-create. Unlinking a
      // stale lock and then racing to re-create it left a window in which a
      // loser could delete the winner's just-linked file, after which several
      // processes all believed they held the lock. Renaming the corpse aside
      // is atomic and auditable, and the subsequent tmp+link create admits
      // exactly one winner.
      //
      // Windows cannot rename a file while ANY process holds it open
      // (co-racers reading/stat'ing the corpse make the rename EPERM), so the
      // rename is retried with jitter. Crucially, each retry re-inspects the
      // file first: a blind retry loop could quarantine a live winner's lock
      // seconds late (exactly the failure this loop is careful not to
      // reintroduce).
      const attemptStart = Date.now();
      const stalePath = `${this.path}.stale.${seen.lockId ?? 'unknown'}`;
      for (let attempt = 0; ; attempt++) {
        // The corpse must still be there and stale. A competitor who landed
        // wins by being alive in the file now — back off instead of
        // quarantining their lock. (Unconditional, not just win32: the same
        // hazard exists on POSIX when a co-racer is descheduled between its
        // first inspect and its rename.)
        const gate = await this.inspect();
        if (gate === null || gate.alive || gate.mine) return false;
        try {
          await fs.rename(this.path, stalePath);
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') break; // a co-racer quarantined it first
          const epermRetryable =
            code === 'EPERM' && process.platform === 'win32' && attempt < 50;
          if (!epermRetryable) {
            // A persistent EPERM (Windows retries exhausted) means some holder
            // kept the path pinned — the corpse could not be displaced this
            // round, so decline like a live lock and let callers retry higher
            // up.
            if (code === 'EPERM' || code === 'EEXIST') return false;
            throw e;
          }
          await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)));
        }
      }

      if (!(await this.tryCreate(lockId))) return false;

      // Adaptive settle: scale with how long our own attempt took (a stalled
      // machine stalls every racer), floored and capped (see the constants).
      const elapsedMs = Date.now() - attemptStart;
      const initialSettleMs = Math.min(
        TAKEOVER_SETTLE_MAX_MS,
        Math.max(TAKEOVER_SETTLE_BASE_MS, elapsedMs * 4),
      );
      if (!(await this.settleForForeignWatches(lockId, watch, initialSettleMs))) return false;
      return await this.confirmCreated(lockId);
    } finally {
      await fs.unlink(watch).catch(() => {});
    }
  }

  /** Atomic create-if-absent publish: tmp write + hard link (EEXIST-safe). */
  private async tryCreate(lockId: string): Promise<boolean> {
    const tmp = `${this.path}.tmp-${process.pid}-${nextSidecarSeq()}`;
    try {
      await fs.writeFile(tmp, this.payload(lockId));
      await fs.link(tmp, this.path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return false;
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  /** Read-back confirm: the file we just linked must still carry our token —
   *  a co-racer resuming inside the takeover window may have replaced it. */
  private async confirmCreated(lockId: string): Promise<boolean> {
    const back = await this.readDiskText();
    if (back === undefined || tryParse(back)?.lock_id !== lockId) return false;
    this.lockId = lockId;
    this.held = true;
    HELD.add(this);
    hookExit();
    return true;
  }

  private payload(lockId: string): string {
    return JSON.stringify({
      pid: this.selfPid,
      ts: this.now(),
      lock_id: lockId,
      // Legacy readers see only `pid`/`ts`; `lock_id`/`process_started_at`
      // follow the unified protocol's snake_case disk keys. Absent when the
      // platform cannot provide a start-time identity (e.g. macOS).
      process_started_at: this.startedAt,
    });
  }

  /** Read the lock file and decide its state. null = the file vanished. */
  private async inspect(): Promise<{ alive: boolean; mine: boolean; lockId?: string } | null> {
    const raw = await this.readDiskText();
    if (raw === undefined) return null;
    const st = await fs.stat(this.path).catch(() => undefined);
    if (st === undefined) return null;
    const parsed = raw.trim() === '' ? undefined : tryParse(raw);
    if (parsed === undefined) {
      // Empty or unparseable: a foreign publisher may be mid-write. Only past
      // the creation window is it definitively stale.
      return { alive: this.now() - st.mtimeMs < LOCK_CREATION_WINDOW_MS, mine: false };
    }
    const pid = parsed.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      // A parsed payload without a usable PID cannot be owned by anyone.
      return { alive: false, mine: false, lockId: stringOrUndefined(parsed.lock_id) };
    }
    const probe = this.probeProcess(pid);
    let alive = probe.alive;
    const diskStartedAt = stringOrUndefined(parsed.process_started_at);
    if (
      alive &&
      probe.processStartedAt !== undefined &&
      diskStartedAt !== undefined &&
      probe.processStartedAt !== diskStartedAt
    ) {
      // PID alive but identity differs: the PID was reused by a new process,
      // the original holder is dead. Treated as dead.
      alive = false;
    }
    // Live, identity matching or unavailable: never take over a live PID.
    return { alive, mine: pid === process.pid, lockId: stringOrUndefined(parsed.lock_id) };
  }

  /** File contents, `undefined` only when the file is gone. */
  private async readDiskText(): Promise<string | undefined> {
    try {
      return await fs.readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
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

  /** Exactly-one is a construction, not a timing bet: after winning the
   *  create, wait until no live foreign watch remains. A watch covers its
   *  owner's WHOLE attempt (registration precedes the first lock touch), so
   *  an in-flight co-racer — e.g. one descheduled between its gate inspect
   *  and its quarantine rename — always resolves before we claim; if its
   *  late rename quarantined our fresh lock, our token is gone from the file
   *  and we resolve WITHOUT claiming. Adaptive backoff: a stalled machine
   *  stalls every racer, so the pause doubles while contention persists. */
  private async settleForForeignWatches(
    lockId: string,
    ownWatch: string,
    initialSettleMs: number,
  ): Promise<boolean> {
    let settleMs = initialSettleMs;
    for (;;) {
      const cur = await this.inspect();
      if (cur === null || cur.lockId !== lockId) return false;
      if (!(await this.hasLiveForeignWatch(ownWatch))) return true;
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      settleMs = Math.min(TAKEOVER_SETTLE_MAX_MS, settleMs * 2);
    }
  }

  /** True when any OTHER attempt's liveness watch exists (reaping dead ones
   *  on sight). Compared by watch NAME, not pid: two LockFile users in one
   *  process (e.g. independent shard pools) can contest the same lock and
   *  must see each other's watches despite sharing a pid. */
  private async hasLiveForeignWatch(ownWatch: string): Promise<boolean> {
    const dir = path.dirname(this.path);
    const prefix = `${path.basename(this.path)}.watch-`;
    const own = path.basename(ownWatch);
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!f.startsWith(prefix) || f === own) continue;
      const pid = Number(f.slice(prefix.length).split('-')[0]);
      if (!Number.isInteger(pid)) continue;
      if (pidAlive(pid)) return true;
      await fs.unlink(path.join(dir, f)).catch(() => {});
    }
    return false;
  }

  /** Refresh the lock timestamp (proves liveness to processes inspecting the
   *  lock file). No-op when the lock is not held. The update is bound to the
   *  inode whose token was verified: replacing the public path after open can
   *  only make this holder lose ownership, never overwrite the replacement. */
  async renew(): Promise<void> {
    if (!this.held || this.lockId === undefined) return;
    const lockId = this.lockId;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.path, 'r+');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.markLost();
        return;
      }
      throw error;
    }
    try {
      const raw = await handle.readFile({ encoding: 'utf8' });
      if (tryParse(raw)?.lock_id !== lockId) {
        this.markLost();
        return;
      }
      const data = Buffer.from(this.payload(lockId));
      await handle.write(data, 0, data.length, 0);
      await handle.truncate(data.length);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (tryParse((await this.readDiskText()) ?? '')?.lock_id !== lockId) {
      this.markLost();
    }
  }

  /** Token-guarded release. Idempotent; a missing or foreign-owned file is
      never unlinked. */
  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    HELD.delete(this);
    const lockId = this.lockId;
    this.lockId = undefined;
    try {
      const raw = await this.readDiskText();
      if (raw !== undefined && tryParse(raw)?.lock_id === lockId) {
        await fs.unlink(this.path).catch(() => {});
      }
    } catch {
      // Missing or unreadable: nothing of ours to remove (best-effort).
    }
  }

  releaseSync(): void {
    if (!this.held) return;
    this.held = false;
    HELD.delete(this);
    const lockId = this.lockId;
    this.lockId = undefined;
    try {
      const raw = fsSync.readFileSync(this.path, 'utf8');
      if (tryParse(raw)?.lock_id === lockId) fsSync.unlinkSync(this.path);
    } catch {
      /* same policy as release(): never unlink on uncertainty */
    }
  }

  private markLost(): void {
    if (!this.held) return;
    this.held = false;
    this.lockId = undefined;
    HELD.delete(this);
    this.onLost?.();
  }
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
