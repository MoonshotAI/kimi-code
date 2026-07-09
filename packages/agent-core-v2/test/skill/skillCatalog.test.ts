import { describe, expect, it } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { LifecycleScope } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IPluginService } from '#/app/plugin/plugin';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IConfigService } from '#/app/config/config';
import {
  EXTRA_SKILL_DIRS_SECTION,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
} from '#/app/skillCatalog/configSection';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import '../../src/index';
import { InMemorySkillDiscovery } from '#/app/skillCatalog/inMemorySkillDiscovery';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import type { SkillRoot } from '#/app/skillCatalog/types';

import { stubSkill } from './stubs';

const bootstrapStub = {
  _serviceBrand: undefined,
  homeDir: '/home',
  osHomeDir: '/home',
} as unknown as IBootstrapService;

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

function pluginStub(skillRoots: readonly SkillRoot[] = []): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: () => ({ dispose: () => {} }),
    listPlugins: async () => [],
    installPlugin: async () => ({ id: '' }) as never,
    setPluginEnabled: async () => {},
    setPluginMcpServerEnabled: async () => {},
    removePlugin: async () => {},
    reloadPlugins: async () => ({ added: [], removed: [], errors: [] }),
    getPluginInfo: async () => undefined,
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
    stubPair(IPluginService, pluginStub(pluginRoots)),
  ]);
  const session = host.child(LifecycleScope.Session, 's1', [stubPair(ISessionWorkspaceContext, ws)]);
  return { host, session, config };
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

    config.fireSectionChange(MERGE_ALL_AVAILABLE_SKILLS_SECTION);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(store.calls).toBeGreaterThanOrEqual(afterLoad + 2);
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
    await catalog.reload();

    expect(catalog.catalog.getSkill('first')).toBeUndefined();
    expect(catalog.catalog.getSkill('second')).toBeDefined();
    expect(catalog.catalog.getSkill('global-only')).toBeDefined();
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
});
