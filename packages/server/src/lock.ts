/**
 * Filesystem lock for single-instance server enforcement.
 *
 * The lock is a small JSON file at `<KIMI_CODE_HOME>/server/lock` (defaults
 * to `~/.kimi-code/server/lock`; overridable via `KIMI_CODE_HOME` env or
 * `lockPath` for tests). It records the live server's `pid`, `started_at`,
 * and `port`. Acquisition is exclusive (`O_WRONLY | O_CREAT | O_EXCL`) —
 * racing servers can't both win.
 *
 * Stale lock takeover: when a lock file exists, we ping the recorded pid via
 * `process.kill(pid, 0)`. Node's `kill` does NOT send a signal when sig is 0 —
 * it only probes existence (man kill(2)). If the probe throws `ESRCH` the
 * process is gone and we take over by `unlink` + retry. If the probe succeeds
 * (or throws `EPERM`, meaning the process exists but is owned by another user),
 * we throw `ESERVER_LOCKED` so the caller surfaces the conflict to stderr.
 *
 * Race vs. takeover: the stale-check sees a dead pid, then unlinks, then
 * re-acquires with `O_EXCL`. If a third party slipped in between unlink and
 * re-create, `O_EXCL` returns `EEXIST`, which we propagate (don't loop) — the
 * operator should see the conflict, not silently overwrite.
 *
 * Release is best-effort: if the file is missing or its `pid` no longer
 * matches ours, we log and continue rather than throw. Crashed servers may
 * leave the file dangling; the next start's stale-check cleans it up.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  openSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveKimiHome } from '@moonshot-ai/agent-core';

export const DEFAULT_LOCK_DIR = join(resolveKimiHome(), 'server');
export const DEFAULT_LOCK_PATH = join(DEFAULT_LOCK_DIR, 'lock');

/** JSON shape stored in the lock file. snake_case to match operator-facing logs. */
export interface LockContents {
  pid: number;
  started_at: string;
  host?: string;
  port: number;
  /** Host CLI version that started this server (e.g. kimi-code package version).
      Lets `kimi server status` detect a build-mismatched server. Absent in locks
      written by older builds. */
  host_version?: string;
  /** Absolute path of the CLI entry that spawned the server. Distinguishes two
      installs that share a version string (e.g. two pkg.pr.new builds of the
      same base version living in different npx cache dirs). */
  entry?: string;
}

export interface AcquireLockOptions {
  /** Override default `<KIMI_CODE_HOME>/server/lock` — used in tests. */
  lockPath?: string;
  /** Port the server will bind to. Recorded in the lock file for diagnostics. */
  port: number;
  /** Host the server will bind to. Recorded in the lock file for diagnostics. */
  host?: string;
  /** Host CLI version, recorded as `host_version` for build-mismatch detection. */
  hostVersion?: string;
  /** CLI entry path that spawned this server, recorded as `entry`. */
  entry?: string;
  /** Override `new Date().toISOString()` — used in tests for deterministic output. */
  nowIso?: string;
  /**
   * Override `process.pid` — used in tests where we want to simulate a
   * different server owning the lock. Production callers should not set this.
   */
  pid?: number;
}

export interface AcquireLockResult {
  /** Idempotent release: safe to call multiple times; best-effort on missing/mismatched lock. */
  release(): void;
  /** Absolute path of the lock file that was acquired. */
  lockPath: string;
  /**
   * Rewrite the lock file's recorded `port` to the one actually bound. Used
   * when the requested port was busy (held by a third-party process) and the
   * server retried on `port + 1`: the lock must advertise the real port so
   * `kimi server status` / `kill` / `ps` can find the daemon. Best-effort and
   * ownership-guarded — a no-op when the file is missing, owned by another
   * pid, or already records `port`.
   */
  updatePort(port: number): void;
}

/** Error thrown when another server is already holding the lock. */
export class ServerLockedError extends Error {
  override readonly name = 'ServerLockedError';
  readonly code = 'ESERVER_LOCKED' as const;
  /**
   * Process exit code preferred by CLI consumers. `2` is distinct from generic
   * failure `1` so operators can scriptly distinguish
   * "another server is running" from "server crashed". Commander reads this if
   * present; library callers can ignore it.
   */
  readonly exitCode = 2 as const;
  readonly existing: LockContents;
  constructor(message: string, existing: LockContents) {
    super(message);
    this.existing = existing;
  }
}

