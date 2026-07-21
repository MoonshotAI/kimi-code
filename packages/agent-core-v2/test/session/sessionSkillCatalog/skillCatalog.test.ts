/**
 * Scenario: session skill-source discovery, merge, and plugin refresh.
 *
 * Exercises the real scoped catalog and source services with filesystem or
 * in-memory discovery boundaries, including controlled concurrent refreshes.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/sessionSkillCatalog/skillCatalog.test.ts`.
 */

import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { describe, expect, it } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { LifecycleScope } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IPluginService } from '#/app/plugin/plugin';
import type { ReloadSummary } from '#/app/plugin/types';
import { IProviderService } from '#/kosong/provider/provider';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IConfigService } from '#/app/config/config';
import {
  EXTRA_SKILL_DIRS_SECTION,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
} from '#/app/skillCatalog/configSection';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import '#/index';
import { InMemorySkillDiscovery } from '#/app/skillCatalog/inMemorySkillDiscovery';
import type { SkillContribution } from '#/app/skillCatalog/skillSource';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IPluginSkillSource } from '#/session/sessionSkillCatalog/pluginSkillSource';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import type { SkillRoot } from '#/app/skillCatalog/types';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { stubSkill } from '../../app/skillCatalog/stubs';
import { stubProviderService } from '../../app/provider/stubs';

const bootstrapStub = stubBootstrap('/home');

function configStub(): IConfigService & {
  setExtraSkillDirs(dirs: readonly string[]): void;
  setMergeAllAvailableSkills(value: boolean): void;
  fireSectionChange(domain: string): void;
} {
  let extraSkillDirs: readonly string[] = [];
  let mergeAllAvailableSkills = true;
  const sectionChangeListeners: Array<(event: unknown) => void> = [];
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: (listener: (event: unknown) => void) => {
      sectionChangeListeners.push(listener);
      return { dispose: () => {} };
    },
    get: (domain: string) => {
      if (domain === EXTRA_SKILL_DIRS_SECTION) return [...extraSkillDirs];
      if (domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) return mergeAllAvailableSkills;
      return undefined;
    },
    inspect: () => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: undefined }),
    getAll: () => ({}),
    set: async () => {},
    replace: async () => {},
    reload: async () => {},
    diagnostics: () => [],
    setExtraSkillDirs: (dirs: readonly string[]) => {
      extraSkillDirs = [...dirs];
    },
    setMergeAllAvailableSkills: (value: boolean) => {
      mergeAllAvailableSkills = value;
    },
    fireSectionChange: (domain: string) => {
      for (const listener of sectionChangeListeners) {
        listener({ domain, source: 'set', value: undefined, previousValue: undefined });
      }
    },
  } as unknown as IConfigService & {
    setExtraSkillDirs(dirs: readonly string[]): void;
    setMergeAllAvailableSkills(value: boolean): void;
    fireSectionChange(domain: string): void;
  };
}

function pluginStub(
  skillRoots: readonly SkillRoot[] = [],
  reloadEmitter?: Emitter<ReloadSummary>,
): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: reloadEmitter !== undefined ? reloadEmitter.event : () => ({ dispose: () => {} }),
    listPlugins: async () => [],
    installPlugin: async () => ({ id: '' }) as never,
    setPluginEnabled: async () => {},
    setPluginMcpServerEnabled: async () => {},
    removePlugin: async () => {},
    reloadPlugins: async () => ({ added: [], removed: [], errors: [] }),
    getPluginInfo: async () => {
      throw new Error('getPluginInfo is not used by these tests');
    },
    listPluginCommands: async () => [],
    checkUpdates: async () => [],
    pluginSkillRoots: async () => skillRoots,
    enabledSessionStarts: async () => [],
    enabledMcpServers: async () => ({}),
    enabledHooks: async () => [],
  };
}

