import { describe, expect, it } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { LifecycleScope } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IPluginService } from '#/app/plugin/plugin';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
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
) {
  const host = createScopedTestHost([
    stubPair(ISkillDiscovery, store),
    stubPair(IBootstrapService, bootstrapStub),
    stubPair(IPluginService, pluginStub(pluginRoots)),
  ]);
  const session = host.child(LifecycleScope.Session, 's1', [stubPair(ISessionWorkspaceContext, ws)]);
  return { host, session };
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
    ]);
    const pluginRoot: SkillRoot = {
      path: '/plugins/demo/skills',
      source: 'extra',
      plugin: { id: 'demo' },
    };
    const { stub: ws } = workspaceStub('/work');
    const { host, session } = makeHost(store, ws, [pluginRoot]);

    const catalog = session.accessor.get(ISessionSkillCatalog);
    await catalog.load();

    expect(catalog.catalog.getSkill('shared')?.description).toBe('from project');
    expect(catalog.catalog.getSkill('user-plugin')?.description).toBe('from user');
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
