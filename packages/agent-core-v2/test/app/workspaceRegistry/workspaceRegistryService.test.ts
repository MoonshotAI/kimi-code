import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ErrorCodes, Error2 } from '#/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWorkspaceRegistry } from '#/app/workspaceRegistry/workspaceRegistry';
import { WorkspaceRegistryService } from '#/app/workspaceRegistry/workspaceRegistryService';
import { FileWorkspacePersistence } from '#/app/workspaceRegistry/fileWorkspacePersistence';
import { IWorkspacePersistence, type PersistedWorkspaceEntry } from '#/app/workspaceRegistry/workspacePersistence';

interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

describe('WorkspaceRegistryService (file-backed)', () => {
  let homeDir: string;
  let currentHost: ReturnType<typeof createScopedTestHost> | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IWorkspacePersistence,
      FileWorkspacePersistence,
      InstantiationType.Delayed,
      'workspaceRegistry',
    );
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceRegistry,
      WorkspaceRegistryService,
      InstantiationType.Delayed,
      'workspaceRegistry',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-registry-'));
  });

  afterEach(async () => {
    currentHost?.dispose();
    currentHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(): IWorkspaceRegistry {
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(
        IBootstrapService,
        { homeDir, sessionsDir: join(homeDir, 'sessions') } as IBootstrapService,
      ),
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IHostFileSystem, new HostFileSystem()),
    ]);
    currentHost = host;
    return host.app.accessor.get(IWorkspaceRegistry);
  }

  function restart(): IWorkspaceRegistry {
    currentHost?.dispose();
    currentHost = undefined;
    return build();
  }

  async function seedSessionIndex(entries: SessionIndexLine[]): Promise<void> {
    const text = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
    await fsp.writeFile(join(homeDir, 'session_index.jsonl'), text, 'utf8');
  }

  async function writeWorkspacesJson(
    workspaces: Record<string, PersistedWorkspaceEntry>,
  ): Promise<void> {
    await fsp.writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({ version: 1, workspaces }),
      'utf8',
    );
  }

  it('persists the catalog across registry instances', async () => {
    const created = await build().createOrTouch(homeDir, 'proj');

    const list = await restart().list();
    expect(list.map((w) => w.id)).toContain(created.id);
    expect(list.find((w) => w.id === created.id)?.name).toBe('proj');
  });

  it('normalizes a lexical root alias before deriving its canonical id', async () => {
    const root = join(homeDir, 'project');
    await fsp.mkdir(root, { recursive: true });
    const created = await build().createOrTouch(join(root, '..', 'project'), 'project');

    expect(created.root).toBe(root);
    expect(created.id).toBe(encodeWorkDirKey(root));
    expect((await restart().list()).map((workspace) => workspace.root)).toEqual([root]);
  });

  it('serializes concurrent registry mutations across instances', async () => {
    const rootA = join(homeDir, 'a');
    const rootB = join(homeDir, 'b');
    await fsp.mkdir(rootA, { recursive: true });
    await fsp.mkdir(rootB, { recursive: true });

    const first = build();
    const firstHost = currentHost as ReturnType<typeof createScopedTestHost>;
    const second = build();
    const releaseExternal = await lockfile.lock(join(homeDir, 'workspaces.json'), {
      realpath: false,
    });
    let settled = false;
    const pending = Promise.all([
      first.createOrTouch(rootA),
      second.createOrTouch(rootB),
    ]).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    await releaseExternal();
    await pending;

    expect((await second.list()).map((workspace) => workspace.root).toSorted()).toEqual(
      [rootA, rootB].toSorted(),
    );
    firstHost.dispose();
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

  it('derives sessions after an empty catalog has already been materialized', async () => {
    const root = join(homeDir, 'late-session');
    const workspaceId = encodeWorkDirKey(root);
    await fsp.mkdir(root, { recursive: true });
    expect(await build().list()).toEqual([]);
    await seedSessionIndex([
      {
        sessionId: 'late-session',
        sessionDir: join(homeDir, 'sessions', workspaceId, 'late-session'),
        workDir: root,
      },
    ]);

    await expect(build().get(workspaceId)).resolves.toMatchObject({
      id: workspaceId,
      root,
    });
    await expect(build().createOrTouch(root)).resolves.toMatchObject({
      id: workspaceId,
      root,
    });
  });

  it('prefers an existing workspaces.json over the session index', async () => {
    const work = join(homeDir, 'existing');
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
        sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(join(homeDir, 'from-index')), 's9'),
        workDir: join(homeDir, 'from-index'),
      },
    ]);

    const list = await build().list();
    expect(list.map((w) => w.id)).toEqual([encodeWorkDirKey(work)]);
    expect(list[0]?.name).toBe('existing');
  });

  it('rebuilds from the session index when workspaces.json is malformed', async () => {
    const work = join(homeDir, 'malformed');
    await fsp.writeFile(join(homeDir, 'workspaces.json'), '{not json', 'utf8');
    await seedSessionIndex([
      {
        sessionId: 's-malformed',
        sessionDir: join(homeDir, 'sessions', encodeWorkDirKey(work), 's-malformed'),
        workDir: work,
      },
    ]);

    await expect(build().list()).resolves.toEqual([
      expect.objectContaining({ id: encodeWorkDirKey(work), root: work }),
    ]);
  });

  it('writes through on update and delete', async () => {
    const created = await build().createOrTouch(homeDir, 'proj');
    await build().update(created.id, { name: 'renamed' });

    expect((await restart().get(created.id))?.name).toBe('renamed');

    await build().delete(created.id);
    expect(await restart().get(created.id)).toBeUndefined();
  });

  it('rejects createOrTouch when the root directory does not exist', async () => {
    const missing = join(homeDir, 'never-created');
    await expect(build().createOrTouch(missing)).rejects.toMatchObject({
      code: ErrorCodes.FS_PATH_NOT_FOUND,
    });
    expect(await build().list()).toEqual([]);
  });

  it('rejects createOrTouch when the root is not a directory', async () => {
    const file = join(homeDir, 'a-file.txt');
    await fsp.writeFile(file, 'hi', 'utf8');
    await expect(build().createOrTouch(file)).rejects.toMatchObject({
      code: ErrorCodes.FS_PATH_NOT_FOUND,
    });
    expect(await build().list()).toEqual([]);
  });

  it('rejects createOrTouch when a parent of the root is not a directory', async () => {
    const file = join(homeDir, 'a-file.txt');
    await fsp.writeFile(file, 'hi', 'utf8');
    await expect(build().createOrTouch(join(file, 'child'))).rejects.toMatchObject({
      code: ErrorCodes.FS_PATH_NOT_FOUND,
    });
  });

  it('collapses duplicate registered entries for the same root, preferring the canonical id', async () => {
    const root = join(homeDir, 'dup');
    const canonicalId = encodeWorkDirKey(root);
    const legacyId = 'wd_duplegacy_deadbeef0000';
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

  it('preserves an alias-only representative across registry operations', async () => {
    const root = join(homeDir, 'alias-only');
    const canonicalId = encodeWorkDirKey(root);
    const alias = 'wd_alias_only_deadbeef0000';
    await fsp.mkdir(root, { recursive: true });
    await writeWorkspacesJson({
      [alias]: {
        root,
        name: 'alias-only',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const registry = build();
    await expect(registry.list()).resolves.toEqual([
      expect.objectContaining({ id: alias, root }),
    ]);
    await expect(registry.get(canonicalId)).resolves.toMatchObject({ id: alias, root });
    await expect(registry.createOrTouch(root, 'new-name')).resolves.toMatchObject({
      id: alias,
      root,
      name: 'alias-only',
    });
    await expect(registry.update(alias, { name: 'renamed' })).resolves.toMatchObject({
      id: alias,
      name: 'renamed',
    });
  });

  it('rebuilds an alias-only workspace from the physical session bucket id', async () => {
    const root = join(homeDir, 'rebuild-alias');
    const alias = 'wd_rebuild_alias_deadbeef0000';
    await seedSessionIndex([
      {
        sessionId: 'legacy-session',
        sessionDir: join(homeDir, 'sessions', alias, 'legacy-session'),
        workDir: root,
      },
    ]);

    const registry = build();
    await expect(registry.list()).resolves.toEqual([
      expect.objectContaining({ id: alias, root }),
    ]);
    await expect(registry.get(alias)).resolves.toMatchObject({ id: alias, root });
  });

  it('ignores session index entries outside the sessions tree', async () => {
    const root = join(homeDir, 'valid-root');
    await seedSessionIndex([
      {
        sessionId: 'relative',
        sessionDir: 'sessions/wd_relative_000000000000/relative',
        workDir: root,
      },
      {
        sessionId: 'outside',
        sessionDir: join(homeDir, 'outside', 'wd_outside_000000000000', 'outside'),
        workDir: root,
      },
      {
        sessionId: 'escape',
        sessionDir: join(homeDir, 'sessions', '..', 'escape', 'escape'),
        workDir: root,
      },
    ]);

    await expect(build().list()).resolves.toEqual([]);
  });

  it('creates the home directory before acquiring the first workspace lock', async () => {
    const registry = build();
    await fsp.rm(homeDir, { recursive: true, force: true });

    await expect(registry.list()).resolves.toEqual([]);
    expect((await fsp.stat(homeDir)).isDirectory()).toBe(true);
  });

  it('keeps a derived workspace tombstoned after a registry restart', async () => {
    const root = join(homeDir, 'derived');
    const id = encodeWorkDirKey(root);
    await seedSessionIndex([
      {
        sessionId: 'derived-session',
        sessionDir: join(homeDir, 'sessions', id, 'derived-session'),
        workDir: root,
      },
    ]);

    const registry = build();
    expect((await registry.list()).map((workspace) => workspace.id)).toContain(id);
    await registry.delete(id);

    expect((await restart().list()).map((workspace) => workspace.id)).not.toContain(id);
  });
});
