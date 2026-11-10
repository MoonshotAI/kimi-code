// src/backup.ts
//
// MiniDb's online backup as injected-dependency free functions: the write-gate
// fence + drain, then the atomic copy (temp dir → per-file fsync → manifest →
// rename swap). Everything the flow needs from MiniDb (lifecycle gates,
// compaction state, the write-op tracker, the backup serializer, the WAL) is
// injected through BackupDeps, so this module never imports the MiniDb class
// itself.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fsyncDir } from './compaction.js';
import { isPersistentFile } from './generation.js';

/** Unique suffixes for backup's temp/aside dirs (see copyBackupAtomic). */
let backupTmpSeq = 0;

/** The owner-injected surface a backup run needs (see the header). */
export interface BackupDeps {
  dir: () => string;
  /** The owner's stats object (fsyncDir's dirFsyncUnsupported sink). */
  stats: { dirFsyncUnsupported: boolean };
  ensureOpen: () => void;
  compacting: () => boolean;
  /** The in-flight compaction's completion (null when none). */
  compactDone: () => Promise<void> | null;
  readOnly: () => boolean;
  compact: () => Promise<void>;
  /** Pause the write gate; resolves at the drain (the quiescence point). */
  pauseWrites: () => Promise<void>;
  resumeWrites: () => void;
  serializeBackups: <T>(fn: () => Promise<T>) => Promise<T>;
  walRecoveryChain: () => Promise<void>;
  flushWal: () => Promise<void>;
}

/** The rejection a write op gets while a backup holds the write gate: the
 *  fence is short (file copies) and retryable, so callers can simply
 *  re-issue the write afterwards. */
export function backupInProgressError(): Error {
  return Object.assign(new Error('MiniDb backup is in progress: writes are fenced until it completes'), {
    code: 'BACKUP_IN_PROGRESS',
  });
}

/** Write a consistent online backup of this database directory.
 *
 *  Semantics (plan 12): backup pauses the write gate — new writes reject
 *  with BACKUP_IN_PROGRESS — and waits for every in-flight write to settle.
 *  That drain completion IS the linearization point: every write
 *  acknowledged before it is included in the backup, every write submitted
 *  after it is not. The copy itself is an atomic commit: persistent files
 *  go to a sibling temp dir, every copied file is fsync'd, the manifest is
 *  written LAST (the commit marker — a manifest on disk implies every file
 *  it lists is fully copied and durable), then the temp dir is renamed over
 *  the destination (an existing previous backup is swapped aside first and
 *  restored if the rename fails). A failure anywhere before the rename
 *  leaves the destination untouched and the temp dir removed — never a half
 *  backup. Concurrent backups serialize on serializeBackups. */
export async function backup(deps: BackupDeps, destDir: string, opts: { compact?: boolean } = {}): Promise<void> {
  deps.ensureOpen();
  if (!destDir) throw new TypeError('backup: destDir is required');
  if (deps.compacting()) await deps.compactDone();
  if (opts.compact !== false && !deps.readOnly()) await deps.compact();
  if (deps.compacting()) await deps.compactDone();

  // The gate closes SYNCHRONOUSLY here (pause's first statement): a write
  // submitted from the same synchronous segment as this backup() call
  // already sees the fence. pause is reference-counted, so a second backup
  // queued on the serializer keeps the gate closed until the last one
  // resumes.
  const drain = deps.pauseWrites();
  try {
    await deps.serializeBackups(async () => {
      // Fence + drain. After the drain resolves, no write op is running and
      // no new one can start, so the on-disk files are quiescent (this
      // instance is the only writer — a read-only instance backing up a
      // LIVE writer's dir can only fence itself and stays best-effort, as
      // before).
      await drain;
      // A compaction kicked by the just-drained writes must finish before
      // the copy; no new one can start with the gate closed (kicks come from
      // write commit bodies only).
      if (deps.compacting()) await deps.compactDone();
      // Wait out any in-flight WAL recovery inside the fence: a WAL failure
      // racing the backup leaves un-acked bytes in db.wal that the recovery
      // is about to truncate away, and the copy must land on the recovered
      // (possibly truncated) file rather than copying bytes that are about
      // to disappear. With the gate closed no new recovery can be kicked,
      // and a persistent failure keeps the WAL poisoned, so the flush below
      // rejects the backup.
      await deps.walRecoveryChain();
      await deps.flushWal();
      await copyBackupAtomic(deps, destDir);
    });
  } finally {
    deps.resumeWrites();
  }
}

/** The atomic-copy core of backup(): temp dir → per-file fsync → manifest
 *  (commit marker) → dir fsync → rename swap → parent fsync. Runs with the
 *  write gate paused. */
async function copyBackupAtomic(deps: BackupDeps, destDir: string): Promise<void> {
  const parent = path.dirname(destDir);
  const base = path.basename(destDir);
  const tmp = path.join(parent, `.${base}.backup-tmp-${process.pid}-${++backupTmpSeq}`);
  const aside = path.join(parent, `.${base}.backup-old-${process.pid}-${++backupTmpSeq}`);
  await fs.mkdir(parent, { recursive: true });
  // Sweep orphans from a crashed previous backup of this destination.
  for (const name of await fs.readdir(parent)) {
    if (name.startsWith(`.${base}.backup-tmp-`) || name.startsWith(`.${base}.backup-old-`)) {
      await fs.rm(path.join(parent, name), { recursive: true, force: true });
    }
  }
  await fs.mkdir(tmp);
  try {
    const files = await persistentFiles(deps.dir());
    const copied: string[] = [];
    for (const name of files) if (await copyIfExists(deps.dir(), name, tmp)) copied.push(name);
    // Fsync every copied file BEFORE the manifest: the manifest is the
    // commit marker, so a durable manifest must imply durable payloads.
    for (const name of copied) {
      const h = await fs.open(path.join(tmp, name), 'r');
      try {
        await h.sync();
      } finally {
        await h.close();
      }
    }
    const manifest = path.join(tmp, 'backup.manifest.json');
    await fs.writeFile(manifest, JSON.stringify({ version: 1, createdAt: Date.now(), files: copied }, null, 2), 'utf8');
    const mh = await fs.open(manifest, 'r');
    try {
      await mh.sync();
    } finally {
      await mh.close();
    }
    await fsyncDir(tmp, { strict: true, stats: deps.stats });
    // Swap into place: move an existing previous backup aside, rename the
    // temp dir over the destination, restore the aside on failure.
    let asideUsed = false;
    try {
      try {
        await fs.rename(destDir, aside);
        asideUsed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fs.rename(tmp, destDir);
    } catch (error) {
      if (asideUsed) await fs.rename(aside, destDir).catch(() => {});
      throw error;
    }
    await fs.rm(aside, { recursive: true, force: true });
    await fsyncDir(parent, { strict: true, stats: deps.stats });
  } finally {
    // A successful rename already moved the temp dir away (this rm is a
    // no-op); a failed copy must not strand it (review #22: no half backup).
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function persistentFiles(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir);
  return names.filter(isPersistentFile);
}

async function copyIfExists(dir: string, name: string, destDir: string): Promise<boolean> {
  try {
    const src = path.join(dir, name);
    const st = await fs.stat(src);
    // The generations/ tree is a directory: copy it recursively (backup
    // includes published generations; a restore's inode change safely
    // invalidates their WAL anchors, so they fall back to a rebuild).
    if (st.isDirectory()) await fs.cp(src, path.join(destDir, name), { recursive: true });
    else await fs.copyFile(src, path.join(destDir, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
