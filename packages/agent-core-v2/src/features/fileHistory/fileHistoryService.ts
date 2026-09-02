import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'pathe';

import { Service } from '#/_base/di/service';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { WillExecuteToolEvent } from '#/agent/toolExecutor/toolHooks';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import {
  IAgentFileHistoryService,
  FILE_HISTORY_BLOB_PREFIX,
  type FileBackupEntry,
  type FileHistoryChange,
  type FileHistoryCheckpointPhase,
  type FileHistoryCheckpointRecord,
  type FileHistoryContent,
  type FileHistoryState,
} from './fileHistory';
import {
  displacedCheckpoints,
  FileHistoryCheckpointed,
  FileHistoryTracked,
  checkpointPhaseOf,
  fileHistoryKey,
} from './fileHistoryOps';
import { touchFileHistorySession } from './fileHistoryRetention';
import { FILE_HISTORY_FLAG_ID } from './flag';

export const FILE_HISTORY_MAX_FILE_BYTES = 4 * 1024 * 1024;
export { FILE_HISTORY_BLOB_PREFIX } from './fileHistory';

export class AgentFileHistoryService extends Service implements IAgentFileHistoryService {
  declare readonly _serviceBrand: undefined;

  private queue: Promise<void> = Promise.resolve();
  private activeTurnId: number | undefined;
  private orphanSweepDone = false;

  constructor(
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IEventBus eventBus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IFlagService private readonly flags: IFlagService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IBlobStore private readonly blobs: IBlobStore,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();
    this.agentState.contributeState(fileHistoryKey);
    if (this.agentCtx.agentId !== MAIN_AGENT_ID) {
      this._register(
        toolExecutor.onWillExecuteTool((event) => this.onSubagentWillExecuteTool(event)),
      );
      return;
    }

    this._register(
      toolExecutor.onWillExecuteTool((event) => this.onWillExecuteTool(event)),
    );
    this._register(
      eventBus.subscribe(TurnStarted, (event) => {
        if (event.agentId !== this.agentCtx.agentId) return;
        this.activeTurnId = event.turnId;
      }),
    );
    this._register(
      eventBus.subscribe(TurnEnded, (event) => {
        if (event.agentId !== this.agentCtx.agentId) return;
        if (this.activeTurnId === event.turnId) this.activeTurnId = undefined;
        if (!this.enabled()) return;
        void this.enqueue(() => this.endCheckpoint(event.turnId));
      }),
    );
    this.effect(() => () => this.queue, 'fileHistory:drain');
  }

  enabled(): boolean {
    return this.flags.enabled(FILE_HISTORY_FLAG_ID);
  }

  history(): FileHistoryState {
    return this.agentState.get(fileHistoryKey);
  }

  settled(): Promise<void> {
    return this.queue;
  }

  changes(turnId: number): Promise<FileHistoryChange[]> {
    if (!this.enabled()) return Promise.resolve([]);
    return this.enqueueValue(() => this.readChanges(turnId));
  }

  turnRecorded(turnId: number): Promise<boolean> {
    if (!this.enabled()) return Promise.resolve(false);
    return this.enqueueValue(async () => {
      const state = this.history();
      const index = state.checkpoints.findIndex(
        (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
      );
      if (index < 0) return false;
      const end = state.checkpoints.find(
        (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'end',
      );
      const live =
        end === undefined &&
        index === state.checkpoints.length - 1 &&
        this.activeTurnId === turnId;
      if (end === undefined && !live) return false;
      const entries = { ...state.checkpoints[index]!.entries, ...end?.entries };
      const keyed = Object.values(entries).find((entry) => entry.key !== null);
      if (keyed?.key === null || keyed?.key === undefined) return true;
      return this.blobs.has(this.agentCtx.scope(), keyed.key);
    });
  }

  private async readChanges(turnId: number): Promise<FileHistoryChange[]> {
    const state = this.history();
    const index = state.checkpoints.findIndex(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
    );
    if (index < 0) return [];
    const end = state.checkpoints.find(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'end',
    );
    const live =
      end === undefined &&
      index === state.checkpoints.length - 1 &&
      this.activeTurnId === turnId;
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
          afterBytes = await this.entryBytes(after);
        }
      } else {
        const current = await this.readCurrent(path);
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
      const beforeBytes = await this.entryBytes(before);
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
  }

  contentAt(
    turnId: number,
    path: string,
    phase: FileHistoryCheckpointPhase = 'start',
  ): Promise<FileHistoryContent | undefined> {
    if (!this.enabled()) return Promise.resolve(undefined);
    return this.enqueueValue(() => this.readContentAt(turnId, path, phase));
  }

  private async readContentAt(
    turnId: number,
    path: string,
    phase: FileHistoryCheckpointPhase,
  ): Promise<FileHistoryContent | undefined> {
    const state = this.history();
    const index = state.checkpoints.findIndex(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === phase,
    );
    if (index < 0) return undefined;
    const record = state.checkpoints[index]!;
    const pathKey = this.pathKey(path);
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
    const bytes = await this.blobs.get(this.agentCtx.scope(), entry.key);
    if (bytes === undefined) return undefined;
    const content = decodeText(bytes);
    if (content === undefined) return { version: entry.version, binary: true };
    return { version: entry.version, content };
  }

  private onWillExecuteTool(event: WillExecuteToolEvent): void {
    if (!this.enabled()) return;
    const path = editTargetPath(event.execution.display);
    if (path === undefined) return;
    event.waitUntil(this.enqueue(() => this.capture(path, event.turnId)));
  }

  private onSubagentWillExecuteTool(event: WillExecuteToolEvent): void {
    if (!this.enabled()) return;
    const path = editTargetPath(event.execution.display);
    if (path === undefined) return;
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) return;
    event.waitUntil(main.accessor.get(IAgentFileHistoryService).captureForActiveTurn(path));
  }

