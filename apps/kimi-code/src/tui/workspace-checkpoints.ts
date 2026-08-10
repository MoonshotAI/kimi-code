import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import createIgnore, { type Ignore } from 'ignore';

const STORE_VERSION = 1;
const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CHECKPOINTS = 20;
const ALWAYS_IGNORED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules']);

interface FileRecord {
  readonly hash: string;
  readonly mode: number;
  readonly size: number;
}

interface RootSnapshot {
  readonly path: string;
  readonly files: Readonly<Record<string, FileRecord>>;
}

interface WorkspaceSnapshot {
  readonly roots: readonly RootSnapshot[];
}

interface CheckpointRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly roots: readonly string[];
}

interface CheckpointIndex {
  readonly version: typeof STORE_VERSION;
  readonly checkpoints: readonly CheckpointRecord[];
}

export type WorkspaceChangeKind = 'created' | 'modified' | 'deleted';

export interface WorkspaceChange {
  readonly root: string;
  readonly path: string;
  readonly kind: WorkspaceChangeKind;
}

export interface WorkspaceRewindPlan {
  readonly count: number;
  readonly checkpointIds: readonly string[];
  readonly changes: readonly WorkspaceChange[];
  /** Internal snapshots are deliberately opaque to command/UI consumers. */
  readonly target: WorkspaceSnapshot;
  readonly current: WorkspaceSnapshot;
}

export interface WorkspaceCheckpointLimits {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxCheckpoints?: number;
}

export class WorkspaceCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceCheckpointError';
  }
}

/**
 * Session-local, content-addressed workspace checkpoints for `/rewind`.
 *
 * A checkpoint is captured before a prompt is submitted. Restores never use
 * Git: they compare the current workspace with that before-image, validate it
 * again immediately before applying, and then recreate/delete regular files.
 */
export class WorkspaceCheckpointStore {
  private readonly storeDir: string;
  private readonly blobsDir: string;
  private readonly checkpointsDir: string;
  private readonly indexPath: string;
  private rootsPromise: Promise<readonly string[]> | undefined;
  private operation: Promise<void> = Promise.resolve();
  private invalidated = false;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly maxFileBytes: number;
  private readonly maxCheckpoints: number;

  constructor(
    sessionDir: string,
    private readonly configuredRoots: readonly string[],
    limits: WorkspaceCheckpointLimits = {},
  ) {
    this.storeDir = join(sessionDir, 'workspace-checkpoints');
    this.blobsDir = join(this.storeDir, 'blobs');
    this.checkpointsDir = join(this.storeDir, 'checkpoints');
    this.indexPath = join(this.storeDir, 'index.json');
    this.maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxCheckpoints = limits.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
  }

