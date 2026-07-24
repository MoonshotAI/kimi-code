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
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { WorkspaceService } from '#/app/workspace/workspaceService';
import { FileWorkspacePersistence } from '#/app/workspace/fileWorkspacePersistence';
import {
  IWorkspacePersistence,
  type PersistedWorkspaceEntry,
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
      InstantiationType.Delayed,
      'workspace',
    );
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceService,
      WorkspaceService,
      InstantiationType.Delayed,
      'workspace',
    );
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceAliases,
      WorkspaceAliasesService,
      InstantiationType.Delayed,
      'workspaceAliases',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-aliases-'));
  });

  afterEach(async () => {
    currentHost?.dispose();
    currentHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(hostFs: IHostFileSystem = new HostFileSystem()): IWorkspaceAliases {
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IHostFileSystem, hostFs),
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
    // A legacy catalog holds two entries whose roots differ only by casing —
    // one physical folder, two bucket ids (this is what `dedupeByRoot` merges
    // for listing; the alias set exposes both for multi-bucket reads).
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
    // The sibling bucket's spelling was never registered: only the legacy
    // session index remembers it. Malformed index lines are skipped, never
    // thrown.
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
    // Unknown id: callers keep their existing not-found semantics.
    expect(await aliases.resolveAliasIds('wd_missing_000000000000')).toEqual([
      'wd_missing_000000000000',
    ]);
    // POSIX roots never fold, so the alias set is just the id itself.
    expect(await aliases.resolveAliasIds(id)).toEqual([id]);
  });
});
