

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Dirent, Stats } from 'node:fs';

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { encodeWorkDirKey } from '../../session/store';
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
    // Surface cwds that have sessions but were never registered (e.g. sessions
    // created with cwd only) by registering them idempotently first, so the
    // sidebar can page sessions per workspace without a full global walk.
    await this.registerDerivedWorkspaces();
    const file = await this.runExclusive(() => this.readRegistry());
    const hydrated = await Promise.all(
      Object.entries(file.workspaces).map(([workspaceId, entry]) =>
        this.hydrate(workspaceId, entry),
      ),
    );
    return hydrated.sort((a, b) => (b.last_opened_at < a.last_opened_at ? -1 : 1));
  }

  /**
   * Register cwds that own sessions but are absent from the registry.
   *
   * `GET /sessions?workspace_id=` resolves the id through this registry, so a
   * workspace that only exists as a session bucket (created with cwd only) must
   * be registered before the web UI can page its sessions. Scanning the buckets
   * and recovering each root from the session index lets `list()` return them
   * without a full global session walk. Registration is idempotent and
   * self-heals: once written, the bucket becomes a normal registered workspace.
   */
  private async registerDerivedWorkspaces(): Promise<void> {
    let dirents: Dirent[];
    try {
      dirents = await fsp.readdir(this.sessionsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    const file = await this.runExclusive(() => this.readRegistry());
    const registered = new Set(Object.keys(file.workspaces));
    const missing = dirents.filter((d) => d.isDirectory() && !registered.has(d.name));
    if (missing.length === 0) return;

    // Recover each bucket's root from the session index: the bucket dir name is
    // encodeWorkDirKey(root), and the index maps sessionId -> workDir.
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    const rootByKey = new Map<string, string>();
    for (const entry of index.values()) {
      rootByKey.set(encodeWorkDirKey(entry.workDir), entry.workDir);
    }

    for (const d of missing) {
      const root = rootByKey.get(d.name);
      if (root === undefined) continue;
      try {
        await this.createOrTouch(root);
      } catch (err) {
        // The project root may have been deleted while its sessions remain on
        // disk; skip it so a stale bucket cannot break listing.
        if (err instanceof WorkspaceRootNotFoundError) continue;
        throw err;
      }
    }
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
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspaceRootNotFoundError(root);
      }
      throw err;
    }
    const workspaceId = encodeWorkDirKey(realRoot);
    await fsp.mkdir(join(this.sessionsDir, workspaceId), { recursive: true, mode: 0o700 });

    const now = new Date().toISOString();
    const { entry, created } = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      const existing = file.workspaces[workspaceId];
      const next: WorkspaceRegistryEntry =
        existing !== undefined
          ? { ...existing, last_opened_at: now }
          : {
              root: realRoot,
              name: name ?? basename(realRoot),
              created_at: now,
              last_opened_at: now,
            };
      file.workspaces[workspaceId] = next;
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
      if (existing === undefined) {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      delete file.workspaces[workspaceId];
      await this.writeRegistry(file);
      return existing.root;
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
    if (entry === null) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return entry.root;
  }

  private async hydrate(
    workspaceId: string,
    entry: WorkspaceRegistryEntry,
  ): Promise<Workspace> {
    const [{ is_git_repo, branch }, session_count] = await Promise.all([
      detectGit(entry.root),
      countActiveSessions(join(this.sessionsDir, workspaceId)),
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
        return { version: WORKSPACE_REGISTRY_VERSION, workspaces: {} };
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
      return { version: WORKSPACE_REGISTRY_VERSION, workspaces: {} };
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
      return { version: WORKSPACE_REGISTRY_VERSION, workspaces: {} };
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
    return { version, workspaces };
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
