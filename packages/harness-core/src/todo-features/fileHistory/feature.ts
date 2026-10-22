import { isAbsolute, relative, resolve } from 'pathe';

import type { ToolCall } from '@moonshot-ai/agent-core/llm/message';
import { MAIN_AGENT_ID, type Session } from '@moonshot-ai/agent-core/session/index';

import { createFeature, useAgent, useSession, useToolStarting, type Feature, useLoopEvent, useFeatureStore } from '#/app/index';
import { useCleanup, useExpose } from '#/composition-api/index';
import { HostFsError, unwrapErrorCause, type OsFsPort } from '#/todo-features/os/host/index';

import { sha256Hex } from '#/sha256';

import { LCS_AGGREGATE_CELL_BUDGET, decodeText, diffChange } from './diff';
import {
  FILE_HISTORY_BLOB_PREFIX,
  FileHistoryRef,
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
  displacedCheckpoints,
  fileHistoryProjection,
} from './projection';

export const FILE_HISTORY_MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface CreateFileHistoryProps {
  readonly workDir: string;
  readonly fs: OsFsPort;
}

type CurrentContent =
  | Uint8Array
  | 'missing'
  | 'unreadable'
  | { oversizeBytes: number; mtimeMs?: number };

export function createFileHistory(props: CreateFileHistoryProps): Feature<void> {
  const mains = new WeakMap<Session, FileHistoryFace>();
  return createFeature('fileHistory', {
    agent() {
      const agent = useAgent();
      const session = useSession();
      const store = useFeatureStore('agent', 'file-history', fileHistoryProjection);
      const blobs = session.blobs(FILE_HISTORY_BLOB_PREFIX);
      let activeTurnId: number | undefined = agent.loop.state.turn?.id;
      let sweepDone = false;
      let queue: Promise<void> = store.ready.then(
        () => undefined,
        () => undefined,
      );

      const _enqueueValue = <T>(op: () => Promise<T>): Promise<T> => {
        const run = queue.then(op);
        queue = run.then(
          () => undefined,
          () => {},
        );
        return run;
      };

      const history = (): FileHistoryState => store.state.value;

      const _comparisonKey = (pathKey: string): string =>
        isWindowsPath(props.workDir) ? pathKey.toLowerCase() : pathKey;

      const _pathKeyOf = (path: string): string => {
        let raw = path;
        if (isAbsolute(path)) {
          const relativePath = relative(props.workDir, path);
          if (relativePath !== '' && relativePath !== '..' && !relativePath.startsWith('../')) {
            raw = relativePath;
          }
        }
        const key = _comparisonKey(raw);
        const existing = history().tracked.find((tracked) => _comparisonKey(tracked) === key);
        return existing ?? raw;
      };

      const _readCurrent = async (pathKey: string): Promise<CurrentContent> => {
        const absolute = isAbsolute(pathKey) ? pathKey : resolve(props.workDir, pathKey);
        let info;
        try {
          info = await props.fs.stat(absolute);
        } catch (error) {
          return isMissingError(error) ? 'missing' : 'unreadable';
        }
        if (!info.isFile) return 'unreadable';
        if (info.size > FILE_HISTORY_MAX_FILE_BYTES) {
          return { oversizeBytes: info.size, mtimeMs: info.mtimeMs };
        }
        try {
          const bytes = await props.fs.readBytes(absolute, info.size + 1);
          if (bytes.byteLength > FILE_HISTORY_MAX_FILE_BYTES) {
            const grown = await props.fs.stat(absolute).catch(() => undefined);
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

      const _backup = async (
        version: number,
        content: Uint8Array,
        contentHash?: string,
      ): Promise<FileBackupEntry> => {
        const hash = contentHash ?? sha256Hex(content);
        const { ref } = await blobs.put({ bytes: content });
        return {
          key: `${FILE_HISTORY_BLOB_PREFIX}/${ref}`,
          version,
          contentHash: hash,
          size: content.byteLength,
        };
      };

      const _capture = async (path: string, turnId: number): Promise<void> => {
        const pathKey = _pathKeyOf(path);
        const state = history();
        const startCheckpoint = state.checkpoints.find(
          (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
        );
        if (startCheckpoint !== undefined && Object.hasOwn(startCheckpoint.entries, pathKey)) return;

        const current = await _readCurrent(pathKey);
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
          const contentHash = sha256Hex(current);
          entry =
            latest !== undefined && latest.contentHash === contentHash
              ? { ...latest }
              : await _backup(nextVersion, current, contentHash);
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
        await store.dispatch([{ type: FILE_HISTORY_TRACKED, turn: turnId, path: pathKey, entry }]);
      };

      const _sweepOrphanBlobs = async (): Promise<void> => {
        if (sweepDone) return;
        sweepDone = true;
        const referenced = new Set<string>();
        for (const checkpoint of history().checkpoints) {
          for (const entry of Object.values(checkpoint.entries)) {
            if (entry.key !== null) referenced.add(entry.key);
          }
        }
        let refs: readonly string[];
        try {
          refs = await blobs.list();
        } catch {
          return;
        }
        for (const ref of refs) {
          if (referenced.has(`${FILE_HISTORY_BLOB_PREFIX}/${ref}`)) continue;
          try {
            await blobs.delete(ref);
          } catch {}
        }
      };

      const _evictBlobs = async (
        evicted: readonly FileHistoryCheckpointRecord[],
        retained: readonly FileHistoryCheckpointRecord[],
      ): Promise<void> => {
        const retainedKeys = new Set<string>();
        for (const checkpoint of retained) {
          for (const entry of Object.values(checkpoint.entries)) {
            if (entry.key !== null) retainedKeys.add(entry.key);
          }
        }
        for (const checkpoint of evicted) {
          for (const entry of Object.values(checkpoint.entries)) {
            if (entry.key === null || retainedKeys.has(entry.key)) continue;
            try {
              await blobs.delete(blobRefOf(entry.key));
            } catch {}
          }
        }
      };

      const _endCheckpoint = async (turnId: number): Promise<void> => {
        const state = history();
        if (state.checkpoints.some((c) => c.turnId === turnId && checkpointPhaseOf(c) === 'end')) {
          return;
        }
        const start = state.checkpoints.find(
          (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
        );
        if (start === undefined) return;
        await _sweepOrphanBlobs();

        const entries: Record<string, FileBackupEntry> = Object.create(null) as Record<
          string,
          FileBackupEntry
        >;
        for (const [pathKey, before] of Object.entries(start.entries)) {
          const nextVersion = maxVersion(state.checkpoints, pathKey) + 1;
          const current = await _readCurrent(pathKey);
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
          const contentHash = sha256Hex(current);
          if (before.contentHash === contentHash) continue;
          entries[pathKey] = await _backup(nextVersion, current, contentHash);
        }
        const evictable = displacedCheckpoints(state.checkpoints, turnId);
        await store.dispatch([{ type: FILE_HISTORY_CHECKPOINT, turn: turnId, phase: 'end', entries }]);
        if (evictable.length > 0) {
          const displaced = new Set(evictable);
          await _evictBlobs(evictable, [
            ...state.checkpoints.filter((c) => !displaced.has(c)),
            { turnId, phase: 'end' as const, entries },
          ]);
        }
      };

      const _entryBytes = async (
        entry: FileBackupEntry | undefined,
      ): Promise<Uint8Array | undefined> => {
        if (entry === undefined || entry.key === null) return undefined;
        const blob = await blobs.get(blobRefOf(entry.key));
        return blob?.bytes;
      };

      const _liveTurnId = (state: FileHistoryState, turnId: number, index: number): boolean =>
        index === state.checkpoints.length - 1 && activeTurnId === turnId;

      const _readChanges = async (turnId: number): Promise<FileHistoryChange[]> => {
        const state = history();
        const index = state.checkpoints.findIndex(
          (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
        );
        if (index < 0) return [];
        const end = state.checkpoints.find(
          (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'end',
        );
        const live = end === undefined && _liveTurnId(state, turnId, index);
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
          const beforeMissing =
            before === undefined || (before.key === null && before.oversize !== true);
          let liveOversize: { size: number; mtimeMs?: number } | undefined;
          let liveMissing = false;
          let afterBytes: Uint8Array | undefined;
          if (end !== undefined) {
            if (before?.oversize !== true && after?.oversize !== true) {
              afterBytes = await _entryBytes(after);
            }
          } else {
            const current = await _readCurrent(path);
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
          const beforeBytes = await _entryBytes(before);
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

      const _turnRecorded = async (turnId: number): Promise<boolean> => {
        const state = history();
        const index = state.checkpoints.findIndex(
          (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
        );
        if (index < 0) return false;
        const end = state.checkpoints.find(
          (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'end',
        );
        const live = end === undefined && _liveTurnId(state, turnId, index);
        if (end === undefined && !live) return false;
        const keys = new Set<string>();
        for (const entry of [
          ...Object.values(state.checkpoints[index]!.entries),
          ...Object.values(end?.entries ?? {}),
        ]) {
          if (entry.key !== null) keys.add(entry.key);
        }
        for (const key of keys) {
          if (!(await blobs.has(blobRefOf(key)))) return false;
        }
        return true;
      };

      const _readContentAt = async (
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
        const pathKey = _pathKeyOf(path);
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
        const bytes = await _entryBytes(entry);
        if (bytes === undefined) return undefined;
        const content = decodeText(bytes);
        if (content === undefined) return { version: entry.version, binary: true };
        return { version: entry.version, content };
      };

      const face: FileHistoryFace = {
        history,
        settled: () => queue,
        captureForActiveTurn: (path) => {
          const turnId = activeTurnId;
          if (turnId === undefined) return Promise.resolve();
          return _enqueueValue(() => _capture(path, turnId));
        },
        changes: (turnId) => _enqueueValue(() => _readChanges(turnId)),
        turnRecorded: (turnId) => _enqueueValue(() => _turnRecorded(turnId)),
        contentAt: (turnId, path, phase = 'start') =>
          _enqueueValue(() => _readContentAt(turnId, path, phase)),
      };

      useExpose(FileHistoryRef, face);
      if (agent.id !== MAIN_AGENT_ID) {
        useToolStarting(async ({ toolCall }) => {
          const path = editTargetPath(toolCall);
          if (path === undefined) return undefined;
          const main = mains.get(session);
          if (main === undefined) return undefined;
          await main.captureForActiveTurn(path);
          return undefined;
        });
        return;
      }
      mains.set(session, face);
      useCleanup(() => {
        if (mains.get(session) === face) mains.delete(session);
      });
      useToolStarting(async ({ toolCall }) => {
        const path = editTargetPath(toolCall);
        const turnId = activeTurnId;
        if (path === undefined || turnId === undefined) return undefined;
        await _enqueueValue(() => _capture(path, turnId));
        return undefined;
      });
      useLoopEvent('turn.started', (event) => {
        activeTurnId = event.turnId;
      });
      useLoopEvent('turn.ended', (event) => {
        if (activeTurnId === event.turnId) activeTurnId = undefined;
        void _enqueueValue(() => _endCheckpoint(event.turnId));
      });
    },
  });
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

const CAPTURED_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write']);

function editTargetPath(toolCall: ToolCall): string | undefined {
  if (!CAPTURED_TOOLS.has(toolCall.name)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.arguments ?? '{}');
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const filePath = record['file_path'];
  if (typeof filePath === 'string') return filePath;
  const path = record['path'];
  return typeof path === 'string' ? path : undefined;
}
