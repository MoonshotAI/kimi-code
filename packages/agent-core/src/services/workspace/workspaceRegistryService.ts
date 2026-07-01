import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { basename as posixBasename } from 'pathe';
import type { Stats } from 'node:fs';

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { encodeWorkDirKey, normalizeWorkDir } from '../../session/store';
import { readSessionIndex } from '../../session/store/session-index';
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
  }

  async list(): Promise<Workspace[]> {
    const file = await this.runExclusive(() => this.readRegistry());
    const deleted = new Set(file.deleted_workspace_ids);

    const result: Workspace[] = [];
    // Registered workspaces (explicitly added by the user). Dedup by root: the
    // registry can hold legacy entries whose id was computed by an older
    // encodeWorkDirKey (e.g. realpath-based on Windows) for the same folder, so
    // a single root may map to multiple ids. Prefer the entry whose id matches
    // the current canonical key so sessions' workspace_id still resolves and
    // the sidebar doesn't render the same workspace twice.
    //
    // The session count is intentionally scoped to the representative's own
    // bucket (via hydrate) rather than aggregated across every id for the root:
    // GET /sessions?workspace_id=<representative> only pages the canonical
    // bucket, so the count must reflect what the list can actually retrieve.
    const byRoot = new Map<string, { id: string; entry: WorkspaceRegistryEntry }>();
    for (const [id, entry] of Object.entries(file.workspaces)) {
      const existing = byRoot.get(entry.root);
      if (existing === undefined) {
        byRoot.set(entry.root, { id, entry });
        continue;
      }
      const canonicalId = encodeWorkDirKey(normalizeWorkDir(entry.root));
      if (existing.id !== canonicalId && id === canonicalId) {
        byRoot.set(entry.root, { id, entry });
      }
    }
    for (const { id, entry } of byRoot.values()) {
      result.push(await this.hydrate(id, entry));
    }

    // Derived workspaces: cwds that own sessions but were never registered
    // (e.g. sessions created with cwd only). Computed on the fly from the
    // session index and never persisted, so the registry cannot drift from the
    // session store.
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    const derived = new Map<string, string>(); // workspace id -> workDir
    for (const entry of index.values()) {
      const id = encodeWorkDirKey(entry.workDir);
      if (file.workspaces[id] !== undefined || deleted.has(id)) continue;
      derived.set(id, entry.workDir);
    }
    for (const [id, workDir] of derived) {
      // Skip archived-only buckets so they don't surface as empty groups.
      const sessionCount = await countActiveSessions(join(this.sessionsDir, id));
      if (sessionCount === 0) continue;
      result.push(
        await this.hydrate(
          id,
          { root: workDir, name: posixBasename(workDir), created_at: '', last_opened_at: '' },
          sessionCount,
        ),
      );
    }

    return result.sort((a, b) => (b.last_opened_at < a.last_opened_at ? -1 : 1));
  }

  async get(workspaceId: string): Promise<Workspace> {
    const entry = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      return file.workspaces[workspaceId] ?? null;
    });
    if (entry === null) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return this.hydrate(workspaceId, entry);
  }

  async createOrTouch(root: string, name?: string): Promise<Workspace> {
    let stat: Stats;
    try {
      stat = await fsp.stat(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspaceRootNotFoundError(root);
      }
      throw err;
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
    await fsp.mkdir(join(this.sessionsDir, workspaceId), { recursive: true, mode: 0o700 });

    const now = new Date().toISOString();
    const { entry, created } = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      const existing = file.workspaces[workspaceId];
      const next: WorkspaceRegistryEntry =
        existing !== undefined
          ? { ...existing, last_opened_at: now }
          : {
              root: normalizedRoot,
              name: name ?? posixBasename(normalizedRoot),
              created_at: now,
              last_opened_at: now,
            };
      file.workspaces[workspaceId] = next;
      // An explicit add clears any prior deletion tombstone.
      file.deleted_workspace_ids = file.deleted_workspace_ids.filter((id) => id !== workspaceId);
      await this.writeRegistry(file);
      return { entry: next, created: existing === undefined };
    });
    const workspace = await this.hydrate(workspaceId, entry);
    if (created) {
      this.publishWorkspace({ type: 'event.workspace.created', workspace });
    }
    return workspace;
  }

  async update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace> {
    const entry = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      const existing = file.workspaces[workspaceId];
      if (existing === undefined) {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      const next: WorkspaceRegistryEntry = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      };
      file.workspaces[workspaceId] = next;
      await this.writeRegistry(file);
      return next;
    });
    const workspace = await this.hydrate(workspaceId, entry);
    this.publishWorkspace({ type: 'event.workspace.updated', workspace });
    return workspace;
  }

  async delete(workspaceId: string): Promise<void> {
    const root = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      const existing = file.workspaces[workspaceId];
      let root: string;
      if (existing !== undefined) {
        delete file.workspaces[workspaceId];
        root = existing.root;
      } else {
        // Derived workspace: not in the file but a valid list result.
        // Tombstone it so list() stops surfacing it.
        const derived = await this.findDerivedWorkDir(workspaceId);
        if (derived === undefined) throw new WorkspaceNotFoundError(workspaceId);
        root = derived;
      }
      if (!file.deleted_workspace_ids.includes(workspaceId)) {
        file.deleted_workspace_ids.push(workspaceId);
      }
      await this.writeRegistry(file);
      return root;
    });
    this.publishWorkspace({
      type: 'event.workspace.deleted',
      workspace_id: workspaceId,
      root,
    });
  }

  async resolveRoot(workspaceId: string): Promise<string> {
    const entry = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      return file.workspaces[workspaceId] ?? null;
    });
    if (entry !== null) return entry.root;

    // Not registered — may be a derived workspace id, which is the session
    // bucket key (encodeWorkDirKey(workDir)). Resolve it from the index.
    const derived = await this.findDerivedWorkDir(workspaceId);
    if (derived !== undefined) return derived;
    throw new WorkspaceNotFoundError(workspaceId);
  }

  /** Look up a derived workspace's workDir from the session index, or undefined
   *  if the id is not a known derived bucket. */
  private async findDerivedWorkDir(workspaceId: string): Promise<string | undefined> {
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    for (const e of index.values()) {
      if (encodeWorkDirKey(e.workDir) === workspaceId) return e.workDir;
    }
    return undefined;
  }

  private async hydrate(
    workspaceId: string,
    entry: WorkspaceRegistryEntry,
    sessionCount?: number,
  ): Promise<Workspace> {
    const [{ is_git_repo, branch }, session_count] = await Promise.all([
      detectGit(entry.root),
      sessionCount ?? countActiveSessions(join(this.sessionsDir, workspaceId)),
    ]);
    return {
      id: workspaceId,
      root: entry.root,
      name: entry.name,
      is_git_repo,
      branch,
      created_at: entry.created_at,
      last_opened_at: entry.last_opened_at,
      session_count,
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
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { version: WORKSPACE_REGISTRY_VERSION, workspaces: {}, deleted_workspace_ids: [] };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(
        { path: this.registryPath, err: String(err) },
        'workspaces.json malformed; treating as empty',
      );
      return { version: WORKSPACE_REGISTRY_VERSION, workspaces: {}, deleted_workspace_ids: [] };
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
      return { version: WORKSPACE_REGISTRY_VERSION, workspaces: {}, deleted_workspace_ids: [] };
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
    return { version, workspaces, deleted_workspace_ids };
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

async function countActiveSessions(dir: string): Promise<number> {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    throw err;
  }
  let count = 0;
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (await isSessionArchived(join(dir, d.name))) continue;
    count += 1;
  }
  return count;
}

async function isSessionArchived(sessionDir: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(join(sessionDir, 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && (parsed as { archived?: boolean }).archived === true;
  } catch {
    // Treat unreadable/missing state.json as non-archived so the directory still
    // counts as a session (matches the session store's own loading behavior).
    return false;
  }
}

export function userHomeDir(): string {
  return os.homedir();
}

export const pathDirname = dirname;

registerSingleton(IWorkspaceRegistry, WorkspaceRegistryService, InstantiationType.Delayed);
