import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { basename as posixBasename } from 'pathe';
import lockfile from 'proper-lockfile';
import type { Stats } from 'node:fs';

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { encodeWorkDirKey, normalizeWorkDir, SessionStore } from '../../session/store';
import { IEnvironmentService } from '../environment/environment';
import { IEventService } from '../event/event';

import type { Workspace } from '@moonshot-ai/protocol';

import { ILogService } from '../logger/logger';
import {
  IWorkspaceRegistry,
  WorkspaceNotFoundError,
  WorkspaceRootNotFoundError,
  type WorkspacePatch,
} from './workspaceRegistry';

const WORKSPACE_REGISTRY_FILE = 'workspaces.json';
const WORKSPACE_REGISTRY_VERSION = 1;

interface WorkspaceRegistryEntry {
  root: string;
  name: string;
  created_at: string;
  last_opened_at: string;
}

interface WorkspaceRegistryFile {
  version: number;
  workspaces: Record<string, WorkspaceRegistryEntry>;
  /** Workspace ids the user explicitly removed. Their session buckets stay on
   *  disk, so derived workspaces (computed from the session index) must skip
   *  them to keep deletion durable. */
  deleted_workspace_ids: string[];
  deleted_workspace_roots?: Record<string, string>;
}

interface IndexedWorkspace {
  readonly root: string;
  readonly workspaceIds: Set<string>;
  activeCount: number;
  createdAt: number;
  lastOpenedAt: number;
}

type WorkspaceRegistryEvent =
  | { type: 'event.workspace.created'; workspace: Workspace }
  | { type: 'event.workspace.updated'; workspace: Workspace }
  | { type: 'event.workspace.deleted'; workspace_id: string; root: string };

export class WorkspaceRegistryService extends Disposable implements IWorkspaceRegistry {
  readonly _serviceBrand: undefined;

