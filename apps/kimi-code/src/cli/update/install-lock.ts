import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getUpdateInstallLockFile } from '#/utils/paths';
import { createFileIfAbsent } from '#/utils/persistence';

const UPDATE_INSTALL_LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * A takeover's critical section is a few syscalls (microseconds), so a
 * takeover lock older than this is crash residue and may be swept freely.
 */
const TAKEOVER_LOCK_STALE_MS = 60_000;

/**
 * On filesystems without hard links the lock is published by an exclusive
 * create + write (see createFileIfAbsent), which IS observable between create
 * and write. A young unparseable lock is almost always that publish window,
 * not corruption — only an unparseable lock older than this is swept as
 * crash residue.
 */
const LOCK_PUBLISH_GRACE_MS = 60_000;

export interface UpdateInstallLockRequest {
  readonly version: string;
  readonly now?: Date;
}

export interface UpdateInstallLockHandle {
  readonly filePath: string;
  /** The exact contents this handle published — its ownership identity. */
  readonly content: string;
  release(): Promise<void>;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST'
  );
}

/**
 * Liveness probe for the lock holder. Signal 0 delivers nothing; ESRCH means
 * the process is gone, EPERM means it exists but may not be signalled — which
 * still counts as alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockInspection {
  readonly content: string;
  readonly mtimeMs: number;
}

/** Read the lock file's content and mtime; null when it is gone/unreadable. */
async function inspectLockFile(filePath: string): Promise<LockInspection | null> {
  const content = await readFile(filePath, 'utf-8').catch(() => null);
  if (content === null) return null;
  const info = await stat(filePath).catch(() => null);
  if (info === null) return null;
  return { content, mtimeMs: info.mtimeMs };
}

/**
 * Staleness check over the lock file's CONTENTS. Shapeless content counts as
 * stale (crash residue). Unparseable content is also crash residue — but only
 * once it is older than the publish grace: on filesystems without hard links
 * a fallback publish is observable mid-write (see LOCK_PUBLISH_GRACE_MS), and
 * sweeping that window would break exclusivity. A holder that is gone can
 * never release its lock (a killed process skips its finally) nor make
 * progress — stale at ANY age; the atomic publish guarantees the pid was
 * written complete by a then-live process, so a dead pid means the holder
 * died afterwards. Past the age threshold a LIVE holder still survives: a
 * native download is idle-bounded but intentionally not duration-bounded, so
 * a slow link legitimately exceeds it. (A pid reused by an unrelated process
 * can pin the lock until that process exits — a delayed update, never a
 * corrupt one.)
 */
function isStaleLock(inspection: LockInspection, now: Date): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspection.content);
  } catch {
    return now.getTime() - inspection.mtimeMs > LOCK_PUBLISH_GRACE_MS;
  }
  if (typeof parsed !== 'object' || parsed === null) return true;
  const lock = parsed as { readonly startedAt?: unknown; readonly pid?: unknown };
  if (typeof lock.startedAt !== 'string') return true;
  const startedAt = Date.parse(lock.startedAt);
  if (!Number.isFinite(startedAt)) return true;
  if (typeof lock.pid === 'number' && !isProcessAlive(lock.pid)) return true;
  if (now.getTime() - startedAt <= UPDATE_INSTALL_LOCK_STALE_MS) return false;
  return typeof lock.pid !== 'number';
}

async function createLockFile(
  filePath: string,
  request: UpdateInstallLockRequest,
): Promise<UpdateInstallLockHandle | null> {
  const now = request.now ?? new Date();
  const content = `${JSON.stringify({
    version: request.version,
    pid: process.pid,
    startedAt: now.toISOString(),
  }, null, 2)}\n`;
  // Publish atomically and only into a still-free path (EEXIST propagates to
  // the caller's inspection flow). The lock file is never observable empty
  // on filesystems with hard links; elsewhere the exclusive-create fallback
  // leaves a brief publish window, which the inspection side covers with
  // LOCK_PUBLISH_GRACE_MS.
  await createFileIfAbsent(filePath, content);
  // A racing stale-takeover may have removed our just-published lock and
  // published its own; only the survivor may proceed.
  const published = await readFile(filePath, 'utf-8').catch(() => null);
  if (published !== content) return null;

  return {
    filePath,
    content,
    release: async (): Promise<void> => {
      // Release only the lock instance we own: a stale takeover may have
      // replaced the file since we published it.
      const current = await readFile(filePath, 'utf-8').catch(() => null);
      if (current !== content) return;
      await unlink(filePath).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    },
  };
}

