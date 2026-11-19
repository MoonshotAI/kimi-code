import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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
import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { ErrorCodes, Error2 } from '#/errors';
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
import type { Event2 } from '#/app/event/event2';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { WorkspaceService } from '#/app/workspace/workspaceService';
import { FileWorkspacePersistence } from '#/app/workspace/fileWorkspacePersistence';
import {
  IWorkspacePersistence,
  type PersistedProjectsFile,
  type PersistedWorkspaceEntry,
} from '#/app/workspace/workspacePersistence';
import { stubBootstrap } from '../bootstrap/stubs';

interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

describe('WorkspaceService (file-backed)', () => {
  let homeDir: string;
  let currentHost: ReturnType<typeof createScopedTestHost> | undefined;
  let published: Array<{ type: string; payload: unknown }>;
  let appendLogs: AppendLogStore;

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
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-registry-'));
    published = [];
  });

  afterEach(async () => {
    currentHost?.dispose();
    currentHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  const noopLog = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  } as unknown as ILogService;

  function build(
    hostFs: IHostFileSystem = new HostFileSystem(),
    storage?: IFileSystemStorageService,
  ): IWorkspaceService {
    const fileStorage = storage ?? new FileStorageService(homeDir);
    appendLogs = new AppendLogStore(fileStorage, noopLog);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IAppendLogStore, appendLogs),
      stubPair(ILogService, noopLog),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(IHostFileSystem, hostFs),
      stubPair(
        IProjectLocalConfigService,
        new FileProjectLocalConfigService(stubBootstrap(homeDir), hostFs),
      ),
      stubPair(IEventService, {
        publish: (event: Event2<any>) => {
          published.push({
            type: event.type,
            payload: (event as { readonly payload?: unknown }).payload,
          });
        },
        subscribe: () => ({ dispose: () => {} }),
      } as unknown as IEventService),
    ]);
    currentHost = host;
    return host.app.accessor.get(IWorkspaceService);
  }

  function restart(hostFs?: IHostFileSystem, storage?: IFileSystemStorageService): IWorkspaceService {
    currentHost?.dispose();
    currentHost = undefined;
    return build(hostFs, storage);
  }

  function allDirsHostFs(): IHostFileSystem {
    return {
      stat: () => Promise.resolve({ isFile: false, isDirectory: true, size: 0 }),
    } as unknown as IHostFileSystem;
  }

  function originalSession(sessionId: string, workDir: string): SessionIndexLine {
    return { sessionId, sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(workDir), sessionId), workDir };
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

  async function writeProjectsJson(
    projects: Record<string, PersistedWorkspaceEntry>,
    deletedIds: readonly string[] = [],
  ): Promise<void> {
    await fsp.writeFile(
      join(homeDir, 'projects.json'),
      JSON.stringify({ schema_version: 2, projects, deleted_project_ids: deletedIds }),
      'utf8',
    );
  }

  async function readRegistry(): Promise<{
    workspaces: Record<string, PersistedWorkspaceEntry>;
    deleted_workspace_ids?: unknown;
  }> {
    const file = JSON.parse(await fsp.readFile(join(homeDir, 'projects.json'), 'utf8')) as {
      projects: Record<string, PersistedWorkspaceEntry>;
      deleted_project_ids?: unknown;
    };
    return { workspaces: file.projects, deleted_workspace_ids: file.deleted_project_ids };
  }

  it('persists the catalog across registry instances', async () => {
    const created = await build().createOrTouch(homeDir, 'proj');

    const list = await restart().list();
    expect(list.map((w) => w.id)).toContain(created.id);
    expect(list.find((w) => w.id === created.id)?.name).toBe('proj');
  });

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  async function worktrees() {
    const main = join(await fsp.realpath(homeDir), 'main repo');
    const linked = join(homeDir, 'linked tree');
    const child = join(linked, 'src');
    await fsp.mkdir(main);
    git(main, 'init');
    git(main, 'commit', '--allow-empty', '-m', 'initial');
    git(main, 'worktree', 'add', '--detach', linked);
    await fsp.mkdir(child);
    return { main, linked, child };
  }

  it('registers one repository when independent clients open its checkouts concurrently', async () => {
    const { main, linked, child } = await worktrees();
    const first = build();
    const firstHost = currentHost!;
    const second = build();
    try {
      const [linkedProject, mainProject] = await Promise.all([first.createOrTouch(child), second.createOrTouch(main)]);
      const id = encodeWorkDirKey(main);
      expect([linkedProject.id, mainProject.id]).toEqual([id, id]);
      expect(linkedProject.root).toBe(main);
      expect(linkedProject).toMatchObject({ vcs: { type: 'git', store: join(main, '.git') } });
      await Promise.all([first.update(id, { name: 'renamed', additionalDirs: [linked] }), second.createOrTouch(linked)]);
      expect(await second.list()).toMatchObject([{ id, root: main, name: 'renamed', additionalDirs: [linked] }]);
    } finally {
      firstHost.dispose();
    }
  });

  it('keeps the exact legacy worktree while a new child and a separate clone get their own owners', async () => {
    const { main, linked, child } = await worktrees();
    const linkId = encodeWorkDirKey(linked);
    await writeProjectsJson({
      [linkId]: { root: linked, name: 'historic', kind: 'implicit', created_at: '', last_opened_at: '' },
    });
    const registry = build();
    expect(await registry.createOrTouch(linked)).toMatchObject({ id: linkId, name: 'historic' });
    expect(await registry.createOrTouch(child)).toMatchObject({ id: encodeWorkDirKey(main), root: main });
    const clone = join(await fsp.realpath(homeDir), 'clone');
    git(main, 'clone', '--local', main, clone);
    expect(await registry.createOrTouch(clone)).toMatchObject({ id: encodeWorkDirKey(clone), root: clone });
    expect((await registry.list()).map((entry) => entry.id).toSorted()).toEqual(
      [linkId, encodeWorkDirKey(main), encodeWorkDirKey(clone)].toSorted(),
    );
  });

  it('opens the exact legacy project before probing Git for an unregistered directory', async () => {
    const { linked, child } = await worktrees();
    const id = encodeWorkDirKey(linked);
    await writeProjectsJson({
      [id]: { root: linked, name: 'historic', kind: 'implicit', created_at: '', last_opened_at: '' },
    });
    await fsp.writeFile(join(linked, '.git'), 'gitdir: missing-checkout\n');
    const registry = build();
    await expect(registry.createOrTouch(linked)).resolves.toMatchObject({ id, name: 'historic' });
    await expect(registry.implicitDirectories(linked)).resolves.toEqual([linked]);
    await expect(registry.createOrTouch(child)).rejects.toMatchObject({ code: ErrorCodes.FS_GIT_UNAVAILABLE });
    expect(await registry.list()).toHaveLength(1);
  });

  it('does not claim a repository for an implicit id whose mutable primary was promoted into it', async () => {
    const { main, linked } = await worktrees();
    const original = join(homeDir, 'original');
    await fsp.mkdir(original);
    const id = encodeWorkDirKey(original);
    await writeProjectsJson({
      [id]: { root: main, name: 'promoted', kind: 'implicit', created_at: '', last_opened_at: '' },
    });
    const registry = build();
    expect((await registry.createOrTouch(original)).id).toBe(id);
    expect((await registry.createOrTouch(linked)).id).toBe(encodeWorkDirKey(main));
    expect((await registry.createOrTouch(main)).id).toBe(encodeWorkDirKey(main));
    expect((await registry.list()).map((entry) => entry.id).toSorted()).toEqual([id, encodeWorkDirKey(main)].toSorted());
    await registry.delete(id);
    expect((await registry.list()).map((entry) => entry.id)).toEqual([encodeWorkDirKey(main)]);
  });

  it('recovers the owning bucket from old and mixed-version logs without cataloguing the worktree cwd', async () => {
    const { main, child } = await worktrees();
    const id = encodeWorkDirKey(main);
    const sessionDir = join(homeDir, 'sessions', id, 's');
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.writeFile(join(homeDir, 'session_index.jsonl'), [
      JSON.stringify({ sessionId: 's', sessionDir, cwd: child }),
      JSON.stringify({ sessionId: 't', sessionDir: join(homeDir, 'sessions', id, 't'), workDir: child }),
    ].join('\n'));
    const registry = build();
    expect(await registry.list()).toMatchObject([{ id, root: main }]);
    const saved = await registry.createOrTouch(child);
    expect(saved.id).toBe(id);
    await registry.delete(id);
    expect(await restart().list()).toEqual([]);
    expect((await readRegistry()).deleted_workspace_ids).toEqual([id]);
  });

  it('recovers a project from physical session state when both the catalog and location log are gone', async () => {
    const { main, linked, child } = await worktrees();
    const id = encodeWorkDirKey(main);
    const state = join(homeDir, 'sessions', id, 'source', 'session-meta');
    const unrelated = join(homeDir, 'sessions', encodeWorkDirKey(linked), 'other');
    const remote = join(homeDir, 'sessions', encodeWorkDirKey(child), 'remote');
    for (const dir of [state, unrelated, remote]) await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(state, 'state.json'), JSON.stringify({ cwd: '/unused-host-anchor', environmentId: 'local', environmentCwd: child }));
    await fsp.writeFile(join(unrelated, 'state.json'), JSON.stringify({ cwd: child }));
    await fsp.writeFile(join(remote, 'state.json'), JSON.stringify({ cwd: '/host', environmentId: 'ssh', environmentCwd: child }));
    expect(await build().list()).toMatchObject([{ id, root: main }]);
    expect((await readRegistry()).workspaces).toHaveProperty(id);
  });

  it('resolves trust directories without opening or creating a project', async () => {
    const { main, linked, child } = await worktrees();
    const registry = build();
    expect(await registry.implicitDirectories(child)).toEqual([main]);
    expect(await registry.list()).toEqual([]);
    const project = await registry.createOrTouch(child);
    await registry.update(project.id, { additionalDirs: [linked] });
    const before = await fsp.readFile(join(homeDir, 'projects.json'), 'utf8');
    expect(await registry.implicitDirectories(linked)).toEqual([main, linked]);
    expect(await fsp.readFile(join(homeDir, 'projects.json'), 'utf8')).toBe(before);
  });

  it('requires the main separate-git-dir checkout once and reuses a verifiable old main project', async () => {
    const base = await fsp.realpath(homeDir);
    const main = join(base, 'primary');
    const store = join(base, 'metadata');
    const tree = join(base, 'linked');
    git(base, 'init', '--separate-git-dir', store, main);
    git(main, 'commit', '--allow-empty', '-m', 'initial');
    git(main, 'worktree', 'add', '--detach', tree);
    const registry = build();
    await expect(registry.createOrTouch(tree)).rejects.toThrow(/open the main checkout/i);
    expect(await registry.list()).toEqual([]);
    const id = encodeWorkDirKey(main);
    await writeProjectsJson({
      [id]: { root: main, name: 'original', kind: 'implicit', created_at: '', last_opened_at: '' },
    });
    expect(await registry.createOrTouch(tree)).toMatchObject({ id, root: main, name: 'original', vcs: { store } });
    expect((await restart().createOrTouch(main)).id).toBe(id);
  });

  it('reports two live main checkouts initialized against one separate Git store', async () => {
    const base = await fsp.realpath(homeDir);
    const original = join(base, 'original');
    const second = join(base, 'second');
    const store = join(base, 'metadata');
    git(base, 'init', '--separate-git-dir', store, original);
    const registry = build();
    const project = await registry.createOrTouch(original);
    git(base, 'init', '--separate-git-dir', store, second);
    await expect(registry.createOrTouch(second)).rejects.toThrow(/main checkout/);
    expect(await registry.list()).toMatchObject([{ id: project.id, root: original }]);
    expect((await registry.createOrTouch(original)).id).toBe(project.id);
  });

  it('reuses a legacy main checkout entered through a symbolic link', async () => {
    const { main, child } = await worktrees();
    const oldPath = join(homeDir, 'checkout');
    await fsp.symlink(main, oldPath, 'dir');
    const id = encodeWorkDirKey(oldPath);
    await writeProjectsJson({
      [id]: { root: oldPath, name: 'old alias', kind: 'implicit', created_at: '', last_opened_at: '' },
    });
    const registry = build();
    const grouped = await registry.createOrTouch(child);
    expect(grouped).toMatchObject({ id, root: oldPath, vcs: { type: 'git', store: join(main, '.git') } });
    expect((await registry.createOrTouch(oldPath)).id).toBe(id);
  });

  it('preserves unknown fields in the project and its repository binding after touch and rename', async () => {
    const { main, child } = await worktrees();
    const id = encodeWorkDirKey(main);
    const store = join(main, '.git');
    const entry = {
      root: main, name: 'original', kind: 'implicit', created_at: '', last_opened_at: '',
      vcs: { type: 'git' as const, store, provider_version: 4 }, icon: 'changes',
    };
    await writeProjectsJson({ [id]: entry });
    const registry = build();
    await registry.createOrTouch(child);
    await registry.update(id, { name: 'renamed' });
    expect((await readRegistry()).workspaces[id]).toMatchObject({
      name: 'renamed', icon: 'changes', vcs: { type: 'git', store, provider_version: 4 },
    });
  });

  it('rejects invalid or duplicate repository bindings and leaves the file untouched', async () => {
    const { main, linked } = await worktrees();
    const first = { root: main, name: 'one', kind: 'implicit', created_at: '', last_opened_at: '',
      vcs: { type: 'git' as const, store: join(main, '.git') } };
    const file = join(homeDir, 'projects.json');
    for (const extra of [
      { ...first, kind: 'managed' },
      { ...first, vcs: { type: 'git', store: 'relative' } },
      { ...first, vcs: { type: 'other', store: '/store' } },
      { ...first, root: linked },
    ]) {
      const bytes = JSON.stringify({ schema_version: 2, projects: { [encodeWorkDirKey(main)]: first, [encodeWorkDirKey(linked)]: extra }, deleted_project_ids: [] });
      await fsp.writeFile(file, bytes);
      await expect(restart().createOrTouch(linked)).rejects.toMatchObject({ code: 'storage.corrupted' });
      expect(await fsp.readFile(file, 'utf8')).toBe(bytes);
    }
  });

  it('atomically adds directories across independent clients and deduplicates the primary and retries', async () => {
    const firstDir = join(homeDir, 'firstDir');
    const secondDir = join(homeDir, 'secondDir');
    await Promise.all([fsp.mkdir(firstDir), fsp.mkdir(secondDir)]);
    const first = build();
    const firstHost = currentHost!;
    const second = build();
    try {
      const { id } = await first.create({ root: homeDir });
      await Promise.all([first.addDirectory(id, firstDir), second.addDirectory(id, secondDir)]);
      await first.addDirectory(id, homeDir);
      expect((await second.addDirectory(id, firstDir))?.additionalDirs.toSorted()).toEqual([firstDir, secondDir].toSorted());
      await expect(first.addDirectory(id, join(homeDir, 'missing'))).rejects.toThrow();
      expect(await second.addDirectory('wm_missing', firstDir)).toBeUndefined();
      expect((await first.get(id))?.additionalDirs.toSorted()).toEqual([firstDir, secondDir].toSorted());
    } finally {
      firstHost.dispose();
    }
  });

  it('accepts a relative session bucket and rejects logs for another storage root or session id', async () => {
    const valid = join(homeDir, 'known');
    const foreign = join(homeDir, 'elsewhere');
    const wrongId = join(homeDir, 'mismatch');
    await fsp.writeFile(join(homeDir, 'session_index.jsonl'), [
      { sessionId: 'ok', sessionDir: join('sessions', encodeWorkDirKey(valid), 'ok'), cwd: valid },
      { sessionId: 'other', sessionDir: join(homeDir, 'other-home', 'sessions', encodeWorkDirKey(foreign), 'other'), workDir: foreign },
      { sessionId: 'wrong', sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(wrongId), 'different'), workDir: wrongId },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    expect((await build().list()).map((project) => project.root)).toEqual([valid]);
  });

  it('only replays session locations after the last deletion of a reused session id', async () => {
    const oldRoot = join(homeDir, 'old');
    const newRoot = join(homeDir, 'new');
    await fsp.writeFile(join(homeDir, 'session_index.jsonl'), [
      originalSession('same', oldRoot),
      { sessionId: 'same', deleted: true },
      originalSession('same', newRoot),
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    expect((await build().list()).map((ws) => ws.root)).toEqual([newRoot]);
  });

  it('publishes lifecycle events on create, touch, rename, and delete', async () => {
    const service = build();
    const created = await service.createOrTouch(homeDir, 'proj');
    await service.createOrTouch(homeDir);
    await service.update(created.id, { name: 'renamed' });
    await service.delete(created.id);

    expect(published.map((event) => event.type)).toEqual([
      'event.workspace.created',
      'event.workspace.updated',
      'event.workspace.updated',
      'event.workspace.deleted',
    ]);
    expect(published[0]?.payload).toMatchObject({ workspace: { id: created.id, name: 'proj' } });
    expect(published[2]?.payload).toMatchObject({ workspace: { id: created.id, name: 'renamed' } });
    expect(published[3]?.payload).toEqual({
      workspaceId: created.id,
      root: homeDir,
      workspace: { ...created, name: 'renamed', lastOpenedAt: expect.any(Number) },
    });
  });

  it('publishes no event when deleting an unknown workspace', async () => {
    await build().delete('wd_missing_000000000000');
    expect(published).toEqual([]);
  });

  it('rebuilds from session_index.jsonl when workspaces.json is absent', async () => {
    const workA = join(homeDir, 'proj-a');
    const workB = join(homeDir, 'proj-b');
    await seedSessionIndex([
      {
        sessionId: 's1',
        sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(workA), 's1'),
        workDir: workA,
      },
      {
        sessionId: 's2',
        sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(workB), 's2'),
        workDir: workB,
      },
      {
        sessionId: 's3',
        sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(workA), 's3'),
        workDir: workA,
      },
    ]);

    const list = await build().list();
    expect(list.map((w) => w.id).toSorted()).toEqual(
      [encodeWorkDirKey(workA), encodeWorkDirKey(workB)].toSorted(),
    );
    const a = list.find((w) => w.id === encodeWorkDirKey(workA));
    expect(a?.root).toBe(workA);
    expect(a?.name).toBe('proj-a');

    expect((await restart().list()).map((w) => w.id).toSorted()).toEqual(
      list.map((w) => w.id).toSorted(),
    );
  });

  it('rebuilds empty when neither file exists', async () => {
    expect(await build().list()).toEqual([]);
  });

  it('merges session-index workDirs into an existing catalog on load', async () => {
    const work = join(homeDir, 'existing');
    const fromIndex = join(homeDir, 'from-index');
    await writeWorkspacesJson({
      [encodeWorkDirKey(work)]: {
        root: work,
        name: 'existing',
        created_at: '2024-01-01T00:00:00.000Z',
        last_opened_at: '2024-01-02T00:00:00.000Z',
      },
    });
    await seedSessionIndex([
      {
        sessionId: 's9',
        sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(fromIndex), 's9'),
        workDir: fromIndex,
      },
    ]);

    const list = await build().list();
    expect(list.map((w) => w.id).toSorted()).toEqual(
      [encodeWorkDirKey(work), encodeWorkDirKey(fromIndex)].toSorted(),
    );
    const existing = list.find((w) => w.id === encodeWorkDirKey(work));
    expect(existing?.name).toBe('existing');
    expect(existing?.lastOpenedAt).toBe(Date.parse('2024-01-02T00:00:00.000Z'));
    expect(list.find((w) => w.id === encodeWorkDirKey(fromIndex))?.name).toBe('from-index');

    expect((await restart().list()).map((w) => w.id).toSorted()).toEqual(
      list.map((w) => w.id).toSorted(),
    );
  });

  it('merge skips tombstoned ids and tolerates a dirty deleted_workspace_ids field', async () => {
    const work = join(homeDir, 'existing');
    const deleted = join(homeDir, 'deleted');
    const fresh = join(homeDir, 'fresh');
    await writeWorkspacesJson(
      {
        [encodeWorkDirKey(work)]: {
          root: work,
          name: 'existing',
          created_at: '2024-01-01T00:00:00.000Z',
          last_opened_at: '2024-01-02T00:00:00.000Z',
        },
      },
      { deleted_workspace_ids: [encodeWorkDirKey(deleted), 42, null] },
    );
    await seedSessionIndex([
      {
        sessionId: 's1',
        sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(deleted), 's1'),
        workDir: deleted,
      },
      {
        sessionId: 's2',
        sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(fresh), 's2'),
        workDir: fresh,
      },
    ]);

    const list = await build().list();
    expect(list.map((w) => w.id).toSorted()).toEqual(
      [encodeWorkDirKey(work), encodeWorkDirKey(fresh)].toSorted(),
    );
  });

  it('delete tombstones the id and the merge never resurrects it', async () => {
    const dirA = join(homeDir, 'dir-a');
    const dirB = join(homeDir, 'dir-b');
    await fsp.mkdir(dirA);
    await fsp.mkdir(dirB);
    const registry = build();
    const a = await registry.createOrTouch(dirA);
    await registry.createOrTouch(dirB);

    await registry.delete(a.id);
    expect((await registry.list()).map((w) => w.id)).toEqual([encodeWorkDirKey(dirB)]);

    const onDisk = await readRegistry();
    expect(onDisk.deleted_workspace_ids).toEqual([a.id]);
    expect(onDisk.workspaces[a.id]).toBeUndefined();

    await seedSessionIndex([
      {
        sessionId: 's1',
        sessionDir: join(homeDir, 'sessions', a.id, 's1'),
        workDir: dirA,
      },
    ]);
    expect((await restart().list()).map((w) => w.id)).toEqual([encodeWorkDirKey(dirB)]);
  });

  it('createOrTouch clears the deletion tombstone', async () => {
    const dirA = join(homeDir, 'dir-a');
    await fsp.mkdir(dirA);
    const registry = build();
    const a = await registry.createOrTouch(dirA);
    await registry.delete(a.id);

    await registry.createOrTouch(dirA);
    expect((await registry.list()).map((w) => w.id)).toEqual([a.id]);
    expect(await readRegistry().then((f) => f.deleted_workspace_ids)).toEqual([]);

    expect((await restart().list()).map((w) => w.id)).toEqual([a.id]);
  });

  it('createOrTouch preserves external additions and tombstones written after load', async () => {
    const dirA = join(homeDir, 'dir-a');
    const dirB = join(homeDir, 'dir-b');
    const dirC = join(homeDir, 'dir-c');
    await fsp.mkdir(dirA);
    await fsp.mkdir(dirC);
    const registry = build();
    await registry.createOrTouch(dirA);

    const onDisk = await readRegistry();
    onDisk.workspaces[encodeWorkDirKey(dirB)] = {
      root: dirB,
      name: 'dir-b',
      kind: 'implicit',
      created_at: '2024-01-01T00:00:00.000Z',
      last_opened_at: '2024-01-01T00:00:00.000Z',
    };
    await writeProjectsJson(onDisk.workspaces, ['wd_external_tombstone']);

    await registry.createOrTouch(dirC);

    const after = await readRegistry();
    expect(Object.keys(after.workspaces).toSorted()).toEqual(
      [encodeWorkDirKey(dirA), encodeWorkDirKey(dirB), encodeWorkDirKey(dirC)].toSorted(),
    );
    expect(after.deleted_workspace_ids).toEqual(['wd_external_tombstone']);
    expect((await registry.list()).map((w) => w.id)).toContain(encodeWorkDirKey(dirB));
  });

  it('delete adds its tombstone on top of the current file state', async () => {
    const dirA = join(homeDir, 'dir-a');
    await fsp.mkdir(dirA);
    const registry = build();
    const a = await registry.createOrTouch(dirA);

    const onDisk = await readRegistry();
    await writeProjectsJson(onDisk.workspaces, ['wd_external_tombstone']);

    await registry.delete(a.id);

    const after = await readRegistry();
    expect(after.workspaces[a.id]).toBeUndefined();
    expect((after.deleted_workspace_ids as string[]).toSorted()).toEqual(
      ['wd_external_tombstone', a.id].toSorted(),
    );
  });

  it('update renames the current file entry and misses externally removed ids', async () => {
    const dirA = join(homeDir, 'dir-a');
    await fsp.mkdir(dirA);
    const registry = build();
    const a = await registry.createOrTouch(dirA);

    const onDisk = await readRegistry();
    const entry = onDisk.workspaces[a.id];
    if (entry === undefined) throw new Error('seed entry missing');
    onDisk.workspaces[a.id] = { ...entry, name: 'external-name' };
    await writeProjectsJson(onDisk.workspaces);

    const renamed = await registry.update(a.id, { name: 'local-name' });
    expect(renamed?.name).toBe('local-name');
    expect(renamed?.lastOpenedAt).toBe(Date.parse(entry.last_opened_at));

    await writeProjectsJson({});
    expect(await registry.update(a.id, { name: 'whatever' })).toBeUndefined();
  });

  it('writes through on update and delete', async () => {
    const created = await build().createOrTouch(homeDir, 'proj');
    await build().update(created.id, { name: 'renamed' });

    expect((await restart().get(created.id))?.name).toBe('renamed');

    await build().delete(created.id);
    expect(await restart().get(created.id)).toBeUndefined();
  });

  it('registers createOrTouch best-effort when the root does not exist locally', async () => {
    const missing = join(homeDir, 'never-created');
    const ws = await build().createOrTouch(missing);
    expect(ws.root).toBe(missing);
    expect((await build().list()).map((w) => w.id)).toEqual([ws.id]);
  });

  it('rejects createOrTouch when the root is not a directory', async () => {
    const file = join(homeDir, 'a-file.txt');
    await fsp.writeFile(file, 'hi', 'utf8');
    await expect(build().createOrTouch(file)).rejects.toMatchObject({
      code: ErrorCodes.FS_PATH_NOT_FOUND,
    });
    expect(await build().list()).toEqual([]);
  });

  it('accepts createOrTouch when the root is given through a symlink', async () => {
    const real = join(homeDir, 'real-root');
    await fsp.mkdir(real, { recursive: true });
    const link = join(homeDir, 'link-root');
    await fsp.symlink(real, link, 'dir');
    const ws = await build().createOrTouch(link);
    expect(ws.root).toBe(link);
    expect(ws.id).toBe(encodeWorkDirKey(link));
  });

  it('registers createOrTouch best-effort when a parent of the root is not a directory', async () => {
    const file = join(homeDir, 'a-file.txt');
    await fsp.writeFile(file, 'hi', 'utf8');
    const child = join(file, 'child');
    const ws = await build().createOrTouch(child);
    expect(ws.root).toBe(child);
  });

  it('collapses duplicate registered entries for the same root, preferring the canonical id', async () => {
    const root = 'c:/users/test/dup';
    const original = 'C:/Users/Test/Dup';
    const canonicalId = encodeWorkDirKey(root);
    const legacyId = encodeWorkDirKey(original);
    await seedSessionIndex([originalSession('old', original)]);
    const entry: PersistedWorkspaceEntry = {
      root,
      name: 'dup',
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    };
    await writeWorkspacesJson({
      [legacyId]: entry,
      [canonicalId]: entry,
    });

    const list = await build().list();
    const matches = list.filter((w) => w.root === root);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe(canonicalId);
  });

  it('folds Windows casing/slash variants onto the first-registered entry', async () => {
    const registry = build(allDirsHostFs());

    const first = await registry.createOrTouch('C:\\Users\\Foo\\Proj');
    const cased = await registry.createOrTouch('c:\\Users\\Foo\\Proj');
    const slashed = await registry.createOrTouch('C:/Users/Foo/Proj/');

    expect(cased.id).toBe(first.id);
    expect(slashed.id).toBe(first.id);
    expect(cased.root).toBe('C:\\Users\\Foo\\Proj');
    expect(cased.name).toBe(first.name);
    expect(cased.lastOpenedAt).toBeGreaterThanOrEqual(first.lastOpenedAt);
    expect(await registry.list()).toHaveLength(1);

    const reloaded = await restart().list();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.root).toBe('C:\\Users\\Foo\\Proj');
  });

  it('merges legacy entries whose roots differ only by casing, preferring the canonical id', async () => {
    const lowerRoot = 'c:\\users\\foo\\proj';
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const legacyId = encodeWorkDirKey(typedRoot);
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

    const list = await build().list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(canonicalId);
    expect(list[0]?.root).toBe(lowerRoot);
  });

  it('rebuild folds session-index workDir variants into one workspace', async () => {
    const firstSeen = '//Host/Share/Proj';
    await seedSessionIndex([
      originalSession('s1', firstSeen),
      originalSession('s2', '//host/share/Proj/'),
      originalSession('s3', '//HOST/SHARE/PROJ'),
    ]);

    const list = await build().list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(encodeWorkDirKey(firstSeen));
    expect(list[0]?.root).toBe(firstSeen);
  });

  it('keeps POSIX roots case-sensitive', async () => {
    const registry = build(allDirsHostFs());

    const upper = await registry.createOrTouch('/tmp/Foo');
    const lower = await registry.createOrTouch('/tmp/foo');

    expect(lower.id).not.toBe(upper.id);
    expect((await registry.list()).map((w) => w.root).toSorted()).toEqual(['/tmp/Foo', '/tmp/foo']);
  });

  it('create mints a wm_ id with additional_dirs and coexists with the hash entry of the same root', async () => {
    const registry = build();
    const extra = join(homeDir, 'extra');
    await fsp.mkdir(extra, { recursive: true });
    const implicit = await registry.createOrTouch(homeDir);

    const created = await registry.create({ root: homeDir, additionalDirs: [extra], name: 'proj' });

    expect(created.id).toMatch(/^wm_[0-9a-f-]{36}$/);
    expect(created.additionalDirs).toEqual([extra]);
    const list = await registry.list();
    expect(list.map((w) => w.id).toSorted()).toEqual([implicit.id, created.id].toSorted());

    const saved = await readRegistry();
    const record = saved.workspaces[created.id] as unknown as Record<string, unknown>;
    expect(record['additional_dirs']).toEqual([extra]);
    expect((await restart().list()).map((w) => w.id).toSorted()).toEqual(
      [implicit.id, created.id].toSorted(),
    );
  });

  it('create dedupes retries by idempotency key across restarts', async () => {
    const registry = build();
    const first = await registry.create({ root: homeDir, idempotencyKey: 'key-1' });
    const second = await registry.create({ root: homeDir, idempotencyKey: 'key-1' });
    expect(second.id).toBe(first.id);

    const other = await registry.create({ root: homeDir, idempotencyKey: 'key-2' });
    expect(other.id).not.toBe(first.id);

    const afterRestart = await restart().create({ root: homeDir, idempotencyKey: 'key-1' });
    expect(afterRestart.id).toBe(first.id);
  });

  it('create rejects additional dirs that are missing or duplicate the root', async () => {
    const registry = build();
    await expect(
      registry.create({ root: homeDir, additionalDirs: [join(homeDir, 'missing')] }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
    await expect(
      registry.create({ root: homeDir, additionalDirs: [homeDir] }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
    await expect(registry.create({ root: join(homeDir, 'missing-root') })).rejects.toMatchObject({
      code: ErrorCodes.FS_PATH_NOT_FOUND,
    });
  });

  it('createOrTouch mints a separate hash entry when only a wm_ entry holds the root', async () => {
    const registry = build();
    const project = await registry.create({ root: homeDir, name: 'proj' });

    const touched = await registry.createOrTouch(homeDir);

    expect(touched.id).toBe(encodeWorkDirKey(homeDir));
    expect(touched.id).not.toBe(project.id);
    expect((await registry.list()).map((w) => w.id).toSorted()).toEqual(
      [project.id, touched.id].toSorted(),
    );
  });

  it('update replaces additional_dirs wholesale and clears the field on empty', async () => {
    const registry = build();
    const extraA = join(homeDir, 'extra-a');
    const extraB = join(homeDir, 'extra-b');
    await fsp.mkdir(extraA, { recursive: true });
    await fsp.mkdir(extraB, { recursive: true });
    const created = await registry.create({ root: homeDir, additionalDirs: [extraA] });

    const replaced = await registry.update(created.id, { additionalDirs: [extraB] });
    expect(replaced?.additionalDirs).toEqual([extraB]);
    let saved = await readRegistry();
    expect((saved.workspaces[created.id] as unknown as Record<string, unknown>)['additional_dirs']).toEqual([extraB]);

    const cleared = await registry.update(created.id, { additionalDirs: [] });
    expect(cleared?.additionalDirs).toEqual([]);
    saved = await readRegistry();
    expect((saved.workspaces[created.id] as unknown as Record<string, unknown>)['additional_dirs']).toBeUndefined();

    const renamed = await registry.update(created.id, { name: 'renamed' });
    expect(renamed?.name).toBe('renamed');
    expect(renamed?.additionalDirs).toEqual([]);
  });

  it('delete of a wm_ entry tombstones only itself and keeps the same-root hash entry', async () => {
    const registry = build();
    const implicit = await registry.createOrTouch(homeDir);
    const project = await registry.create({ root: homeDir, name: 'proj' });

    await registry.delete(project.id);

    expect((await registry.list()).map((w) => w.id)).toEqual([implicit.id]);
    const saved = await readRegistry();
    expect(saved.deleted_workspace_ids).toEqual([project.id]);
    expect(Object.keys(saved.workspaces)).toEqual([implicit.id]);
  });

  it('delete of a hash entry leaves the same-root wm_ entry registered', async () => {
    const registry = build();
    const implicit = await registry.createOrTouch(homeDir);
    const project = await registry.create({ root: homeDir, name: 'proj' });

    await registry.delete(implicit.id);

    expect((await registry.list()).map((w) => w.id)).toEqual([project.id]);
    const saved = await readRegistry();
    expect(Object.keys(saved.workspaces)).toEqual([project.id]);
    expect(saved.deleted_workspace_ids).toEqual([implicit.id]);
  });

  it('create ignores local.toml additional_dir and leaves the file untouched', async () => {
    const extraA = join(homeDir, 'extra-a');
    const extraB = join(homeDir, 'extra-b');
    await fsp.mkdir(extraA, { recursive: true });
    await fsp.mkdir(extraB, { recursive: true });
    await fsp.mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await fsp.writeFile(
      join(homeDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${extraA.replaceAll('\\', '\\\\')}", "${extraB.replaceAll('\\', '\\\\')}"]\nother_key = "keep"\n`,
      'utf8',
    );

    const registry = build();
    const created = await registry.create({ root: homeDir, additionalDirs: [extraA] });
    expect(created.additionalDirs).toEqual([extraA]);

    const text = await fsp.readFile(join(homeDir, '.kimi-code', 'local.toml'), 'utf8');
    expect(text).toContain('other_key');
    expect(text).toContain('extra-a');
    expect(text).toContain('extra-b');
  });

  it('persists kind per channel', async () => {
    const registry = build();
    const managed = await registry.create({ root: homeDir, name: 'proj' });
    expect(managed.kind).toBe('managed');
    const implicit = await registry.createOrTouch(homeDir);
    expect(implicit.kind).toBe('implicit');

    const saved = await readRegistry();
    expect(saved.workspaces[managed.id]?.kind).toBe('managed');
    expect(saved.workspaces[implicit.id]?.kind).toBe('implicit');
  });

  it('readProjectConfigDirs returns resolved local.toml dirs without mutating anything', async () => {
    const extra = join(homeDir, 'extra');
    await fsp.mkdir(extra, { recursive: true });
    await fsp.mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await fsp.writeFile(
      join(homeDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${extra.replaceAll('\\', '\\\\')}"]\n`,
      'utf8',
    );

    const registry = build();
    expect(await registry.readProjectConfigDirs(homeDir)).toEqual([extra]);

    const text = await fsp.readFile(join(homeDir, '.kimi-code', 'local.toml'), 'utf8');
    expect(text).toContain('extra');
  });

  it('readProjectConfigDirs drops the root itself and duplicate entries', async () => {
    const extra = join(homeDir, 'extra');
    await fsp.mkdir(extra, { recursive: true });
    await fsp.mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await fsp.writeFile(
      join(homeDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${homeDir.replaceAll('\\', '\\\\')}", "${extra.replaceAll('\\', '\\\\')}", "${extra.replaceAll('\\', '\\\\')}"]\n`,
      'utf8',
    );

    const registry = build();
    expect(await registry.readProjectConfigDirs(homeDir)).toEqual([extra]);
  });

  it('readProjectConfigDirs returns empty when local.toml is missing and rejects invalid config', async () => {
    const registry = build();
    expect(await registry.readProjectConfigDirs(homeDir)).toEqual([]);

    await fsp.mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await fsp.writeFile(join(homeDir, '.kimi-code', 'local.toml'), 'not toml at all = [', 'utf8');
    await expect(registry.readProjectConfigDirs(homeDir)).rejects.toThrow();
  });

  it('readProjectConfigDirs rejects a configured directory that no longer exists', async () => {
    const missing = join(homeDir, 'missing');
    await fsp.mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await fsp.writeFile(
      join(homeDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${missing.replaceAll('\\', '\\\\')}"]\n`,
      'utf8',
    );

    await expect(build().readProjectConfigDirs(homeDir)).rejects.toThrow();
  });

  it('setPrimary swaps root with an additional dir atomically and keeps id and bucket', async () => {
    const registry = build();
    const extraA = join(homeDir, 'extra-a');
    const extraB = join(homeDir, 'extra-b');
    await fsp.mkdir(extraA, { recursive: true });
    await fsp.mkdir(extraB, { recursive: true });
    const created = await registry.create({
      root: homeDir,
      additionalDirs: [extraA, extraB],
      name: 'proj',
    });

    const promoted = await registry.setPrimary(created.id, extraA);
    expect(promoted?.id).toBe(created.id);
    expect(promoted?.root).toBe(extraA);
    expect(promoted?.additionalDirs).toEqual([homeDir, extraB]);

    const saved = await readRegistry();
    expect(saved.workspaces[created.id]?.root).toBe(extraA);
    expect((await restart().get(created.id))?.additionalDirs).toEqual([homeDir, extraB]);

    const noop = await registry.setPrimary(created.id, extraA);
    expect(noop?.root).toBe(extraA);
    expect(noop?.additionalDirs).toEqual([homeDir, extraB]);
  });

  it('setPrimary rejects a path outside the dir set, a missing path, or an unknown id', async () => {
    const registry = build();
    const outside = join(homeDir, 'outside');
    await fsp.mkdir(outside, { recursive: true });
    const created = await registry.create({ root: homeDir });

    await expect(registry.setPrimary(created.id, outside)).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
    await expect(registry.setPrimary(created.id, join(homeDir, 'missing'))).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
    expect(await registry.setPrimary('wd_missing_000000000000', homeDir)).toBeUndefined();
  });

  it('merge and rebuild skip session-index lines written into wm_ buckets', async () => {
    const workA = join(homeDir, 'proj-a');
    const workB = join(homeDir, 'proj-b');
    await seedSessionIndex([
      {
        sessionId: 's1',
        sessionDir: join(homeDir, 'sessions', 'wm_7f3a9c1e-1111-2222-3333-444455556666', 's1'),
        workDir: workA,
      },
      {
        sessionId: 's2',
        sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(workB), 's2'),
        workDir: workB,
      },
    ]);

    const list = await build().list();
    expect(list.map((w) => w.id)).toEqual([encodeWorkDirKey(workB)]);
  });

  it('migration and patch preserve unknown entry and top-level fields', async () => {
    const id = encodeWorkDirKey(homeDir);
    await writeWorkspacesJson(
      {
        [id]: {
          root: homeDir,
          name: 'proj',
          created_at: '2026-01-01T00:00:00.000Z',
          last_opened_at: '2026-01-01T00:00:00.000Z',
          icon: 'rocket-2',
        } as PersistedWorkspaceEntry,
      } as Record<string, PersistedWorkspaceEntry>,
    );
    await fsp.writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({
        ...JSON.parse(await fsp.readFile(join(homeDir, 'workspaces.json'), 'utf8')) as object,
        future_top_level: { nested: true },
      }),
      'utf8',
    );

    const registry = build();
    await registry.touch(id);

    const saved = JSON.parse(await fsp.readFile(join(homeDir, 'projects.json'), 'utf8')) as {
      schema_version: number;
      projects: Record<string, Record<string, unknown>>;
      future_top_level?: unknown;
    };
    expect(saved.schema_version).toBe(2);
    expect(saved.projects[id]?.['icon']).toBe('rocket-2');
    expect(saved.future_top_level).toEqual({ nested: true });
  });

  it('createOrTouch resurrects a tombstoned hash entry through the implicit channel', async () => {
    const registry = build();
    const implicit = await registry.createOrTouch(homeDir);
    await registry.delete(implicit.id);
    expect(await registry.list()).toEqual([]);

    const revived = await registry.createOrTouch(homeDir);
    expect(revived.id).toBe(implicit.id);
    expect((await registry.list()).map((w) => w.id)).toEqual([implicit.id]);
  });




  it('delete tombstones every folded alias so a legacy split cannot resurface', async () => {
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const typedId = encodeWorkDirKey(typedRoot);
    const aliasRoot = 'c:\\Users\\Foo\\Proj';
    const aliasId = encodeWorkDirKey(aliasRoot);
    const indexOnlyRoot = 'C:/users/foo/proj';
    const indexOnlyId = encodeWorkDirKey(indexOnlyRoot);
    await writeWorkspacesJson({
      [typedId]: {
        root: typedRoot,
        name: 'proj',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
      [aliasId]: {
        root: aliasRoot,
        name: 'proj',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedSessionIndex([
      originalSession('s1', typedRoot),
      originalSession('s2', indexOnlyRoot),
      originalSession('s3', join(homeDir, 'unrelated')),
    ]);

    const registry = build();
    await registry.delete(typedId);

    const stillListed = (await registry.list()).filter(
      (w) => workspaceRootKey(w.root) === workspaceRootKey(typedRoot),
    );
    expect(stillListed).toEqual([]);
    const unrelatedId = encodeWorkDirKey(join(homeDir, 'unrelated'));
    const saved = await readRegistry();
    expect(Object.keys(saved.workspaces)).toEqual([unrelatedId]);
    expect([...(saved.deleted_workspace_ids as string[])].toSorted()).toEqual(
      [typedId, aliasId, indexOnlyId].toSorted(),
    );

    const reopened = restart();
    const relisted = (await reopened.list()).filter(
      (w) => workspaceRootKey(w.root) === workspaceRootKey(typedRoot),
    );
    expect(relisted).toEqual([]);
    const afterMerge = await readRegistry();
    expect(Object.keys(afterMerge.workspaces)).toEqual([unrelatedId]);
  });

  function staleEntry(i: number): SessionIndexLine {
    return originalSession(`s_stale_${i}`, join(homeDir, `stale-${i}`));
  }

  async function writeSessionIndexLines(lines: readonly unknown[]): Promise<void> {
    const text = `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`;
    await fsp.writeFile(join(homeDir, 'session_index.jsonl'), text, 'utf8');
  }

  async function readSessionIndexIds(): Promise<{
    ids: Set<string>;
    tombstoned: Set<string>;
    lines: string[];
  }> {
    const raw = await fsp.readFile(join(homeDir, 'session_index.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    const ids = new Set<string>();
    const tombstoned = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed['deleted'] === true) {
        tombstoned.add(parsed['sessionId'] as string);
      } else {
        ids.add(parsed['sessionId'] as string);
      }
    }
    return { ids, tombstoned, lines };
  }

  it('drops session-index entries whose session dir is gone, keeping live entries and tombstones', async () => {
    const fresh: SessionIndexLine[] = [];
    const lines: unknown[] = [];
    for (let i = 0; i < 20; i++) lines.push(staleEntry(i));
    for (let i = 0; i < 8; i++) {
      const entry = originalSession(`s_fresh_${i}`, join(homeDir, `fresh-${i}`));
      await fsp.mkdir(entry.sessionDir, { recursive: true });
      fresh.push(entry);
      lines.push(entry);
    }
    lines.push({ sessionId: 's_gone_0', deleted: true });
    lines.push({ sessionId: 's_gone_1', deleted: true });
    lines.push('not-json');
    await writeSessionIndexLines(lines);

    const list = await build().list();
    expect(list).toHaveLength(28);

    const { ids, tombstoned, lines: compacted } = await readSessionIndexIds();
    expect(compacted).toHaveLength(10);
    expect([...ids].toSorted()).toEqual(fresh.map((entry) => entry.sessionId).toSorted());
    expect([...tombstoned].toSorted()).toEqual(['s_gone_0', 's_gone_1']);

    const afterRestart = await restart().list();
    expect(afterRestart).toHaveLength(28);
  });

  it('compacts mixed-version cwd entries by sessionDir and keeps a live row in its original wire shape', async () => {
    const { main, child } = await worktrees();
    const id = encodeWorkDirKey(main);
    const live = { sessionId: 'live', sessionDir: join(homeDir, 'sessions', id, 'live'), cwd: child };
    await fsp.mkdir(live.sessionDir, { recursive: true });
    const stale = Array.from({ length: 20 }, (_, i) => ({
      sessionId: `stale-${i}`, sessionDir: join(homeDir, 'sessions', id, `stale-${i}`), cwd: child,
    }));
    await writeSessionIndexLines([...stale, live]);
    expect((await build().list()).map((ws) => ws.id)).toEqual([id]);
    const remaining = (await fsp.readFile(join(homeDir, 'session_index.jsonl'), 'utf8')).trim();
    expect(JSON.parse(remaining)).toEqual(live);
  });

  it('keeps relative session directories under the data home when compacting stale rows', async () => {
    const id = encodeWorkDirKey(homeDir);
    const live = { sessionId: 'relative', sessionDir: join('sessions', id, 'relative'), cwd: join(homeDir, 'checkout') };
    await fsp.mkdir(join(homeDir, live.sessionDir), { recursive: true });
    await writeSessionIndexLines([live, ...Array.from({ length: 16 }, (_, index) => staleEntry(index))]);
    await build().list();
    expect((await fsp.readFile(join(homeDir, 'session_index.jsonl'), 'utf8')).trimEnd()).toBe(JSON.stringify(live));
  });

  it('leaves a mostly-fresh session index byte-identical', async () => {
    await seedSessionIndex([staleEntry(0), staleEntry(1), staleEntry(2), staleEntry(3)]);
    const before = await fsp.readFile(join(homeDir, 'session_index.jsonl'), 'utf8');

    await build().list();

    expect(await fsp.readFile(join(homeDir, 'session_index.jsonl'), 'utf8')).toBe(before);
  });

  it('keeps entries appended while the compaction scans session dirs', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 20; i++) lines.push(staleEntry(i));
    const gateDir = originalSession('s_gate', join(homeDir, 'gate')).sessionDir;
    await fsp.mkdir(gateDir, { recursive: true });
    lines.push({ sessionId: 's_gate', sessionDir: gateDir, workDir: join(homeDir, 'gate') });
    await writeSessionIndexLines(lines);

    let statEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      statEntered = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const hostFs = new HostFileSystem();
    const gated = Object.create(hostFs) as IHostFileSystem;
    let first = true;
    gated.stat = async (path: string) => {
      if (path === gateDir && first) {
        first = false;
        statEntered();
        await gate;
      }
      return hostFs.stat(path);
    };

    const listPromise = build(gated).list();
    await entered;
    const appendedDir = originalSession('s_new', join(homeDir, 'new')).sessionDir;
    await fsp.mkdir(appendedDir, { recursive: true });
    appendLogs.append('', 'session_index.jsonl', {
      sessionId: 's_new',
      sessionDir: appendedDir,
      workDir: join(homeDir, 'new'),
    });
    await appendLogs.flush();
    releaseGate();
    await listPromise;

    const { ids, lines: compacted } = await readSessionIndexIds();
    expect(ids.has('s_new')).toBe(true);
    expect(ids.has('s_gate')).toBe(true);
    expect(compacted).toHaveLength(2);
  });

  it('keeps the original file when the compaction rewrite fails and compacts on the next startup', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 20; i++) lines.push(staleEntry(i));
    const liveDir = originalSession('s_live', join(homeDir, 'live')).sessionDir;
    await fsp.mkdir(liveDir, { recursive: true });
    lines.push({ sessionId: 's_live', sessionDir: liveDir, workDir: join(homeDir, 'live') });
    await writeSessionIndexLines(lines);
    const before = await fsp.readFile(join(homeDir, 'session_index.jsonl'), 'utf8');

    let failWrites = true;
    class FlakyStorage extends FileStorageService {
      override async write(
        scope: string,
        key: string,
        data: Uint8Array,
        options?: { readonly atomic?: boolean; readonly signal?: AbortSignal },
      ): Promise<void> {
        if (failWrites && key === 'session_index.jsonl') throw new Error('injected write failure');
        return super.write(scope, key, data, options);
      }
    }
    const flaky = new FlakyStorage(homeDir);

    const list = await build(new HostFileSystem(), flaky).list();
    expect(list).toHaveLength(21);
    expect(await fsp.readFile(join(homeDir, 'session_index.jsonl'), 'utf8')).toBe(before);

    failWrites = false;
    await restart(new HostFileSystem(), flaky).list();

    const { ids, lines: compacted } = await readSessionIndexIds();
    expect([...ids]).toEqual(['s_live']);
    expect(compacted).toHaveLength(1);
  });

describe('projects.json migration and patch', () => {
  function createPersistence(storage = new FileStorageService(homeDir)): FileWorkspacePersistence {
    return new FileWorkspacePersistence(
      new JsonAtomicDocumentStore(storage),
      storage,
      stubBootstrap(homeDir),
    );
  }

  async function readProjects(): Promise<PersistedProjectsFile & Record<string, unknown>> {
    return JSON.parse(await fsp.readFile(join(homeDir, 'projects.json'), 'utf8')) as PersistedProjectsFile & Record<string, unknown>;
  }

  async function writeProjects(value: unknown): Promise<void> {
    await fsp.writeFile(join(homeDir, 'projects.json'), JSON.stringify(value), 'utf8');
  }

  async function backupFiles(): Promise<string[]> {
    return (await fsp.readdir(homeDir)).filter((name) =>
      name.startsWith('workspaces.json.pre-projects-migration-'),
    );
  }

  it('shares a parsed catalog across repeated reads until the file changes', async () => {
    await writeProjects({ schema_version: 2, projects: {}, deleted_project_ids: [] });
    const storage = new FileStorageService(homeDir);
    const docs = new JsonAtomicDocumentStore(storage);
    const get = vi.spyOn(docs, 'get');
    const persistence = new FileWorkspacePersistence(docs, storage, stubBootstrap(homeDir));
    try {
      const first = await persistence.load();
      for (let index = 0; index < 64; index += 1) {
        expect(await persistence.load()).toEqual(first);
      }
      expect(get.mock.calls.filter(([, key]) => key === 'projects.json')).toHaveLength(1);
      await persistence.update((catalog) => ({ ...catalog, deletedIds: ['wd_removed'] }));
      expect((await persistence.load())?.deletedIds).toEqual(['wd_removed']);
    } finally {
      persistence.dispose();
    }
  });

  it('observes same-sized atomic replacement even when the modification time is preserved', async () => {
    const original = { schema_version: 2, projects: {}, deleted_project_ids: ['old'] };
    await writeProjects(original);
    const persistence = createPersistence();
    try {
      expect((await persistence.load())?.deletedIds).toEqual(['old']);
      const target = join(homeDir, 'projects.json');
      const metadata = await fsp.stat(target);
      const replacement = join(homeDir, 'replacement.json');
      await fsp.writeFile(replacement, JSON.stringify({ ...original, deleted_project_ids: ['new'] }));
      await fsp.utimes(replacement, metadata.atime, metadata.mtime);
      await fsp.rename(replacement, target);
      expect((await persistence.load())?.deletedIds).toEqual(['new']);
      await fsp.writeFile(target, '{invalid');
      await expect(persistence.load()).rejects.toThrow();
      await writeProjects(original);
      expect((await persistence.load())?.deletedIds).toEqual(['old']);
    } finally {
      persistence.dispose();
    }
  });

  it('does not cache a snapshot when the file is atomically replaced during its read', async () => {
    const original = { schema_version: 2, projects: {}, deleted_project_ids: ['old'] };
    await writeProjects(original);
    const storage = new FileStorageService(homeDir);
    const docs = new JsonAtomicDocumentStore(storage);
    const get = docs.get.bind(docs);
    vi.spyOn(docs, 'get').mockImplementationOnce(async (scope, key) => {
      const value = await get(scope, key);
      await docs.set(scope, key, { ...original, deleted_project_ids: ['new'] });
      return value;
    });
    const persistence = new FileWorkspacePersistence(docs, storage, stubBootstrap(homeDir));
    try {
      expect((await persistence.load())?.deletedIds).toEqual(['old']);
      expect((await persistence.load())?.deletedIds).toEqual(['new']);
    } finally {
      persistence.dispose();
    }
  });

  it('migrates once, preserves source bytes, and ignores later legacy writes', async () => {
    const id = 'wm_legacy';
    const legacy = {
      version: 1,
      workspaces: {
        [id]: {
          root: homeDir,
          name: 'legacy',
          kind: 'managed',
          additional_dirs: ['/tmp/extra'],
          created_at: '2026-01-01T00:00:00.000Z',
          last_opened_at: '2026-01-02T00:00:00.000Z',
        },
      },
      deleted_workspace_ids: ['wd_deleted'],
      idempotency_keys: { retry: id },
      future_top_level: { nested: true },
    };
    await fsp.writeFile(join(homeDir, 'workspaces.json'), JSON.stringify(legacy), 'utf8');
    const before = await fsp.readFile(join(homeDir, 'workspaces.json'), 'utf8');

    const registry = build();
    expect((await registry.list()).map((workspace) => workspace.id)).toEqual([id]);
    const migrated = await readProjects();
    expect(migrated.schema_version).toBe(2);
    expect(migrated.projects[id]?.additional_dirs).toEqual(['/tmp/extra']);
    expect(migrated.migration).toMatchObject({
      source_file: 'workspaces.json',
      source_version: 1,
      source_sha256: createHash('sha256').update(before).digest('hex'),
    });
    expect(migrated['future_top_level']).toEqual({ nested: true });
    expect(await fsp.readFile(join(homeDir, 'workspaces.json'), 'utf8')).toBe(before);
    const backups = await backupFiles();
    expect(backups).toHaveLength(1);
    expect(await fsp.readFile(join(homeDir, backups[0]!), 'utf8')).toBe(before);

    await fsp.writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({ version: 1, workspaces: {}, deleted_workspace_ids: [] }),
      'utf8',
    );
    expect((await restart().list()).map((workspace) => workspace.id)).toEqual([id]);
    expect((await restart().get(id))?.additionalDirs).toEqual(['/tmp/extra']);
    expect(await backupFiles()).toHaveLength(1);
    expect((await readProjects())['future_top_level']).toEqual({ nested: true });
  });

  it.each([
    { scenario: 'missing workspaces', legacy: {} },
    { scenario: 'non-object workspaces', legacy: { version: 1, workspaces: null } },
    {
      scenario: 'non-array deletion tombstones',
      legacy: { version: 1, workspaces: {}, deleted_workspace_ids: 'invalid' },
    },
  ])('rebuilds from the session index with $scenario', async ({ legacy }) => {
    const workDir = join(homeDir, 'recovered');
    const id = encodeWorkDirKey(workDir);
    await fsp.writeFile(join(homeDir, 'workspaces.json'), JSON.stringify(legacy), 'utf8');
    await seedSessionIndex([
      {
        sessionId: 's_recovered',
        sessionDir: join(homeDir, 'sessions', id, 's_recovered'),
        workDir,
      },
    ]);

    expect((await build().list()).map((workspace) => workspace.id)).toEqual([id]);
    const migrated = await readProjects();
    expect(migrated.projects[id]?.root).toBe(workDir);
    expect(migrated.deleted_project_ids).toEqual([]);
  });

  it('initializes a fresh projects file without migration metadata', async () => {
    expect(await build().list()).toEqual([]);
    const file = await readProjects();
    expect(file).toMatchObject({
      schema_version: 2,
      projects: {},
      deleted_project_ids: [],
      idempotency_keys: {},
    });
    expect(file.migration).toBeUndefined();
  });

  it('rejects a newer schema without rebuilding from legacy data', async () => {
    await writeWorkspacesJson({});
    const invalid = { schema_version: 3, projects: {}, deleted_project_ids: [] };
    await writeProjects(invalid);
    await expect(build().list()).rejects.toThrow(/newer than supported/);
    expect(await fsp.readFile(join(homeDir, 'projects.json'), 'utf8')).toBe(JSON.stringify(invalid));
  });

  it('rejects malformed projects without rebuilding from legacy data', async () => {
    await writeWorkspacesJson({});
    await writeProjects({ schema_version: 2, projects: null, deleted_project_ids: [] });
    await expect(build().list()).rejects.toThrow(/invalid projects.json projects/);
  });

  it.each([
    { scenario: 'a single string', dirs: '/tmp/extra' },
    { scenario: 'a non-string array item', dirs: ['/tmp/extra', 42] },
  ])('rejects additional_dirs as $scenario in the new projects format', async ({ dirs }) => {
    await writeProjects({
      schema_version: 2,
      projects: {
        wm_bad: {
          root: homeDir,
          name: 'bad',
          kind: 'managed',
          additional_dirs: dirs,
          created_at: '2026-01-01T00:00:00.000Z',
          last_opened_at: '2026-01-01T00:00:00.000Z',
        },
      },
      deleted_project_ids: [],
    });

    await expect(build().list()).rejects.toThrow(/invalid additional_dirs/);
  });

  it.each([
    { scenario: 'unknown', kind: 'manged' },
    { scenario: 'missing', kind: undefined },
  ])('rejects $scenario kind in schema-v2 projects', async ({ kind }) => {
    await writeProjects({
      schema_version: 2,
      projects: {
        wm_bad: {
          root: homeDir,
          name: 'bad',
          kind,
          additional_dirs: [],
          created_at: '2026-01-01T00:00:00.000Z',
          last_opened_at: '2026-01-01T00:00:00.000Z',
        },
      },
      deleted_project_ids: [],
    });

    await expect(build().list()).rejects.toThrow(/invalid kind/);
  });

  it.each([undefined, 'manged'])('defaults kind %s to implicit during legacy migration', async (kind) => {
    await fsp.writeFile(join(homeDir, 'workspaces.json'), JSON.stringify({
      version: 1,
      workspaces: {
        wd_legacy: {
          root: homeDir,
          name: 'legacy',
          kind,
          additional_dirs: [],
          created_at: '2026-01-01T00:00:00.000Z',
          last_opened_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }), 'utf8');

    const list = await build().list();
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe('implicit');
  });

  it('keeps tolerant additional_dirs sanitation during legacy migration', async () => {
    await fsp.writeFile(join(homeDir, 'workspaces.json'), JSON.stringify({
      version: 1,
      workspaces: {
        wd_legacy: {
          root: homeDir,
          name: 'legacy',
          additional_dirs: '/tmp/legacy',
          created_at: '2026-01-01T00:00:00.000Z',
          last_opened_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }), 'utf8');

    const list = await build().list();
    expect(list).toHaveLength(1);
    expect(list[0]?.additionalDirs).toEqual([]);
  });

  it('coalesces concurrent first-load migration', async () => {
    const id = encodeWorkDirKey(homeDir);
    await writeWorkspacesJson({
      [id]: {
        root: homeDir,
        name: 'legacy',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-02T00:00:00.000Z',
      },
    });
    const first = createPersistence();
    const second = createPersistence();
    try {
      const [a, b] = await Promise.all([first.load(), second.load()]);
      expect(a?.workspaces.map((workspace) => workspace.id)).toEqual([id]);
      expect(b?.workspaces.map((workspace) => workspace.id)).toEqual([id]);
      expect(await backupFiles()).toHaveLength(1);
      expect((await readProjects()).projects[id]?.name).toBe('legacy');
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('retries migration after transient snapshot conflicts', async () => {
    const storage = new FileStorageService(homeDir);
    const read = storage.read.bind(storage);
    let attempts = 0;
    vi.spyOn(storage, 'read').mockImplementation(async (scope, key) => {
      if (key === 'workspaces.json' && attempts < 6) {
        attempts += 1;
        return new TextEncoder().encode(JSON.stringify({ version: 1, workspaces: {}, attempt: attempts }));
      }
      return read(scope, key);
    });
    const persistence = createPersistence(storage);

    try {
      await expect(persistence.load()).rejects.toThrow(/changed repeatedly/);
      expect((await persistence.load())?.workspaces).toEqual([]);
    } finally {
      persistence.dispose();
    }
  });

  it('watches consecutive atomic projects replacements', async () => {
    const persistence = createPersistence();
    const id = 'wm_watch';
    const entry: PersistedWorkspaceEntry = {
      root: homeDir,
      name: 'initial',
      kind: 'managed',
      additional_dirs: [],
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    };
    const replace = async (name: string): Promise<void> => {
      const temporary = join(homeDir, `projects-${name}.tmp`);
      await fsp.writeFile(
        temporary,
        JSON.stringify({
          schema_version: 2,
          projects: { [id]: { ...entry, name } },
          deleted_project_ids: [],
          idempotency_keys: {},
        }),
        'utf8',
      );
      await fsp.rename(temporary, join(homeDir, 'projects.json'));
    };

    try {
      await persistence.load();
      let events = 0;
      persistence.onDidChange(() => {
        events += 1;
      });
      await replace('first');
      await vi.waitFor(() => {
        expect(events).toBeGreaterThan(0);
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const firstEvents = events;

      await replace('second');
      await vi.waitFor(() => {
        expect(events).toBeGreaterThan(firstEvents);
      });
    } finally {
      persistence.dispose();
    }
  });

  it('merges concurrent patches and preserves unrelated records and extensions', async () => {
    const idA = 'wd_a';
    const idB = 'wd_b';
    const entry = (root: string, name: string): PersistedWorkspaceEntry => ({
      root,
      name,
      kind: 'implicit',
      additional_dirs: [],
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    });
    await writeProjects({
      schema_version: 2,
      projects: {
        [idA]: entry('/a', 'a'),
        [idB]: { ...entry('/b', 'b'), icon: 'rocket-2' },
      },
      deleted_project_ids: [],
      idempotency_keys: { keep: idA },
      future_top_level: { nested: true },
    });
    const first = createPersistence();
    const second = createPersistence();
    try {
      await Promise.all([first.load(), second.load()]);
      await Promise.all([
        first.update((catalog) => ({
          ...catalog,
          workspaces: catalog.workspaces.map((workspace) =>
            workspace.id === idA ? { ...workspace, name: 'renamed-a' } : workspace,
          ),
        })),
        second.update((catalog) => ({
          ...catalog,
          workspaces: catalog.workspaces.map((workspace) =>
            workspace.id === idB ? { ...workspace, name: 'renamed-b' } : workspace,
          ),
        })),
      ]);
      const saved = await readProjects();
      expect(saved.projects[idA]?.name).toBe('renamed-a');
      expect(saved.projects[idB]?.name).toBe('renamed-b');
      expect((saved.projects[idB] as unknown as Record<string, unknown>)['icon']).toBe('rocket-2');
      expect(saved.idempotency_keys).toEqual({ keep: idA });
      expect(saved['future_top_level']).toEqual({ nested: true });

      const before = await fsp.readFile(join(homeDir, 'projects.json'), 'utf8');
      await first.update((catalog) => catalog);
      expect(await fsp.readFile(join(homeDir, 'projects.json'), 'utf8')).toBe(before);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('reads schema_version 1 and upgrades on the next patch', async () => {
    const id = encodeWorkDirKey(homeDir);
    await writeProjects({
      schema_version: 1,
      projects: {
        [id]: {
          root: homeDir,
          name: 'legacy',
          created_at: '2026-01-01T00:00:00.000Z',
          last_opened_at: '2026-01-01T00:00:00.000Z',
        },
      },
      deleted_project_ids: [],
    });
    const persistence = createPersistence();
    try {
      expect((await persistence.load())?.workspaces.map((workspace) => workspace.id)).toEqual([id]);
      await persistence.update((catalog) => ({
        ...catalog,
        workspaces: catalog.workspaces.map((workspace) => ({
          ...workspace,
          lastOpenedAt: workspace.lastOpenedAt + 1,
        })),
      }));
      expect((await readProjects()).schema_version).toBe(2);
    } finally {
      persistence.dispose();
    }
  });
});
});

describe('workspaceRootKey', () => {
  it('folds drive-letter casing and slash direction', () => {
    expect(workspaceRootKey('C:\\Users\\Foo\\Proj')).toBe('c:/users/foo/proj');
    expect(workspaceRootKey('c:/Users/Foo/Proj/')).toBe('c:/users/foo/proj');
    expect(workspaceRootKey('C:\\Users\\Foo\\Proj')).toBe(workspaceRootKey('c:/users/foo/proj'));
  });

  it('folds drive roots before separator stripping can mask the shape', () => {
    expect(workspaceRootKey('C:\\')).toBe('c:');
    expect(workspaceRootKey('C:\\')).toBe(workspaceRootKey('c:\\'));
    expect(workspaceRootKey('C:\\')).toBe(workspaceRootKey('c:/'));
  });

  it('folds UNC hosts and shares', () => {
    expect(workspaceRootKey('\\\\HOST\\Share\\Dir')).toBe('//host/share/dir');
    expect(workspaceRootKey('//HOST/Share/Dir/')).toBe('//host/share/dir');
  });

  it('strips trailing separators but never case-folds POSIX paths', () => {
    expect(workspaceRootKey('/tmp/Foo/')).toBe('/tmp/Foo');
    expect(workspaceRootKey('/tmp/Foo')).not.toBe(workspaceRootKey('/tmp/foo'));
  });
});
