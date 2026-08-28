import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'pathe';

import { Service } from '#/_base/di/service';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { WillExecuteToolEvent } from '#/agent/toolExecutor/toolHooks';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import {
  IAgentFileHistoryService,
  type FileBackupEntry,
  type FileHistoryChange,
  type FileHistoryCheckpointRecord,
  type FileHistoryContent,
  type FileHistoryState,
} from './fileHistory';
import {
  FILE_HISTORY_CHECKPOINT_CAP,
  FileHistoryCheckpointed,
  FileHistoryTracked,
  fileHistoryKey,
} from './fileHistoryOps';
import { FILE_HISTORY_FLAG_ID } from './flag';

export const FILE_HISTORY_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const FILE_HISTORY_BLOB_PREFIX = 'file-history';

export class AgentFileHistoryService extends Service implements IAgentFileHistoryService {
  declare readonly _serviceBrand: undefined;

  private queue: Promise<void> = Promise.resolve();

  constructor(
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IEventBus eventBus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IFlagService private readonly flags: IFlagService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBlobStore private readonly blobs: IBlobStore,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
  ) {
    super();
    this.agentState.contributeState(fileHistoryKey);
    if (this.agentCtx.agentId !== MAIN_AGENT_ID) return;

    this._register(
      toolExecutor.onWillExecuteTool((event) => this.onWillExecuteTool(event)),
    );
    this._register(
      eventBus.subscribe(TurnStarted, (event) => {
        if (event.agentId !== this.agentCtx.agentId || !this.enabled()) return;
        void this.enqueue(() => this.checkpoint(event.turnId));
      }),
    );
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

  async changes(turnId: number): Promise<FileHistoryChange[]> {
    await this.settled();
    const state = this.history();
    const index = state.checkpoints.findIndex((c) => c.turnId === turnId);
    if (index < 0) return [];
    const next = state.checkpoints[index + 1];

    const paths = new Set<string>();
    for (const path of Object.keys(state.checkpoints[index]!.entries)) paths.add(path);
    if (next !== undefined) for (const path of Object.keys(next.entries)) paths.add(path);
    else for (const path of state.tracked) paths.add(path);

    const changes: FileHistoryChange[] = [];
    for (const path of [...paths].toSorted()) {
      const before = entryAt(state.checkpoints, index, path);
      const beforeBytes = await this.entryBytes(before);
      let afterBytes: Uint8Array | undefined;
      if (next !== undefined) {
        afterBytes = await this.entryBytes(entryAt(state.checkpoints, index + 1, path));
      } else {
        const current = await this.readCurrent(path);
        if (current === 'unreadable') continue;
        afterBytes = current === 'missing' ? undefined : current;
      }
      const change = diffChange(path, beforeBytes, afterBytes);
      if (change !== undefined) changes.push(change);
    }
    return changes;
  }

  async contentAt(turnId: number, path: string): Promise<FileHistoryContent | undefined> {
    await this.settled();
    const state = this.history();
    const index = state.checkpoints.findIndex((c) => c.turnId === turnId);
    if (index < 0) return undefined;
    const entry = entryAt(state.checkpoints, index, this.pathKey(path));
    if (entry === undefined) return undefined;
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

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.queue.then(op);
    this.queue = run.catch((error) => {
      onUnexpectedError(error);
    });
    return run;
  }

  private async capture(path: string, turnId: number): Promise<void> {
    const pathKey = this.pathKey(path);
    const state = this.history();
    if (state.tracked.includes(pathKey)) return;

    const current = await this.readCurrent(pathKey);
    if (current === 'unreadable') return;
    const entry =
      current === 'missing' ? { key: null, version: 1 } : await this.backup(pathKey, 1, current);
    await this.dispatcher.dispatch(
      new FileHistoryTracked({ agentId: this.agentCtx.agentId, turnId, path: pathKey, entry }),
    );
  }

  private async checkpoint(turnId: number): Promise<void> {
    const state = this.history();
    if (state.checkpoints.some((c) => c.turnId === turnId)) return;

    const entries: Record<string, FileBackupEntry> = {};
    for (const pathKey of state.tracked) {
      const latest = latestEntry(state.checkpoints, pathKey);
      const nextVersion = maxVersion(state.checkpoints, pathKey) + 1;
      const current = await this.readCurrent(pathKey);
      if (current === 'unreadable') {
        if (latest !== undefined) entries[pathKey] = latest;
        continue;
      }
      if (current === 'missing') {
        entries[pathKey] =
          latest?.key === null ? latest : { key: null, version: nextVersion };
        continue;
      }
      const contentHash = sha256(current);
      if (latest !== undefined && latest.contentHash === contentHash) {
        entries[pathKey] = latest;
        continue;
      }
      entries[pathKey] = await this.backup(pathKey, nextVersion, current, contentHash);
    }

    const evictable = evictableCheckpoints(state.checkpoints);
    await this.dispatcher.dispatch(
      new FileHistoryCheckpointed({ agentId: this.agentCtx.agentId, turnId, entries }),
    );
    await this.evictBlobs(evictable, this.history().checkpoints);
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
        if (entry.key === null || entry.version === 1 || retainedKeys.has(entry.key)) continue;
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

  private async readCurrent(pathKey: string): Promise<Uint8Array | 'missing' | 'unreadable'> {
    const absolute = isAbsolute(pathKey) ? pathKey : resolve(this.workspaceCtx.workDir, pathKey);
    let info;
    try {
      info = await this.fs.stat(absolute);
    } catch (error) {
      const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
      return code === 'ENOENT' ? 'missing' : 'unreadable';
    }
    if (!info.isFile || info.size > FILE_HISTORY_MAX_FILE_BYTES) return 'unreadable';
    try {
      return await this.fs.readBytes(absolute);
    } catch {
      return 'unreadable';
    }
  }

  private pathKey(path: string): string {
    if (!isAbsolute(path)) return path;
    const relativePath = relative(this.workspaceCtx.workDir, path);
    if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) return path;
    return relativePath;
  }
}

function editTargetPath(display: ToolInputDisplay | undefined): string | undefined {
  if (display === undefined || display.kind !== 'file_io') return undefined;
  if (display.operation !== 'edit' && display.operation !== 'write') return undefined;
  return display.path;
}

function entryAt(
  checkpoints: readonly FileHistoryCheckpointRecord[],
  index: number,
  path: string,
): FileBackupEntry | undefined {
  for (let i = index; i >= 0; i -= 1) {
    const entry = checkpoints[i]!.entries[path];
    if (entry !== undefined) return entry;
  }
  return undefined;
}

function latestEntry(
  checkpoints: readonly FileHistoryCheckpointRecord[],
  path: string,
): FileBackupEntry | undefined {
  return entryAt(checkpoints, checkpoints.length - 1, path);
}

function maxVersion(
  checkpoints: readonly FileHistoryCheckpointRecord[],
  path: string,
): number {
  let max = 0;
  for (const checkpoint of checkpoints) {
    const entry = checkpoint.entries[path];
    if (entry !== undefined && entry.version > max) max = entry.version;
  }
  return max;
}

function evictableCheckpoints(
  checkpoints: readonly FileHistoryCheckpointRecord[],
): readonly FileHistoryCheckpointRecord[] {
  const overflow = checkpoints.length + 1 - FILE_HISTORY_CHECKPOINT_CAP;
  return overflow > 0 ? checkpoints.slice(0, overflow) : [];
}

function blobKey(pathKey: string, version: number): string {
  const hash = createHash('sha256').update(pathKey, 'utf8').digest('hex').slice(0, 16);
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
  const { additions, deletions } = countLineDiff(before ?? '', after ?? '');
  return { path, status: 'modified', additions, deletions };
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
  return lines;
}

function countLines(content: string): number {
  return splitLines(content).length;
}

export function countLineDiff(
  before: string,
  after: string,
): { additions: number; deletions: number } {
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
  const common = lcsLength(oldSlice, newSlice);
  return {
    additions: newSlice.length - common,
    deletions: oldSlice.length - common,
  };
}

const LCS_CELL_BUDGET = 4_000_000;

function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length * b.length > LCS_CELL_BUDGET) {
    const bSet = new Set(b);
    return a.filter((line) => bSet.has(line)).length;
  }
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
