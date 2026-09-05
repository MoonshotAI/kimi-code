import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IEventService } from '#/app/event/event';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { WorkspaceService } from '#/app/workspace/workspaceService';
import { FileWorkspacePersistence } from '#/app/workspace/fileWorkspacePersistence';
import {
  IWorkspacePersistence,
  type PersistedWorkspaceEntry,
  type WorkspaceCatalog,
} from '#/app/workspace/workspacePersistence';
import { IWorkspaceAliases } from '#/app/workspaceAliases/workspaceAliases';
import { WorkspaceAliasesService } from '#/app/workspaceAliases/workspaceAliasesService';

interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

describe('WorkspaceAliasesService (file-backed)', () => {
  let homeDir: string;
  let currentHost: ReturnType<typeof createScopedTestHost> | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IWorkspacePersistence,
      FileWorkspacePersistence,
      ScopeActivation.OnDemand,
      'workspace',
    );
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceService,
      WorkspaceService,
      ScopeActivation.OnDemand,
      'workspace',
    );
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceAliases,
      WorkspaceAliasesService,
      ScopeActivation.OnDemand,
      'workspaceAliases',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-aliases-'));
  });

  afterEach(async () => {
    currentHost?.dispose();
    currentHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  class CountingStorage extends FileStorageService {
    reads = 0;
    override async read(scope: string, key: string): Promise<Uint8Array | undefined> {
      this.reads += 1;
      return super.read(scope, key);
    }
  }

  function build(
    hostFs: IHostFileSystem = new HostFileSystem(),
    fileStorage: FileStorageService = new FileStorageService(homeDir),
    persistence?: IWorkspacePersistence,
  ): IWorkspaceAliases {
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      ...(persistence !== undefined ? [stubPair(IWorkspacePersistence, persistence)] : []),
      stubPair(IHostFileSystem, hostFs),
      stubPair(IEventService, {
        publish: () => {},
        subscribe: () => ({ dispose: () => {} }),
      } as unknown as IEventService),
    ]);
    currentHost = host;
    return host.app.accessor.get(IWorkspaceAliases);
  }

  async function seedSessionIndex(entries: SessionIndexLine[]): Promise<void> {
    const text = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
    await fsp.writeFile(join(homeDir, 'session_index.jsonl'), text, 'utf8');
  }

  async function writeWorkspacesJson(
    workspaces: Record<string, PersistedWorkspaceEntry>,
    extra?: { readonly deleted_workspace_ids?: unknown },
  ): Promise<void> {
    await fsp.writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({ version: 1, workspaces, ...extra }),
      'utf8',
    );
  }

  it('resolveAliasIds returns every registered id for one physical directory', async () => {
    const lowerRoot = 'c:\\users\\foo\\proj';
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const legacyId = 'wd_proj_deadbeef0002';
    const canonicalId = encodeWorkDirKey(lowerRoot);
    const entry = (root: string): PersistedWorkspaceEntry => ({
      root,
      name: 'proj',
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    });
    await writeWorkspacesJson({
      [legacyId]: entry(typedRoot),
      [canonicalId]: entry(lowerRoot),
    });

    const aliases = build();
    for (const id of [legacyId, canonicalId]) {
      expect((await aliases.resolveAliasIds(id)).toSorted()).toEqual(
        [legacyId, canonicalId].toSorted(),
      );
    }
  });

  it('resolveAliasIds folds in session-index-only spellings of the same root', async () => {
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const typedId = encodeWorkDirKey(typedRoot);
    const indexOnlyId = encodeWorkDirKey('c:\\Users\\Foo\\Proj');
    await writeWorkspacesJson({
      [typedId]: {
        root: typedRoot,
        name: 'proj',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedSessionIndex([
      { sessionId: 's1', sessionDir: 'sessions/a/s1', workDir: typedRoot },
      { sessionId: 's2', sessionDir: 'sessions/b/s2', workDir: 'c:\\Users\\Foo\\Proj' },
      { sessionId: 's3', sessionDir: 'sessions/c/s3', workDir: join(homeDir, 'unrelated') },
    ]);
    await fsp.appendFile(join(homeDir, 'session_index.jsonl'), 'not-json\n{}\n', 'utf8');

    const aliases = build();
    expect((await aliases.resolveAliasIds(typedId)).toSorted()).toEqual(
      [typedId, indexOnlyId].toSorted(),
    );
  });

  it('resolveAliasIds keeps unknown ids and POSIX roots singleton', async () => {
    const root = join(homeDir, 'posix');
    const id = encodeWorkDirKey(root);
    await writeWorkspacesJson({
      [id]: {
        root,
        name: 'posix',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const aliases = build();
    expect(await aliases.resolveAliasIds('wd_missing_000000000000')).toEqual([
      'wd_missing_000000000000',
    ]);
    expect(await aliases.resolveAliasIds(id)).toEqual([id]);
  });

  it('resolveAliasIds reuses the loaded catalog and session index across calls', async () => {
    const root = join(homeDir, 'proj');
    const id = encodeWorkDirKey(root);
    await writeWorkspacesJson({
      [id]: {
        root,
        name: 'proj',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedSessionIndex([{ sessionId: 's1', sessionDir: 'sessions/a/s1', workDir: root }]);
    const storage = new CountingStorage(homeDir);
    const aliases = build(undefined, storage);

    await aliases.resolveAliasIds(id);
    const readsAfterWarm = storage.reads;
    await aliases.resolveAliasIds(id);
    await aliases.resolveAliasIds('wd_missing_000000000000');
    expect(storage.reads).toBe(readsAfterWarm);
  });

  it('resolveAliasIds coalesces concurrent cold loads', async () => {
    const root = join(homeDir, 'proj');
    const id = encodeWorkDirKey(root);
    await writeWorkspacesJson({
      [id]: {
        root,
        name: 'proj',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedSessionIndex([{ sessionId: 's1', sessionDir: 'sessions/a/s1', workDir: root }]);
    const storage = new CountingStorage(homeDir);
    const aliases = build(undefined, storage);

    await Promise.all([
      aliases.resolveAliasIds(id),
      aliases.resolveAliasIds(id),
      aliases.resolveAliasIds('wd_missing_000000000000'),
      aliases.resolveAliasIds(encodeWorkDirKey(join(homeDir, 'nowhere'))),
    ]);
    expect(storage.reads).toBeLessThanOrEqual(6);
  });

  it('resolveAliasIds follows in-process catalog writes synchronously', async () => {
    const entry = (root: string): PersistedWorkspaceEntry => ({
      root,
      name: 'proj',
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    });
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const typedId = encodeWorkDirKey(typedRoot);
    const legacyId = 'wd_proj_deadbeef0002';
    await writeWorkspacesJson({ [typedId]: entry(typedRoot) });
    const aliases = build();
    expect(await aliases.resolveAliasIds(typedId)).toEqual([typedId]);

    const persistence = currentHost!.app.accessor.get(IWorkspacePersistence);
    await persistence.save({
      workspaces: [
        { id: typedId, root: typedRoot, name: 'proj', createdAt: 0, lastOpenedAt: 0 },
        { id: legacyId, root: 'c:\\users\\foo\\proj', name: 'proj', createdAt: 0, lastOpenedAt: 0 },
      ],
      deletedIds: [],
    });
    expect((await aliases.resolveAliasIds(typedId)).toSorted()).toEqual(
      [legacyId, typedId].toSorted(),
    );
  });

  it('resolveAliasIds retries a shared load that spanned a write', async () => {
    class GatedPersistence implements IWorkspacePersistence {
      declare readonly _serviceBrand: undefined;
      loads = 0;
      gate: Promise<void> | undefined;
      constructor(private readonly inner: IWorkspacePersistence) {}
      get onDidChange(): IWorkspacePersistence['onDidChange'] {
        return this.inner.onDidChange;
      }
      async load(): ReturnType<IWorkspacePersistence['load']> {
        this.loads += 1;
        const catalog = await this.inner.load();
        if (this.gate !== undefined) await this.gate;
        return catalog;
      }
      save(catalog: WorkspaceCatalog): Promise<void> {
        return this.inner.save(catalog);
      }
    }
    const entry = (root: string): PersistedWorkspaceEntry => ({
      root,
      name: 'proj',
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    });
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const typedId = encodeWorkDirKey(typedRoot);
    const legacyId = 'wd_proj_deadbeef0002';
    await writeWorkspacesJson({ [typedId]: entry(typedRoot) });
    const storage = new FileStorageService(homeDir);
    const persistence = new GatedPersistence(
      new FileWorkspacePersistence(new JsonAtomicDocumentStore(storage)),
    );
    const aliases = build(undefined, storage, persistence);
    const ws = (id: string, root: string): Workspace => ({
      id,
      root,
      name: 'proj',
      createdAt: 0,
      lastOpenedAt: 0,
    });

    await aliases.resolveAliasIds(typedId);
    await persistence.save({ workspaces: [ws(typedId, typedRoot)], deletedIds: [] });

    let release: (() => void) | undefined;
    persistence.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const baseline = persistence.loads;
    const p1 = aliases.resolveAliasIds(typedId);
    await vi.waitFor(() => {
      expect(persistence.loads).toBe(baseline + 1);
    });
    await persistence.save({
      workspaces: [ws(typedId, typedRoot), ws(legacyId, 'c:\\users\\foo\\proj')],
      deletedIds: [],
    });
    const p2 = aliases.resolveAliasIds(legacyId);
    release!();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.toSorted()).toEqual([legacyId, typedId].toSorted());
    expect(r2.toSorted()).toEqual([legacyId, typedId].toSorted());
  });

  it('resolveAliasIds does not mix snapshots across a mid-resolution write', async () => {
    class GatedStorage extends FileStorageService {
      indexReads = 0;
      gate: Promise<void> | undefined;
      override async read(scope: string, key: string): Promise<Uint8Array | undefined> {
        if (key === 'session_index.jsonl') {
          this.indexReads += 1;
          if (this.gate !== undefined) await this.gate;
        }
        return super.read(scope, key);
      }
    }
    const entry = (root: string): PersistedWorkspaceEntry => ({
      root,
      name: 'proj',
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    });
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const typedId = encodeWorkDirKey(typedRoot);
    const legacyId = 'wd_proj_deadbeef0002';
    await writeWorkspacesJson({ [typedId]: entry(typedRoot) });
    const storage = new GatedStorage(homeDir);
    const aliases = build(undefined, storage);
    const persistence = currentHost!.app.accessor.get(IWorkspacePersistence);
    const appendLogs = currentHost!.app.accessor.get(IAppendLogStore);
    const ws = (id: string, root: string): Workspace => ({
      id,
      root,
      name: 'proj',
      createdAt: 0,
      lastOpenedAt: 0,
    });

    await aliases.resolveAliasIds(typedId);
    appendLogs.append('', 'session_index.jsonl', {
      sessionId: 's9',
      sessionDir: 'sessions/s/s9',
      workDir: join(homeDir, 'unrelated'),
    });
    await appendLogs.flush();

    let release: (() => void) | undefined;
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const baseline = storage.indexReads;
    const p = aliases.resolveAliasIds(typedId);
    await vi.waitFor(() => {
      expect(storage.indexReads).toBe(baseline + 1);
    });
    await persistence.save({
      workspaces: [ws(typedId, typedRoot), ws(legacyId, 'c:\\users\\foo\\proj')],
      deletedIds: [],
    });
    release!();

    expect((await p).toSorted()).toEqual([legacyId, typedId].toSorted());
  });

  it('resolveAliasIds follows in-process session-index writes synchronously', async () => {
    const entry = (root: string): PersistedWorkspaceEntry => ({
      root,
      name: 'proj',
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    });
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const typedId = encodeWorkDirKey(typedRoot);
    await writeWorkspacesJson({ [typedId]: entry(typedRoot) });
    const aliases = build();
    expect(await aliases.resolveAliasIds(typedId)).toEqual([typedId]);

    const appendLogs = currentHost!.app.accessor.get(IAppendLogStore);
    appendLogs.append('', 'session_index.jsonl', {
      sessionId: 's9',
      sessionDir: 'sessions/s/s9',
      workDir: 'c:\\Users\\Foo\\Proj',
    });
    await appendLogs.flush();
    const indexOnlyId = encodeWorkDirKey('c:\\Users\\Foo\\Proj');
    expect((await aliases.resolveAliasIds(typedId)).toSorted()).toEqual(
      [indexOnlyId, typedId].toSorted(),
    );
  });

  it('resolveAliasIds picks up catalog and session index changes', async () => {
    const entry = (root: string): PersistedWorkspaceEntry => ({
      root,
      name: 'proj',
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    });
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const typedId = encodeWorkDirKey(typedRoot);
    const legacyId = 'wd_proj_deadbeef0002';
    await writeWorkspacesJson({ [typedId]: entry(typedRoot) });
    const aliases = build();
    expect(await aliases.resolveAliasIds(typedId)).toEqual([typedId]);

    await writeWorkspacesJson({
      [typedId]: entry(typedRoot),
      [legacyId]: entry('c:\\users\\foo\\proj'),
    });
    await vi.waitFor(
      async () => {
        expect((await aliases.resolveAliasIds(typedId)).toSorted()).toEqual(
          [legacyId, typedId].toSorted(),
        );
      },
      { timeout: 5000 },
    );

    const indexOnlyId = encodeWorkDirKey('c:\\Users\\Foo\\Proj');
    await seedSessionIndex([
      { sessionId: 's1', sessionDir: 'sessions/a/s1', workDir: 'c:\\Users\\Foo\\Proj' },
    ]);
    await vi.waitFor(
      async () => {
        expect((await aliases.resolveAliasIds(typedId)).toSorted()).toEqual(
          [indexOnlyId, legacyId, typedId].toSorted(),
        );
      },
      { timeout: 5000 },
    );
  });
});
