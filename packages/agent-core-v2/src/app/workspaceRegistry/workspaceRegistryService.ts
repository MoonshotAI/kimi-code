/**
 * `workspaceRegistry` domain (L1) — `IWorkspaceRegistry` implementation.
 *
 * Process-wide catalog of known workspaces, durable in
 * `<homeDir>/workspaces.json` (the v1-compatible file shared with
 * agent-core). The service keeps NO in-memory write cache: every operation
 * is a fresh read-modify-write against the file, serialized through a
 * promise-chain mutex. This is required, not just tidy — the same file is
 * written concurrently by other processes (the v1 TUI registers session cwds
 * via `touchWorkspaceRegistry`, which also re-reads the file on every call),
 * so a write-through cache would clobber external additions and tombstones
 * with stale state. Atomic renames at the persistence layer plus fresh
 * read-modify-write on both engines shrink the lost-update window to a
 * single read-modify-write, and the next session-index merge heals anything
 * still lost there.
 *
 * Once per process, the first operation triggers the startup sync with the
 * legacy `<homeDir>/session_index.jsonl`:
 *
 * 1. No usable catalog file → one-shot rebuild (one workspace per distinct
 *    absolute `workDir`), persisted.
 * 2. Catalog loaded → only workDirs the file does not know about yet are
 *    added (e.g. sessions created by the v1 TUI since the last sync),
 *    persisted if anything changed.
 *
 * Deletion is soft: `delete` drops the entry but records the id in
 * `deleted_workspace_ids`, and the merge never resurrects a tombstoned id.
 * An explicit `createOrTouch` clears the tombstone — the user opening the
 * folder again is a stronger signal than the historical index.
 *
 * `createOrTouch` is the single choke point every workspace/session creation
 * funnels through, so it owns the root-existence contract: the root must be
 * an existing directory on the host filesystem, otherwise it throws
 * `fs.path_not_found` (mirrors v1's `WorkspaceRootNotFoundError`). The
 * directory probe follows symlinks (`IHostFileSystem.stat` is lstat-based, so
 * a symlink-form root is re-checked through `realpath`), while the workspace
 * identity stays lexical — v1 deliberately never realpaths the root either.
 * The rebuild and merge paths bypass the check on purpose — they catalog
 * where sessions *were*, not where new ones may open. Bound at App scope.
 *
 * One physical folder can arrive under several spellings — most visibly on
 * Windows, where drive-letter casing, slash direction, and typed-vs-realpath
 * casing all differ for one directory. Every "same directory?" judgment
 * (`createOrTouch` reuse, the session-index rebuild, and the `list` merge in
 * `dedupeByRoot`) therefore goes through the `workspaceRootKey` identity key
 * rather than the raw root string, while the minted `workspaceId` stays the
 * case-sensitive `encodeWorkDirKey` so already-persisted session buckets,
 * `workspaces.json` entries, and session metadata keep resolving with zero
 * data migration.
 *
 * Legacy data may still be split: two registry entries (or a registry entry
 * plus session-index-only spellings) for one physical folder, with sessions
 * bucketed per id. `resolveAliasIds` is the read-only counterpart to the
 * write-path folding: it enumerates every id spelling that identifies one
 * directory (registered entries by `workspaceRootKey`, plus `workDir`
 * spellings recorded only in `session_index.jsonl`) so readers can query all
 * sibling buckets at once without rewriting any stored id.
 */

import { basename, isAbsolute } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { IWorkspaceRegistry, type Workspace, type WorkspaceUpdate } from './workspaceRegistry';
import { IWorkspacePersistence, type WorkspaceCatalog } from './workspacePersistence';

// Legacy v1 session index, read for the one-shot rebuild and for
// `resolveAliasIds` (session-index-only id spellings). Empty scope resolves to
// `<homeDir>/<key>` (join skips empty segments).
const SESSION_INDEX_SCOPE = '';
const SESSION_INDEX_KEY = 'session_index.jsonl';

const textDecoder = new TextDecoder();

interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export class WorkspaceRegistryService implements IWorkspaceRegistry {
  declare readonly _serviceBrand: undefined;

  /** Whether the once-per-process session-index sync already ran. */
  private merged = false;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {}

  list(): Promise<readonly Workspace[]> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      return dedupeByRoot(byId);
    });
  }

  get(id: string): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      return catalog.workspaces.find((ws) => ws.id === id);
    });
  }

  resolveAliasIds(id: string): Promise<readonly string[]> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const entry = catalog.workspaces.find((ws) => ws.id === id);
      // Unknown ids stay singletons so callers keep their not-found semantics.
      if (entry === undefined) return [id];
      return this.collectAliasIds(catalog, entry.root);
    });
  }

  /** Every id identifying `root`'s directory: all registered spellings plus
   *  `workDir` spellings recorded only in `session_index.jsonl` (legacy split
   *  buckets that were never registered). Callers must already hold the op
   *  mutex — this is the unfolded core of `resolveAliasIds`, shared with
   *  `delete`. */
  private async collectAliasIds(catalog: WorkspaceCatalog, root: string): Promise<string[]> {
    const rootKey = workspaceRootKey(root);
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (alias: string): void => {
      if (seen.has(alias)) return;
      seen.add(alias);
      ids.push(alias);
    };
    for (const ws of catalog.workspaces) {
      if (workspaceRootKey(ws.root) === rootKey) add(ws.id);
    }
    // Legacy split buckets may exist under spellings never registered: fold
    // in every session-index `workDir` that identifies the same directory.
    // Best-effort — a missing/corrupt index simply contributes nothing.
    for (const line of await this.readSessionIndexEntries()) {
      if (workspaceRootKey(line.workDir) === rootKey) add(encodeWorkDirKey(line.workDir));
    }
    return ids;
  }

  createOrTouch(root: string, name?: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      let stat;
      try {
        stat = await this.hostFs.stat(root);
      } catch (error) {
        const code = (unwrapErrorCause(error) as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} does not exist`);
        }
        throw error;
      }
      if (!stat.isDirectory) {
        try {
          stat = await this.hostFs.stat(await this.hostFs.realpath(root));
        } catch {
          // Fall through to the not-a-directory error below.
        }
      }
      if (!stat.isDirectory) {
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} is not a directory`);
      }
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      const deletedIds = new Set(catalog.deletedIds);
      const id = encodeWorkDirKey(root);
      let existing = byId.get(id);
      if (existing === undefined) {
        // Fold identity-equivalent spellings (`workspaceRootKey`: Windows
        // drive-letter/realpath casing, slash direction) onto the registered
        // entry instead of minting a second id for the same folder. The first
        // matching entry wins wholesale — its id, root, and name are kept;
        // only `lastOpenedAt` advances.
        const rootKey = workspaceRootKey(root);
        for (const entry of byId.values()) {
          if (workspaceRootKey(entry.root) === rootKey) {
            existing = entry;
            break;
          }
        }
      }
      const now = Date.now();
      const ws: Workspace =
        existing !== undefined
          ? { ...existing, lastOpenedAt: now }
          : {
              id,
              root,
              name: name ?? basename(root),
              createdAt: now,
              lastOpenedAt: now,
            };
      byId.set(ws.id, ws);
      // An explicit add clears any prior deletion tombstone.
      deletedIds.delete(ws.id);
      await this.store.save({ workspaces: [...byId.values()], deletedIds: [...deletedIds] });
      return ws;
    });
  }

  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const existing = catalog.workspaces.find((ws) => ws.id === id);
      if (existing === undefined) return undefined;
      const updated: Workspace = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      };
      await this.store.save({
        workspaces: catalog.workspaces.map((ws) => (ws.id === id ? updated : ws)),
        deletedIds: catalog.deletedIds,
      });
      return updated;
    });
  }

  delete(id: string): Promise<void> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      // Soft delete: tombstone the id so the session-index merge cannot
      // resurrect it, even if sessions still reference the workDir. Folded
      // aliases must die with it — a sibling spelling left registered (or
      // resurrectable from the session index) would resurface as this
      // directory's representative on the next list().
      let root = catalog.workspaces.find((ws) => ws.id === id)?.root;
      if (root === undefined) {
        // Derived/unknown id: recover its spelling from the session index so
        // the whole alias set can still be tombstoned.
        root = (await this.readSessionIndexEntries()).find(
          (line) => encodeWorkDirKey(line.workDir) === id,
        )?.workDir;
      }
      if (root === undefined) {
        await this.store.save({
          workspaces: catalog.workspaces.filter((ws) => ws.id !== id),
          deletedIds: [...new Set([...catalog.deletedIds, id])],
        });
        return;
      }
      const rootKey = workspaceRootKey(root);
      const aliasIds = await this.collectAliasIds(catalog, root);
      await this.store.save({
        workspaces: catalog.workspaces.filter((ws) => workspaceRootKey(ws.root) !== rootKey),
        deletedIds: [...new Set([...catalog.deletedIds, ...aliasIds])],
      });
    });
  }

  /** Once-per-process startup sync with the legacy session index (see the
   *  file header). Runs inside the op mutex, so it cannot interleave with a
   *  mutation's read-modify-write. */
  private async ensureMerged(): Promise<void> {
    if (this.merged) return;
    const loaded = await this.store.load();
    if (loaded === undefined) {
      const rebuilt = await this.rebuildFromSessionIndex();
      await this.store.save({ workspaces: [...rebuilt.values()], deletedIds: [] });
      this.merged = true;
      return;
    }
    const byId = new Map(loaded.workspaces.map((ws) => [ws.id, ws]));
    const deletedIds = new Set(loaded.deletedIds);
    if (await this.mergeFromSessionIndex(byId, deletedIds)) {
      await this.store.save({ workspaces: [...byId.values()], deletedIds: [...deletedIds] });
    }
    this.merged = true;
  }

  /** Read the current catalog; a missing or malformed file is an empty
   *  catalog (mirrors v1's tolerant read). */
  private async loadCatalog(): Promise<WorkspaceCatalog> {
    return (await this.store.load()) ?? { workspaces: [], deletedIds: [] };
  }

  /** Add every distinct workDir from the legacy session index that the
   *  catalog does not know about yet. Tombstoned ids are skipped, so a
   *  soft-deleted workspace stays deleted. Returns whether anything changed. */
  private async mergeFromSessionIndex(
    byId: Map<string, Workspace>,
    deletedIds: ReadonlySet<string>,
  ): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    for (const workDir of await this.readSessionIndexWorkDirs()) {
      const id = encodeWorkDirKey(workDir);
      if (byId.has(id) || deletedIds.has(id)) continue;
      byId.set(id, {
        id,
        root: workDir,
        name: basename(workDir),
        createdAt: now,
        lastOpenedAt: now,
      });
      changed = true;
    }
    return changed;
  }

  private async rebuildFromSessionIndex(): Promise<Map<string, Workspace>> {
    const result = new Map<string, Workspace>();
    const now = Date.now();
    // Dedupe by identity key, not by minted id: casing/slash variants of one
    // directory (Windows) collapse here too. First seen wins — the id stays
    // `encodeWorkDirKey` of that first-seen workDir string.
    const seenRootKeys = new Set<string>();
    for (const entry of await this.readSessionIndexEntries()) {
      if (!isAbsolute(entry.workDir)) continue;
      const rootKey = workspaceRootKey(entry.workDir);
      if (seenRootKeys.has(rootKey)) continue;
      seenRootKeys.add(rootKey);
      const id = encodeWorkDirKey(entry.workDir);
      result.set(id, {
        id,
        root: entry.workDir,
        name: basename(entry.workDir),
        createdAt: now,
        lastOpenedAt: now,
      });
    }
    return result;
  }

  private async readSessionIndexWorkDirs(): Promise<readonly string[]> {
    const bytes = await this.storage.read(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
    if (bytes === undefined) return [];
    const workDirs: string[] = [];
    for (const line of textDecoder.decode(bytes).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const entry = parseSessionIndexLine(trimmed);
      if (entry === undefined) continue;
      if (!isAbsolute(entry.workDir)) continue;
      workDirs.push(entry.workDir);
    }
    return workDirs;
  }

  /**
   * Parse the legacy v1 session index. Blank and malformed lines are skipped
   * individually so one bad record never fails the whole file (matches the
   * rebuild's tolerance).
   */
  private async readSessionIndexEntries(): Promise<SessionIndexLine[]> {
    const bytes = await this.storage.read(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
    if (bytes === undefined) return [];
    const entries: SessionIndexLine[] = [];
    for (const line of textDecoder.decode(bytes).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const entry = parseSessionIndexLine(trimmed);
      if (entry === undefined) continue;
      entries.push(entry);
    }
    return entries;
  }

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(op, op);
    this.opQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

function parseSessionIndexLine(line: string): SessionIndexLine | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<SessionIndexLine>;
    if (
      typeof entry.sessionId !== 'string' ||
      typeof entry.sessionDir !== 'string' ||
      typeof entry.workDir !== 'string'
    ) {
      return undefined;
    }
    return {
      sessionId: entry.sessionId,
      sessionDir: entry.sessionDir,
      workDir: entry.workDir,
    };
  } catch {
    return undefined;
  }
}