  async captureBeforeTurn(): Promise<string> {
    return this.exclusive(async () => {
      const snapshot = await this.captureSnapshot();
      const record: CheckpointRecord = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        roots: snapshot.roots.map((root) => root.path),
      };
      const wasInvalidated = this.invalidated;
      const index = wasInvalidated
        ? { version: STORE_VERSION, checkpoints: [] }
        : await this.readIndex();
      const previousRoots = index.checkpoints.at(-1)?.roots;
      const compatible = previousRoots === undefined || sameStrings(previousRoots, record.roots);
      await this.writeSnapshot(record.id, snapshot);
      const checkpoints = [...(compatible ? index.checkpoints : []), record].slice(
        -this.maxCheckpoints,
      );
      await this.writeIndex({
        version: STORE_VERSION,
        checkpoints,
      });
      this.invalidated = false;
      if (wasInvalidated || !compatible || checkpoints.length <= index.checkpoints.length) {
        await this.pruneStore();
      }
      return record.id;
    });
  }

  async discardCaptured(checkpointId: string): Promise<void> {
    await this.exclusive(async () => {
      const index = await this.readIndex();
      if (index.checkpoints.at(-1)?.id !== checkpointId) return;
      await this.writeIndex({ version: STORE_VERSION, checkpoints: index.checkpoints.slice(0, -1) });
      await this.pruneStore();
    });
  }

  async discardLast(count: number): Promise<void> {
    await this.exclusive(async () => {
      const index = await this.readIndex();
      const keep = Math.max(0, index.checkpoints.length - count);
      await this.writeIndex({ version: STORE_VERSION, checkpoints: index.checkpoints.slice(0, keep) });
      await this.pruneStore();
    });
  }

  async invalidate(): Promise<void> {
    this.invalidated = true;
    await this.exclusive(async () => {
      await this.writeIndex({ version: STORE_VERSION, checkpoints: [] });
      await this.pruneStore();
    });
  }

  async availableCount(): Promise<number> {
    if (this.invalidated) return 0;
    return this.exclusive(async () => (await this.readIndex()).checkpoints.length);
  }

  async prepareRewind(count: number): Promise<WorkspaceRewindPlan> {
    return this.exclusive(async () => {
      if (this.invalidated) {
        throw new WorkspaceCheckpointError('Workspace checkpoints were invalidated by an earlier failure.');
      }
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new WorkspaceCheckpointError('Rewind count must be a positive integer.');
      }
      const index = await this.readIndex();
      if (count > index.checkpoints.length) {
        throw new WorkspaceCheckpointError(
          `Only ${index.checkpoints.length} workspace checkpoint${index.checkpoints.length === 1 ? '' : 's'} available.`,
        );
      }
      const selected = index.checkpoints.slice(-count);
      const target = await this.readSnapshot(selected[0]!.id);
      await this.assertCurrentRoots(target);
      const current = await this.captureSnapshot();
      return {
        count,
        checkpointIds: selected.map((checkpoint) => checkpoint.id),
        changes: diffSnapshots(target, current),
        target,
        current,
      };
    });
  }

  async apply(plan: WorkspaceRewindPlan): Promise<void> {
    await this.exclusive(async () => {
      await this.validatePlan(plan);
      try {
        await this.applySnapshot(plan.target, plan.current, plan.changes);
      } catch (error) {
        try {
          await this.applySnapshot(plan.current, plan.target, plan.changes);
        } catch (rollbackError) {
          throw new WorkspaceCheckpointError(
            `Workspace restore failed (${errorMessage(error)}) and rollback also failed (${errorMessage(rollbackError)}).`,
          );
        }
        throw error;
      }
    });
  }

  async rollback(plan: WorkspaceRewindPlan): Promise<void> {
    await this.exclusive(async () => {
      await this.applySnapshot(plan.current, plan.target, plan.changes);
    });
  }

  async commit(plan: WorkspaceRewindPlan): Promise<void> {
    await this.exclusive(async () => {
      const index = await this.readIndex();
      const tail = index.checkpoints.slice(-plan.count).map((checkpoint) => checkpoint.id);
      if (!sameStrings(tail, plan.checkpointIds)) {
        throw new WorkspaceCheckpointError('Workspace checkpoints changed while rewind was open.');
      }
      await this.writeIndex({
        version: STORE_VERSION,
        checkpoints: index.checkpoints.slice(0, -plan.count),
      });
      await this.pruneStore();
    });
  }

  async releasePreview(): Promise<void> {
    await this.exclusive(() => this.pruneStore());
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolveOperation) => {
      release = resolveOperation;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async roots(): Promise<readonly string[]> {
    this.rootsPromise ??= normalizeRoots(this.configuredRoots);
    return this.rootsPromise;
  }

  private async captureSnapshot(): Promise<WorkspaceSnapshot> {
    await mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
    const excludedStoreDir = await realpath(this.storeDir);
    const roots = await this.roots();
    const snapshots: RootSnapshot[] = [];
    let fileCount = 0;
    let byteCount = 0;
    for (const root of roots) {
      const matcher = await loadIgnoreMatcher(root);
      const files: Record<string, FileRecord> = {};
      const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }];
      while (pending.length > 0) {
        const directory = pending.pop()!;
        let entries;
        try {
          entries = await readdir(directory.absolute, { withFileTypes: true });
        } catch (error) {
          throw checkpointFsError('scan', directory.absolute, error);
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index]!;
          const relativePath = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`;
          const absolutePath = join(directory.absolute, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (resolve(absolutePath) === excludedStoreDir) continue;
            if (ALWAYS_IGNORED_DIRECTORIES.has(entry.name) || matcher.ignores(`${relativePath}/`)) {
              continue;
            }
            pending.push({ absolute: absolutePath, relative: relativePath });
            continue;
          }
          if (!entry.isFile() || matcher.ignores(relativePath)) continue;
          let contents: Buffer;
          let stats;
          try {
            stats = await lstat(absolutePath);
            if (!stats.isFile()) continue;
            if (stats.size > this.maxFileBytes) {
              throw new WorkspaceCheckpointError(
                `Cannot checkpoint ${relativePath}: file exceeds ${formatBytes(this.maxFileBytes)}.`,
              );
            }
            contents = await readFile(absolutePath);
            if (contents.byteLength > this.maxFileBytes) {
              throw new WorkspaceCheckpointError(
                `Cannot checkpoint ${relativePath}: file exceeds ${formatBytes(this.maxFileBytes)}.`,
              );
            }
          } catch (error) {
            if (error instanceof WorkspaceCheckpointError) throw error;
            if (isMissing(error)) continue;
            throw checkpointFsError('read', absolutePath, error);
          }
          fileCount += 1;
          byteCount += contents.byteLength;
          if (fileCount > this.maxFiles) {
            throw new WorkspaceCheckpointError(`Workspace exceeds the ${this.maxFiles} file checkpoint limit.`);
          }
          if (byteCount > this.maxBytes) {
            throw new WorkspaceCheckpointError(
              `Workspace exceeds the ${formatBytes(this.maxBytes)} checkpoint limit.`,
            );
          }
          const hash = createHash('sha256').update(contents).digest('hex');
          await this.writeBlob(hash, contents);
          files[relativePath] = { hash, mode: stats.mode & 0o777, size: contents.byteLength };
        }
      }
      snapshots.push({ path: root, files });
    }
    return { roots: snapshots };
  }

  private async writeBlob(hash: string, contents: Buffer): Promise<void> {
    const path = join(this.blobsDir, hash);
    try {
      await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw checkpointFsError('store', path, error);
    }
  }

  private async validatePlan(plan: WorkspaceRewindPlan): Promise<void> {
    const currentRoots = rootMap(plan.current);
    for (const change of plan.changes) {
      const expected = currentRoots.get(change.root)?.files[change.path];
      const actual = await readCurrentRecord(change.root, change.path);
      if (!sameFile(expected, actual)) {
        throw new WorkspaceCheckpointError(
          `Workspace changed after the rewind preview: ${join(change.root, change.path)}`,
        );
      }
    }
  }

  private async applySnapshot(
    desired: WorkspaceSnapshot,
    source: WorkspaceSnapshot,
    changes: readonly WorkspaceChange[],
  ): Promise<void> {
    const desiredRoots = rootMap(desired);
    const sourceRoots = rootMap(source);
    for (const change of changes) {
      const wanted = desiredRoots.get(change.root)?.files[change.path];
      const previous = sourceRoots.get(change.root)?.files[change.path];
      const targetPath = safeWorkspacePath(change.root, change.path);
      await assertNoSymlinkParent(change.root, change.path);
      if (wanted === undefined) {
        if (previous !== undefined) {
          try {
            await unlink(targetPath);
          } catch (error) {
            if (!isMissing(error)) throw checkpointFsError('remove', targetPath, error);
          }
        }
        continue;
      }
      const contents = await readFile(join(this.blobsDir, wanted.hash));
      const actualHash = createHash('sha256').update(contents).digest('hex');
      if (actualHash !== wanted.hash || contents.byteLength !== wanted.size) {
        throw new WorkspaceCheckpointError(`Checkpoint content is corrupt for ${targetPath}.`);
      }
      await mkdir(dirname(targetPath), { recursive: true });
      const temporary = `${targetPath}.kimi-rewind-${randomUUID()}`;
      try {
        await writeFile(temporary, contents, { mode: wanted.mode });
        await chmod(temporary, wanted.mode);
        await rename(temporary, targetPath);
      } catch (error) {
        try {
          await unlink(temporary);
        } catch {
          // Best effort cleanup; preserve the original write failure.
        }
        throw checkpointFsError('restore', targetPath, error);
      }
    }
  }

  private async assertCurrentRoots(snapshot: WorkspaceSnapshot): Promise<void> {
    const current = await this.roots();
    const captured = snapshot.roots.map((root) => root.path);
    if (!sameStrings(current, captured)) {
      throw new WorkspaceCheckpointError(
        'Workspace roots changed after this checkpoint; rewind is unavailable for that turn.',
      );
    }
  }

  private async readIndex(): Promise<CheckpointIndex> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.indexPath, 'utf8'));
      if (!isCheckpointIndex(parsed)) throw new Error('unsupported checkpoint index');
      return parsed;
    } catch (error) {
      if (isMissing(error)) return { version: STORE_VERSION, checkpoints: [] };
      throw checkpointFsError('read', this.indexPath, error);
    }
  }

  private async writeIndex(index: CheckpointIndex): Promise<void> {
    await this.writeJson(this.indexPath, index);
  }

  private async readSnapshot(id: string): Promise<WorkspaceSnapshot> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.checkpointPath(id), 'utf8'));
      if (!isWorkspaceSnapshot(parsed)) throw new Error('invalid workspace snapshot');
      return parsed;
    } catch (error) {
      throw checkpointFsError('read', this.checkpointPath(id), error);
    }
  }

  private async writeSnapshot(id: string, snapshot: WorkspaceSnapshot): Promise<void> {
    await this.writeJson(this.checkpointPath(id), snapshot);
  }

  private checkpointPath(id: string): string {
    return join(this.checkpointsDir, `${id}.json`);
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch {
        // Best effort cleanup; preserve the original write failure.
      }
      throw checkpointFsError('write', path, error);
    }
  }

  private async pruneStore(): Promise<void> {
    const index = await this.readIndex();
    const retained = new Set<string>();
    for (const checkpoint of index.checkpoints) {
      const snapshot = await this.readSnapshot(checkpoint.id);
      for (const root of snapshot.roots) {
        for (const file of Object.values(root.files)) retained.add(file.hash);
      }
    }
    await this.pruneCheckpointFiles(new Set(index.checkpoints.map((checkpoint) => checkpoint.id)));
    let entries;
    try {
      entries = await readdir(this.blobsDir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw checkpointFsError('scan', this.blobsDir, error);
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && !retained.has(entry.name))
        .map(async (entry) => {
          try {
            await unlink(join(this.blobsDir, entry.name));
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }),
    );
  }

  private async pruneCheckpointFiles(retained: ReadonlySet<string>): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.checkpointsDir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw checkpointFsError('scan', this.checkpointsDir, error);
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .filter((entry) => !retained.has(entry.name.slice(0, -'.json'.length)))
        .map(async (entry) => {
          try {
            await unlink(join(this.checkpointsDir, entry.name));
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }),
    );
  }
}

function diffSnapshots(target: WorkspaceSnapshot, current: WorkspaceSnapshot): WorkspaceChange[] {
  const currentRoots = rootMap(current);
  const changes: WorkspaceChange[] = [];
  for (const targetRoot of target.roots) {
    const currentRoot = currentRoots.get(targetRoot.path);
    if (currentRoot === undefined) continue;
    const paths = new Set([...Object.keys(targetRoot.files), ...Object.keys(currentRoot.files)]);
    for (const path of [...paths].toSorted()) {
      const before = targetRoot.files[path];
      const now = currentRoot.files[path];
      if (sameFile(before, now)) continue;
      changes.push({
        root: targetRoot.path,
        path,
        kind: before === undefined ? 'created' : now === undefined ? 'deleted' : 'modified',
      });
    }
  }
  return changes;
}

async function normalizeRoots(configuredRoots: readonly string[]): Promise<readonly string[]> {
  const unique = new Set<string>();
  for (const configured of configuredRoots) {
    if (!isAbsolute(configured)) {
      throw new WorkspaceCheckpointError(`Workspace root must be absolute: ${configured}`);
    }
    let canonical: string;
    try {
      canonical = await realpath(resolve(configured));
    } catch (error) {
      throw checkpointFsError('resolve', configured, error);
    }
    unique.add(canonical);
  }
  const sorted = [...unique].toSorted((left, right) => left.length - right.length || left.localeCompare(right));
  return sorted.filter(
    (candidate, index) => !sorted.slice(0, index).some((parent) => isPathInside(parent, candidate)),
  );
}

async function loadIgnoreMatcher(root: string): Promise<Ignore> {
  const matcher = createIgnore();
  for (const filename of ['.gitignore', '.ignore']) {
    try {
      matcher.add(await readFile(join(root, filename), 'utf8'));
    } catch (error) {
      if (!isMissing(error)) throw checkpointFsError('read', join(root, filename), error);
    }
  }
  return matcher;
}

function rootMap(snapshot: WorkspaceSnapshot): Map<string, RootSnapshot> {
  return new Map(snapshot.roots.map((root) => [root.path, root]));
}

async function readCurrentRecord(root: string, relativePath: string): Promise<FileRecord | undefined> {
  const absolutePath = safeWorkspacePath(root, relativePath);
  try {
    const stats = await lstat(absolutePath);
    if (!stats.isFile()) return undefined;
    const contents = await readFile(absolutePath);
    return {
      hash: createHash('sha256').update(contents).digest('hex'),
      mode: stats.mode & 0o777,
      size: contents.byteLength,
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw checkpointFsError('read', absolutePath, error);
  }
}

function safeWorkspacePath(root: string, relativePath: string): string {
  if (relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new WorkspaceCheckpointError(`Invalid checkpoint path: ${relativePath}`);
  }
  const absolutePath = resolve(root, relativePath);
  if (!isPathInside(root, absolutePath)) {
    throw new WorkspaceCheckpointError(`Checkpoint path escapes workspace: ${relativePath}`);
  }
  return absolutePath;
}

function isPathInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

async function assertNoSymlinkParent(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split('/').slice(0, -1);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new WorkspaceCheckpointError(`Refusing to restore through symlink: ${cursor}`);
      }
      if (!stats.isDirectory()) {
        throw new WorkspaceCheckpointError(`Restore parent is not a directory: ${cursor}`);
      }
    } catch (error) {
      if (isMissing(error)) return;
      if (error instanceof WorkspaceCheckpointError) throw error;
      throw checkpointFsError('inspect', cursor, error);
    }
  }
}

function sameFile(left: FileRecord | undefined, right: FileRecord | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.hash === right.hash && left.mode === right.mode && left.size === right.size;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCheckpointIndex(value: unknown): value is CheckpointIndex {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; checkpoints?: unknown };
  return (
    candidate.version === STORE_VERSION &&
    Array.isArray(candidate.checkpoints) &&
    candidate.checkpoints.every(isCheckpointRecord)
  );
}

function isCheckpointRecord(value: unknown): value is CheckpointRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; createdAt?: unknown; roots?: unknown };
  return (
    typeof candidate.id === 'string' &&
    /^[a-f0-9-]{36}$/.test(candidate.id) &&
    typeof candidate.createdAt === 'string' &&
    Array.isArray(candidate.roots) &&
    candidate.roots.every((root) => typeof root === 'string' && isAbsolute(root))
  );
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (typeof value !== 'object' || value === null || !('roots' in value)) return false;
  const roots = value.roots;
  return Array.isArray(roots) && roots.every(isRootSnapshot);
}

function isRootSnapshot(value: unknown): value is RootSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { path?: unknown; files?: unknown };
  if (typeof candidate.path !== 'string' || !isAbsolute(candidate.path)) return false;
  if (typeof candidate.files !== 'object' || candidate.files === null || Array.isArray(candidate.files)) {
    return false;
  }
  return Object.entries(candidate.files).every(([path, record]) => {
    if (path.length === 0 || isAbsolute(path) || path.split('/').includes('..')) return false;
    return isFileRecord(record);
  });
}

function isFileRecord(value: unknown): value is FileRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { hash?: unknown; mode?: unknown; size?: unknown };
  return (
    typeof candidate.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.hash) &&
    typeof candidate.mode === 'number' &&
    Number.isInteger(candidate.mode) &&
    candidate.mode >= 0 &&
    candidate.mode <= 0o777 &&
    typeof candidate.size === 'number' &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= 0
  );
}

function checkpointFsError(action: string, path: string, cause: unknown): WorkspaceCheckpointError {
  const message = errorMessage(cause);
  return new WorkspaceCheckpointError(`Failed to ${action} workspace checkpoint at ${path}: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function formatBytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}
