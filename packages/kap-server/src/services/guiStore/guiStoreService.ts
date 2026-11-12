import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { IDisposable } from '@moonshot-ai/agent-core-v2';
import { parse as parseToml } from 'smol-toml';

import type {
  GuiStoreChangeEvent,
  GuiStoreEntry,
  GuiStoreMutation,
  GuiStorePatchResult,
  GuiStoreQuery,
  GuiStoreSnapshot,
  IGuiStoreService,
} from './guiStore';

export class GuiStorePersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GuiStorePersistenceError';
  }
}

export class GuiStoreCorruptError extends GuiStorePersistenceError {
  readonly quarantinePath: string;

  constructor(message: string, quarantinePath: string, cause?: unknown) {
    super(message, cause);
    this.name = 'GuiStoreCorruptError';
    this.quarantinePath = quarantinePath;
  }
}

export interface GuiStoreLogger {
  warn(obj: unknown, msg: string): void;
}

const noopLogger: GuiStoreLogger = { warn: () => {} };

const STORE_FILENAME = 'gui.json';
const LEGACY_TOML_FILENAME = 'gui.toml';
const LOCK_DIRNAME = '.gui.json.lock';
const CORRUPT_PREFIX = `${STORE_FILENAME}.corrupt-`;
const SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 15_000;
const LOCK_HEARTBEAT_MS = 2_500;
const LOCK_TIMEOUT_MS = 15_000;
const WATCH_DEBOUNCE_MS = 80;
const WATCH_RESTART_MS = 500;
const WIN32_RENAME_RETRIES = 40;

export interface GuiStoreOptions {
  readonly lockStaleMs?: number;
  readonly lockHeartbeatMs?: number;
  readonly lockTimeoutMs?: number;
  readonly beforeCommitHook?: () => Promise<void>;
}

export interface AcquiredGuiStoreLock {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface InternalState {
  revision: number;
  entries: Record<string, GuiStoreEntry>;
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function cloneEntries(source: Record<string, GuiStoreEntry>): Record<string, GuiStoreEntry> {
  const copy = emptyRecord<GuiStoreEntry>();
  for (const key of Object.keys(source)) {
    const entry = source[key];
    if (entry !== undefined) {
      setOwn(copy, key, { value: entry.value, revision: entry.revision });
    }
  }
  return copy;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toPersistenceError(error: unknown, message: string): GuiStorePersistenceError {
  if (error instanceof GuiStorePersistenceError) return error;
  return new GuiStorePersistenceError(message, error);
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

async function syncDirSafe(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  let dirFh;
  try {
    dirFh = await open(dirPath, 'r');
    await dirFh.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === 'EINVAL' ||
      code === 'ENOTSUP' ||
      code === 'EBADF' ||
      code === 'EISDIR' ||
      code === 'EPERM'
    ) {
      return;
    }
    throw error;
  } finally {
    await dirFh?.close().catch(() => undefined);
  }
}

async function renameWithRetry(src: string, dst: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(src, dst);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
      if (!retryable || attempt >= WIN32_RENAME_RETRIES) throw error;
      await sleep(10 + Math.floor(Math.random() * 25));
    }
  }
}

async function writeAtomicDurable(
  filePath: string,
  content: string,
  beforeRenameFence?: () => Promise<void>,
): Promise<void> {
  const dir = dirname(filePath);
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const tmpPath = `${filePath}.tmp.${suffix}`;
  let renamed = false;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const fh = await open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile(content, 'utf-8');
      await syncFd(fh.fd);
    } finally {
      await fh.close();
    }
    if (beforeRenameFence !== undefined) {
      await beforeRenameFence();
    }
    await renameWithRetry(tmpPath, filePath);
    renamed = true;
    await syncDirSafe(dir);
  } catch (error) {
    throw toPersistenceError(error, `Failed to persist GUI store at ${filePath}`);
  } finally {
    if (!renamed) {
      await unlink(tmpPath).catch(() => undefined);
    }
  }
}

