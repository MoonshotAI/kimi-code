import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';

import type { FileChange } from '../../shared/types';
import { relativeFsPath } from '../utils/fs-path';

const MANIFEST_VERSION = 1;
const SNAPSHOT_HASH = /^[a-f0-9]{64}$/;

export interface BaselineSession {
  readonly id: string;
  readonly workDir: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface ManifestEntry {
  readonly snapshot: string;
  readonly existedBefore: boolean;
}

interface BaselineManifestV1 {
  readonly version: 1;
  readonly sessionId: string;
  readonly entries: Readonly<Record<string, ManifestEntry>>;
  readonly acceptedLegacyPaths: readonly string[];
}

interface MutableManifest {
  version: 1;
  sessionId: string;
  entries: Record<string, ManifestEntry>;
  acceptedLegacyPaths: string[];
}

interface ResolvedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

interface BaselineValue {
  readonly content: string;
  readonly existedBefore: boolean;
}

export class BaselineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BaselineError';
  }
}

export class BaselineManager {
  private readonly baselinesRoot: string;
  private readonly updates = new Map<string, Promise<void>>();

  constructor(globalStorageRoot: string, homeNamespace = 'default') {
    if (globalStorageRoot.length === 0) {
      throw new BaselineError('The VSCode global storage path is empty');
    }
    if (homeNamespace.length === 0) {
      throw new BaselineError('The Kimi home namespace is empty');
    }
    this.baselinesRoot = path.join(globalStorageRoot, 'baselines', hash(homeNamespace));
  }