export async function tryAcquireUpdateInstallLock(
  request: UpdateInstallLockRequest,
  filePath: string = getUpdateInstallLockFile(),
): Promise<UpdateInstallLockHandle | null> {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    return await createLockFile(filePath, request);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  // A lock file exists. Inspect it once to decide whether it is stale.
  const inspected = await inspectLockFile(filePath);
  if (inspected !== null && !isStaleLock(inspected, request.now ?? new Date())) {
    return null;
  }
  if (inspected === null) {
    // Vanished between create and read — retry the create once.
    try {
      return await createLockFile(filePath, request);
    } catch (error) {
      if (isAlreadyExists(error)) return null;
      throw error;
    }
  }

  // Stale lock. A pathname-level delete can never be conditioned on the file
  // still being the inspected instance, so delete+publish MUST NOT run
  // concurrently: serialize takeovers through a secondary create-if-absent
  // lock and re-validate staleness inside that section.
  const takeoverPath = `${filePath}.takeover`;
  if (!(await acquireTakeoverLock(takeoverPath))) return null;
  try {
    const current = await inspectLockFile(filePath);
    if (current !== null && !isStaleLock(current, request.now ?? new Date())) {
      // A fresh lock appeared while we waited for the takeover section.
      return null;
    }
    if (current !== null) {
      await unlink(filePath).catch(() => {});
    }
    try {
      // A fast-path creator may still win the briefly-free path — its lock is
      // legitimate (the path really was free), we simply lose.
      return await createLockFile(filePath, request);
    } catch (error) {
      if (isAlreadyExists(error)) return null;
      throw error;
    }
  } finally {
    await unlink(takeoverPath).catch(() => {});
  }
}

/**
 * The takeover lock serializes stale-lock recovery. create-if-absent via the
 * shared primitive (hard link, or an exclusive create where unsupported); an
 * ancient holder is crash residue (a live section lasts microseconds) and is
 * swept, then retried once.
 */
async function acquireTakeoverLock(takeoverPath: string): Promise<boolean> {
  if (await publishTakeoverMarker(takeoverPath)) return true;
  const info = await stat(takeoverPath).catch(() => null);
  if (info !== null && Date.now() - info.mtimeMs <= TAKEOVER_LOCK_STALE_MS) return false;
  await unlink(takeoverPath).catch(() => {});
  return publishTakeoverMarker(takeoverPath);
}

/** Create-if-absent publish of a small lock marker file. */
async function publishTakeoverMarker(target: string): Promise<boolean> {
  // Unique marker content doubles as the ownership identity below.
  const marker = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  try {
    await createFileIfAbsent(target, marker);
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
  // The stale-marker sweep races this publish: it may unlink our fresh marker
  // and publish its own. Verify ownership so only the survivor of that race
  // proceeds. (A delete landing after this read is the irreducible residual
  // of pathname-only locking — there is no conditional-delete syscall; its
  // worst case is a duplicated download cycle, never a corrupt install,
  // because swap claims guard the executable independently.)
  const published = await readFile(target, 'utf-8').catch(() => null);
  return published === marker;
}

/**
 * Return the version recorded in the held lock file, or undefined when the
 * lock is gone or unreadable. Lets a downloader that failed to acquire the
 * lock distinguish "another instance is staging the SAME version" (its
 * outcome is ours — report success) from "a different version is in flight"
 * (must not be reported as success to a foreground `kimi upgrade`).
 */
export async function readUpdateInstallLockVersion(
  filePath: string = getUpdateInstallLockFile(),
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const version: unknown = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}
