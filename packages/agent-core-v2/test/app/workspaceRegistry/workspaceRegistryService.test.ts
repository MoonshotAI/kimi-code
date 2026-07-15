import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

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
    extra?: { readonly deleted_workspace_ids?: unknown },
  ): Promise<void> {
    await fsp.writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({ version: 1, workspaces, ...extra }),
      'utf8',
    );
  }

  async function readWorkspacesJson(): Promise<{
    workspaces: Record<string, PersistedWorkspaceEntry>;
    deleted_workspace_ids?: unknown;
  }> {
    return JSON.parse(await fsp.readFile(join(homeDir, 'workspaces.json'), 'utf8')) as {
      workspaces: Record<string, PersistedWorkspaceEntry>;
      deleted_workspace_ids?: unknown;
    };
  }

  it('persists the catalog across registry instances', async () => {
    const created = await build().createOrTouch(homeDir, 'proj');

    const list = await restart().list();
    expect(list.map((w) => w.id)).toContain(created.id);
    expect(list.find((w) => w.id === created.id)?.name).toBe('proj');
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
    // The registered entry keeps its persisted data; the merged entry only
    // gets a basename-derived name.
    expect(existing?.name).toBe('existing');
    expect(existing?.lastOpenedAt).toBe(Date.parse('2024-01-02T00:00:00.000Z'));
    expect(list.find((w) => w.id === encodeWorkDirKey(fromIndex))?.name).toBe('from-index');

    // The merge is persisted, so a restart sees the same catalog.
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

    // The tombstone is on disk in the v1-compatible field.
    const onDisk = await readWorkspacesJson();
    expect(onDisk.deleted_workspace_ids).toEqual([a.id]);
    expect(onDisk.workspaces[a.id]).toBeUndefined();

    // Sessions referencing the deleted workDir must not resurrect it.
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
    expect(await readWorkspacesJson().then((f) => f.deleted_workspace_ids)).toEqual([]);

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

    // Simulate a v1 writer touching the file after the v2 registry already
    // ran an operation: a new workspace entry plus an unrelated tombstone.
    const onDisk = await readWorkspacesJson();
    onDisk.workspaces[encodeWorkDirKey(dirB)] = {
      root: dirB,
      name: 'dir-b',
      created_at: '2024-01-01T00:00:00.000Z',
      last_opened_at: '2024-01-01T00:00:00.000Z',
    };
    await fsp.writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        workspaces: onDisk.workspaces,
        deleted_workspace_ids: ['wd_external_tombstone'],
      }),
      'utf8',
    );

    await registry.createOrTouch(dirC);

    const after = await readWorkspacesJson();
    expect(Object.keys(after.workspaces).toSorted()).toEqual(
      [encodeWorkDirKey(dirA), encodeWorkDirKey(dirB), encodeWorkDirKey(dirC)].toSorted(),
    );
    expect(after.deleted_workspace_ids).toEqual(['wd_external_tombstone']);
    // Reads also see the external entry without a restart.
    expect((await registry.list()).map((w) => w.id)).toContain(encodeWorkDirKey(dirB));
  });

  it('delete adds its tombstone on top of the current file state', async () => {
    const dirA = join(homeDir, 'dir-a');
    await fsp.mkdir(dirA);
    const registry = build();
    const a = await registry.createOrTouch(dirA);

    const onDisk = await readWorkspacesJson();
    await fsp.writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        workspaces: onDisk.workspaces,
        deleted_workspace_ids: ['wd_external_tombstone'],
      }),
      'utf8',
    );

    await registry.delete(a.id);

    const after = await readWorkspacesJson();
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

    // External rename on disk: the update must start from it, not stale state.
    const onDisk = await readWorkspacesJson();
    const entry = onDisk.workspaces[a.id];
    if (entry === undefined) throw new Error('seed entry missing');
    onDisk.workspaces[a.id] = { ...entry, name: 'external-name' };
    await fsp.writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({ version: 1, workspaces: onDisk.workspaces, deleted_workspace_ids: [] }),
      'utf8',
    );

    const renamed = await registry.update(a.id, { name: 'local-name' });
    expect(renamed?.name).toBe('local-name');
    expect(renamed?.lastOpenedAt).toBe(Date.parse(entry.last_opened_at));

    // External removal: update reports the id as gone instead of resurrecting.
    await fsp.writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({ version: 1, workspaces: {}, deleted_workspace_ids: [] }),
      'utf8',
    );
    expect(await registry.update(a.id, { name: 'whatever' })).toBeUndefined();
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

  it('accepts createOrTouch when the root is given through a symlink', async () => {
    const real = join(homeDir, 'real-root');
    await fsp.mkdir(real, { recursive: true });
    const link = join(homeDir, 'link-root');
    await fsp.symlink(real, link, 'dir');
    const ws = await build().createOrTouch(link);
    expect(ws.root).toBe(link);
    expect(ws.id).toBe(encodeWorkDirKey(link));
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
});