  /**
   * Capture the file synchronously before returning control to the caller.
   * Persistence is serialized per session and completes through the returned
   * promise, but no `await` occurs before the original file has been read.
   */
  async capture(session: BaselineSession, filePath: string): Promise<void> {
    const resolved = resolveSessionFile(session, filePath);
    const captured = captureOriginal(resolved.absolutePath);

    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const localPath = equivalentPath(
        session,
        Object.keys(manifest.entries),
        resolved.relativePath,
      );
      if (localPath !== undefined) return;

      const accepted = new Set(manifest.acceptedLegacyPaths);
      const acceptedPath = equivalentPath(session, accepted, resolved.relativePath);
      if (acceptedPath === undefined) {
        const legacyExists = await this.hasLegacyBaseline(session, resolved.relativePath);
        if (legacyExists) return;
      }

      const snapshot = hash(captured.content);
      await this.writeSnapshot(session.id, snapshot, captured.content);
      if (acceptedPath !== undefined) accepted.delete(acceptedPath);

      const next = mutableManifest(manifest);
      next.entries[resolved.relativePath] = {
        snapshot,
        existedBefore: captured.existedBefore,
      };
      next.acceptedLegacyPaths = uniquePaths(session, accepted);
      await this.writeManifest(next);
    });
  }

  async getChanges(session: BaselineSession): Promise<FileChange[]> {
    await this.waitForUpdates([session.id]);
    const manifest = await this.readManifest(session);
    const relativePaths = await this.effectivePaths(session, manifest);
    const changes: FileChange[] = [];

    for (const relativePath of relativePaths) {
      const baseline = await this.readEffectiveBaseline(session, relativePath, manifest);
      if (baseline === undefined) continue;

      const resolved = resolveSessionFile(session, relativePath);
      const currentContent = await readCurrentFile(resolved.absolutePath);
      if (currentContent === undefined) {
        if (baseline.existedBefore) {
          changes.push({
            path: relativePath,
            status: 'Deleted',
            additions: 0,
            deletions: countLines(baseline.content),
          });
        }
        continue;
      }

      if (!baseline.existedBefore) {
        changes.push({
          path: relativePath,
          status: 'Added',
          additions: countLines(currentContent),
          deletions: 0,
        });
        continue;
      }

      if (currentContent !== baseline.content) {
        const diff = computeLineDiff(baseline.content, currentContent);
        changes.push({
          path: relativePath,
          status: 'Modified',
          additions: diff.additions,
          deletions: diff.deletions,
        });
      }
    }

    return changes;
  }

  async getContent(session: BaselineSession, filePath: string): Promise<string> {
    await this.waitForUpdates([session.id]);
    const resolved = resolveSessionFile(session, filePath);
    const manifest = await this.readManifest(session);
    const baseline = await this.readEffectiveBaseline(session, resolved.relativePath, manifest);
    if (baseline === undefined) {
      throw new BaselineError(
        `No baseline exists for "${resolved.relativePath}" in session "${session.id}"`,
      );
    }
    return baseline.content;
  }

  async undo(session: BaselineSession, filePath: string): Promise<void> {
    const resolved = resolveSessionFile(session, filePath);
    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const baseline = await this.readEffectiveBaseline(session, resolved.relativePath, manifest);
      if (baseline === undefined) {
        throw new BaselineError(
          `No baseline exists for "${resolved.relativePath}" in session "${session.id}"`,
        );
      }
      await restoreFile(session.workDir, resolved.absolutePath, baseline);
    });
  }

  async undoAll(session: BaselineSession): Promise<void> {
    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const relativePaths = await this.effectivePaths(session, manifest);
      for (const relativePath of relativePaths) {
        const baseline = await this.readEffectiveBaseline(session, relativePath, manifest);
        if (baseline === undefined) continue;
        await restoreFile(
          session.workDir,
          resolveSessionFile(session, relativePath).absolutePath,
          baseline,
        );
      }
    });
  }

  async keep(session: BaselineSession, filePath: string): Promise<void> {
    const resolved = resolveSessionFile(session, filePath);
    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const localPath = equivalentPath(
        session,
        Object.keys(manifest.entries),
        resolved.relativePath,
      );
      const hadLocal = localPath !== undefined;
      const hasLegacy = await this.hasLegacyBaseline(session, resolved.relativePath);
      if (!hadLocal && !hasLegacy) return;

      const next = mutableManifest(manifest);
      if (localPath !== undefined) delete next.entries[localPath];
      const accepted = new Set(next.acceptedLegacyPaths);
      const acceptedPath = equivalentPath(session, accepted, resolved.relativePath);
      if (acceptedPath !== undefined) accepted.delete(acceptedPath);
      if (hasLegacy) accepted.add(resolved.relativePath);
      next.acceptedLegacyPaths = uniquePaths(session, accepted);

      await this.writeManifest(next);
      await this.removeUnreferencedSnapshots(session.id, next);
    });
  }

  async keepAll(session: BaselineSession): Promise<void> {
    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const legacyPaths = await this.listLegacyPaths(session);
      const next = mutableManifest(manifest);
      next.entries = {};
      next.acceptedLegacyPaths = uniquePaths(session, [
        ...next.acceptedLegacyPaths,
        ...legacyPaths,
      ]);

      await this.writeManifest(next);
      await this.removeUnreferencedSnapshots(session.id, next);
    });
  }

  async materializeToFork(source: BaselineSession, target: BaselineSession): Promise<void> {
    if (source.id === target.id) {
      throw new BaselineError('Cannot materialize a baseline fork onto the source session');
    }

    await this.serialize([source.id, target.id], async () => {
      const sourceManifest = await this.readManifest(source);
      const sourcePaths = await this.effectivePaths(source, sourceManifest);
      const values = new Map<string, BaselineValue>();
      for (const relativePath of sourcePaths) {
        const baseline = await this.readEffectiveBaseline(source, relativePath, sourceManifest);
        if (baseline !== undefined) values.set(relativePath, baseline);
      }

      const targetManifest = await this.readManifest(target);
      const next = mutableManifest(targetManifest);
      const accepted = uniquePaths(target, [
        ...next.acceptedLegacyPaths,
        ...sourceManifest.acceptedLegacyPaths,
      ]);

      for (const [relativePath, baseline] of values) {
        const existingPath = equivalentPath(target, Object.keys(next.entries), relativePath);
        if (existingPath !== undefined) continue;
        const snapshot = hash(baseline.content);
        await this.writeSnapshot(target.id, snapshot, baseline.content);
        next.entries[relativePath] = {
          snapshot,
          existedBefore: baseline.existedBefore,
        };
      }

      next.acceptedLegacyPaths = accepted;
      await this.writeManifest(next);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    requireSessionId(sessionId);
    await this.serialize([sessionId], async () => {
      await rm(this.sessionRoot(sessionId), { recursive: true, force: true });
    });
  }

  private async effectivePaths(
    session: BaselineSession,
    manifest: BaselineManifestV1,
  ): Promise<string[]> {
    const paths = new Map<string, string>();
    for (const relativePath of Object.keys(manifest.entries)) {
      paths.set(pathComparisonKey(session, relativePath), relativePath);
    }
    const accepted = new Set(
      manifest.acceptedLegacyPaths.map((relativePath) =>
        pathComparisonKey(session, relativePath),
      ),
    );
    for (const relativePath of await this.listLegacyPaths(session)) {
      const key = pathComparisonKey(session, relativePath);
      if (!accepted.has(key) && !paths.has(key)) paths.set(key, relativePath);
    }
    return [...paths.values()].toSorted();
  }

  private async readEffectiveBaseline(
    session: BaselineSession,
    relativePath: string,
    manifest: BaselineManifestV1,
  ): Promise<BaselineValue | undefined> {
    const localPath = equivalentPath(session, Object.keys(manifest.entries), relativePath);
    const local = localPath === undefined ? undefined : manifest.entries[localPath];
    if (localPath !== undefined && local !== undefined) {
      const content = await this.readSnapshot(session.id, local.snapshot, localPath);
      return { content, existedBefore: local.existedBefore };
    }

    if (equivalentPath(session, manifest.acceptedLegacyPaths, relativePath) !== undefined) {
      return undefined;
    }
    return this.readLegacyBaseline(session, relativePath);
  }

  private async readManifest(session: BaselineSession): Promise<BaselineManifestV1> {
    requireSession(session);
    let text: string;
    try {
      text = await readFile(this.manifestPath(session.id), 'utf-8');
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return emptyManifest(session.id);
      throw new BaselineError(`Unable to read baseline manifest for session "${session.id}"`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new BaselineError(`Baseline manifest for session "${session.id}" is invalid JSON`, {
        cause: error,
      });
    }
    return parseManifest(parsed, session);
  }

  private async writeManifest(manifest: BaselineManifestV1): Promise<void> {
    if (
      Object.keys(manifest.entries).length === 0 &&
      manifest.acceptedLegacyPaths.length === 0
    ) {
      await rm(this.sessionRoot(manifest.sessionId), { recursive: true, force: true });
      return;
    }

    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    await atomicWrite(this.manifestPath(manifest.sessionId), text);
  }

  private async writeSnapshot(sessionId: string, snapshot: string, content: string): Promise<void> {
    const snapshotPath = this.snapshotPath(sessionId, snapshot);
    try {
      const existing = await readFile(snapshotPath, 'utf-8');
      if (hash(existing) !== snapshot) {
        throw new BaselineError(
          `Baseline snapshot "${snapshot}" for session "${sessionId}" is corrupt`,
        );
      }
      return;
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) {
        if (error instanceof BaselineError) throw error;
        throw new BaselineError(
          `Unable to inspect baseline snapshot "${snapshot}" for session "${sessionId}"`,
          { cause: error },
        );
      }
    }
    await atomicWrite(snapshotPath, content);
  }

  private async readSnapshot(
    sessionId: string,
    snapshot: string,
    relativePath: string,
  ): Promise<string> {
    let content: string;
    try {
      content = await readFile(this.snapshotPath(sessionId, snapshot), 'utf-8');
    } catch (error) {
      throw new BaselineError(
        `Unable to read baseline snapshot for "${relativePath}" in session "${sessionId}"`,
        { cause: error },
      );
    }
    if (hash(content) !== snapshot) {
      throw new BaselineError(
        `Baseline snapshot for "${relativePath}" in session "${sessionId}" is corrupt`,
      );
    }
    return content;
  }

  private async removeUnreferencedSnapshots(
    sessionId: string,
    manifest: BaselineManifestV1,
  ): Promise<void> {
    const snapshotsDir = this.snapshotsRoot(sessionId);
    let names: string[];
    try {
      names = await readdir(snapshotsDir);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return;
      throw new BaselineError(`Unable to clean baseline snapshots for session "${sessionId}"`, {
        cause: error,
      });
    }

    const referenced = new Set(Object.values(manifest.entries).map((entry) => entry.snapshot));
    await Promise.all(
      names.map(async (name) => {
        if (referenced.has(name)) return;
        await rm(path.join(snapshotsDir, name), { force: true });
      }),
    );
  }

  private async listLegacyPaths(session: BaselineSession): Promise<string[]> {
    const root = legacyBaselineRoot(session);
    if (root === undefined) return [];

    const result: string[] = [];
    await walkLegacyBaselines(root, '', result);
    return result.toSorted();
  }

  private async hasLegacyBaseline(
    session: BaselineSession,
    relativePath: string,
  ): Promise<boolean> {
    const legacyPath = legacyBaselinePath(session, relativePath);
    if (legacyPath === undefined) return false;
    try {
      const info = await stat(legacyPath);
      if (!info.isFile()) {
        throw new BaselineError(`Legacy baseline "${relativePath}" is not a regular file`);
      }
      return true;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return false;
      if (error instanceof BaselineError) throw error;
      throw new BaselineError(`Unable to inspect legacy baseline "${relativePath}"`, {
        cause: error,
      });
    }
  }

  private async readLegacyBaseline(
    session: BaselineSession,
    relativePath: string,
  ): Promise<BaselineValue | undefined> {
    const legacyPath = legacyBaselinePath(session, relativePath);
    if (legacyPath === undefined) return undefined;

    let info;
    try {
      info = await stat(legacyPath);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return undefined;
      throw new BaselineError(`Unable to inspect legacy baseline "${relativePath}"`, {
        cause: error,
      });
    }
    if (!info.isFile()) {
      throw new BaselineError(`Legacy baseline "${relativePath}" is not a regular file`);
    }

    try {
      const content = await readFile(legacyPath, 'utf-8');
      return { content, existedBefore: content.length > 0 };
    } catch (error) {
      throw new BaselineError(`Unable to read legacy baseline "${relativePath}"`, {
        cause: error,
      });
    }
  }

  private async serialize<T>(sessionIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ids = [...new Set(sessionIds)].toSorted();
    for (const id of ids) requireSessionId(id);

    const previous = ids.map((id) => this.updates.get(id) ?? Promise.resolve());
    const run = Promise.all(previous).then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    for (const id of ids) this.updates.set(id, settled);
    void settled.then(() => {
      for (const id of ids) {
        if (this.updates.get(id) === settled) this.updates.delete(id);
      }
    });
    return run;
  }

  private async waitForUpdates(sessionIds: readonly string[]): Promise<void> {
    await Promise.all(sessionIds.map((id) => this.updates.get(id) ?? Promise.resolve()));
  }

  private sessionRoot(sessionId: string): string {
    return path.join(this.baselinesRoot, hash(sessionId));
  }

  private manifestPath(sessionId: string): string {
    return path.join(this.sessionRoot(sessionId), 'manifest.json');
  }

  private snapshotsRoot(sessionId: string): string {
    return path.join(this.sessionRoot(sessionId), 'snapshots');
  }

  private snapshotPath(sessionId: string, snapshot: string): string {
    if (!SNAPSHOT_HASH.test(snapshot)) {
      throw new BaselineError(`Invalid baseline snapshot hash "${snapshot}"`);
    }
    return path.join(this.snapshotsRoot(sessionId), snapshot);
  }
}

function emptyManifest(sessionId: string): BaselineManifestV1 {
  return { version: MANIFEST_VERSION, sessionId, entries: {}, acceptedLegacyPaths: [] };
}

function mutableManifest(manifest: BaselineManifestV1): MutableManifest {
  return {
    version: MANIFEST_VERSION,
    sessionId: manifest.sessionId,
    entries: { ...manifest.entries },
    acceptedLegacyPaths: [...manifest.acceptedLegacyPaths],
  };
}

function parseManifest(value: unknown, session: BaselineSession): BaselineManifestV1 {
  if (!isRecord(value) || value['version'] !== MANIFEST_VERSION) {
    throw new BaselineError(`Unsupported baseline manifest for session "${session.id}"`);
  }
  if (value['sessionId'] !== session.id) {
    throw new BaselineError(`Baseline manifest does not belong to session "${session.id}"`);
  }

  const rawEntries = value['entries'];
  const rawAccepted = value['acceptedLegacyPaths'];
  if (!isRecord(rawEntries) || !Array.isArray(rawAccepted)) {
    throw new BaselineError(`Invalid baseline manifest for session "${session.id}"`);
  }

  const entries: Record<string, ManifestEntry> = {};
  const entryKeys = new Set<string>();
  for (const [rawPath, rawEntry] of Object.entries(rawEntries)) {
    if (
      !isRecord(rawEntry) ||
      typeof rawEntry['snapshot'] !== 'string' ||
      !SNAPSHOT_HASH.test(rawEntry['snapshot']) ||
      typeof rawEntry['existedBefore'] !== 'boolean'
    ) {
      throw new BaselineError(`Invalid baseline entry "${rawPath}" in session "${session.id}"`);
    }
    const relativePath = resolveSessionFile(session, rawPath).relativePath;
    const comparisonKey = pathComparisonKey(session, relativePath);
    if (relativePath !== rawPath || entryKeys.has(comparisonKey)) {
      throw new BaselineError(`Unsafe baseline path "${rawPath}" in session "${session.id}"`);
    }
    entryKeys.add(comparisonKey);
    entries[relativePath] = {
      snapshot: rawEntry['snapshot'],
      existedBefore: rawEntry['existedBefore'],
    };
  }

  const acceptedLegacyPaths: string[] = [];
  for (const rawPath of rawAccepted) {
    if (typeof rawPath !== 'string') {
      throw new BaselineError(`Invalid accepted legacy path in session "${session.id}"`);
    }
    const relativePath = resolveSessionFile(session, rawPath).relativePath;
    if (relativePath !== rawPath) {
      throw new BaselineError(`Unsafe accepted legacy path "${rawPath}" in session "${session.id}"`);
    }
    if (equivalentPath(session, acceptedLegacyPaths, relativePath) === undefined) {
      acceptedLegacyPaths.push(relativePath);
    }
  }

  return {
    version: MANIFEST_VERSION,
    sessionId: session.id,
    entries,
    acceptedLegacyPaths: uniquePaths(session, acceptedLegacyPaths),
  };
}

function equivalentPath(
  session: BaselineSession,
  paths: Iterable<string>,
  candidate: string,
): string | undefined {
  const candidateKey = pathComparisonKey(session, candidate);
  for (const existing of paths) {
    if (pathComparisonKey(session, existing) === candidateKey) return existing;
  }
  return undefined;
}

function uniquePaths(session: BaselineSession, paths: Iterable<string>): string[] {
  const unique = new Map<string, string>();
  for (const relativePath of paths) {
    const key = pathComparisonKey(session, relativePath);
    if (!unique.has(key)) unique.set(key, relativePath);
  }
  return [...unique.values()].toSorted();
}

function pathComparisonKey(session: BaselineSession, relativePath: string): string {
  return isWindowsAbsolute(session.workDir) ? relativePath.toLowerCase() : relativePath;
}

function resolveSessionFile(session: BaselineSession, filePath: string): ResolvedFile {
  requireSession(session);
  if (filePath.length === 0) throw new BaselineError('The baseline file path is empty');

  const windows = isWindowsAbsolute(session.workDir);
  if (!windows && isWindowsAbsolute(filePath)) {
    throw new BaselineError(`File "${filePath}" is outside workspace "${session.workDir}"`);
  }

  const paths = windows ? path.win32 : path;
  const root = paths.resolve(session.workDir);
  const absolutePath = paths.resolve(root, filePath);
  const relativePath = paths.relative(root, absolutePath);
  const parentPrefix = `..${paths.sep}`;
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(parentPrefix) ||
    paths.isAbsolute(relativePath)
  ) {
    throw new BaselineError(`File "${filePath}" is outside workspace "${session.workDir}"`);
  }

  return {
    absolutePath,
    relativePath: windows ? relativePath.replaceAll('\\', '/') : relativePath,
  };
}

function isWindowsAbsolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

function legacyBaselineRoot(session: BaselineSession): string | undefined {
  const source = session.metadata?.['kimi_cli_source_path'];
  if (typeof source !== 'string' || source.length === 0) return undefined;

  const sourceIsWindows = isWindowsAbsolute(source);
  if (sourceIsWindows !== (process.platform === 'win32')) return undefined;
  if (!path.isAbsolute(source)) return undefined;
  return path.join(source, 'baseline');
}

function legacyBaselinePath(
  session: BaselineSession,
  relativePath: string,
): string | undefined {
  const root = legacyBaselineRoot(session);
  if (root === undefined) return undefined;
  const resolved = resolveSessionFile(session, relativePath);
  return path.join(root, ...resolved.relativePath.split('/'));
}

async function walkLegacyBaselines(
  directory: string,
  relativeDirectory: string,
  result: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, 'ENOENT') && relativeDirectory.length === 0) return;
    throw new BaselineError(`Unable to list legacy baseline directory "${directory}"`, {
      cause: error,
    });
  }

  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      await walkLegacyBaselines(path.join(directory, entry.name), relativePath, result);
    } else if (entry.isFile()) {
      result.push(relativePath);
    }
  }
}

function captureOriginal(absolutePath: string): BaselineValue {
  let info;
  try {
    info = statSync(absolutePath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { content: '', existedBefore: false };
    throw new BaselineError(`Unable to inspect original file "${absolutePath}"`, {
      cause: error,
    });
  }
  if (!info.isFile()) {
    throw new BaselineError(`Original path "${absolutePath}" is not a regular file`);
  }

  try {
    return { content: readFileSync(absolutePath, 'utf-8'), existedBefore: true };
  } catch (error) {
    throw new BaselineError(`Unable to capture original file "${absolutePath}"`, {
      cause: error,
    });
  }
}

async function readCurrentFile(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, 'utf-8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined;
    throw new BaselineError(`Unable to read current file "${absolutePath}"`, { cause: error });
  }
}