/**
 * Collapse registered workspaces that identify the same directory. The
 * persisted catalog (v1-compatible `workspaces.json`) can hold legacy entries
 * whose id was computed by an older `encodeWorkDirKey` (e.g. realpath-based on
 * Windows) for the same folder, and Windows roots additionally differ by
 * casing or slash spelling, so one directory may map to multiple ids. Entries
 * merge on the `workspaceRootKey` identity key; prefer the entry whose id
 * matches the canonical key computed on its own root string so current
 * sessions' `workspace_id` still resolves and the same folder is not listed
 * twice.
 */
function dedupeByRoot(byId: ReadonlyMap<string, Workspace>): Workspace[] {
  const byRoot = new Map<string, Workspace>();
  for (const ws of byId.values()) {
    const rootKey = workspaceRootKey(ws.root);
    const existing = byRoot.get(rootKey);
    if (existing === undefined) {
      byRoot.set(rootKey, ws);
      continue;
    }
    const canonicalId = encodeWorkDirKey(ws.root);
    if (existing.id !== canonicalId && ws.id === canonicalId) {
      byRoot.set(rootKey, ws);
    }
  }
  return [...byRoot.values()];
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceRegistry,
  WorkspaceRegistryService,
  InstantiationType.Eager,
  'workspaceRegistry',
);
