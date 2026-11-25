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
import { ILogService } from '#/_base/log/log';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IEventService } from '#/app/event/event';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IProjectService, type Project } from '#/app/project/project';
import { ProjectService } from '#/app/project/projectService';
import { FileProjectPersistence } from '#/app/project/fileProjectPersistence';
import {
  IProjectPersistence,
  type PersistedProjectEntry,
  type ProjectCatalog,
} from '#/app/project/projectPersistence';
import { IProjectAliases } from '#/app/projectAliases/projectAliases';
import { ProjectAliasesService } from '#/app/projectAliases/projectAliasesService';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubHostEnvironment } from '../../stubs';
import { stubConfigService } from '../config/stubs';
import { IProjectTrustStore, ProjectTrustStore } from '#/project/projectTrust/projectTrustStore';

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
      IProjectPersistence,
      FileProjectPersistence,
      ScopeActivation.OnDemand,
      'workspace',
    );
    registerScopedService(
      LifecycleScope.App,
      IProjectService,
      ProjectService,
      ScopeActivation.OnDemand,
      'workspace',
    );
    registerScopedService(
      LifecycleScope.App,
      IProjectAliases,
      ProjectAliasesService,
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
    persistence?: IProjectPersistence,
  ): IProjectAliases {
    const noopLog = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as ILogService;
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage, noopLog)),
      stubPair(ILogService, noopLog),
      ...(persistence !== undefined ? [stubPair(IProjectPersistence, persistence)] : []),
      stubPair(IHostFileSystem, hostFs),
      stubPair(
        IProjectLocalConfigService,
        new FileProjectLocalConfigService(stubBootstrap(homeDir), hostFs),
      ),
      stubPair(IEventService, {
        publish: () => {},
        subscribe: () => ({ dispose: () => {} }),
      } as unknown as IEventService),
      stubPair(IHostEnvironment, stubHostEnvironment(homeDir)),
      stubPair(ITelemetryService, noopTelemetryService),
      stubPair(
        IProjectTrustStore,
        new ProjectTrustStore(new JsonAtomicDocumentStore(fileStorage), noopTelemetryService, stubBootstrap(homeDir), stubConfigService()),
      ),
    ]);
    currentHost = host;
    return host.app.accessor.get(IProjectAliases);
  }

  async function seedSessionIndex(entries: SessionIndexLine[]): Promise<void> {
    const text = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
    await fsp.writeFile(join(homeDir, 'session_index.jsonl'), text, 'utf8');
  }

  async function writeWorkspacesJson(
    workspaces: Record<string, PersistedProjectEntry>,
    extra?: { readonly deleted_workspace_ids?: unknown },
  ): Promise<void> {
    await fsp.writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({ version: 1, workspaces, ...extra }),
      'utf8',
    );
  }

  async function writeProjectsJson(
    projects: Record<string, PersistedProjectEntry>,
    deletedIds: readonly string[] = [],
  ): Promise<void> {
    await fsp.writeFile(
      join(homeDir, 'projects.json'),
      JSON.stringify({ schema_version: 2, projects, deleted_project_ids: deletedIds }),
      'utf8',
    );
  }

  it('resolveAliasIds returns every registered id for one physical directory', async () => {
    const lowerRoot = 'c:\\users\\foo\\proj';
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const legacyId = 'wd_proj_deadbeef0002';
    const canonicalId = encodeWorkDirKey(lowerRoot);
    const entry = (root: string): PersistedProjectEntry => ({
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
        kind: 'implicit',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedSessionIndex([
      { sessionId: 's1', sessionDir: `sessions/${encodeWorkDirKey(typedRoot)}/s1`, workDir: typedRoot },
      { sessionId: 's2', sessionDir: `sessions/${encodeWorkDirKey('c:\\Users\\Foo\\Proj')}/s2`, workDir: 'c:\\Users\\Foo\\Proj' },
      { sessionId: 's3', sessionDir: `sessions/${encodeWorkDirKey(join(homeDir, 'unrelated'))}/s3`, workDir: join(homeDir, 'unrelated') },
    ]);
    await fsp.appendFile(join(homeDir, 'session_index.jsonl'), 'not-json\n{}\n', 'utf8');

    const aliases = build();
    expect((await aliases.resolveAliasIds(typedId)).toSorted()).toEqual(
      [typedId, indexOnlyId].toSorted(),
    );
  });

  it('resolveAliasIds ignores index lines of sessions grouped into another bucket', async () => {
    const mainRoot = 'C:\\Users\\Foo\\Proj';
    const mainId = encodeWorkDirKey(mainRoot);
    const worktreeRoot = 'c:\\users\\foo\\proj';
    await writeWorkspacesJson({
      [mainId]: {
        root: mainRoot,
        name: 'proj',
        kind: 'implicit',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedSessionIndex([
      { sessionId: 's1', sessionDir: `sessions/${mainId}/s1`, workDir: worktreeRoot },
      { sessionId: 's2', sessionDir: `sessions/${mainId}/s2`, workDir: 'C:\\Users\\Foo\\Proj-fix' },
    ]);

    const aliases = build();
    expect(await aliases.resolveAliasIds(mainId)).toEqual([mainId]);
    expect(await aliases.resolveAliasIds(encodeWorkDirKey('C:\\Users\\Foo\\Proj-fix'))).toEqual([
      encodeWorkDirKey('C:\\Users\\Foo\\Proj-fix'),
    ]);
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

  it('resolveAliasIds keeps wm_ entries out of hash alias sets and vice versa', async () => {
    const root = join(homeDir, 'proj');
    const hashId = encodeWorkDirKey(root);
    const projectId = 'wm_7f3a9c1e-1111-2222-3333-444455556666';
    await writeWorkspacesJson({
      [hashId]: {
        root,
        name: 'proj',
        kind: 'implicit',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
      [projectId]: {
        root,
        name: 'proj project',
        kind: 'managed',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const aliases = build();
    expect(await aliases.resolveAliasIds(hashId)).toEqual([hashId]);
    expect(await aliases.resolveAliasIds(projectId)).toEqual([projectId]);
  });

  it('resolveAliasIds reuses the loaded catalog and session index across calls', async () => {
    const root = join(homeDir, 'proj');
    const id = encodeWorkDirKey(root);
    await writeWorkspacesJson({
      [id]: {
        root,
        name: 'proj',
        kind: 'implicit',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedSessionIndex([{ sessionId: 's1', sessionDir: `sessions/${encodeWorkDirKey(root)}/s1`, workDir: root }]);
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
    await writeProjectsJson({
      [id]: {
        root,
        name: 'proj',
        kind: 'implicit',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedSessionIndex([{ sessionId: 's1', sessionDir: `sessions/${encodeWorkDirKey(root)}/s1`, workDir: root }]);
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
    const entry = (root: string): PersistedProjectEntry => ({
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

    const persistence = currentHost!.app.accessor.get(IProjectPersistence);
    await persistence.update(() => ({
      workspaces: [
        { id: typedId, root: typedRoot, name: 'proj', kind: 'implicit', additionalDirs: [], createdAt: 0, lastOpenedAt: 0 },
        { id: legacyId, root: 'c:\\users\\foo\\proj', name: 'proj', kind: 'implicit', additionalDirs: [], createdAt: 0, lastOpenedAt: 0 },
      ],
      deletedIds: [],
    }));
    expect((await aliases.resolveAliasIds(typedId)).toSorted()).toEqual(
      [legacyId, typedId].toSorted(),
    );
  });

  it('resolveAliasIds retries a shared load that spanned a write', async () => {
    class GatedPersistence implements IProjectPersistence {
      declare readonly _serviceBrand: undefined;
      loads = 0;
      gate: Promise<void> | undefined;
      constructor(private readonly inner: IProjectPersistence) {}
      get onDidChange(): IProjectPersistence['onDidChange'] {
        return this.inner.onDidChange;
      }
      async load(): ReturnType<IProjectPersistence['load']> {
        this.loads += 1;
        const catalog = await this.inner.load();
        if (this.gate !== undefined) await this.gate;
        return catalog;
      }
      update(
        mutator: (current: ProjectCatalog) => ProjectCatalog | Promise<ProjectCatalog>,
      ): Promise<void> {
        return this.inner.update(mutator);
      }
    }
    const entry = (root: string): PersistedProjectEntry => ({
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
      new FileProjectPersistence(new JsonAtomicDocumentStore(storage), storage, stubBootstrap(homeDir)),
    );
    const aliases = build(undefined, storage, persistence);
    const ws = (id: string, root: string): Project => ({
      id,
      root,
      name: 'proj',
      kind: 'implicit',
      additionalDirs: [],
      createdAt: 0,
      lastOpenedAt: 0,
    });

    await aliases.resolveAliasIds(typedId);
    await persistence.update(() => ({ workspaces: [ws(typedId, typedRoot)], deletedIds: [] }));

    let release: (() => void) | undefined;
    persistence.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const baseline = persistence.loads;
    const p1 = aliases.resolveAliasIds(typedId);
    await vi.waitFor(() => {
      expect(persistence.loads).toBe(baseline + 1);
    });
    await persistence.update(() => ({
      workspaces: [ws(typedId, typedRoot), ws(legacyId, 'c:\\users\\foo\\proj')],
      deletedIds: [],
    }));
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
    const entry = (root: string): PersistedProjectEntry => ({
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
    const persistence = currentHost!.app.accessor.get(IProjectPersistence);
    const appendLogs = currentHost!.app.accessor.get(IAppendLogStore);
    const ws = (id: string, root: string): Project => ({
      id,
      root,
      name: 'proj',
      kind: 'implicit',
      additionalDirs: [],
      createdAt: 0,
      lastOpenedAt: 0,
    });

    await aliases.resolveAliasIds(typedId);
    appendLogs.append('', 'session_index.jsonl', {
      sessionId: 's9',
      sessionDir: `sessions/${encodeWorkDirKey(join(homeDir, 'unrelated'))}/s9`,
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
    await persistence.update(() => ({
      workspaces: [ws(typedId, typedRoot), ws(legacyId, 'c:\\users\\foo\\proj')],
      deletedIds: [],
    }));
    release!();

    expect((await p).toSorted()).toEqual([legacyId, typedId].toSorted());
  });

  it('resolveAliasIds follows in-process session-index writes synchronously', async () => {
    const entry = (root: string): PersistedProjectEntry => ({
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
      sessionDir: `sessions/${encodeWorkDirKey('c:\\Users\\Foo\\Proj')}/s9`,
      workDir: 'c:\\Users\\Foo\\Proj',
    });
    await appendLogs.flush();
    const indexOnlyId = encodeWorkDirKey('c:\\Users\\Foo\\Proj');
    expect((await aliases.resolveAliasIds(typedId)).toSorted()).toEqual(
      [indexOnlyId, typedId].toSorted(),
    );
  });

  it('resolveAliasIds picks up catalog and session index changes', async () => {
    const entry = (root: string): PersistedProjectEntry => ({
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

    await writeProjectsJson({
      [typedId]: { ...entry(typedRoot), kind: 'implicit' },
      [legacyId]: { ...entry('c:\\users\\foo\\proj'), kind: 'implicit' },
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
      { sessionId: 's1', sessionDir: `sessions/${encodeWorkDirKey('c:\\Users\\Foo\\Proj')}/s1`, workDir: 'c:\\Users\\Foo\\Proj' },
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