async function restoreFile(
  workDir: string,
  absolutePath: string,
  baseline: BaselineValue,
): Promise<void> {
  await requireContainedRestorePath(workDir, absolutePath);
  if (!baseline.existedBefore) {
    try {
      await unlink(absolutePath);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) {
        throw new BaselineError(`Unable to remove newly created file "${absolutePath}"`, {
          cause: error,
        });
      }
    }
    return;
  }

  try {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, baseline.content, 'utf-8');
  } catch (error) {
    throw new BaselineError(`Unable to restore file "${absolutePath}"`, { cause: error });
  }
}

async function requireContainedRestorePath(workDir: string, absolutePath: string): Promise<void> {
  try {
    const [realWorkDir, realTarget] = await Promise.all([
      realpath(workDir),
      realExistingPath(absolutePath),
    ]);
    if (relativeFsPath(realWorkDir, realTarget) === undefined) {
      throw new BaselineError(`Refusing to restore path outside the session workspace: "${absolutePath}"`);
    }
  } catch (error) {
    if (error instanceof BaselineError) throw error;
    throw new BaselineError(`Unable to validate restore path "${absolutePath}"`, { cause: error });
  }
}

async function realExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      let isDanglingSymlink = false;
      try {
        isDanglingSymlink = (await lstat(current)).isSymbolicLink();
      } catch (lstatError) {
        if (!isErrorCode(lstatError, 'ENOENT')) throw lstatError;
      }
      if (isDanglingSymlink) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function atomicWrite(targetPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf-8', mode: 0o600 });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new BaselineError(`Unable to atomically write "${targetPath}"`, { cause: error });
  }
}

function requireSession(session: BaselineSession): void {
  requireSessionId(session.id);
  if (session.workDir.length === 0) throw new BaselineError('The session workspace path is empty');
}

function requireSessionId(sessionId: string): void {
  if (sessionId.length === 0) throw new BaselineError('The baseline session id is empty');
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.replaceAll('\r\n', '\n').split('\n').length;
}

function computeLineDiff(
  oldContent: string,
  newContent: string,
): { additions: number; deletions: number } {
  const lines = (content: string): string[] =>
    content.length === 0 ? [] : content.replaceAll('\r\n', '\n').split('\n');
  const oldLines = lines(oldContent);
  const newLines = lines(newContent);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  return {
    additions: newLines.filter((line) => !oldSet.has(line)).length,
    deletions: oldLines.filter((line) => !newSet.has(line)).length,
  };
}
