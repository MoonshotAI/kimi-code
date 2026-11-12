import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { mkdir, open, readFile, rename, rm, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { IDisposable } from '@moonshot-ai/agent-core-v2';

import type {
  GuiStoreChangeEvent,
  GuiStoreEntry,
  GuiStoreMutation,
  GuiStorePatchResult,
  GuiStoreQuery,
  GuiStoreSnapshot,
  IGuiStoreService,
} from './guiStore';

export class GuiStoreCorruptError extends Error {
  readonly quarantinePath: string;

  constructor(message: string, quarantinePath: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GuiStoreCorruptError';
    this.quarantinePath = quarantinePath;
  }
}

export interface GuiStoreLogger {
  warn(obj: unknown, msg: string): void;
}

const noopLogger: GuiStoreLogger = { warn: () => {} };

const STORE_FILENAME = 'gui.json';
const LOCK_DIRNAME = '.gui.json.lock';
const SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 15_000;
const LOCK_HEARTBEAT_MS = 2_500;
const LOCK_TIMEOUT_MS = 15_000;
const WATCH_DEBOUNCE_MS = 80;
const WIN32_RENAME_RETRIES = 40;

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

async function writeAtomicDurable(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const tmpPath = `${filePath}.tmp.${suffix}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile(content, 'utf-8');
      await syncFd(fh.fd);
    } finally {
      await fh.close();
    }
    await renameWithRetry(tmpPath, filePath);
    renamed = true;
    await syncDirSafe(dir);
  } finally {
    if (!renamed) {
      await unlink(tmpPath).catch(() => undefined);
    }
  }
}

async function acquireDirLock(lockDir: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(lockDir, now, now).catch(() => undefined);
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        await rmdir(lockDir).catch(() => rm(lockDir, { recursive: true, force: true }).catch(() => undefined));
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      try {
        const st = await stat(lockDir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
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
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring GUI store lock: ${lockDir}`, { cause: error });
      }
      await sleep(8 + Math.floor(Math.random() * 28));
    }
  }
}