async function acquireDirLock(
  lockDir: string,
  opts: { lockStaleMs: number; lockHeartbeatMs: number; lockTimeoutMs: number },
): Promise<AcquiredGuiStoreLock> {
  try {
    await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw toPersistenceError(error, `Failed to prepare GUI store directory for ${lockDir}`);
  }
  const deadline = Date.now() + opts.lockTimeoutMs;
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      const ownerToken = `owner-${process.pid}-${randomBytes(8).toString('hex')}`;
      const ownerPath = join(lockDir, ownerToken);
      try {
        const fh = await open(ownerPath, 'wx', 0o600);
        await fh.close();
      } catch (tokenError) {
        await rmdir(lockDir).catch(() => undefined);
        throw tokenError;
      }
      const heartbeat = setInterval(() => {
        void stat(ownerPath)
          .then(() => {
            const now = new Date();
            return utimes(lockDir, now, now);
          })
          .catch(() => undefined);
      }, opts.lockHeartbeatMs);
      heartbeat.unref?.();
      return {
        assertOwned: async () => {
          try {
            await stat(ownerPath);
          } catch (error) {
            throw new GuiStorePersistenceError(
              `Lost GUI store lock ownership before commit: ${lockDir}`,
              error,
            );
          }
        },
        release: async () => {
          clearInterval(heartbeat);
          const stillOwned = await unlink(ownerPath).then(
            () => true,
            () => false,
          );
          if (stillOwned) {
            await rmdir(lockDir).catch(() => undefined);
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw toPersistenceError(error, `Failed to acquire GUI store lock: ${lockDir}`);
      }
      try {
        const st = await stat(lockDir);
        if (Date.now() - st.mtimeMs > opts.lockStaleMs) {
          const reclaimDir = `${lockDir}.reclaim`;
          let gotReclaim = await mkdir(reclaimDir, { mode: 0o700 }).then(
            () => true,
            () => false,
          );
          if (!gotReclaim) {
            const reclaimStat = await stat(reclaimDir).catch(() => undefined);
            if (reclaimStat !== undefined && Date.now() - reclaimStat.mtimeMs > opts.lockStaleMs) {
              await rm(reclaimDir, { recursive: true, force: true }).catch(() => undefined);
              gotReclaim = await mkdir(reclaimDir, { mode: 0o700 }).then(
                () => true,
                () => false,
              );
            }
          }
          if (gotReclaim) {
            try {
              const verifyStat = await stat(lockDir).catch(() => undefined);
              if (verifyStat !== undefined && Date.now() - verifyStat.mtimeMs > opts.lockStaleMs) {
                const trash = `${lockDir}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
                const claimed = await rename(lockDir, trash).then(
                  () => true,
                  () => false,
                );
                if (claimed) {
                  await rm(trash, { recursive: true, force: true }).catch(() => undefined);
                  continue;
                }
              }
            } finally {
              await rmdir(reclaimDir).catch(() => undefined);
            }
          }
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      if (Date.now() >= deadline) {
        throw new GuiStorePersistenceError(`Timed out acquiring GUI store lock: ${lockDir}`, error);
      }
      await sleep(8 + Math.floor(Math.random() * 28));
    }
  }
}

export function acquireGuiStoreLockForTest(
  lockDir: string,
  opts: { lockStaleMs: number; lockHeartbeatMs: number; lockTimeoutMs: number },
): Promise<AcquiredGuiStoreLock> {
  return acquireDirLock(lockDir, opts);
}

function parsePersistedState(text: string): InternalState {
  if (text.trim().length === 0) {
    throw new Error('gui.json is empty');
  }
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('gui.json root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj['schema_version'] !== SCHEMA_VERSION) {
    throw new Error(`Unsupported gui.json schema_version: ${String(obj['schema_version'])}`);
  }
  const revision = obj['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new Error('Invalid gui.json revision');
  }
  const rawEntries = obj['entries'];
  if (typeof rawEntries !== 'object' || rawEntries === null || Array.isArray(rawEntries)) {
    throw new Error('Invalid gui.json entries map');
  }
  const entries = emptyRecord<GuiStoreEntry>();
  for (const key of Object.keys(rawEntries)) {
    const item = (rawEntries as Record<string, unknown>)[key];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Invalid gui.json entry for key: ${key}`);
    }
    const val = (item as Record<string, unknown>)['value'];
    const rev = (item as Record<string, unknown>)['revision'];
    if (
      typeof val !== 'string' ||
      typeof rev !== 'number' ||
      !Number.isInteger(rev) ||
      rev < 1 ||
      rev > revision
    ) {
      throw new Error(`Invalid gui.json entry fields for key: ${key}`);
    }
    setOwn(entries, key, { value: val, revision: rev });
  }
  return { revision, entries };
}

function serializePersistedState(state: InternalState): string {
  const entries = emptyRecord<GuiStoreEntry>();
  for (const key of Object.keys(state.entries).toSorted()) {
    const entry = state.entries[key];
    if (entry !== undefined) {
      setOwn(entries, key, { value: entry.value, revision: entry.revision });
    }
  }
  return `${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    revision: state.revision,
    entries,
  })}\n`;
}

function filterEntries(
  entries: Record<string, GuiStoreEntry>,
  query?: GuiStoreQuery,
): Record<string, GuiStoreEntry> {
  const out = emptyRecord<GuiStoreEntry>();
  const prefix = query?.prefix;
  const keySet = query?.keys === undefined ? undefined : new Set(query.keys);
  for (const key of Object.keys(entries)) {
    if (prefix !== undefined && !key.startsWith(prefix)) continue;
    if (keySet !== undefined && !keySet.has(key)) continue;
    const entry = entries[key];
    if (entry !== undefined) {
      setOwn(out, key, { value: entry.value, revision: entry.revision });
    }
  }
  return out;
}

function diffSnapshots(
  previous: InternalState,
  next: InternalState,
): Record<string, GuiStoreEntry | null> | undefined {
  const changes = emptyRecord<GuiStoreEntry | null>();
  let count = 0;
  for (const key of Object.keys(previous.entries)) {
    if (!hasOwn(next.entries, key)) {
      setOwn(changes, key, null);
      count += 1;
    }
  }
  for (const key of Object.keys(next.entries)) {
    const nextEntry = next.entries[key]!;
    const prevEntry = hasOwn(previous.entries, key) ? previous.entries[key] : undefined;
    if (
      prevEntry === undefined ||
      prevEntry.revision !== nextEntry.revision ||
      prevEntry.value !== nextEntry.value
    ) {
      setOwn(changes, key, { value: nextEntry.value, revision: nextEntry.revision });
      count += 1;
    }
  }
  return count > 0 ? changes : undefined;
}

function findLatestCorruptFile(
  homeDir: string,
  names: readonly string[],
): { floor: number; path: string | undefined } {
  let maxFloor = 0;
  let latestName: string | undefined;
  for (const name of names) {
    if (!name.startsWith(CORRUPT_PREFIX)) continue;
    const rest = name.slice(CORRUPT_PREFIX.length);
    const dash = rest.indexOf('-');
    const numText = dash === -1 ? rest : rest.slice(0, dash);
    const parsed = Number(numText);
    if (Number.isSafeInteger(parsed) && parsed > maxFloor) {
      maxFloor = parsed;
      latestName = name;
    }
  }
  return {
    floor: maxFloor,
    path: latestName === undefined ? undefined : join(homeDir, latestName),
  };
}

export class GuiStoreService implements IGuiStoreService {
  readonly _serviceBrand: undefined;

  private readonly homeDir: string;
  private readonly filePath: string;
  private readonly legacyTomlPath: string;
  private readonly lockDir: string;
  private readonly logger: GuiStoreLogger;
  private readonly lockOpts: { lockStaleMs: number; lockHeartbeatMs: number; lockTimeoutMs: number };
  private readonly beforeCommitHook: (() => Promise<void>) | undefined;
  private readonly listeners = new Set<(event: GuiStoreChangeEvent) => void>();
  private queue: Promise<void> = Promise.resolve();
  private watchedState: InternalState | undefined;
  private minRevisionFloor = 0;
  private watcher: nodeFs.FSWatcher | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private watchRestartTimer: ReturnType<typeof setTimeout> | undefined;
  private selfWriting = 0;
  private closed = false;

  constructor(homeDir: string, logger?: GuiStoreLogger, options?: GuiStoreOptions) {
    this.homeDir = homeDir;
    this.filePath = join(homeDir, STORE_FILENAME);
    this.legacyTomlPath = join(homeDir, LEGACY_TOML_FILENAME);
    this.lockDir = join(homeDir, LOCK_DIRNAME);
    this.logger = logger ?? noopLogger;
    this.lockOpts = {
      lockStaleMs: options?.lockStaleMs ?? LOCK_STALE_MS,
      lockHeartbeatMs: options?.lockHeartbeatMs ?? LOCK_HEARTBEAT_MS,
      lockTimeoutMs: options?.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    };
    this.beforeCommitHook = options?.beforeCommitHook;
  }

  async getSnapshot(query?: GuiStoreQuery): Promise<GuiStoreSnapshot> {
    const state = await this.readOrQuarantine(true);
    this.advanceWatchedStateAndEmit(state);
    return {
      revision: state.revision,
      entries: filterEntries(state.entries, query),
    };
  }

  async patch(mutations: readonly GuiStoreMutation[]): Promise<GuiStorePatchResult> {
    if (mutations.length === 0) {
      const state = await this.readOrQuarantine(true);
      this.advanceWatchedStateAndEmit(state);
      return {
        applied: true,
        revision: state.revision,
        entries: emptyRecord(),
        conflicts: emptyRecord(),
      };
    }

    const outcome = await this.withCrossProcessLock(async (lock) => {
      const state = await this.readUnlocked(lock, false);
      const conflicts = emptyRecord<GuiStoreEntry | null>();
      let hasConflict = false;

      for (const mutation of mutations) {
        if (mutation.ifRevision === undefined) continue;
        const existing = hasOwn(state.entries, mutation.key)
          ? state.entries[mutation.key]
          : undefined;
        const currentRev = existing?.revision ?? 0;
        if (currentRev !== mutation.ifRevision) {
          setOwn(
            conflicts,
            mutation.key,
            existing === undefined ? null : { value: existing.value, revision: existing.revision },
          );
          hasConflict = true;
        }
      }

      if (hasConflict) {
        return {
          result: {
            applied: false,
            revision: state.revision,
            entries: emptyRecord<GuiStoreEntry | null>(),
            conflicts,
          },
          finalState: state,
          directDiff: undefined,
        };
      }

      const nextEntries = cloneEntries(state.entries);
      const changedEntries = emptyRecord<GuiStoreEntry | null>();
      const resultEntries = emptyRecord<GuiStoreEntry | null>();
      const nextStoreRevision = Math.max(state.revision, this.minRevisionFloor) + 1;
      let anyChanged = false;

      for (const mutation of mutations) {
        const existing = hasOwn(nextEntries, mutation.key) ? nextEntries[mutation.key] : undefined;
        if (mutation.value === null) {
          if (existing !== undefined) {
            delete nextEntries[mutation.key];
            setOwn(changedEntries, mutation.key, null);
            anyChanged = true;
          }
          setOwn(resultEntries, mutation.key, null);
        } else {
          const sanitized = Buffer.from(mutation.value, 'utf-8').toString('utf-8');
          if (existing !== undefined && existing.value === sanitized) {
            const kept: GuiStoreEntry = { value: existing.value, revision: existing.revision };
            setOwn(resultEntries, mutation.key, kept);
          } else {
            const updated: GuiStoreEntry = { value: sanitized, revision: nextStoreRevision };
            setOwn(nextEntries, mutation.key, updated);
            setOwn(changedEntries, mutation.key, updated);
            setOwn(resultEntries, mutation.key, updated);
            anyChanged = true;
          }
        }
      }

      if (!anyChanged) {
        return {
          result: {
            applied: true,
            revision: state.revision,
            entries: resultEntries,
            conflicts: emptyRecord<GuiStoreEntry | null>(),
          },
          finalState: state,
          directDiff: undefined,
        };
      }

      const nextState: InternalState = {
        revision: nextStoreRevision,
        entries: nextEntries,
      };
      this.selfWriting += 1;
      try {
        await writeAtomicDurable(
          this.filePath,
          serializePersistedState(nextState),
          async () => {
            if (this.beforeCommitHook !== undefined) {
              await this.beforeCommitHook();
            }
            await lock.assertOwned();
            await this.verifyDiskRevisionBeforeCommit(state.revision);
          },
        );
        await this.archiveResidualLegacyTomlUnlocked();
      } finally {
        this.selfWriting -= 1;
      }
      if (nextState.revision > this.minRevisionFloor) {
        this.minRevisionFloor = nextState.revision;
      }

      return {
        result: {
          applied: true,
          revision: nextState.revision,
          entries: resultEntries,
          conflicts: emptyRecord<GuiStoreEntry | null>(),
        },
        finalState: nextState,
        directDiff: changedEntries,
      };
    });

    this.advanceWatchedStateAndEmit(outcome.finalState, outcome.directDiff);
    return outcome.result;
  }

  onDidChange(listener: (event: GuiStoreChangeEvent) => void): IDisposable {
    this.listeners.add(listener);
    void this.ensureWatcher();
    return {
      dispose: () => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
          this.stopWatcher(true);
          this.watchedState = undefined;
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopWatcher(true);
    this.listeners.clear();
    this.watchedState = undefined;
    await this.queue;
  }

  private withQueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private withCrossProcessLock<T>(fn: (lock: AcquiredGuiStoreLock) => Promise<T>): Promise<T> {
    return this.withQueue(async () => {
      const lock = await acquireDirLock(this.lockDir, this.lockOpts);
      try {
        return await fn(lock);
      } finally {
        await lock.release();
      }
    });
  }

  private async verifyDiskRevisionBeforeCommit(expectedRevision: number): Promise<void> {
    try {
      const text = await readFile(this.filePath, 'utf-8');
      const onDisk = parsePersistedState(text);
      if (onDisk.revision !== expectedRevision) {
        throw new GuiStorePersistenceError(
          `Concurrent GUI store revision drift before commit: expected ${expectedRevision}, got ${onDisk.revision}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (expectedRevision > this.minRevisionFloor) {
          throw new GuiStorePersistenceError('GUI store disappeared unexpectedly before commit');
        }
        return;
      }
      throw toPersistenceError(error, `Failed to validate GUI store before commit: ${this.filePath}`);
    }
  }

  private async emptyStateWithFloor(): Promise<{
    state: InternalState;
    quarantinePath: string | undefined;
  }> {
    let quarantinePath: string | undefined;
    try {
      const names = await readdir(this.homeDir);
      const latest = findLatestCorruptFile(this.homeDir, names);
      if (latest.floor > this.minRevisionFloor) {
        this.minRevisionFloor = latest.floor;
      }
      quarantinePath = latest.path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw toPersistenceError(error, `Failed to inspect GUI store directory ${this.homeDir}`);
      }
    }
    return {
      state: { revision: this.minRevisionFloor, entries: emptyRecord() },
      quarantinePath,
    };
  }

  private async archiveResidualLegacyTomlUnlocked(): Promise<void> {
    const exists = await stat(this.legacyTomlPath).then(
      (st) => st.isFile(),
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw toPersistenceError(error, `Failed to stat legacy ${this.legacyTomlPath}`);
      },
    );
    if (!exists) return;
    const suffix = `${Date.now()}-${process.pid}-${randomBytes(3).toString('hex')}`;
    const archivePath = `${this.legacyTomlPath}.migrated-${suffix}`;
    await renameWithRetry(this.legacyTomlPath, archivePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw toPersistenceError(error, `Failed to archive migrated ${this.legacyTomlPath}`);
    });
    await syncDirSafe(this.homeDir);
  }

  private async migrateLegacyTomlUnlocked(lock: AcquiredGuiStoreLock): Promise<InternalState | undefined> {
    let tomlText: string;
    try {
      tomlText = await readFile(this.legacyTomlPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw toPersistenceError(error, `Failed to read legacy ${this.legacyTomlPath}`);
    }

    const { state: floorState, quarantinePath: existingQuarantine } =
      await this.emptyStateWithFloor();
    if (existingQuarantine !== undefined || floorState.revision > 0) {
      return undefined;
    }
    const migratedEntries = emptyRecord<GuiStoreEntry>();
    let migratedRevision = floorState.revision;

    if (tomlText.trim().length > 0) {
      let parsedToml: Record<string, unknown>;
      try {
        parsedToml = parseToml(tomlText) as Record<string, unknown>;
      } catch (parseError) {
        const nextFloor = Math.max(Date.now(), this.minRevisionFloor + 1);
        this.minRevisionFloor = nextFloor;
        const suffix = `${nextFloor}-${process.pid}-${randomBytes(3).toString('hex')}`;
        const quarantinePath = `${this.filePath}.corrupt-${suffix}`;
        await lock.assertOwned();
        await renameWithRetry(this.legacyTomlPath, quarantinePath).catch((error: unknown) => {
          throw toPersistenceError(error, `Failed to quarantine ${this.legacyTomlPath}`);
        });
        await syncDirSafe(this.homeDir);
        this.logger.warn(
          { filePath: this.legacyTomlPath, quarantinePath, err: parseError },
          'gui.toml parse failed during migration; quarantined corrupt file',
        );
        throw new GuiStoreCorruptError(
          `Corrupt gui.toml quarantined to ${quarantinePath}`,
          quarantinePath,
          parseError,
        );
      }

      const nextRev = floorState.revision + 1;
      let count = 0;
      for (const [key, val] of Object.entries(parsedToml)) {
        if (typeof val === 'string' && key.length > 0) {
          const sanitized = Buffer.from(val, 'utf-8').toString('utf-8');
          setOwn(migratedEntries, key, { value: sanitized, revision: nextRev });
          count += 1;
        }
      }
      if (count > 0) {
        migratedRevision = nextRev;
      }
    }

    const migratedState: InternalState = {
      revision: migratedRevision,
      entries: migratedEntries,
    };

    this.selfWriting += 1;
    try {
      await writeAtomicDurable(
        this.filePath,
        serializePersistedState(migratedState),
        () => lock.assertOwned(),
      );
      await this.archiveResidualLegacyTomlUnlocked();
    } finally {
      this.selfWriting -= 1;
    }

    if (migratedState.revision > this.minRevisionFloor) {
      this.minRevisionFloor = migratedState.revision;
    }
    return migratedState;
  }

  private async readOrQuarantine(failIfUnrecoveredQuarantine: boolean): Promise<InternalState> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.withCrossProcessLock((lock) =>
          this.readUnlocked(lock, failIfUnrecoveredQuarantine),
        );
      }
      throw toPersistenceError(error, `Failed to read GUI store at ${this.filePath}`);
    }
    try {
      const parsed = parsePersistedState(text);
      if (parsed.revision > this.minRevisionFloor) {
        this.minRevisionFloor = parsed.revision;
      }
      const residualLegacy = await stat(this.legacyTomlPath).then(
        (st) => st.isFile(),
        () => false,
      );
      if (residualLegacy) {
        await this.withCrossProcessLock(async (lock) => {
          await lock.assertOwned();
          await this.archiveResidualLegacyTomlUnlocked();
        });
      }
      return parsed;
    } catch (error) {
      if (error instanceof GuiStorePersistenceError) throw error;
      return this.withCrossProcessLock((lock) =>
        this.readUnlocked(lock, failIfUnrecoveredQuarantine),
      );
    }
  }

  private async readUnlocked(
    lock: AcquiredGuiStoreLock,
    failIfUnrecoveredQuarantine: boolean,
  ): Promise<InternalState> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const migrated = await this.migrateLegacyTomlUnlocked(lock);
        if (migrated !== undefined) return migrated;
        const { state, quarantinePath } = await this.emptyStateWithFloor();
        if (failIfUnrecoveredQuarantine && quarantinePath !== undefined) {
          throw new GuiStoreCorruptError(
            `GUI store remains quarantined at ${quarantinePath} until recovered`,
            quarantinePath,
          );
        }
        return state;
      }
      throw toPersistenceError(error, `Failed to read GUI store at ${this.filePath}`);
    }
    try {
      const parsed = parsePersistedState(text);
      if (parsed.revision > this.minRevisionFloor) {
        this.minRevisionFloor = parsed.revision;
      }
      return parsed;
    } catch (parseError) {
      const names = await readdir(this.homeDir).catch(() => [] as string[]);
      const existingFloor = findLatestCorruptFile(this.homeDir, names).floor;
      let rawRev = 0;
      const revMatch = /"revision"\s*:\s*(\d+)/.exec(text);
      if (revMatch !== null) {
        const candidate = Number(revMatch[1]);
        if (Number.isSafeInteger(candidate) && candidate > 0) {
          rawRev = candidate;
        }
      }
      const nextFloor = Math.max(Date.now(), this.minRevisionFloor + 1, existingFloor + 1, rawRev + 1);
      this.minRevisionFloor = nextFloor;
      const suffix = `${nextFloor}-${process.pid}-${randomBytes(3).toString('hex')}`;
      const quarantinePath = `${this.filePath}.corrupt-${suffix}`;
      await lock.assertOwned();
      await renameWithRetry(this.filePath, quarantinePath).catch((error: unknown) => {
        throw toPersistenceError(error, `Failed to quarantine ${this.filePath}`);
      });
      await syncDirSafe(this.homeDir);
      this.logger.warn(
        { filePath: this.filePath, quarantinePath, err: parseError },
        'gui.json parse failed; quarantined corrupt file',
      );
      throw new GuiStoreCorruptError(
        `Corrupt gui.json quarantined to ${quarantinePath}`,
        quarantinePath,
        parseError,
      );
    }
  }

  private advanceWatchedStateAndEmit(
    nextState: InternalState,
    directDiff?: Record<string, GuiStoreEntry | null>,
  ): void {
    if (this.listeners.size === 0) return;
    const prev = this.watchedState;
    this.watchedState = nextState;
    if (prev !== undefined && nextState.revision > prev.revision) {
      const mergedDiff = diffSnapshots(prev, nextState);
      if (mergedDiff !== undefined) {
        this.emitChange({ revision: nextState.revision, entries: mergedDiff });
      }
      return;
    }
    if (directDiff !== undefined) {
      this.emitChange({ revision: nextState.revision, entries: directDiff });
    }
  }

  private emitChange(event: GuiStoreChangeEvent): void {
    const snapshotListeners = Array.from(this.listeners);
    for (const listener of snapshotListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn({ err: error }, 'gui store change listener failed');
      }
    }
  }

  private async readPassiveWithoutQuarantine(): Promise<
    { kind: 'ok'; state: InternalState } | { kind: 'skip' } | { kind: 'io_error' }
  > {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const legacyExists = await stat(this.legacyTomlPath).then(
          (st) => st.isFile(),
          () => false,
        );
        if (legacyExists) return { kind: 'skip' };
        try {
          const { state: emptyFloor, quarantinePath } = await this.emptyStateWithFloor();
          if (quarantinePath !== undefined || emptyFloor.revision > 0) return { kind: 'skip' };
          return { kind: 'ok', state: emptyFloor };
        } catch {
          return { kind: 'io_error' };
        }
      }
      return { kind: 'io_error' };
    }
    try {
      const parsed = parsePersistedState(text);
      if (parsed.revision > this.minRevisionFloor) {
        this.minRevisionFloor = parsed.revision;
      }
      return { kind: 'ok', state: parsed };
    } catch {
      return { kind: 'skip' };
    }
  }

  private scheduleWatchDebounce(): void {
    if (this.closed || this.listeners.size === 0) return;
    if (this.watchTimer !== undefined) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      void this.reconcileExternalChange();
    }, WATCH_DEBOUNCE_MS);
    this.watchTimer.unref?.();
  }

  private scheduleWatcherRestart(): void {
    if (this.closed || this.listeners.size === 0 || this.watchRestartTimer !== undefined) return;
    this.watchRestartTimer = setTimeout(() => {
      this.watchRestartTimer = undefined;
      if (this.closed || this.listeners.size === 0) return;
      void this.reconcileExternalChange();
      void this.ensureWatcher();
    }, WATCH_RESTART_MS);
    this.watchRestartTimer.unref?.();
  }

  private async ensureWatcher(): Promise<void> {
    if (this.closed || this.watcher !== undefined || this.listeners.size === 0) return;
    try {
      await mkdir(this.homeDir, { recursive: true, mode: 0o700 });
      if (this.watchedState === undefined) {
        const passive = await this.readPassiveWithoutQuarantine();
        if (passive.kind === 'io_error') {
          this.scheduleWatcherRestart();
          return;
        }
        if (passive.kind === 'ok' && this.watchedState === undefined) {
          this.watchedState = passive.state;
        }
      }
    } catch {
      this.scheduleWatcherRestart();
      return;
    }
    if (this.closed || this.watcher !== undefined || this.listeners.size === 0) return;
    try {
      const watcher = nodeFs.watch(this.homeDir, { persistent: false }, (_eventType, filename) => {
        if (this.closed) return;
        if (filename !== null && filename !== STORE_FILENAME && !filename.startsWith(STORE_FILENAME)) {
          return;
        }
        this.scheduleWatchDebounce();
      });
      watcher.on('error', (error) => {
        this.logger.warn({ homeDir: this.homeDir, err: error }, 'gui store watcher error; restarting');
        this.stopWatcher(false);
        this.scheduleWatcherRestart();
      });
      watcher.unref?.();
      this.watcher = watcher;
      void this.reconcileExternalChange();
    } catch {
      this.watcher = undefined;
      this.scheduleWatcherRestart();
    }
  }

  private stopWatcher(cancelRestart: boolean): void {
    if (cancelRestart && this.watchRestartTimer !== undefined) {
      clearTimeout(this.watchRestartTimer);
      this.watchRestartTimer = undefined;
    }
    if (this.watchTimer !== undefined) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
    if (this.watcher !== undefined) {
      try {
        this.watcher.close();
      } catch {
      }
      this.watcher = undefined;
    }
  }

  private async reconcileExternalChange(): Promise<void> {
    if (this.closed || this.listeners.size === 0) return;
    if (this.selfWriting > 0) {
      this.scheduleWatchDebounce();
      return;
    }
    const passive = await this.readPassiveWithoutQuarantine();
    if (passive.kind === 'io_error') {
      this.scheduleWatcherRestart();
      return;
    }
    if (passive.kind !== 'ok') return;
    const current = passive.state;
    this.watchedState ??= { revision: 0, entries: emptyRecord() };
    if (current.revision <= this.watchedState.revision) return;
    this.advanceWatchedStateAndEmit(current);
  }
}
