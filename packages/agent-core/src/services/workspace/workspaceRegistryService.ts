import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { basename as posixBasename } from 'pathe';
import type { Stats } from 'node:fs';

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { encodeWorkDirKey, normalizeWorkDir, workspaceRootKey } from '../../session/store';
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
import {
  readWorkspaceRegistryFile,
  writeWorkspaceRegistryFile,
  type WorkspaceRegistryEntry,
  type WorkspaceRegistryFile,
} from '../../session/store/workspace-registry-file';

type WorkspaceRegistryEvent =
  | { type: 'event.workspace.created'; workspace: Workspace }
  | { type: 'event.workspace.updated'; workspace: Workspace }
  | { type: 'event.workspace.deleted'; workspace_id: string; root: string };

/**
 * Pure scan over registry entries: the id whose root identity-matches
 * `rootKey` (see `workspaceRootKey`), or undefined. When several entries
 * identity-match (e.g. a legacy-alias id plus a canonical one for the same
 * folder), `preferredId` wins when present — callers pass the id the current
 * code would mint for the query root, so post-scan behavior stays consistent
 * with a fresh `encodeWorkDirKey`. Otherwise the first entry in file order
 * wins. Extracted so the identity-reuse rule is unit-testable without fs.
 */
export function findRegisteredIdByRootKey(
  workspaces: Record<string, WorkspaceRegistryEntry>,
  rootKey: string,
  preferredId?: string,
): string | undefined {
  let first: string | undefined;
  for (const [id, entry] of Object.entries(workspaces)) {
    if (workspaceRootKey(entry.root) !== rootKey) continue;
    if (id === preferredId) return id;
    first ??= id;
  }
  return first;
}

export class WorkspaceRegistryService extends Disposable implements IWorkspaceRegistry {
  readonly _serviceBrand: undefined;