function parsePersistedState(text: string): InternalState {
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

export class GuiStoreService implements IGuiStoreService {
  readonly _serviceBrand: undefined;

  private readonly homeDir: string;
  private readonly filePath: string;
  private readonly lockDir: string;
  private readonly logger: GuiStoreLogger;
  private readonly listeners = new Set<(event: GuiStoreChangeEvent) => void>();
  private queue: Promise<void> = Promise.resolve();
  private lastKnownState: InternalState = { revision: 0, entries: emptyRecord() };
  private watcher: nodeFs.FSWatcher | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private selfWriting = 0;
  private closed = false;

  constructor(homeDir: string, logger?: GuiStoreLogger) {
    this.homeDir = homeDir;
    this.filePath = join(homeDir, STORE_FILENAME);
    this.lockDir = join(homeDir, LOCK_DIRNAME);
    this.logger = logger ?? noopLogger;
  }

  async getSnapshot(query?: GuiStoreQuery): Promise<GuiStoreSnapshot> {
    const state = await this.readOrQuarantine();
    return {
      revision: state.revision,
      entries: filterEntries(state.entries, query),
    };
  }

  async patch(mutations: readonly GuiStoreMutation[]): Promise<GuiStorePatchResult> {
    if (mutations.length === 0) {
      const state = await this.readOrQuarantine();
      return {
        applied: true,
        revision: state.revision,
        entries: emptyRecord(),
        conflicts: emptyRecord(),
      };
    }

    const outcome = await this.withCrossProcessLock(async () => {
      const state = await this.readUnlocked();
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
          changeEvent: undefined,
        };
      }

      const nextEntries = cloneEntries(state.entries);
      const changedEntries = emptyRecord<GuiStoreEntry | null>();
      const resultEntries = emptyRecord<GuiStoreEntry | null>();
      const nextStoreRevision = state.revision + 1;
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
        this.lastKnownState = state;
        return {
          result: {
            applied: true,
            revision: state.revision,
            entries: resultEntries,
            conflicts: emptyRecord<GuiStoreEntry | null>(),
          },
          changeEvent: undefined,
        };
      }

      const nextState: InternalState = {
        revision: nextStoreRevision,
        entries: nextEntries,
      };
      this.selfWriting += 1;
      try {
        await writeAtomicDurable(this.filePath, serializePersistedState(nextState));
      } finally {
        this.selfWriting -= 1;
      }
      this.lastKnownState = nextState;

      return {
        result: {
          applied: true,
          revision: nextState.revision,
          entries: resultEntries,
          conflicts: emptyRecord<GuiStoreEntry | null>(),
        },
        changeEvent: {
          revision: nextState.revision,
          entries: changedEntries,
        },
      };
    });

    if (outcome.changeEvent !== undefined) {
      this.emitChange(outcome.changeEvent);
    }
    return outcome.result;
  }

  onDidChange(listener: (event: GuiStoreChangeEvent) => void): IDisposable {
    this.listeners.add(listener);
    void this.ensureWatcher();
    return {
      dispose: () => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
          this.stopWatcher();
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopWatcher();
    this.listeners.clear();
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

  private withCrossProcessLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.withQueue(async () => {
      const release = await acquireDirLock(this.lockDir);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private async readOrQuarantine(): Promise<InternalState> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { revision: 0, entries: emptyRecord() };
      }
      throw error;
    }
    if (text.trim().length === 0) {
      return { revision: 0, entries: emptyRecord() };
    }
    try {
      const parsed = parsePersistedState(text);
      if (parsed.revision >= this.lastKnownState.revision) {
        this.lastKnownState = parsed;
      }
      return parsed;
    } catch {
      return this.withCrossProcessLock(() => this.readUnlocked());
    }
  }

  private async readUnlocked(): Promise<InternalState> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { revision: 0, entries: emptyRecord() };
      }
      throw error;
    }
    if (text.trim().length === 0) {
      return { revision: 0, entries: emptyRecord() };
    }
    try {
      const parsed = parsePersistedState(text);
      this.lastKnownState = parsed;
      return parsed;
    } catch (error) {
      const suffix = `${Date.now()}-${process.pid}-${randomBytes(3).toString('hex')}`;
      const quarantinePath = `${this.filePath}.corrupt-${suffix}`;
      await renameWithRetry(this.filePath, quarantinePath);
      await syncDirSafe(this.homeDir);
      this.logger.warn(
        { filePath: this.filePath, quarantinePath, err: error },
        'gui.json parse failed; quarantined corrupt file',
      );
      throw new GuiStoreCorruptError(
        `Corrupt gui.json quarantined to ${quarantinePath}`,
        quarantinePath,
        error,
      );
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

  private async ensureWatcher(): Promise<void> {
    if (this.closed || this.watcher !== undefined || this.listeners.size === 0) return;
    try {
      await mkdir(this.homeDir, { recursive: true, mode: 0o700 });
      const initial = await this.readOrQuarantine().catch(() => undefined);
      if (initial !== undefined && initial.revision > this.lastKnownState.revision) {
        this.lastKnownState = initial;
      }
    } catch {
      return;
    }
    if (this.closed || this.watcher !== undefined || this.listeners.size === 0) return;
    try {
      const watcher = nodeFs.watch(this.homeDir, { persistent: false }, (_eventType, filename) => {
        if (this.closed || this.selfWriting > 0) return;
        if (filename !== null && filename !== STORE_FILENAME && !filename.startsWith(STORE_FILENAME)) {
          return;
        }
        if (this.watchTimer !== undefined) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = undefined;
          void this.reconcileExternalChange();
        }, WATCH_DEBOUNCE_MS);
        this.watchTimer.unref?.();
      });
      watcher.on('error', () => {
        this.stopWatcher();
      });
      watcher.unref?.();
      this.watcher = watcher;
    } catch {
      this.watcher = undefined;
    }
  }

  private stopWatcher(): void {
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
    if (this.closed || this.selfWriting > 0 || this.listeners.size === 0) return;
    const previous = this.lastKnownState;
    let current: InternalState;
    try {
      const text = await readFile(this.filePath, 'utf-8');
      current = text.trim().length === 0 ? { revision: 0, entries: emptyRecord() } : parsePersistedState(text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        current = { revision: 0, entries: emptyRecord() };
      } else {
        return;
      }
    }
    if (current.revision <= previous.revision) return;
    const changes = diffSnapshots(previous, current);
    this.lastKnownState = current;
    if (changes !== undefined) {
      this.emitChange({ revision: current.revision, entries: changes });
    }
  }
}
