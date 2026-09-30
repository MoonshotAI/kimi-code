import { isAbsolute, relative, resolve } from 'pathe';

import {
  BlobMissingError,
  sha256Hex,
  type Blobs,
  type RecordEvent,
} from '@moonshot-ai/agent-core';

import { HostFsError, unwrapErrorCause, type OsFsPort } from '#/features/os/host/index';

import { LCS_AGGREGATE_CELL_BUDGET, decodeText, diffChange } from './diff';
import {
  FILE_HISTORY_BLOB_PREFIX,
  type FileBackupEntry,
  type FileHistoryChange,
  type FileHistoryCheckpointPhase,
  type FileHistoryCheckpointRecord,
  type FileHistoryContent,
  type FileHistoryFace,
  type FileHistoryState,
} from './fileHistory';
import {
  FILE_HISTORY_CHECKPOINT,
  FILE_HISTORY_TRACKED,
  checkpointPhaseOf,
} from './projection';

export const FILE_HISTORY_MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface FileHistoryServiceDeps {
  readonly workDir: string;
  readonly fs: OsFsPort;
  readonly blobs: Blobs;
  readonly state: () => FileHistoryState;
  readonly dispatch: (event: RecordEvent) => Promise<unknown>;
  readonly activeTurnId: () => number | undefined;
}

export interface FileHistoryService {
  readonly face: FileHistoryFace;
  capture(path: string, turnId: number): Promise<void>;
  endCheckpoint(turnId: number): Promise<void>;
}

type CurrentContent =
  | Uint8Array
  | 'missing'
  | 'unreadable'
  | { oversizeBytes: number; mtimeMs?: number };