  private readonly homeDir: string;
  private readonly sessionsDir: string;
  private readonly registryPath: string;
  private readonly sessionStore: SessionStore;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IEnvironmentService env: IEnvironmentService,
    @ILogService private readonly logger: ILogService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
    this.homeDir = env.homeDir;
    this.sessionsDir = join(env.homeDir, 'sessions');
    this.registryPath = join(env.homeDir, WORKSPACE_REGISTRY_FILE);
    this.sessionStore = new SessionStore(env.homeDir);
  }

  async list(): Promise<Workspace[]> {
    const [file, indexed] = await Promise.all([
      this.runExclusive(() => this.readRegistry()),
      this.readIndexedWorkspaces(),
    ]);
    const deleted = new Set(file.deleted_workspace_ids);
    const deletedRoots = normalizedDeletedRoots(file);

    const result: Workspace[] = [];
    // Registered workspaces (explicitly added by the user). Dedup by root: the
    // registry can hold legacy entries whose id was computed by an older
    // encodeWorkDirKey (e.g. realpath-based on Windows) for the same folder, so
    // a single root may map to multiple ids. Prefer the entry whose id matches
    // the current canonical key so sessions' workspace_id still resolves and
    // the sidebar doesn't render the same workspace twice.
    //
    // Counts are aggregated by normalized root. The session query endpoint
    // uses the same root grouping, so legacy alias buckets remain visible
    // after a canonical entry is selected as the public representative.
    const byRoot = new Map<
      string,
      { id: string; entry: WorkspaceRegistryEntry; canonical: boolean }
    >();
    for (const [id, entry] of Object.entries(file.workspaces)) {
      const root = normalizeWorkDir(entry.root);
      const existing = byRoot.get(root);
      const canonicalId = encodeWorkDirKey(root);
      if (deleted.has(id) || deleted.has(canonicalId) || deletedRoots.has(root)) continue;
      const canonical = id === canonicalId;
      if (existing === undefined) {
        // Keep the persisted id when this is the only entry for the root. A
        // legacy alias can also be the physical session bucket name; inventing
        // the canonical id here would make the reported count point at an
        // empty bucket.
        byRoot.set(root, { id, entry: { ...entry, root }, canonical });
        continue;
      }
      if (!existing.canonical && canonical) {
        byRoot.set(root, { id: canonicalId, entry: { ...entry, root }, canonical: true });
      }
    }
    for (const [root, { id, entry }] of byRoot) {
      const bucket = indexed.get(root);
      result.push(await this.hydrate(id, entry, activeCountForWorkspace(bucket)));
    }

    // Derived workspaces: cwds that own sessions but were never registered
    // (e.g. sessions created with cwd only). Computed on the fly from the
    // session index and never persisted, so the registry cannot drift from the
    // session store.
    for (const [root, workspace] of indexed) {
      const id = representativeIndexedWorkspaceId(workspace);
      const canonicalId = encodeWorkDirKey(root);
      const sessionCount = activeCountForWorkspace(workspace);
      if (
        sessionCount === 0 ||
        byRoot.has(root) ||
        deleted.has(id) ||
        deleted.has(canonicalId) ||
        deletedRoots.has(root)
      ) {
        continue;
      }
      result.push(
        await this.hydrate(
          id,
          {
            root,
            name: posixBasename(root),
            created_at: new Date(workspace.createdAt).toISOString(),
            last_opened_at: new Date(workspace.lastOpenedAt).toISOString(),
          },
          sessionCount,
        ),
      );
    }

    return result.toSorted(
      (a, b) =>
        b.last_opened_at.localeCompare(a.last_opened_at) || a.id.localeCompare(b.id),
    );
  }

  async get(workspaceId: string): Promise<Workspace> {
    const { match, deleted, deletedRoots, deletedIds } = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      const deletedRoots = normalizedDeletedRoots(file);
      const deletedIds = file.deleted_workspace_ids;
      const exact = file.workspaces[workspaceId];
      const match =
        exact === undefined
          ? findRepresentativeRegistryEntry(file, workspaceId)
          : { id: workspaceId, entry: exact };
      return {
        match,
        deletedRoots,
        deletedIds,
        deleted:
          file.deleted_workspace_ids.includes(workspaceId) ||
          (match !== null &&
            (deletedRoots.has(normalizeWorkDir(match.entry.root)) ||
              file.deleted_workspace_ids.includes(
                encodeWorkDirKey(normalizeWorkDir(match.entry.root)),
              ))),
      };
    });
    if (deleted) throw new WorkspaceNotFoundError(workspaceId);
    if (match !== null) {
      const root = normalizeWorkDir(match.entry.root);
      return this.hydrate(
        match.id,
        { ...match.entry, root },
        activeCountForWorkspace((await this.readIndexedWorkspaces()).get(root)),
      );
    }
    const derived = await this.findDerivedWorkspace(workspaceId);
    if (derived === undefined) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    const derivedRoot = normalizeWorkDir(derived.root);
    if (
      deletedRoots.has(derivedRoot) ||
      deletedIds.includes(workspaceId) ||
      deletedIds.includes(encodeWorkDirKey(derivedRoot))
    ) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    const representativeId = representativeIndexedWorkspaceId(derived, workspaceId);
    return this.hydrate(
      representativeId,
      {
        root: derived.root,
        name: posixBasename(derived.root),
        created_at: new Date(derived.createdAt).toISOString(),
        last_opened_at: new Date(derived.lastOpenedAt).toISOString(),
      },
      activeCountForWorkspace(derived),
    );
  }

  async createOrTouch(root: string, name?: string): Promise<Workspace> {
    let stat: Stats;
    try {
      stat = await fsp.stat(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspaceRootNotFoundError(root);
      }
      throw error;
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceRootNotFoundError(root);
    }
    // Normalize with pathe (NOT realpath) so the workspace id matches the
    // session store's `encodeWorkDirKey`, which also normalizes via pathe and
    // never resolves symlinks or 8.3 short names. Using `fsp.realpath` here
    // diverged from the session store on Windows and orphaned legacy sessions.
    const normalizedRoot = normalizeWorkDir(root);
    const workspaceId = encodeWorkDirKey(normalizedRoot);

    const now = new Date().toISOString();
    const { id: representativeId, entry, created } = await this.mutateRegistry(async (file) => {
      const aliases = Object.entries(file.workspaces).filter(
        ([, candidate]) => normalizeWorkDir(candidate.root) === normalizedRoot,
      );
      const existing =
        file.workspaces[workspaceId] !== undefined
          ? ([workspaceId, file.workspaces[workspaceId]] as const)
          : aliases[0];
      const representativeId = existing?.[0] ?? workspaceId;
      const existingEntry = existing?.[1];
      const next: WorkspaceRegistryEntry =
        existingEntry !== undefined
          ? { ...existingEntry, root: normalizedRoot, last_opened_at: now }
          : {
              root: normalizedRoot,
              name: name ?? posixBasename(normalizedRoot),
              created_at: now,
              last_opened_at: now,
            };
      file.workspaces[representativeId] = next;
      clearWorkspaceTombstones(file, representativeId, normalizedRoot);
      return { id: representativeId, entry: next, created: existingEntry === undefined };
    });
    await fsp.mkdir(join(this.sessionsDir, representativeId), { recursive: true, mode: 0o700 });
    const sessionCount = activeCountForWorkspace(
      (await this.readIndexedWorkspaces()).get(normalizedRoot),
    );
    const workspace = await this.hydrate(representativeId, entry, sessionCount);
    if (created) {
      this.publishWorkspace({ type: 'event.workspace.created', workspace });
    }
    return workspace;
  }

  async update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace> {
    const { id: representativeId, entry } = await this.mutateRegistry(async (file) => {
      const exact = file.workspaces[workspaceId];
      const fallback =
        exact === undefined
          ? Object.entries(file.workspaces).find(
              ([, candidate]) =>
                encodeWorkDirKey(normalizeWorkDir(candidate.root)) === workspaceId,
            )
          : undefined;
      let existing =
        exact === undefined
          ? fallback === undefined
            ? undefined
            : { id: fallback[0], entry: fallback[1] }
          : { id: workspaceId, entry: exact };
      if (existing === undefined) {
        if (file.deleted_workspace_ids.includes(workspaceId)) {
          throw new WorkspaceNotFoundError(workspaceId);
        }
        const derived = await this.findDerivedWorkspace(workspaceId);
        if (
          derived === undefined ||
          normalizedDeletedRoots(file).has(normalizeWorkDir(derived.root)) ||
          file.deleted_workspace_ids.includes(encodeWorkDirKey(normalizeWorkDir(derived.root)))
        ) {
          throw new WorkspaceNotFoundError(workspaceId);
        }
        const representativeId = representativeIndexedWorkspaceId(derived, workspaceId);
        if (file.deleted_workspace_ids.includes(representativeId)) {
          throw new WorkspaceNotFoundError(workspaceId);
        }
        existing = {
          id: representativeId,
          entry: {
            root: derived.root,
            name: posixBasename(derived.root),
            created_at: new Date(derived.createdAt).toISOString(),
            last_opened_at: new Date(derived.lastOpenedAt).toISOString(),
          },
        };
      }
      const root = normalizeWorkDir(existing.entry.root);
      const canonicalId = encodeWorkDirKey(root);
      const canonicalEntry = file.workspaces[canonicalId];
      const representative =
        canonicalEntry === undefined
          ? existing
          : { id: canonicalId, entry: canonicalEntry };
      const next: WorkspaceRegistryEntry = {
        ...representative.entry,
        root,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      };
      file.workspaces[representative.id] = next;
      return { id: representative.id, entry: next };
    });
    const root = normalizeWorkDir(entry.root);
    const workspace = await this.hydrate(
      representativeId,
      entry,
      activeCountForWorkspace((await this.readIndexedWorkspaces()).get(root)),
    );
    this.publishWorkspace({ type: 'event.workspace.updated', workspace });
    return workspace;
  }

  async delete(workspaceId: string): Promise<void> {
    const derived = await this.findDerivedWorkspace(workspaceId);
    const root = await this.mutateRegistry(async (file) => {
      const existing =
        file.workspaces[workspaceId] ??
        Object.values(file.workspaces).find(
          (candidate) => encodeWorkDirKey(normalizeWorkDir(candidate.root)) === workspaceId,
        );
      let root: string;
      if (existing !== undefined) {
        root = normalizeWorkDir(existing.root);
        if (normalizedDeletedRoots(file).has(root)) {
          throw new WorkspaceNotFoundError(workspaceId);
        }
        for (const [aliasId, candidate] of Object.entries(file.workspaces)) {
          if (normalizeWorkDir(candidate.root) !== root) continue;
          delete file.workspaces[aliasId];
          addWorkspaceTombstone(file, aliasId, root);
        }
      } else {
        if (
          derived === undefined ||
          normalizedDeletedRoots(file).has(normalizeWorkDir(derived.root))
        ) {
          throw new WorkspaceNotFoundError(workspaceId);
        }
        root = derived.root;
      }
      addWorkspaceTombstone(file, workspaceId, root);
      return root;
    });
    this.publishWorkspace({
      type: 'event.workspace.deleted',
      workspace_id: workspaceId,
      root,
    });
  }

  async resolveRoot(workspaceId: string): Promise<string> {
    const { entry, deleted, deletedRoots, deletedIds } = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      const deletedRoots = normalizedDeletedRoots(file);
      const deletedIds = file.deleted_workspace_ids;
      const entry =
        file.workspaces[workspaceId] ??
        Object.values(file.workspaces).find(
          (candidate) => encodeWorkDirKey(normalizeWorkDir(candidate.root)) === workspaceId,
        ) ??
        null;
      return {
        entry,
        deletedRoots,
        deletedIds,
        deleted:
          file.deleted_workspace_ids.includes(workspaceId) ||
          (entry !== null &&
            (deletedRoots.has(normalizeWorkDir(entry.root)) ||
              file.deleted_workspace_ids.includes(
                encodeWorkDirKey(normalizeWorkDir(entry.root)),
              ))),
      };
    });
    if (deleted) throw new WorkspaceNotFoundError(workspaceId);
    if (entry !== null) return normalizeWorkDir(entry.root);

    const derived = await this.findDerivedWorkspace(workspaceId);
    if (derived !== undefined) {
      const root = normalizeWorkDir(derived.root);
      if (
        !deletedRoots.has(root) &&
        !deletedIds.includes(workspaceId) &&
        !deletedIds.includes(encodeWorkDirKey(root))
      ) {
        return root;
      }
    }
    throw new WorkspaceNotFoundError(workspaceId);
  }

  private async findDerivedWorkspace(workspaceId: string): Promise<IndexedWorkspace | undefined> {
    for (const workspace of (await this.readIndexedWorkspaces()).values()) {
      if (
        workspace.workspaceIds.has(workspaceId) ||
        encodeWorkDirKey(workspace.root) === workspaceId
      ) {
        return workspace;
      }
    }
    return undefined;
  }

  private async readIndexedWorkspaces(): Promise<Map<string, IndexedWorkspace>> {
    const summaries = await this.sessionStore.list({ includeArchive: true });
    const indexed = new Map<string, IndexedWorkspace>();
    for (const summary of summaries) {
      if (!(await hasReadableSessionState(summary.sessionDir))) continue;
      if (typeof summary.workDir !== 'string' || summary.workDir.trim() === '') continue;
      if (!isAbsolute(summary.workDir)) continue;
      const root = normalizeWorkDir(summary.workDir);
      const bucketId = posixBasename(dirname(summary.sessionDir));
      const existing = indexed.get(root);
      const workspace =
        existing ??
        {
          root,
          workspaceIds: new Set<string>(),
          activeCount: 0,
          createdAt: finiteTimestamp(summary.createdAt),
          lastOpenedAt: finiteTimestamp(summary.updatedAt),
        };
      workspace.workspaceIds.add(bucketId);
      if (summary.archived !== true) {
        workspace.activeCount += 1;
      }
      workspace.createdAt = Math.min(workspace.createdAt, finiteTimestamp(summary.createdAt));
      workspace.lastOpenedAt = Math.max(
        workspace.lastOpenedAt,
        finiteTimestamp(summary.updatedAt),
      );
      indexed.set(root, workspace);
    }
    return indexed;
  }

  private async hydrate(
    workspaceId: string,
    entry: WorkspaceRegistryEntry,
    sessionCount: number,
  ): Promise<Workspace> {
    const { is_git_repo, branch } = await detectGit(entry.root);
    return {
      id: workspaceId,
      root: entry.root,
      name: entry.name,
      is_git_repo,
      branch,
      created_at: entry.created_at,
      last_opened_at: entry.last_opened_at,
      session_count: sessionCount,
    };
  }

  private publishWorkspace(event: WorkspaceRegistryEvent): void {
    switch (event.type) {
      case 'event.workspace.created':
      case 'event.workspace.updated':
        this.eventService.publish({
          agentId: 'main',
          sessionId: '__global__',
          type: event.type,
          workspace: event.workspace,
        });
        break;
      case 'event.workspace.deleted':
        this.eventService.publish({
          agentId: 'main',
          sessionId: '__global__',
          type: event.type,
          workspace_id: event.workspace_id,
          root: event.root,
        });
        break;
    }
  }

  private async readRegistry(): Promise<WorkspaceRegistryFile> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.registryPath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          version: WORKSPACE_REGISTRY_VERSION,
          workspaces: {},
          deleted_workspace_ids: [],
          deleted_workspace_roots: undefined,
        };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger.warn(
        { path: this.registryPath, err: String(error) },
        'workspaces.json malformed; treating as empty',
      );
      return {
        version: WORKSPACE_REGISTRY_VERSION,
        workspaces: {},
        deleted_workspace_ids: [],
        deleted_workspace_roots: undefined,
      };
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { workspaces?: unknown }).workspaces !== 'object' ||
      (parsed as { workspaces?: unknown }).workspaces === null
    ) {
      this.logger.warn(
        { path: this.registryPath },
        'workspaces.json missing required keys; treating as empty',
      );
      return {
        version: WORKSPACE_REGISTRY_VERSION,
        workspaces: {},
        deleted_workspace_ids: [],
        deleted_workspace_roots: undefined,
      };
    }
    const rawWorkspaces = (parsed as { workspaces: Record<string, unknown> }).workspaces;
    const workspaces: Record<string, WorkspaceRegistryEntry> = {};
    for (const [id, value] of Object.entries(rawWorkspaces)) {
      const entry = this.sanitizeEntry(value);
      if (entry !== null) {
        workspaces[id] = entry;
      }
    }
    const version =
      typeof (parsed as { version?: unknown }).version === 'number'
        ? (parsed as { version: number }).version
        : WORKSPACE_REGISTRY_VERSION;
    const rawDeleted = (parsed as { deleted_workspace_ids?: unknown }).deleted_workspace_ids;
    const deleted_workspace_ids = Array.isArray(rawDeleted)
      ? rawDeleted.filter((id): id is string => typeof id === 'string')
      : [];
    const rawDeletedRoots = (parsed as { deleted_workspace_roots?: unknown })
      .deleted_workspace_roots;
    const deleted_workspace_roots: Record<string, string> = {};
    if (typeof rawDeletedRoots === 'object' && rawDeletedRoots !== null) {
      for (const [id, root] of Object.entries(rawDeletedRoots)) {
        if (typeof root === 'string') deleted_workspace_roots[id] = root;
      }
    }
    return { version, workspaces, deleted_workspace_ids, deleted_workspace_roots };
  }

  private sanitizeEntry(value: unknown): WorkspaceRegistryEntry | null {
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Partial<WorkspaceRegistryEntry>;
    if (
      typeof v.root !== 'string' ||
      typeof v.name !== 'string' ||
      typeof v.created_at !== 'string' ||
      typeof v.last_opened_at !== 'string'
    ) {
      return null;
    }
    return {
      root: v.root,
      name: v.name,
      created_at: v.created_at,
      last_opened_at: v.last_opened_at,
    };
  }

  private async writeRegistry(file: WorkspaceRegistryFile): Promise<void> {
    await fsp.mkdir(dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.registryPath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
    await fsp.rename(tmp, this.registryPath);
  }

  private mutateRegistry<T>(operation: (file: WorkspaceRegistryFile) => Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      await fsp.mkdir(this.homeDir, { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(this.registryPath, {
        realpath: false,
        retries: {
          retries: 100,
          factor: 1,
          minTimeout: 10,
          maxTimeout: 50,
          randomize: true,
        },
      });
      try {
        const file = await this.readRegistry();
        const result = await operation(file);
        await this.writeRegistry(file);
        return result;
      } finally {
        await release();
      }
    });
  }

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(op, op);
    this.opQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    super.dispose();
  }
}

