import { mkdtempSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import type { ILogService } from '#/_base/log/log';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import type { IEventService } from '#/app/event/event';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { FileProjectPersistence } from '#/app/project/fileProjectPersistence';
import { ProjectService } from '#/app/project/projectService';
import type { Project } from '#/app/project/project';
import { ProjectStateService } from '#/project/state/projectStateService';
import type { IProjectContext } from '#/project/projectContext/projectContext';
import { ProjectDirsService } from '#/project/projectDirs/projectDirsService';

import { linkedWorktree, mainCheckout } from '../../app/git/checkoutLayouts';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import { stubHostEnvironment } from '../../stubs';
import { stubConfigService } from '../../app/config/stubs';
import { ProjectTrustStore } from '#/project/projectTrust/projectTrustStore';

const noopLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
} as unknown as ILogService;

const noopEvent = {
  publish: () => {},
  subscribe: () => ({ dispose: () => {} }),
} as unknown as IEventService;

describe('WorkspaceDirsService (registry source)', () => {
  let homeDir: string;
  let dirA: string;
  let dirB: string;
  let dirC: string;
  let disposables: DisposableStore;
  let persistence: FileProjectPersistence;
  let workspaces: ProjectService;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'ws-dirs-home-'));
    dirA = mkdtempSync(join(tmpdir(), 'ws-dirs-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'ws-dirs-b-'));
    dirC = mkdtempSync(join(tmpdir(), 'ws-dirs-c-'));
    disposables = new DisposableStore();
    const storage = new FileStorageService(homeDir);
    const hostFs = new HostFileSystem();
    const bootstrap = stubBootstrap(homeDir);
    persistence = disposables.add(
      new FileProjectPersistence(new JsonAtomicDocumentStore(storage), storage, bootstrap),
    );
    const localConfig = new FileProjectLocalConfigService(bootstrap, hostFs);
    workspaces = new ProjectService(
      persistence,
      storage,
      new AppendLogStore(storage, noopLog),
      hostFs,
      localConfig,
      noopLog,
      noopEvent,
      stubHostEnvironment(homeDir),
      noopTelemetryService,
      bootstrap,
      new JsonAtomicDocumentStore(storage),
      new ProjectTrustStore(new JsonAtomicDocumentStore(storage), noopTelemetryService, bootstrap, stubConfigService()),
    );
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all(
      [homeDir, dirA, dirB, dirC].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function createDirs(
    cwd: string,
    workspaceId: string,
    kind: 'managed' | 'implicit' = 'implicit',
    environmentId = 'local',
    followsPrimary = environmentId === 'local',
  ): ProjectDirsService {
    const bootstrap = stubBootstrap(homeDir);
    const hostFs = new HostFileSystem();
    return disposables.add(
      new ProjectDirsService(
        {
          _serviceBrand: undefined,
          workspaceId,
          cwd,
          root: cwd,
          source: 'local',
          meta: { id: workspaceId, root: cwd, name: 'test', kind, createdAt: 0, lastOpenedAt: 0 },
          persistenceScope: `sessions/${workspaceId}`,
        } as unknown as IProjectContext,
        new FileProjectLocalConfigService(bootstrap, hostFs),
        workspaces,
        persistence,
        noopLog,
        new ProjectStateService(),
        environmentId,
        followsPrimary,
      ),
    );
  }

  it('coalesces pending registry reloads and applies changes received during an active reload', async () => {
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB] });
    const changes = disposables.add(new Emitter<void>());
    vi.spyOn(persistence, 'onDidChange').mockImplementation(changes.event);
    const dirs = createDirs(dirA, project.id, 'managed');
    await dirs.ready;
    let release!: (workspaces: readonly Project[]) => void;
    const held = new Promise<readonly Project[]>((resolve) => {
      release = resolve;
    });
    const list = vi.spyOn(workspaces, 'list').mockImplementationOnce(() => held);
    changes.fire();
    await vi.waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1);
    });
    await workspaces.update(project.id, { additionalDirs: [dirC] });
    for (let index = 0; index < 32; index += 1) changes.fire();
    release([project]);
    await dirs.dispose();
    expect(list).toHaveBeenCalledTimes(2);
    expect(dirs.additionalDirs).toEqual([dirC]);
  });

  it('keeps the current primary for managed scopes and lets implicit scopes absorb only implicit projects', async () => {
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'proj' });
    const primary = createDirs(dirA, project.id, 'managed');
    await primary.ready;
    expect(primary.additionalDirs).toEqual([dirB]);
    expect(primary.sessionInfo().primaryByWorkspace).toEqual({ [project.id]: dirA });

    const managedMember = createDirs(dirB, 'wd_other_000000000000');
    await managedMember.ready;
    expect(managedMember.additionalDirs).toEqual([]);
    expect(managedMember.sessionInfo().primaryByWorkspace).toEqual({});

    const implicitProject = await workspaces.resolveImplicit(dirC);
    await workspaces.update(implicitProject.id, { additionalDirs: [dirB] });
    const implicitMember = createDirs(dirB, 'wd_member_000000000000');
    await implicitMember.ready;
    expect(implicitMember.additionalDirs).toEqual([dirC]);
    expect(implicitMember.sessionInfo().primaryByWorkspace).toEqual({ [implicitProject.id]: dirC });

    const outsiderDir = mkdtempSync(join(tmpdir(), 'ws-dirs-outsider-'));
    try {
      const outsider = createDirs(outsiderDir, 'wd_else_000000000000');
      await outsider.ready;
      expect(outsider.additionalDirs).toEqual([]);
      expect(outsider.sessionInfo().primaryByWorkspace).toEqual({});
    } finally {
      await rm(outsiderDir, { recursive: true, force: true });
    }
  });

  it('keeps same-root managed workspaces scoped to their workspace id', async () => {
    const first = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'first' });
    const second = await workspaces.create({ root: dirA, additionalDirs: [dirC], name: 'second' });
    const firstDirs = createDirs(dirA, first.id, 'managed');
    const secondDirs = createDirs(dirA, second.id, 'managed');
    await Promise.all([firstDirs.ready, secondDirs.ready]);

    expect(firstDirs.additionalDirs).toEqual([dirB]);
    expect(firstDirs.sessionInfo().primaryByWorkspace).toEqual({ [first.id]: dirA });
    expect(secondDirs.additionalDirs).toEqual([dirC]);
    expect(secondDirs.sessionInfo().primaryByWorkspace).toEqual({ [second.id]: dirA });

    await workspaces.update(first.id, { additionalDirs: [] });
    await vi.waitFor(() => {
      expect(firstDirs.additionalDirs).toEqual([]);
    });
    await secondDirs.reload();
    expect(secondDirs.additionalDirs).toEqual([dirC]);
  });

  it('merges registry dirs with local.toml dirs for implicit scopes and skips a same-root managed project', async () => {
    const implicit = await workspaces.resolveImplicit(dirA);
    await workspaces.update(implicit.id, { additionalDirs: [dirB] });
    const managedDir = mkdtempSync(join(tmpdir(), 'ws-dirs-managed-'));
    await workspaces.create({ root: dirA, additionalDirs: [managedDir], name: 'proj' });
    await mkdir(join(dirA, '.kimi-code'), { recursive: true });
    await writeFile(
      join(dirA, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${dirC.replaceAll('\\', '\\\\')}"]\n`,
      'utf8',
    );

    try {
      const dirs = createDirs(dirA, implicit.id, 'implicit');
      await dirs.ready;
      expect(dirs.additionalDirs).toEqual([dirC, dirB]);

      await dirs.addDir({ path: dirB, persist: false });
      expect(dirs.additionalDirs).toEqual([dirC, dirB]);
    } finally {
      await rm(managedDir, { recursive: true, force: true });
    }
  });

  it('moves legacy local config and its watcher when an older version moves the implicit primary', async () => {
    const project = await workspaces.resolveImplicit(dirA);
    await workspaces.update(project.id, { additionalDirs: [dirB] });
    const dirD = mkdtempSync(join(tmpdir(), 'ws-dirs-d-'));
    const writeLocalConfig = async (root: string, additionalDirs: readonly string[]) => {
      await mkdir(join(root, '.kimi-code'), { recursive: true });
      const entries = additionalDirs.map((dir) => `"${dir.replaceAll('\\', '\\\\')}"`).join(', ');
      await writeFile(join(root, '.kimi-code', 'local.toml'), `[workspace]\nadditional_dir = [${entries}]\n`, 'utf8');
    };
    try {
      await writeLocalConfig(dirA, [dirC]);
      await writeLocalConfig(dirB, [dirD]);
      const dirs = createDirs(dirA, encodeWorkDirKey(dirA), 'implicit');
      await dirs.ready;
      expect(dirs.additionalDirs).toEqual([dirC, dirB]);

      await persistence.update((catalog) => ({
        ...catalog,
        workspaces: catalog.workspaces.map((entry) =>
          entry.id === project.id ? { ...entry, root: dirB, additionalDirs: [dirA] } : entry,
        ),
      }));
      await vi.waitFor(
        () => {
          expect(dirs.primary).toBe(dirB);
          expect(dirs.additionalDirs).toEqual([dirD, dirA]);
        },
        { timeout: 5_000 },
      );

      await writeLocalConfig(dirB, []);
      await vi.waitFor(
        () => {
          expect(dirs.additionalDirs).toEqual([dirA]);
        },
        { timeout: 5_000 },
      );
    } finally {
      await rm(dirD, { recursive: true, force: true });
    }
  });

  it('ignores local.toml entirely for managed workspaces', async () => {
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'proj' });
    await mkdir(join(dirA, '.kimi-code'), { recursive: true });
    await writeFile(
      join(dirA, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${dirC.replaceAll('\\', '\\\\')}"]\n`,
      'utf8',
    );

    const dirs = createDirs(dirA, project.id, 'managed');
    await dirs.ready;
    expect(dirs.additionalDirs).toEqual([dirB]);

    let fired = 0;
    dirs.onDidChange(() => {
      fired += 1;
    });
    await writeFile(
      join(dirA, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${dirA.replaceAll('\\', '\\\\')}", "${dirC.replaceAll('\\', '\\\\')}"]\n`,
      'utf8',
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(dirs.additionalDirs).toEqual([dirB]);
    expect(fired).toBe(0);

    await dirs.addDir({ path: dirC, persist: false });
    expect(dirs.additionalDirs).toEqual([dirB, dirC]);
    expect(dirs.sharedAdditionalDirs).toEqual([dirB]);
  });

  it('pushes registry updates live through the persistence change event', async () => {
    const project = await workspaces.create({ root: dirA, name: 'proj' });
    const dirs = createDirs(dirA, project.id, 'managed');
    await dirs.ready;
    expect(dirs.additionalDirs).toEqual([]);

    let fired = 0;
    dirs.onDidChange(() => {
      fired += 1;
    });
    await workspaces.update(project.id, { additionalDirs: [dirB] });
    await vi.waitFor(() => {
      expect(dirs.additionalDirs).toEqual([dirB]);
    });
    expect(fired).toBeGreaterThan(0);
  });

  it('persists added dirs to the workspace registry instead of local.toml', async () => {
    const project = await workspaces.create({ root: dirA, name: 'proj' });
    const dirs = createDirs(dirA, project.id, 'managed');
    await dirs.ready;

    const result = await dirs.addDir({ path: dirB, persist: true });
    expect(result.persisted).toBe(true);
    expect(result.projectRoot).toBe(dirA);
    expect(result.configPath).toBe(join(dirA, '.kimi-code', 'local.toml'));
    expect(result.additionalDirs).toEqual([dirB]);

    const entry = await workspaces.get(project.id);
    expect(entry?.additionalDirs).toEqual([dirB]);
    await expect(stat(join(dirA, '.kimi-code', 'local.toml'))).rejects.toThrow();

    const again = await dirs.addDir({ path: dirB, persist: true });
    expect(again.additionalDirs).toEqual([dirB]);
    expect((await workspaces.get(project.id))?.additionalDirs).toEqual([dirB]);
  });

  it('registers the hash entry on demand when persisting from a hash scope', async () => {
    const dirs = createDirs(dirA, encodeWorkDirKey(dirA));
    await dirs.ready;

    await dirs.addDir({ path: dirB, persist: true });

    const entry = await workspaces.get(encodeWorkDirKey(dirA));
    expect(entry?.additionalDirs).toEqual([dirB]);
  });

  it('persists and exposes additions from a folded implicit alias', async () => {
    const typedId = 'wd_typed_000000000001';
    const aliasRoot = `${dirA}/`;
    const aliasId = 'wd_alias_000000000002';
    await persistence.update(() => ({
      workspaces: [
        { id: typedId, root: dirA, name: 'typed', kind: 'implicit', additionalDirs: [], createdAt: 0, lastOpenedAt: 0 },
        { id: aliasId, root: aliasRoot, name: 'alias', kind: 'implicit', additionalDirs: [], createdAt: 0, lastOpenedAt: 0 },
      ],
      deletedIds: [],
      idempotencyKeys: {},
    }));
    const visibleIds = (await workspaces.list()).map((workspace) => workspace.id);
    const hiddenId = visibleIds.includes(typedId) ? aliasId : typedId;
    const hiddenRoot = hiddenId === aliasId ? aliasRoot : dirA;
    const dirs = createDirs(hiddenRoot, hiddenId);
    await dirs.ready;

    const result = await dirs.addDir({ path: dirB, persist: true });

    expect(result.additionalDirs).toContain(dirB);
    expect(dirs.additionalDirs).toContain(dirB);
    expect((await workspaces.get(hiddenId))?.additionalDirs).toEqual([dirB]);
  });

  it('adds the primary to a view pinned away from it for this session only, because a project cannot register it', async () => {
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'proj' });
    const pinned = createDirs(dirC, project.id, 'managed', 'local', false);
    await pinned.ready;
    let fired = 0;
    pinned.onDidChange(() => {
      fired += 1;
    });

    const result = await pinned.addDir({ path: dirA, persist: true });

    expect(result.persisted).toBe(false);
    expect(result.additionalDirs).toEqual([dirA]);
    expect(pinned.additionalDirs).toEqual([dirA]);
    expect(pinned.sharedAdditionalDirs).toEqual([]);
    expect(fired).toBe(1);
    expect((await workspaces.get(project.id))?.additionalDirs).toEqual([dirB]);
    expect((await pinned.addDir({ path: dirA, persist: true })).persisted).toBe(false);
  });

  it('keeps reporting the primary as remembered to views the project already gives it', async () => {
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'proj' });
    const atRoot = createDirs(dirA, project.id, 'managed');
    const atRegistered = createDirs(dirB, project.id, 'managed', 'local', false);
    await Promise.all([atRoot.ready, atRegistered.ready]);

    expect(await atRoot.addDir({ path: dirA, persist: true })).toMatchObject({ persisted: true, additionalDirs: [dirB] });
    expect(await atRegistered.addDir({ path: dirA, persist: true })).toMatchObject({ persisted: true, additionalDirs: [dirA] });
    expect((await workspaces.get(project.id))?.additionalDirs).toEqual([dirB]);
  });

  it('opens a remembered directory to the view that added it even when project dirs do not reach it', async () => {
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'proj' });
    const pinned = createDirs(dirC, project.id, 'managed', 'local', false);
    await pinned.ready;
    const dirD = mkdtempSync(join(tmpdir(), 'ws-dirs-d-'));
    try {
      const added = await pinned.addDir({ path: dirD, persist: true });
      expect(added).toMatchObject({ persisted: true, additionalDirs: [dirD] });
      expect((await workspaces.get(project.id))?.additionalDirs).toEqual([dirB, dirD]);

      const known = await pinned.addDir({ path: dirB, persist: true });
      expect(known).toMatchObject({ persisted: true, additionalDirs: [dirD, dirB] });
      expect((await workspaces.get(project.id))?.additionalDirs).toEqual([dirB, dirD]);
    } finally {
      await rm(dirD, { recursive: true, force: true });
    }
  });

  it('keeps persist:false dirs in memory only', async () => {
    const project = await workspaces.create({ root: dirA, name: 'proj' });
    const dirs = createDirs(dirA, project.id, 'managed');
    await dirs.ready;
    let fired = 0;
    dirs.onDidChange(() => {
      fired += 1;
    });

    const result = await dirs.addDir({ path: dirB, persist: false });

    expect(result.persisted).toBe(false);
    expect(result.projectRoot).toBe(dirA);
    expect(result.configPath).toBe(join(dirA, '.kimi-code', 'local.toml'));
    expect(result.additionalDirs).toEqual([dirB]);
    expect((await workspaces.get(project.id))?.additionalDirs).toEqual([]);
    expect(fired).toBe(1);
    await dirs.reload();
    expect(fired).toBe(1);
  });

  it('emits when a directory moves between ephemeral and shared sets', async () => {
    const project = await workspaces.create({ root: dirA, name: 'proj' });
    const dirs = createDirs(dirA, project.id, 'managed');
    await dirs.ready;
    await dirs.addDir({ path: dirB, persist: false });
    let fired = 0;
    dirs.onDidChange(() => {
      fired += 1;
    });

    await dirs.addDir({ path: dirB, persist: true });
    await vi.waitFor(() => expect(fired).toBeGreaterThan(0));
    expect(dirs.sharedAdditionalDirs).toEqual([dirB]);

    fired = 0;
    await workspaces.update(project.id, { additionalDirs: [] });
    await vi.waitFor(() => expect(fired).toBeGreaterThan(0));
    expect(dirs.sharedAdditionalDirs).toEqual([]);
    expect(dirs.additionalDirs).toEqual([dirB]);
  });

  it('observes a primary swap of an absorbed implicit project from a member cwd', async () => {
    const project = await workspaces.resolveImplicit(dirA);
    await workspaces.update(project.id, { additionalDirs: [dirB] });
    const dirs = createDirs(dirB, 'wd_member_000000000000');
    const oldPrimaryMember = createDirs(dirA, 'wd_old_member_000000000');
    await Promise.all([dirs.ready, oldPrimaryMember.ready]);
    expect(dirs.additionalDirs).toEqual([dirA]);
    expect(oldPrimaryMember.additionalDirs).toEqual([dirB]);
    expect(dirs.sessionInfo().primaryByWorkspace).toEqual({ [project.id]: dirA });
    let fired = 0;
    dirs.onDidChange(() => {
      fired += 1;
    });

    await persistence.update((catalog) => ({
      ...catalog,
      workspaces: catalog.workspaces.map((entry) =>
        entry.id === project.id ? { ...entry, root: dirB, additionalDirs: [dirA] } : entry,
      ),
    }));
    await vi.waitFor(() => {
      expect(dirs.sessionInfo().primaryByWorkspace).toEqual({ [project.id]: dirB });
    });

    expect(dirs.additionalDirs).toEqual([dirA]);
    expect(oldPrimaryMember.additionalDirs).toEqual([dirB]);
    expect(fired).toBe(1);
    await dirs.reload();
    expect(fired).toBe(1);
  });

  it('pins explicit local roots without expanding directory access', async () => {
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'proj' });
    const pinned = createDirs(dirC, project.id, 'managed', 'local', false);
    const following = createDirs(dirC, project.id, 'managed', 'local', true);
    await Promise.all([pinned.ready, following.ready]);

    expect(pinned.primary).toBe(dirC);
    expect(pinned.additionalDirs).toEqual([]);
    expect(pinned.sessionInfo().primaryByWorkspace).toEqual({});
    expect(following.primary).toBe(dirA);
    expect(following.additionalDirs).toEqual([dirB]);

    await workspaces.setPrimary(project.id, dirB);
    await vi.waitFor(() => {
      expect(following.primary).toBe(dirB);
    });
    await pinned.reload();
    expect(pinned.primary).toBe(dirC);
    expect(pinned.additionalDirs).toEqual([]);
    expect(pinned.sessionInfo().primaryByWorkspace).toEqual({});
    expect(following.additionalDirs).toEqual([dirA]);
  });

  it.each(['managed', 'implicit'] as const)(
    'gives a view pinned in the repository of a %s project its additional dirs but never the primary',
    async (kind) => {
      const main = mainCheckout(dirA);
      const worktree = linkedWorktree(join(main, '.git'), dirB);
      const subdir = join(main, 'src');
      const nested = mainCheckout(join(main, 'vendor', 'lib'));
      await mkdir(subdir);
      const project = kind === 'managed'
        ? await workspaces.create({ root: main })
        : await workspaces.resolveImplicit(main);
      await workspaces.update(project.id, { additionalDirs: [dirC] });
      const views = [worktree, subdir, nested].map((cwd) => createDirs(cwd, project.id, kind, 'local', false));
      await Promise.all(views.map((view) => view.ready));

      expect(views.map((view) => view.additionalDirs)).toEqual([[dirC], [dirC], []]);
      expect(views.map((view) => view.sessionInfo().primaryByWorkspace)).toEqual([{}, {}, {}]);

      await workspaces.update(project.id, { additionalDirs: [] });
      await vi.waitFor(() => {
        expect(views.map((view) => view.additionalDirs)).toEqual([[], [], []]);
      });
    },
  );

  it.each(['managed', 'implicit'] as const)(
    'keeps the primary away from a worktree of a %s project even when the worktree is registered, and remembers the worktree as itself without registering it',
    async (kind) => {
      const main = mainCheckout(dirA);
      const worktree = linkedWorktree(join(main, '.git'), dirB);
      const project = kind === 'managed'
        ? await workspaces.create({ root: main })
        : await workspaces.resolveImplicit(main);
      await workspaces.update(project.id, { additionalDirs: [dirC] });
      const view = createDirs(worktree, project.id, kind, 'local', false);
      await view.ready;

      expect(await view.addDir({ path: worktree, persist: true })).toMatchObject({ persisted: true, additionalDirs: [dirC] });
      expect((await workspaces.get(project.id))?.additionalDirs).toEqual([dirC]);

      await workspaces.update(project.id, { additionalDirs: [dirC, worktree] });
      await view.reload();
      expect(view.additionalDirs).toEqual([dirC]);
      expect(view.sessionInfo().primaryByWorkspace).toEqual({});
    },
  );

  it('keeps the complete directory set when the primary changes from the original cwd', async () => {
    const project = await workspaces.create({
      root: dirA,
      additionalDirs: [dirB],
      name: 'proj',
    });
    const dirs = createDirs(dirA, project.id, 'managed');
    await dirs.ready;

    await workspaces.setPrimary(project.id, dirB);
    await vi.waitFor(() => {
      expect(dirs.primary).toBe(dirB);
    });

    expect(dirs.additionalDirs).toEqual([dirA]);
    expect(dirs.sessionInfo().primaryByWorkspace).toEqual({ [project.id]: dirB });

    await workspaces.update(project.id, { additionalDirs: [dirA, dirC] });
    await vi.waitFor(() => {
      expect(dirs.additionalDirs).toEqual([dirA, dirC]);
    });
    expect(dirs.primary).toBe(dirB);
  });

  it('keeps a remote workdir rooted at its environment cwd without local registry roots', async () => {
    const project = await workspaces.create({
      root: dirA,
      additionalDirs: [dirB],
      name: 'proj',
    });
    const remoteCwd = join(dirC, 'remote-workdir');
    const dirs = createDirs(remoteCwd, project.id, 'managed', 'ssh-dev');
    await dirs.ready;

    expect(dirs.primary).toBe(remoteCwd);
    expect(dirs.additionalDirs).toEqual([]);
    expect(dirs.sessionInfo().primaryByWorkspace).toEqual({});
  });

  it('does not fire for project rename or touch', async () => {
    const project = await workspaces.create({
      root: dirA,
      additionalDirs: [dirB],
      name: 'proj',
    });
    const dirs = createDirs(dirA, project.id, 'managed');
    await dirs.ready;
    let fired = 0;
    dirs.onDidChange(() => {
      fired += 1;
    });

    await workspaces.update(project.id, { name: 'renamed' });
    await dirs.reload();
    await workspaces.touch(project.id);
    await dirs.reload();

    expect(fired).toBe(0);
    expect(dirs.additionalDirs).toEqual([dirB]);
    expect(dirs.sessionInfo().primaryByWorkspace).toEqual({ [project.id]: dirA });
  });

  it('coalesces local config and registry changes into one explicit reload event', async () => {
    const project = await workspaces.resolveImplicit(dirA);
    const dirs = createDirs(dirA, encodeWorkDirKey(dirA));
    await dirs.ready;
    await mkdir(join(dirA, '.kimi-code'), { recursive: true });
    await writeFile(
      join(dirA, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${dirC.replaceAll('\\', '\\\\')}"]\n`,
      'utf8',
    );
    await writeFile(
      join(homeDir, 'projects.json'),
      JSON.stringify({
        schema_version: 2,
        projects: {
          [project.id]: {
            root: dirA,
            name: 'proj',
            kind: 'implicit',
            additional_dirs: [dirB],
            created_at: new Date(project.createdAt).toISOString(),
            last_opened_at: new Date(project.lastOpenedAt).toISOString(),
          },
        },
        deleted_project_ids: [],
        idempotency_keys: {},
      }),
      'utf8',
    );
    let fired = 0;
    dirs.onDidChange(() => {
      fired += 1;
    });

    await dirs.reload();

    expect(dirs.additionalDirs).toEqual([dirC, dirB]);
    expect(fired).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fired).toBe(1);
  });

  it('waits for a pending registry reload during dispose', async () => {
    let resolveList!: () => void;
    const pending = new Promise<never[]>((resolve) => {
      resolveList = () => resolve([]);
    });
    const list = vi.spyOn(workspaces, 'list').mockImplementationOnce(() => pending);
    const dirs = createDirs(dirA, encodeWorkDirKey(dirA));
    let settled = false;
    const disposal = dirs.dispose().then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(list).toHaveBeenCalled();
    });
    expect(settled).toBe(false);
    resolveList();
    await disposal;
    expect(settled).toBe(true);
    await dirs.ready;
    list.mockRestore();
  });

  it('drops a deleted project from the primary snapshot without substituting cwd', async () => {
    const project = await workspaces.create({
      root: dirA,
      additionalDirs: [dirB],
      name: 'proj',
    });
    const dirs = createDirs(dirA, project.id, 'managed');
    await dirs.ready;

    await workspaces.delete(project.id);
    await vi.waitFor(() => {
      expect(dirs.additionalDirs).toEqual([]);
    });

    expect(dirs.sessionInfo().primaryByWorkspace).toEqual({});
  });

  it('keeps an initial local config failure on ready without an unhandled watcher rejection', async () => {
    await mkdir(join(dirA, '.kimi-code'), { recursive: true });
    await writeFile(
      join(dirA, '.kimi-code', 'local.toml'),
      '[workspace]\nadditional_dir = ["missing"]\n',
      'utf8',
    );
    const dirs = createDirs(dirA, encodeWorkDirKey(dirA));

    await expect(dirs.ready).rejects.toThrow(
      `workspace.additional_dir must exist and be a directory: ${join(dirA, 'missing')}`,
    );
  });
});