  captureForActiveTurn(path: string): Promise<void> {
    const turnId = this.activeTurnId;
    if (!this.enabled() || turnId === undefined) return Promise.resolve();
    return this.enqueue(() => this.capture(path, turnId));
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    return this.enqueueValue(op);
  }

  private enqueueValue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op);
    this.queue = run.then(
      () => undefined,
      (error) => {
        onUnexpectedError(error);
      },
    );
    return run;
  }

  private async capture(path: string, turnId: number): Promise<void> {
    const pathKey = this.pathKey(path);
    const state = this.history();
    const startCheckpoint = state.checkpoints.find(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
    );
    if (startCheckpoint !== undefined && Object.hasOwn(startCheckpoint.entries, pathKey)) return;

    const current = await this.readCurrent(pathKey);
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
      const contentHash = sha256(current);
      entry =
        latest !== undefined && latest.contentHash === contentHash
          ? { ...latest }
          : await this.backup(pathKey, nextVersion, current, contentHash);
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
    await this.dispatcher.dispatch(
      new FileHistoryTracked({ agentId: this.agentCtx.agentId, turnId, path: pathKey, entry }),
    );
  }

  private async endCheckpoint(turnId: number): Promise<void> {
    const state = this.history();
    if (state.checkpoints.some((c) => c.turnId === turnId && checkpointPhaseOf(c) === 'end')) {
      return;
    }
    const start = state.checkpoints.find(
      (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
    );
    if (start === undefined) return;
    await this.sweepOrphanBlobs();
    void touchFileHistorySession({
      docs: this.docs,
      hostFs: this.hostFs,
      workspaceId: this.sessionCtx.workspaceId,
      sessionDir: this.sessionCtx.sessionDir,
      sessionId: this.sessionCtx.sessionId,
    });

    const entries: Record<string, FileBackupEntry> = Object.create(null) as Record<
      string,
      FileBackupEntry
    >;
    for (const [pathKey, before] of Object.entries(start.entries)) {
      const nextVersion = maxVersion(state.checkpoints, pathKey) + 1;
      const current = await this.readCurrent(pathKey);
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
      const contentHash = sha256(current);
      if (before.contentHash === contentHash) continue;
      entries[pathKey] = await this.backup(pathKey, nextVersion, current, contentHash);
    }

    const evictable = displacedCheckpoints(state.checkpoints, turnId);
    await this.dispatcher.dispatch(
      new FileHistoryCheckpointed({ agentId: this.agentCtx.agentId, turnId, phase: 'end', entries }),
    );
    if (evictable.length > 0) {
      await this.dispatcher.flush();
      await this.evictBlobs(evictable, this.history().checkpoints);
    }
  }

  private async backup(
    pathKey: string,
    version: number,
    content: Uint8Array,
    contentHash?: string,
  ): Promise<FileBackupEntry> {
    const hash = contentHash ?? sha256(content);
    const key = blobKey(pathKey, version);
    await this.blobs.put(this.agentCtx.scope(), key, content);
    return { key, version, contentHash: hash, size: content.byteLength };
  }

  private async sweepOrphanBlobs(): Promise<void> {
    if (this.orphanSweepDone) return;
    this.orphanSweepDone = true;
    const referenced = new Set<string>();
    for (const checkpoint of this.history().checkpoints) {
      for (const entry of Object.values(checkpoint.entries)) {
        if (entry.key !== null) referenced.add(entry.key);
      }
    }
    let names: readonly string[];
    try {
      names = await this.blobs.list(`${this.agentCtx.scope()}/${FILE_HISTORY_BLOB_PREFIX}`);
    } catch (error) {
      onUnexpectedError(error);
      return;
    }
    for (const name of names) {
      const key = `${FILE_HISTORY_BLOB_PREFIX}/${name}`;
      if (referenced.has(key)) continue;
      try {
        await this.blobs.delete(this.agentCtx.scope(), key);
      } catch (error) {
        onUnexpectedError(error);
      }
    }
  }

  private async evictBlobs(
    evicted: readonly FileHistoryCheckpointRecord[],
    retained: readonly FileHistoryCheckpointRecord[],
  ): Promise<void> {
    if (evicted.length === 0) return;
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
          await this.blobs.delete(this.agentCtx.scope(), entry.key);
        } catch (error) {
          onUnexpectedError(error);
        }
      }
    }
  }

  private async entryBytes(entry: FileBackupEntry | undefined): Promise<Uint8Array | undefined> {
    if (entry === undefined || entry.key === null) return undefined;
    return this.blobs.get(this.agentCtx.scope(), entry.key);
  }

  private async readCurrent(
    pathKey: string,
  ): Promise<
    Uint8Array | 'missing' | 'unreadable' | { oversizeBytes: number; mtimeMs?: number }
  > {
    const absolute = isAbsolute(pathKey) ? pathKey : resolve(this.workspaceCtx.workDir, pathKey);
    const lease = this.runtime.acquire(['fs']);
    try {
      const fs = lease.runtime.fs;
      if (fs === undefined) return 'unreadable';
      let info;
      try {
        info = await fs.stat(absolute);
      } catch (error) {
        const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
        return code === 'ENOENT' ? 'missing' : 'unreadable';
      }
      if (!info.isFile) return 'unreadable';
      if (info.size > FILE_HISTORY_MAX_FILE_BYTES) {
        return { oversizeBytes: info.size, mtimeMs: info.mtimeMs };
      }
      try {
        const bytes = await fs.readBytes(absolute, info.size + 1);
        if (bytes.byteLength > FILE_HISTORY_MAX_FILE_BYTES) {
          const grown = await fs.stat(absolute).catch(() => undefined);
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
    } finally {
      lease.dispose();
    }
  }

  private pathKey(path: string): string {
    let raw = path;
    if (isAbsolute(path)) {
      const relativePath = relative(this.workspaceCtx.workDir, path);
      if (relativePath !== '' && relativePath !== '..' && !relativePath.startsWith('../')) {
        raw = relativePath;
      }
    }
    const key = this.comparisonKey(raw);
    const existing = this.history().tracked.find(
      (tracked) => this.comparisonKey(tracked) === key,
    );
    return existing ?? raw;
  }

  private comparisonKey(pathKey: string): string {
    return isWindowsPath(this.workspaceCtx.workDir) ? pathKey.toLowerCase() : pathKey;
  }
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

function editTargetPath(display: ToolInputDisplay | undefined): string | undefined {
  if (display === undefined || display.kind !== 'file_io') return undefined;
  if (display.operation !== 'edit' && display.operation !== 'write') return undefined;
  return display.path;
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

function blobKey(pathKey: string, version: number): string {
  const hash = createHash('sha256').update(pathKey, 'utf8').digest('hex');
  return `${FILE_HISTORY_BLOB_PREFIX}/${hash}@v${String(version)}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function diffChange(
  path: string,
  beforeBytes: Uint8Array | undefined,
  afterBytes: Uint8Array | undefined,
  budget?: LcsCellBudget,
): FileHistoryChange | undefined {
  if (beforeBytes === undefined && afterBytes === undefined) return undefined;
  const before = beforeBytes === undefined ? undefined : decodeText(beforeBytes);
  const after = afterBytes === undefined ? undefined : decodeText(afterBytes);
  const binary =
    (beforeBytes !== undefined && before === undefined) ||
    (afterBytes !== undefined && after === undefined);

  if (beforeBytes === undefined) {
    return binary
      ? { path, status: 'added', additions: 0, deletions: 0, binary }
      : { path, status: 'added', additions: countLines(after ?? ''), deletions: 0 };
  }
  if (afterBytes === undefined) {
    return binary
      ? { path, status: 'deleted', additions: 0, deletions: 0, binary }
      : { path, status: 'deleted', additions: 0, deletions: countLines(before ?? '') };
  }
  if (binary) {
    return bytesEqual(beforeBytes, afterBytes)
      ? undefined
      : { path, status: 'modified', additions: 0, deletions: 0, binary };
  }
  if (before === after) return undefined;
  const counted = countLineDiff(before ?? '', after ?? '', budget);
  if (counted === undefined) {
    return { path, status: 'modified', additions: 0, deletions: 0, oversize: true };
  }
  return { path, status: 'modified', additions: counted.additions, deletions: counted.deletions };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  else lines[lines.length - 1] = `${lines[lines.length - 1]!}\u0000`;
  return lines;
}

function countLines(content: string): number {
  return splitLines(content).length;
}

export function countLineDiff(
  before: string,
  after: string,
  budget?: LcsCellBudget,
): { additions: number; deletions: number } | undefined {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }
  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const oldSlice = beforeLines.slice(start, beforeEnd);
  const newSlice = afterLines.slice(start, afterEnd);
  const cells = oldSlice.length * newSlice.length;
  if (cells > LCS_CELL_BUDGET) return undefined;
  if (budget !== undefined) {
    if (cells > budget.remaining) return undefined;
    budget.remaining -= cells;
  }
  const common = lcsLength(oldSlice, newSlice);
  return {
    additions: newSlice.length - common,
    deletions: oldSlice.length - common,
  };
}

interface LcsCellBudget {
  remaining: number;
}

const LCS_CELL_BUDGET = 4_000_000;
const LCS_AGGREGATE_CELL_BUDGET = 16_000_000;

function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? previous[j - 1]! + 1
          : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}