export interface GitInfo {
  is_git_repo: boolean;
  branch: string | null;
}

export async function detectGit(root: string): Promise<GitInfo> {
  let dotGit: Stats;
  try {
    dotGit = await fsp.lstat(join(root, '.git'));
  } catch {
    return { is_git_repo: false, branch: null };
  }

  let gitDir: string;
  if (dotGit.isDirectory()) {
    gitDir = join(root, '.git');
  } else if (dotGit.isFile()) {
    let text: string;
    try {
      text = await fsp.readFile(join(root, '.git'), 'utf8');
    } catch {
      return { is_git_repo: false, branch: null };
    }
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (m === null) return { is_git_repo: false, branch: null };
    const ref = m[1] ?? '';
    if (ref === '') return { is_git_repo: false, branch: null };
    gitDir = ref.trim();

    if (!gitDir.startsWith('/')) {
      gitDir = join(root, gitDir);
    }
  } else {
    return { is_git_repo: false, branch: null };
  }

  let head: string;
  try {
    head = (await fsp.readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    return { is_git_repo: true, branch: null };
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return { is_git_repo: true, branch: ref ? (ref[1] ?? null) : null };
}

async function hasReadableSessionState(sessionDir: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(join(sessionDir, 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function normalizedDeletedRoots(file: WorkspaceRegistryFile): ReadonlySet<string> {
  const roots = new Set(
    Object.values(file.deleted_workspace_roots ?? {}).map((root) => normalizeWorkDir(root)),
  );
  for (const id of file.deleted_workspace_ids) {
    const workspace = file.workspaces[id];
    if (workspace !== undefined) roots.add(normalizeWorkDir(workspace.root));
  }
  return roots;
}

function findRepresentativeRegistryEntry(
  file: WorkspaceRegistryFile,
  workspaceId: string,
): { id: string; entry: WorkspaceRegistryEntry } | null {
  const exact = file.workspaces[workspaceId];
  const candidates =
    exact === undefined
      ? Object.entries(file.workspaces).filter(
          ([, candidate]) =>
            encodeWorkDirKey(normalizeWorkDir(candidate.root)) === workspaceId,
        )
      : Object.entries(file.workspaces).filter(
          ([, candidate]) =>
            normalizeWorkDir(candidate.root) === normalizeWorkDir(exact.root),
        );
  if (candidates.length === 0) return null;
  const root = normalizeWorkDir(candidates[0]![1].root);
  const canonicalId = encodeWorkDirKey(root);
  const representative = candidates.find(([id]) => id === canonicalId) ?? candidates[0]!;
  return { id: representative[0], entry: representative[1] };
}

function addWorkspaceTombstone(
  file: WorkspaceRegistryFile,
  workspaceId: string,
  root: string,
): void {
  if (!file.deleted_workspace_ids.includes(workspaceId)) {
    file.deleted_workspace_ids.push(workspaceId);
  }
  file.deleted_workspace_roots = {
    ...file.deleted_workspace_roots,
    [workspaceId]: normalizeWorkDir(root),
  };
}

function clearWorkspaceTombstones(
  file: WorkspaceRegistryFile,
  workspaceId: string,
  root: string,
): void {
  const canonicalId = encodeWorkDirKey(root);
  const cleared: string[] = [];
  for (const deletedId of file.deleted_workspace_ids) {
    const deletedRoot = file.deleted_workspace_roots?.[deletedId];
    if (
      deletedId === workspaceId ||
      deletedId === canonicalId ||
      (deletedRoot !== undefined && normalizeWorkDir(deletedRoot) === root)
    ) {
      cleared.push(deletedId);
    }
  }
  if (cleared.length === 0) return;
  const clearedSet = new Set(cleared);
  file.deleted_workspace_ids = file.deleted_workspace_ids.filter((id) => !clearedSet.has(id));
  if (file.deleted_workspace_roots !== undefined) {
    for (const deletedId of cleared) delete file.deleted_workspace_roots[deletedId];
  }
}

function finiteTimestamp(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function activeCountForWorkspace(indexed: IndexedWorkspace | undefined): number {
  return indexed?.activeCount ?? 0;
}

function representativeIndexedWorkspaceId(
  indexed: IndexedWorkspace,
  preferredId?: string,
): string {
  if (preferredId !== undefined && indexed.workspaceIds.has(preferredId)) {
    return preferredId;
  }
  const canonicalId = encodeWorkDirKey(indexed.root);
  if (indexed.workspaceIds.has(canonicalId)) return canonicalId;
  // A legacy index can contain only alias bucket names. Keep one of those
  // actual names instead of returning a canonical id with no matching bucket.
  for (const id of indexed.workspaceIds) return id;
  return canonicalId;
}

export function userHomeDir(): string {
  return os.homedir();
}

export const pathDirname = dirname;

registerSingleton(IWorkspaceRegistry, WorkspaceRegistryService, InstantiationType.Delayed);