function workspaceStub(workDir: string): {
  readonly stub: ISessionWorkspaceContext;
  setWorkDir(dir: string): void;
} {
  let current = workDir;
  const stub = {
    _serviceBrand: undefined,
    get workDir() {
      return current;
    },
    additionalDirs: [] as readonly string[],
    setWorkDir: (dir: string) => {
      current = dir;
    },
    setAdditionalDirs: () => {},
    resolve: (rel: string) => rel,
    isWithin: () => true,
    assertAllowed: (p: string) => p,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  } satisfies ISessionWorkspaceContext;
  return { stub, setWorkDir: (dir) => { current = dir; } };
}

function makeHost(
  store: ISkillDiscovery,
  ws: ISessionWorkspaceContext,
  pluginRoots: readonly SkillRoot[] = [],
  explicitDirs?: readonly string[],
  pluginReloadEmitter?: Emitter<ReloadSummary>,
) {
  const config = configStub();
  const runtimeOptions = {
    _serviceBrand: undefined,
    explicitDirs,
  } as unknown as ISkillCatalogRuntimeOptions;
  const host = createScopedTestHost([
    stubPair(ISkillDiscovery, store),
    stubPair(IBootstrapService, bootstrapStub),
    stubPair(IConfigService, config),
    stubPair(ISkillCatalogRuntimeOptions, runtimeOptions),
    stubPair(IPluginService, pluginStub(pluginRoots, pluginReloadEmitter)),
  ]);
  const session = host.child(LifecycleScope.Session, 's1', [stubPair(ISessionWorkspaceContext, ws)]);
  return { host, session, config };
}