export function createFileHistoryService(deps: FileHistoryServiceDeps): FileHistoryService {
  let queue: Promise<void> = Promise.resolve();

  const enqueueValue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = queue.then(op);
    queue = run.then(
      () => undefined,
      () => {},
    );
    return run;
  };

  const history = (): FileHistoryState => deps.state();

  const comparisonKey = (pathKey: string): string =>
    isWindowsPath(deps.workDir) ? pathKey.toLowerCase() : pathKey;

  const pathKeyOf = (path: string): string => {
    let raw = path;
    if (isAbsolute(path)) {
      const relativePath = relative(deps.workDir, path);
      if (relativePath !== '' && relativePath !== '..' && !relativePath.startsWith('../')) {
        raw = relativePath;
      }
    }
    const key = comparisonKey(raw);
    const existing = history().tracked.find((tracked) => comparisonKey(tracked) === key);
    return existing ?? raw;
  };

  const readCurrent = async (pathKey: string): Promise<CurrentContent> => {
    const absolute = isAbsolute(pathKey) ? pathKey : resolve(deps.workDir, pathKey);
    let info;
    try {
      info = await deps.fs.stat(absolute);
    } catch (error) {
      return isMissingError(error) ? 'missing' : 'unreadable';
    }
    if (!info.isFile) return 'unreadable';
    if (info.size > FILE_HISTORY_MAX_FILE_BYTES) {
      return { oversizeBytes: info.size, mtimeMs: info.mtimeMs };
    }
    try {
      const bytes = await deps.fs.readBytes(absolute, info.size + 1);
      if (bytes.byteLength > FILE_HISTORY_MAX_FILE_BYTES) {
        const grown = await deps.fs.stat(absolute).catch(() => undefined);
        return {
          oversizeBytes: grown?.size ?? bytes.byteLength,
          mtimeMs: grown?.mtimeMs,
        };
      }
      if (bytes.byteLength !== info.size) return 'unreadable';
      return bytes;
    } catch {
      return 'unreadable';
    }
  };

  const backup = async (
    version: number,
    content: Uint8Array,
    contentHash?: string,
  ): Promise<FileBackupEntry> => {
    const hash = contentHash ?? (await sha256Hex(content));
    await deps.blobs.put(content);
    return {
      key: `${FILE_HISTORY_BLOB_PREFIX}/${hash}`,
      version,
      contentHash: hash,
      size: content.byteLength,
    };
  };

  const capture = async (path: string, turnId: number): Promise<void> => {
    const pathKey = pathKeyOf(path);
    const state = history();
    const startCheckpoint = state.checkpoints.find(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
    );
    if (startCheckpoint !== undefined && Object.hasOwn(startCheckpoint.entries, pathKey)) return;

    const current = await readCurrent(pathKey);
    if (current === 'unreadable') return;
    const latest = latestEntry(state.checkpoints, pathKey);
    const nextVersion = maxVersion(state.checkpoints, pathKey) + 1;
    let entry: FileBackupEntry;
    if (current === 'missing') {
      entry =
        latest !== undefined && latest.key === null && latest.oversize !== true
          ? { ...latest }
          : { key: null, version: nextVersion };
    } else if (current instanceof Uint8Array) {
      const contentHash = await sha256Hex(current);
      entry =
        latest !== undefined && latest.contentHash === contentHash
          ? { ...latest }
          : await backup(nextVersion, current, contentHash);
    } else {
      entry =
        latest?.oversize === true &&
        latest.size === current.oversizeBytes &&
        latest.mtimeMs === current.mtimeMs
          ? { ...latest }
          : {
              key: null,
              version: nextVersion,
              oversize: true,
              size: current.oversizeBytes,
              mtimeMs: current.mtimeMs,
            };
    }
    await deps.dispatch({ type: FILE_HISTORY_TRACKED, turnId, path: pathKey, entry });
  };

  const endCheckpoint = async (turnId: number): Promise<void> => {
    const state = history();
    if (state.checkpoints.some((c) => c.turnId === turnId && checkpointPhaseOf(c) === 'end')) {
      return;
    }
    const start = state.checkpoints.find(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
    );
    if (start === undefined) return;

    const entries: Record<string, FileBackupEntry> = Object.create(null) as Record<
      string,
      FileBackupEntry
    >;
    for (const [pathKey, before] of Object.entries(start.entries)) {
      const nextVersion = maxVersion(state.checkpoints, pathKey) + 1;
      const current = await readCurrent(pathKey);
      if (current === 'unreadable') continue;
      if (current === 'missing') {
        if (before.key !== null || before.oversize === true) {
          entries[pathKey] = { key: null, version: nextVersion };
        }
        continue;
      }
      if (!(current instanceof Uint8Array)) {
        if (
          before.oversize !== true ||
          before.size !== current.oversizeBytes ||
          before.mtimeMs !== current.mtimeMs
        ) {
          entries[pathKey] = {
            key: null,
            version: nextVersion,
            oversize: true,
            size: current.oversizeBytes,
            mtimeMs: current.mtimeMs,
          };
        }
        continue;
      }
      const contentHash = await sha256Hex(current);
      if (before.contentHash === contentHash) continue;
      entries[pathKey] = await backup(nextVersion, current, contentHash);
    }
    await deps.dispatch({ type: FILE_HISTORY_CHECKPOINT, turnId, phase: 'end', entries });
  };

  const entryBytes = async (
    entry: FileBackupEntry | undefined,
  ): Promise<Uint8Array | undefined> => {
    if (entry === undefined || entry.key === null) return undefined;
    try {
      return await deps.blobs.get(blobRefOf(entry.key));
    } catch (error) {
      if (error instanceof BlobMissingError) return undefined;
      throw error;
    }
  };

  const liveTurnId = (state: FileHistoryState, turnId: number, index: number): boolean =>
    index === state.checkpoints.length - 1 && deps.activeTurnId() === turnId;

  const readChanges = async (turnId: number): Promise<FileHistoryChange[]> => {
    const state = history();
    const index = state.checkpoints.findIndex(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
    );
    if (index < 0) return [];
    const end = state.checkpoints.find(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'end',
    );
    const live = end === undefined && liveTurnId(state, turnId, index);
    if (end === undefined && !live) return [];

    const start = state.checkpoints[index]!;
    const paths = Object.keys(end !== undefined ? end.entries : start.entries);

    const changes: FileHistoryChange[] = [];
    const lcsBudget = { remaining: LCS_AGGREGATE_CELL_BUDGET };
    for (const path of paths.toSorted()) {
      const before = Object.hasOwn(start.entries, path) ? start.entries[path] : undefined;
      const after = end !== undefined ? end.entries[path] : undefined;
      if (end !== undefined && before?.version === after?.version) continue;
      if (before?.oversize === true && after?.oversize === true) {
        if (before.version !== after.version) {
          changes.push({ path, status: 'modified', additions: 0, deletions: 0, oversize: true });
        }
        continue;
      }
      const beforeMissing = before === undefined || (before.key === null && before.oversize !== true);
      let liveOversize: { size: number; mtimeMs?: number } | undefined;
      let liveMissing = false;
      let afterBytes: Uint8Array | undefined;
      if (end !== undefined) {
        if (before?.oversize !== true && after?.oversize !== true) {
          afterBytes = await entryBytes(after);
        }
      } else {
        const current = await readCurrent(path);
        if (current === 'unreadable') continue;
        if (current instanceof Uint8Array) afterBytes = current;
        else if (current === 'missing') liveMissing = true;
        else liveOversize = { size: current.oversizeBytes, mtimeMs: current.mtimeMs };
      }
      const afterMissing =
        end !== undefined
          ? after === undefined || (after.key === null && after.oversize !== true)
          : liveMissing;
      if (before?.oversize === true || after?.oversize === true || liveOversize !== undefined) {
        if (
          before?.oversize === true &&
          liveOversize !== undefined &&
          before.size === liveOversize.size &&
          before.mtimeMs === liveOversize.mtimeMs
        ) {
          continue;
        }
        const status = beforeMissing ? 'added' : afterMissing ? 'deleted' : 'modified';
        changes.push({ path, status, additions: 0, deletions: 0, oversize: true });
        continue;
      }
      const beforeBytes = await entryBytes(before);
      const beforeLost =
        before !== undefined && before.key !== null && beforeBytes === undefined;
      const afterLost =
        end !== undefined && after !== undefined && after.key !== null && afterBytes === undefined;
      if (beforeLost || afterLost) {
        const status = beforeMissing ? 'added' : afterMissing ? 'deleted' : 'modified';
        changes.push({ path, status, additions: 0, deletions: 0, binary: true });
        continue;
      }
      const change = diffChange(path, beforeBytes, afterBytes, lcsBudget);
      if (change !== undefined) changes.push(change);
    }
    return changes;
  };

  const turnRecorded = async (turnId: number): Promise<boolean> => {
    const state = history();
    const index = state.checkpoints.findIndex(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
    );
    if (index < 0) return false;
    const end = state.checkpoints.find(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'end',
    );
    const live = end === undefined && liveTurnId(state, turnId, index);
    if (end === undefined && !live) return false;
    const keys = new Set<string>();
    for (const entry of [
      ...Object.values(state.checkpoints[index]!.entries),
      ...Object.values(end?.entries ?? {}),
    ]) {
      if (entry.key !== null) keys.add(entry.key);
    }
    for (const key of keys) {
      if (!(await deps.blobs.has(blobRefOf(key)))) return false;
    }
    return true;
  };

  const readContentAt = async (
    turnId: number,
    path: string,
    phase: FileHistoryCheckpointPhase,
  ): Promise<FileHistoryContent | undefined> => {
    const state = history();
    const index = state.checkpoints.findIndex(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === phase,
    );
    if (index < 0) return undefined;
    const record = state.checkpoints[index]!;
    const pathKey = pathKeyOf(path);
    let entry = Object.hasOwn(record.entries, pathKey) ? record.entries[pathKey] : undefined;
    if (entry === undefined && phase === 'end') {
      const start = state.checkpoints.find(
        (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
      );
      entry =
        start !== undefined && Object.hasOwn(start.entries, pathKey)
          ? start.entries[pathKey]
          : undefined;
    }
    if (entry === undefined || entry.oversize === true) return undefined;
    if (entry.key === null) return { version: entry.version };
    const bytes = await entryBytes(entry);
    if (bytes === undefined) return undefined;
    const content = decodeText(bytes);
    if (content === undefined) return { version: entry.version, binary: true };
    return { version: entry.version, content };
  };

  const face: FileHistoryFace = {
    history,
    settled: () => queue,
    captureForActiveTurn: (path) => {
      const turnId = deps.activeTurnId();
      if (turnId === undefined) return Promise.resolve();
      return enqueueValue(() => capture(path, turnId));
    },
    changes: (turnId) => enqueueValue(() => readChanges(turnId)),
    turnRecorded: (turnId) => enqueueValue(() => turnRecorded(turnId)),
    contentAt: (turnId, path, phase = 'start') =>
      enqueueValue(() => readContentAt(turnId, path, phase)),
  };

  return {
    face,
    capture: (path, turnId) => enqueueValue(() => capture(path, turnId)),
    endCheckpoint: (turnId) => enqueueValue(() => endCheckpoint(turnId)),
  };
}

function blobRefOf(key: string): string {
  return key.slice(FILE_HISTORY_BLOB_PREFIX.length + 1);
}

function isMissingError(error: unknown): boolean {
  if (error instanceof HostFsError && error.code === 'os.fs.not_found') return true;
  const cause = unwrapErrorCause(error) as { code?: unknown } | null;
  return cause?.code === 'ENOENT';
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

function latestEntry(
  checkpoints: readonly FileHistoryCheckpointRecord[],
  path: string,
): FileBackupEntry | undefined {
  for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
    const record = checkpoints[i]!.entries;
    if (Object.hasOwn(record, path)) return record[path];
  }
  return undefined;
}

function maxVersion(
  checkpoints: readonly FileHistoryCheckpointRecord[],
  path: string,
): number {
  let max = 0;
  for (const checkpoint of checkpoints) {
    const entry = Object.hasOwn(checkpoint.entries, path) ? checkpoint.entries[path] : undefined;
    if (entry !== undefined && entry.version > max) max = entry.version;
  }
  return max;
}