/** `process.kill(pid, 0)` probe — true if the pid exists, false on ESRCH. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM = process exists but we can't signal it (different user). Treat as alive.
    if (code === 'EPERM') return true;
    // Anything else: be safe, assume alive so we don't clobber.
    return true;
  }
}

/** Read + JSON.parse the lock file; returns undefined on any error so callers can fall through. */
function readLockContents(path: string): LockContents | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as LockContents).pid === 'number' &&
      typeof (parsed as LockContents).started_at === 'string' &&
      typeof (parsed as LockContents).port === 'number'
    ) {
      return parsed as LockContents;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the lock file and return its contents only when it describes a *live*
 * server (parseable JSON whose recorded pid still exists). Returns `undefined`
 * when the file is missing, unparseable, or stale (dead pid) — i.e. when there
 * is no daemon to reuse. Read-only: never mutates the lock.
 */
export function getLiveLock(lockPath: string = DEFAULT_LOCK_PATH): LockContents | undefined {
  const contents = readLockContents(lockPath);
  if (!contents) return undefined;
  return pidAlive(contents.pid) ? contents : undefined;
}

/**
 * Try `O_WRONLY | O_CREAT | O_EXCL` to create the lock file with the contents.
 * Returns true on success, false on EEXIST. Throws on any other fs error.
 */
function tryExclusiveCreate(path: string, contents: LockContents): boolean {
  let fd: number | undefined;
  try {
    // 0o100 (O_CREAT) | 0o200 (O_EXCL) | 0o2 (O_RDWR) — but `openSync` accepts the
    // string flag form which is portable.
    fd = openSync(path, 'wx');
    writeFileSync(fd, JSON.stringify(contents));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed by writeFileSync in some Node versions — ignore.
      }
    }
  }
}

/**
 * Acquire an exclusive lock for this server instance. Throws `ServerLockedError`
 * if another live server holds the lock; silently takes over a stale lock whose
 * recorded pid is no longer running.
 */
export function acquireLock(opts: AcquireLockOptions): AcquireLockResult {
  const lockPath = opts.lockPath ?? DEFAULT_LOCK_PATH;
  const pid = opts.pid ?? process.pid;
  const startedAt = opts.nowIso ?? new Date().toISOString();
  const contents: LockContents = {
    pid,
    started_at: startedAt,
    host: opts.host,
    port: opts.port,
    ...(opts.hostVersion !== undefined ? { host_version: opts.hostVersion } : {}),
    ...(opts.entry !== undefined ? { entry: opts.entry } : {}),
  };

  mkdirSync(dirname(lockPath), { recursive: true });

  // First try: clean acquire.
  if (tryExclusiveCreate(lockPath, contents)) {
    return makeReleaseHandle(lockPath, pid);
  }

  // Lock exists — inspect.
  const existing = readLockContents(lockPath);
  if (existing && pidAlive(existing.pid)) {
    // Live owner — refuse to take over. Note that "same pid as ours" still
    // counts as live: callers that genuinely want to swap should release the
    // existing handle first, not stomp via acquireLock.
    throw new ServerLockedError(
      `server already running (pid=${existing.pid}, port=${existing.port}, started=${existing.started_at})`,
      existing,
    );
  }

  // Stale (dead pid) or unparseable — take over.
  try {
    unlinkSync(lockPath);
  } catch (err) {
    // EBUSY/ENOENT both acceptable — race with another concurrent acquirer.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  if (!tryExclusiveCreate(lockPath, contents)) {
    // Someone slipped in. Re-read for diagnostic.
    const winner = readLockContents(lockPath);
    throw new ServerLockedError(
      winner
        ? `server already running (pid=${winner.pid}, port=${winner.port}, started=${winner.started_at})`
        : 'lock file present but unreadable',
      winner ?? { pid: -1, started_at: '', port: opts.port },
    );
  }
  return makeReleaseHandle(lockPath, pid);
}

function makeReleaseHandle(lockPath: string, ownerPid: number): AcquireLockResult {
  let released = false;
  return {
    lockPath,
    release(): void {
      if (released) return;
      released = true;
      if (!existsSync(lockPath)) return;
      const contents = readLockContents(lockPath);
      if (contents && contents.pid !== ownerPid) {
        // Someone else owns the lock now — don't touch it.
        return;
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort: file may have vanished between existsSync and unlinkSync.
      }
    },
    updatePort(port: number): void {
      if (!existsSync(lockPath)) return;
      const contents = readLockContents(lockPath);
      // Only rewrite our own lock, and only when the port actually changed.
      if (!contents || contents.pid !== ownerPid || contents.port === port) return;
      try {
        writeFileSync(lockPath, JSON.stringify({ ...contents, port }));
      } catch {
        // Best-effort: a concurrent release/takeover may have removed the file.
      }
    },
  };
}