  private readonly homeDir: string;
  private readonly sessionsDir: string;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IEnvironmentService env: IEnvironmentService,
    @ILogService private readonly logger: ILogService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
    this.homeDir = env.homeDir;
    this.sessionsDir = join(env.homeDir, 'sessions');
  }

  async list(): Promise<Workspace[]> {
    const file = await this.runExclusive(() => this.readRegistry());
    const deleted = new Set(file.deleted_workspace_ids);

    const result: Workspace[] = [];
    // Registered workspaces (explicitly added by the user). Dedup by root
    // identity (`workspaceRootKey` — slashes unified and case folded for
    // Windows-shaped roots): the registry can hold multiple entries for the
    // same folder — legacy ids computed by an older encodeWorkDirKey (e.g.
    // realpath-based on Windows), or ids minted from case variants of one
    // directory — so a single physical root may map to multiple ids. Prefer
    // the entry whose id matches the current canonical key so sessions'
    // workspace_id still resolves and the sidebar doesn't render the same
    // workspace twice.
    //
    // The session count spans every alias bucket for the root (via hydrate):
    // GET /sessions?workspace_id=<representative> pages the UNION of the
    // root's alias buckets, so the count aggregates the same set the list
    // can actually retrieve.
    const byRoot = new Map<string, { id: string; entry: WorkspaceRegistryEntry }>();
    for (const [id, entry] of Object.entries(file.workspaces)) {
      const rootKey = workspaceRootKey(entry.root);
      const existing = byRoot.get(rootKey);
      if (existing === undefined) {
        byRoot.set(rootKey, { id, entry });
        continue;
      }
      const canonicalId = encodeWorkDirKey(normalizeWorkDir(entry.root));
      if (existing.id !== canonicalId && id === canonicalId) {
        byRoot.set(rootKey, { id, entry });
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
    // Identity keys of every registered root: a session whose workDir only
    // differs from a registered root by case/slash spelling (Windows) belongs
    // to that registered workspace and must not resurface as a derived
    // duplicate. Derived candidates themselves are likewise deduped by
    // identity key (first wins).
    const registeredKeys = new Set(
      Object.values(file.workspaces).map((entry) => workspaceRootKey(entry.root)),
    );
    const derived = new Map<string, { id: string; workDir: string }>(); // identity key -> workspace id + workDir
    for (const entry of index.values()) {
      const id = encodeWorkDirKey(entry.workDir);
      // Deletion tombstones store exact ids, so this match stays exact-string:
      // a deleted legacy-alias id whose minted string differs from the current
      // session workDir's id can still resurface here as derived (known
      // residual edge — the workspaces.json schema is shared with
      // agent-core-v2 and must not change).
      if (deleted.has(id)) continue;
      const rootKey = workspaceRootKey(entry.workDir);
      if (registeredKeys.has(rootKey) || derived.has(rootKey)) continue;
      derived.set(rootKey, { id, workDir: entry.workDir });
    }
    for (const { id, workDir } of derived.values()) {
      // Skip archived-only buckets so they don't surface as empty groups. The
      // count spans every alias bucket for the root, matching the registered
      // entries (a derived root can also have split legacy spellings).
      const sessionCount = await this.countAliasSessions(id);
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
    const now = new Date().toISOString();
    const { workspaceId, entry, created } = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      // Reuse an already-registered entry whose root names the same physical
      // directory (identity-key match) instead of minting a second id: on
      // Windows a case/slash variant of a registered root would otherwise
      // create a duplicate registry entry — and with it a second session
      // bucket — for one folder. The stored root/name stay as first
      // registered; stored paths are never rewritten.
      const mintedId = encodeWorkDirKey(normalizedRoot);
      const workspaceId =
        findRegisteredIdByRootKey(file.workspaces, workspaceRootKey(normalizedRoot), mintedId) ??
        mintedId;
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
      // An explicit add clears any prior deletion tombstone for that id.
      file.deleted_workspace_ids = file.deleted_workspace_ids.filter((id) => id !== workspaceId);
      await this.writeRegistry(file);
      return { workspaceId, entry: next, created: existing === undefined };
    });
    await fsp.mkdir(join(this.sessionsDir, workspaceId), { recursive: true, mode: 0o700 });
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
        root = existing.root;
      } else {
        // Derived workspace: not in the file but a valid list result.
        // Tombstone it so list() stops surfacing it.
        const derived = await this.findDerivedWorkDir(workspaceId);
        if (derived === undefined) throw new WorkspaceNotFoundError(workspaceId);
        root = derived;
      }
      // Folded aliases must die together: a sibling spelling left registered
      // (or resurrectable from the session index) would resurface as this
      // directory's representative on the next list(). Remove every registered
      // spelling and tombstone every id that could carry sessions for the
      // directory — registered alias ids plus each spelling's own minted
      // bucket (the derived-workspace loop reads tombstones by exact id).
      const rootKey = workspaceRootKey(root);
      const tombstones = new Set<string>([workspaceId]);
      const spellings = new Set<string>([root]);
      for (const [id, entry] of Object.entries(file.workspaces)) {
        if (workspaceRootKey(entry.root) !== rootKey) continue;
        delete file.workspaces[id];
        tombstones.add(id);
        spellings.add(entry.root);
      }
      const index = await readSessionIndex(this.homeDir, this.sessionsDir);
      for (const entry of index.values()) {
        if (workspaceRootKey(entry.workDir) === rootKey) spellings.add(entry.workDir);
      }
      for (const spelling of spellings) {
        // Both mint forms: the derived-workspace loop keys itself on the raw
        // workDir, registered ids and buckets on the normalized one.
        tombstones.add(encodeWorkDirKey(spelling));
        tombstones.add(encodeWorkDirKey(normalizeWorkDir(spelling)));
      }
      file.deleted_workspace_ids = [
        ...new Set([...file.deleted_workspace_ids, ...tombstones]),
      ];
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

  async findWorkspaceIdByRoot(root: string): Promise<string | undefined> {
    return this.runExclusive(async () => {
      const file = await this.readRegistry();
      // Prefer the id a fresh `encodeWorkDirKey(root)` would mint so callers
      // (the session store's bucket derivation) stay on the canonical bucket
      // when both a legacy alias and a canonical entry identity-match.
      return findRegisteredIdByRootKey(file.workspaces, workspaceRootKey(root), encodeWorkDirKey(root));
    });
  }

  async resolveAliasWorkDirs(workspaceId: string): Promise<readonly string[]> {
    return (await this.aliasLayout(workspaceId))?.aliases ?? [];
  }

  /**
   * Alias workDir spellings plus the session buckets that can hold sessions
   * for the same physical root as `workspaceId` — or undefined when the id is
   * unknown to both the registry and the session index. The bucket set is the
   * union of both placement eras: every registered id for the root (sessions
   * created with a wired bucket resolver land there, including legacy alias
   * ids that no longer match a fresh `encodeWorkDirKey(root)` mint) and each
   * spelling's own minted bucket (pre-resolver split, never rewritten).
   */
  private async aliasLayout(
    workspaceId: string,
  ): Promise<{ aliases: readonly string[]; buckets: readonly string[] } | undefined> {
    const [file, index] = await Promise.all([
      this.runExclusive(() => this.readRegistry()),
      readSessionIndex(this.homeDir, this.sessionsDir),
    ]);
    // Resolve the id's root: the registered entry verbatim, else the derived
    // bucket's recorded workDir (same rule as resolveRoot/findDerivedWorkDir).
    let root = file.workspaces[workspaceId]?.root;
    if (root === undefined) {
      for (const entry of index.values()) {
        if (encodeWorkDirKey(entry.workDir) === workspaceId) {
          root = entry.workDir;
          break;
        }
      }
      if (root === undefined) return undefined;
    }
    const rootKey = workspaceRootKey(root);
    const aliases = new Set<string>([root]);
    const buckets = new Set<string>();
    for (const [id, entry] of Object.entries(file.workspaces)) {
      if (workspaceRootKey(entry.root) !== rootKey) continue;
      aliases.add(entry.root);
      buckets.add(id);
    }
    for (const entry of index.values()) {
      if (workspaceRootKey(entry.workDir) === rootKey) aliases.add(entry.workDir);
    }
    for (const dir of aliases) {
      buckets.add(encodeWorkDirKey(normalizeWorkDir(dir)));
    }
    return { aliases: [...aliases].toSorted(), buckets: [...buckets] };
  }

  /**
   * Active-session count across ALL alias buckets for the workspace's root,
   * not just the id's own bucket: GET /sessions?workspace_id=<id> pages the
   * union of alias buckets, so the count aggregates the same set the list can
   * actually retrieve.
   */
  private async countAliasSessions(workspaceId: string): Promise<number> {
    const layout = await this.aliasLayout(workspaceId);
    if (layout === undefined) {
      return countActiveSessions(join(this.sessionsDir, workspaceId));
    }
    let count = 0;
    for (const bucket of layout.buckets) {
      count += await countActiveSessions(join(this.sessionsDir, bucket));
    }
    return count;
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
    const session_count = sessionCount ?? (await this.countAliasSessions(workspaceId));
    return {
      id: workspaceId,
      root: entry.root,
      name: entry.name,
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
    return readWorkspaceRegistryFile(this.homeDir, (context, message) =>
      this.logger.warn(context, message),
    );
  }

  private async writeRegistry(file: WorkspaceRegistryFile): Promise<void> {
    await writeWorkspaceRegistryFile(this.homeDir, file);
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