function waitForEvents(event: Event<unknown>, count: number): Promise<void> {
  return new Promise((resolve) => {
    let received = 0;
    const disposable = event(() => {
      received += 1;
      if (received === count) {
        disposable.dispose();
        resolve();
      }
    });
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withSkillCatalogWorkspace(
  run: (fixture: { readonly workDir: string; readonly skillRoot: string }) => Promise<void>,
): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
  const skillRoot = join(workDir, '.kimi-code', 'skills');
  await mkdir(skillRoot, { recursive: true });
  try {
    await run({ workDir, skillRoot: await realpath(skillRoot) });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

describe('SessionSkillCatalogService', () => {
  it('merges global and project skills; project wins on name collision', async () => {
    const store = new InMemorySkillDiscovery();
    store.setUserSkills([
      stubSkill('global-only'),
      stubSkill('shared', { description: 'from user' }),
    ]);
    store.setProjectSkills([
      stubSkill('project-only'),
      stubSkill('shared', { description: 'from project' }),
    ]);
    const { stub: ws } = workspaceStub('/work');
    const { host, session } = makeHost(store, ws);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();

    const names = catalog.catalog.listSkills().map((s) => s.name);
    expect(names).toContain('global-only');
    expect(names).toContain('project-only');
    expect(names).toContain('shared');
    expect(catalog.catalog.getSkill('shared')?.description).toBe('from project');
    host.dispose();
  });

  it('orders project, user and plugin skills as project > user > plugin', async () => {
    const store = new InMemorySkillDiscovery();
    store.setUserSkills([
      stubSkill('shared', { description: 'from user' }),
      stubSkill('user-plugin', { description: 'from user' }),
    ]);
    store.setProjectSkills([stubSkill('shared', { description: 'from project' })]);
    store.setExtraSkills([
      stubSkill('shared', { description: 'from extra', source: 'extra' }),
      stubSkill('user-plugin', { description: 'from extra', source: 'extra' }),
      stubSkill('extra-plugin', { description: 'from extra', source: 'extra' }),
    ]);
    store.setPluginSkills([
      stubSkill('shared', {
        description: 'from plugin',
        source: 'extra',
        plugin: { id: 'demo' },
      }),
      stubSkill('user-plugin', {
        description: 'from plugin',
        source: 'extra',
        plugin: { id: 'demo' },
      }),
      stubSkill('extra-plugin', {
        description: 'from plugin',
        source: 'extra',
        plugin: { id: 'demo' },
      }),
    ]);
    const pluginRoot: SkillRoot = {
      path: '/plugins/demo/skills',
      source: 'extra',
      plugin: { id: 'demo' },
    };
    const { stub: ws } = workspaceStub('/work');
    const { host, session, config } = makeHost(store, ws, [pluginRoot]);
    config.setExtraSkillDirs(['/']);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();

    expect(catalog.catalog.getSkill('shared')?.description).toBe('from project');
    expect(catalog.catalog.getSkill('user-plugin')?.description).toBe('from user');
    expect(catalog.catalog.getSkill('extra-plugin')?.description).toBe('from extra');
    host.dispose();
  });

  it('replaces default user and project discovery with explicitDirs', async () => {
    const store = new InMemorySkillDiscovery();
    store.setUserSkills([stubSkill('from-explicit', { description: 'from explicit' })]);
    store.setProjectSkills([stubSkill('project-only', { description: 'from project' })]);
    store.setExtraSkills([stubSkill('extra-only', { description: 'from extra', source: 'extra' })]);
    store.setPluginSkills([
      stubSkill('plugin-only', {
        description: 'from plugin',
        source: 'extra',
        plugin: { id: 'demo' },
      }),
    ]);
    const pluginRoot: SkillRoot = {
      path: '/plugins/demo/skills',
      source: 'extra',
      plugin: { id: 'demo' },
    };
    const { stub: ws } = workspaceStub('/work');
    const { host, session, config } = makeHost(store, ws, [pluginRoot], ['/']);
    config.setExtraSkillDirs(['/']);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();

    expect(catalog.catalog.getSkill('from-explicit')?.description).toBe('from explicit');
    expect(catalog.catalog.getSkill('project-only')).toBeUndefined();
    expect(catalog.catalog.getSkill('extra-only')?.description).toBe('from extra');
    expect(catalog.catalog.getSkill('plugin-only')?.description).toBe('from plugin');
    host.dispose();
  });

  it('waits for config ready before loading extra skill dirs', async () => {
    let markReady!: () => void;
    let ready = false;
    const configReady = new Promise<void>((resolve) => {
      markReady = () => {
        ready = true;
        resolve();
      };
    });
    const config = {
      ...configStub(),
      ready: configReady,
      get: (domain: string) => {
        if (domain === EXTRA_SKILL_DIRS_SECTION) return ready ? ['/'] : [];
        if (domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) return true;
        return undefined;
      },
    } as unknown as IConfigService;
    const store = new InMemorySkillDiscovery();
    store.setExtraSkills([stubSkill('extra-only', { description: 'from extra', source: 'extra' })]);
    const runtimeOptions = {
      _serviceBrand: undefined,
    } as unknown as ISkillCatalogRuntimeOptions;
    const { stub: ws } = workspaceStub('/work');
    const host = createScopedTestHost([
      stubPair(ISkillDiscovery, store),
      stubPair(IBootstrapService, bootstrapStub),
      stubPair(IConfigService, config),
      stubPair(ISkillCatalogRuntimeOptions, runtimeOptions),
      stubPair(IPluginService, pluginStub()),
    ]);
    const session = host.child(LifecycleScope.Session, 's1', [stubPair(ISessionWorkspaceContext, ws)]);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    let settled = false;
    const loading = catalog.load().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    markReady();
    await loading;

    expect(catalog.catalog.getSkill('extra-only')?.description).toBe('from extra');
    host.dispose();
  });

  it('reloads user and workspace sources when mergeAllAvailableSkills changes', async () => {
    class CountingDiscovery implements ISkillDiscovery {
      declare readonly _serviceBrand: undefined;
      calls = 0;
      async discover() {
        this.calls++;
        return { skills: [], skipped: [], scannedRoots: [] };
      }
    }
    const store = new CountingDiscovery();
    const config = configStub();
    const runtimeOptions = {
      _serviceBrand: undefined,
    } as unknown as ISkillCatalogRuntimeOptions;
    const { stub: ws } = workspaceStub('/work');
    const host = createScopedTestHost([
      stubPair(ISkillDiscovery, store),
      stubPair(IBootstrapService, bootstrapStub),
      stubPair(IConfigService, config),
      stubPair(ISkillCatalogRuntimeOptions, runtimeOptions),
      stubPair(IPluginService, pluginStub()),
    ]);
    const session = host.child(LifecycleScope.Session, 's1', [stubPair(ISessionWorkspaceContext, ws)]);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();
    const afterLoad = store.calls;

    const reloaded = waitForEvents(catalog.onDidChange, 2);
    config.fireSectionChange(MERGE_ALL_AVAILABLE_SKILLS_SECTION);
    await reloaded;

    expect(store.calls).toBe(afterLoad + 2);
    host.dispose();
  });

  it('reload replaces project skills when the workDir changes', async () => {
    const store = new InMemorySkillDiscovery();
    store.setUserSkills([stubSkill('global-only')]);
    store.setProjectSkills([stubSkill('first')]);
    const { stub: ws, setWorkDir } = workspaceStub('/work1');
    const { host, session } = makeHost(store, ws);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();
    expect(catalog.catalog.getSkill('first')).toBeDefined();

    setWorkDir('/work2');
    store.setProjectSkills([stubSkill('second')]);
    const changes: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => changes.push(sourceId));
    await catalog.reload();

    expect(catalog.catalog.getSkill('first')).toBeUndefined();
    expect(catalog.catalog.getSkill('second')).toBeDefined();
    expect(catalog.catalog.getSkill('global-only')).toBeDefined();
    expect(changes).toEqual(['catalog']);
    subscription.dispose();
    host.dispose();
  });

  it('does not reload when the workDir is unchanged', async () => {
    const store = new InMemorySkillDiscovery();
    store.setProjectSkills([stubSkill('first')]);
    const { stub: ws } = workspaceStub('/work');
    const { host, session } = makeHost(store, ws);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();

    store.setProjectSkills([stubSkill('second')]);
    await catalog.load();

    expect(catalog.catalog.getSkill('first')).toBeDefined();
    expect(catalog.catalog.getSkill('second')).toBeUndefined();
    host.dispose();
  });

  it('passes plugin skill roots to the store so plugin skills are discoverable', async () => {
    const pluginRoot: SkillRoot = {
      path: '/plugins/demo/skills',
      source: 'extra',
      plugin: { id: 'demo', instructions: 'Use the demo tools.' },
    };
    class ExtraRootStore implements ISkillDiscovery {
      declare readonly _serviceBrand: undefined;
      receivedRoots: readonly SkillRoot[] | undefined;
      async discover(roots: readonly SkillRoot[]) {
        if (roots.some((root) => root.plugin !== undefined)) {
          this.receivedRoots = roots;
        }
        const pluginSkills = roots
          .filter((root) => root.plugin !== undefined)
          .map((root) => stubSkill('demo-skill', { source: 'extra', plugin: root.plugin }));
        return { skills: pluginSkills, skipped: [], scannedRoots: [] };
      }
    }
    const store = new ExtraRootStore();
    const { stub: ws } = workspaceStub('/work');
    const { host, session } = makeHost(store, ws, [pluginRoot]);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();

    expect(store.receivedRoots).toEqual([pluginRoot]);
    expect(catalog.catalog.getSkill('demo-skill')?.plugin?.id).toBe('demo');
    expect(catalog.catalog.getPluginSkill('demo', 'demo-skill')).toBeDefined();
    host.dispose();
  });

  it('feeds scanned roots from file sources into the merged catalog', async () => {
    await withSkillCatalogWorkspace(async ({ workDir, skillRoot }) => {
      class RootDiscovery implements ISkillDiscovery {
        declare readonly _serviceBrand: undefined;
        async discover(roots: readonly SkillRoot[]) {
          return {
            skills: [],
            skipped: [],
            scannedRoots: roots
              .filter((root) => root.source === 'project')
              .map((root) => root.path),
          };
        }
      }
      const { stub: ws } = workspaceStub(workDir);
      const { host, session } = makeHost(new RootDiscovery(), ws);

      try {
        const catalog = session.accessor.get(ISessionSkillCatalog);
        await catalog.load();

        expect(catalog.catalog.getSkillRoots()).toEqual([skillRoot]);
      } finally {
        host.dispose();
      }
    });
  });

  it('feeds skipped skills from file sources into the merged catalog', async () => {
    await withSkillCatalogWorkspace(async ({ workDir }) => {
      const skippedEntry = {
        path: join(workDir, '.kimi-code', 'skills', 'bad', 'SKILL.md'),
        type: 'nope',
        reason: 'unsupported skill type "nope"',
      };
      class SkippingDiscovery implements ISkillDiscovery {
        declare readonly _serviceBrand: undefined;
        async discover(roots: readonly SkillRoot[]) {
          const isProject = roots.some((root) => root.source === 'project');
          return {
            skills: [],
            skipped: isProject ? [skippedEntry] : [],
            scannedRoots: [],
          };
        }
      }
      const { stub: ws } = workspaceStub(workDir);
      const { host, session } = makeHost(new SkippingDiscovery(), ws);

      try {
        const catalog = session.accessor.get(ISessionSkillCatalog);
        await catalog.load();

        expect(catalog.catalog.getSkippedByPolicy()).toEqual([skippedEntry]);
      } finally {
        host.dispose();
      }
    });
  });

  it('fires onDidChange with the plugin source id after a plugin reload re-pulls plugin skills', async () => {
    const store = new InMemorySkillDiscovery();
    store.setPluginSkills([
      stubSkill('demo-skill', { source: 'extra', plugin: { id: 'demo' } }),
    ]);
    const reloadEmitter = new Emitter<ReloadSummary>();
    const pluginRoot: SkillRoot = {
      path: '/plugins/demo/skills',
      source: 'extra',
      plugin: { id: 'demo' },
    };
    const { stub: ws } = workspaceStub('/work');
    const { host, session } = makeHost(store, ws, [pluginRoot], undefined, reloadEmitter);

    try {
      const catalog = session.accessor.get(ISessionSkillCatalog);
      await catalog.load();
      expect(catalog.catalog.getPluginSkill('demo', 'demo-skill')).toBeDefined();

      const refreshed = new Promise<string>((resolve) => {
        const d = catalog.onDidChange((sourceId) => {
          d.dispose();
          resolve(sourceId);
        });
      });
      reloadEmitter.fire({ added: [], removed: [], errors: [] });

      await expect(refreshed).resolves.toBe('plugin');
    } finally {
      host.dispose();
      reloadEmitter.dispose();
    }
  });

  it('queues a plugin refresh during initial load so the refreshed contribution remains active', async () => {
    const initialLoad = deferred<SkillContribution>();
    const refreshedLoad = deferred<SkillContribution>();
    const initialStarted = deferred<void>();
    const refreshedStarted = deferred<void>();
    const sourceChanges = new Emitter<void>();
    let loadCount = 0;
    const pluginSource: IPluginSkillSource = {
      _serviceBrand: undefined,
      id: 'plugin',
      priority: 5,
      onDidChange: sourceChanges.event,
      load: () => {
        loadCount += 1;
        if (loadCount === 1) {
          initialStarted.resolve(undefined);
          return initialLoad.promise;
        }
        if (loadCount === 2) {
          refreshedStarted.resolve(undefined);
          return refreshedLoad.promise;
        }
        throw new Error('unexpected plugin source load');
      },
    };
    const { stub: ws } = workspaceStub('/work');
    const host = createScopedTestHost([
      stubPair(ISkillDiscovery, new InMemorySkillDiscovery()),
      stubPair(IBootstrapService, bootstrapStub),
      stubPair(IConfigService, configStub()),
      stubPair(ISkillCatalogRuntimeOptions, {
        _serviceBrand: undefined,
      } as unknown as ISkillCatalogRuntimeOptions),
      stubPair(IPluginService, pluginStub()),
    ]);
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(ISessionWorkspaceContext, ws),
      stubPair(IPluginSkillSource, pluginSource),
    ]);

    try {
      const catalog = session.accessor.get(ISessionSkillCatalog);
      const loading = catalog.load();
      await initialStarted.promise;
      const sourceIds: string[] = [];
      const refreshed = new Promise<void>((resolve) => {
        const subscription = catalog.onDidChange((sourceId) => {
          sourceIds.push(sourceId);
          if (sourceId === 'plugin') {
            subscription.dispose();
            resolve();
          }
        });
      });

      sourceChanges.fire();

      expect(loadCount).toBe(1);

      initialLoad.resolve({
        skills: [
          stubSkill('stale-skill', { source: 'extra', plugin: { id: 'demo' } }),
        ],
      });
      await refreshedStarted.promise;
      refreshedLoad.resolve({
        skills: [
          stubSkill('fresh-skill', { source: 'extra', plugin: { id: 'demo' } }),
        ],
      });
      await Promise.all([loading, refreshed]);

      expect(sourceIds).toEqual(['plugin']);
      expect(catalog.catalog.getPluginSkill('demo', 'stale-skill')).toBeUndefined();
      expect(catalog.catalog.getPluginSkill('demo', 'fresh-skill')).toBeDefined();
    } finally {
      host.dispose();
      sourceChanges.dispose();
    }
  });

  it('binds thisArg when forwarding plugin reloads through the plugin skill source', async () => {
    const reloadEmitter = new Emitter<ReloadSummary>();
    const pluginService = pluginStub([], reloadEmitter);
    const { stub: ws } = workspaceStub('/work');
    const host = createScopedTestHost([
      stubPair(ISkillDiscovery, new InMemorySkillDiscovery()),
      stubPair(IBootstrapService, bootstrapStub),
      stubPair(IConfigService, configStub()),
      stubPair(ISkillCatalogRuntimeOptions, {
        _serviceBrand: undefined,
      } as unknown as ISkillCatalogRuntimeOptions),
      stubPair(IPluginService, pluginService),
    ]);
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(ISessionWorkspaceContext, ws),
    ]);

    try {
      const source = session.accessor.get(IPluginSkillSource);
      void source.id;
      const receiver = { tag: 'receiver' };
      const seen: unknown[] = [];
      const subscription = source.onDidChange?.(
        function (this: unknown) {
          seen.push(this);
        },
        receiver,
      );

      reloadEmitter.fire({ added: [], removed: [], errors: [] });

      expect(seen).toEqual([receiver]);
      subscription?.dispose();
    } finally {
      host.dispose();
      reloadEmitter.dispose();
    }
  });

  it('keeps non-plugin skills working and recovers plugin skills after a corrupt installed.json is fixed and reloaded', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'plugin-home-'));
    await mkdir(join(homeDir, 'plugins'), { recursive: true });
    await writeFile(join(homeDir, 'plugins', 'installed.json'), '{ not json', 'utf8');

    const managedRoot = join(homeDir, 'plugins', 'managed', 'demo');
    await mkdir(join(managedRoot, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(
      join(managedRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', skills: './skills/' }),
      'utf8',
    );
    await writeFile(
      join(managedRoot, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: demo\n---\nbody',
      'utf8',
    );

    const store = new InMemorySkillDiscovery();
    store.setUserSkills([stubSkill('global-only')]);
    store.setPluginSkills([
      stubSkill('demo-skill', { source: 'extra', plugin: { id: 'demo' } }),
    ]);
    const host = createScopedTestHost([
      stubPair(ISkillDiscovery, store),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(IConfigService, configStub()),
      stubPair(ISkillCatalogRuntimeOptions, {
        _serviceBrand: undefined,
      } as unknown as ISkillCatalogRuntimeOptions),
      stubPair(IProviderService, stubProviderService()),
    ]);
    const { stub: ws } = workspaceStub('/work');
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(ISessionWorkspaceContext, ws),
    ]);

    try {
      const catalog = session.accessor.get(ISessionSkillCatalog);
      await catalog.load();
      expect(catalog.catalog.getSkill('global-only')).toBeDefined();
      expect(catalog.catalog.getPluginSkill('demo', 'demo-skill')).toBeUndefined();

      await writeFile(
        join(homeDir, 'plugins', 'installed.json'),
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: 'demo',
              root: managedRoot,
              source: 'local-path',
              enabled: true,
              installedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
        'utf8',
      );
      const refreshed = new Promise<void>((resolve) => {
        const d = catalog.onDidChange((sourceId) => {
          if (sourceId === 'plugin') {
            d.dispose();
            resolve();
          }
        });
      });
      await host.app.accessor.get(IPluginService).reloadPlugins();
      await refreshed;

      expect(catalog.catalog.getPluginSkill('demo', 'demo-skill')).toBeDefined();
    } finally {
      host.dispose();
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
