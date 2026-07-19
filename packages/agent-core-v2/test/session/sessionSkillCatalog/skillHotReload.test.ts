/**
 * Scenario: skill-catalog hot reload — filesystem changes under watched skill
 * roots drive each file-backed source's `onDidChange`, the serialized catalog
 * remerge, and expose the new skills through `ISessionSkillCatalog`.
 *
 * Exercises the real chokidar watcher (`HostFsWatchService`) and real
 * `FileSkillDiscovery` over temporary directories, wired through the real
 * DI scope tree. Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest
 * run test/session/sessionSkillCatalog/skillHotReload.test.ts`.
 */

import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { LifecycleScope, type Scope } from '#/_base/di/scope';
import '#/index';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ILogService } from '#/_base/log/log';
import { IPluginService } from '#/app/plugin/plugin';
import {
  EXTRA_SKILL_DIRS_SECTION,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
} from '#/app/skillCatalog/configSection';
import { FileSkillDiscovery } from '#/app/skillCatalog/fileSkillDiscovery';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function configStub(): IConfigService & {
  setExtraSkillDirs(dirs: readonly string[]): void;
  fireSectionChange(domain: string): void;
} {
  let extraSkillDirs: readonly string[] = [];
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
      if (domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) return true;
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
    fireSectionChange: (domain: string) => {
      for (const listener of sectionChangeListeners) {
        listener({ domain, source: 'set', value: undefined, previousValue: undefined });
      }
    },
  } as unknown as IConfigService & {
    setExtraSkillDirs(dirs: readonly string[]): void;
    fireSectionChange(domain: string): void;
  };
}

function pluginStub(): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: () => ({ dispose: () => {} }),
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
    pluginSkillRoots: async () => [],
    enabledSessionStarts: async () => [],
    enabledMcpServers: async () => ({}),
    enabledHooks: async () => [],
  };
}

function workspaceStub(workDir: string): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir,
    additionalDirs: [],
    setWorkDir: () => {},
    setAdditionalDirs: () => {},
    resolve: (rel: string) => rel,
    isWithin: () => true,
    assertAllowed: (p: string) => p,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  } satisfies ISessionWorkspaceContext;
}

interface HotReloadFixture {
  readonly host: ScopedTestHost;
  readonly session: Scope;
  readonly catalog: ISessionSkillCatalog;
  readonly config: ReturnType<typeof configStub>;
  readonly changes: string[];
}

async function makeBase(): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), 'skill-hot-reload-')));
}

async function writeSkill(root: string, name: string, description?: string): Promise<void> {
  const descriptionText = description ?? `desc for ${name}`;
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${descriptionText}\n---\nbody`);
}

function makeHost(
  base: string,
  opts: { readonly extraSkillDirs?: readonly string[]; readonly explicitDirs?: readonly string[] } = {},
): HotReloadFixture {
  const homeDir = join(base, 'home');
  const osHomeDir = join(base, 'os-home');
  const workDir = join(base, 'project');
  const bootstrap = { ...stubBootstrap(homeDir), osHomeDir };
  const config = configStub();
  const runtimeOptions = {
    _serviceBrand: undefined,
    explicitDirs: opts.explicitDirs,
  } as unknown as ISkillCatalogRuntimeOptions;
  const host = createScopedTestHost([
    [ISkillDiscovery, new SyncDescriptor(FileSkillDiscovery) as unknown],
    stubPair(ILogService, stubLog()),
    stubPair(IBootstrapService, bootstrap),
    stubPair(IConfigService, config),
    stubPair(ISkillCatalogRuntimeOptions, runtimeOptions),
    stubPair(IPluginService, pluginStub()),
    stubPair(IHostFsWatchService, new HostFsWatchService()),
  ]);
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(ISessionWorkspaceContext, workspaceStub(workDir)),
    stubPair(ILogService, stubLog()),
  ]);
  const catalog = session.accessor.get(ISessionSkillCatalog);
  const changes: string[] = [];
  catalog.onDidChange((sourceId) => changes.push(sourceId));
  if (opts.extraSkillDirs !== undefined) config.setExtraSkillDirs(opts.extraSkillDirs);
  return { host, session, catalog, config, changes };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await wait(100);
  }
}

describe('skill hot reload', () => {
  const tmpdirs: string[] = [];
  const fixtures: HotReloadFixture[] = [];

  async function fixture(
    opts: { readonly extraSkillDirs?: readonly string[]; readonly explicitDirs?: readonly string[] } = {},
  ): Promise<HotReloadFixture & { readonly base: string }> {
    const base = await makeBase();
    tmpdirs.push(base);
    const f = makeHost(base, opts);
    fixtures.push(f);
    return { ...f, base };
  }

  afterEach(async () => {
    for (const f of fixtures.splice(0)) f.host.dispose();
    for (const dir of tmpdirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('reloads the user source on add / modify / remove under <home>/skills', async () => {
    const { catalog, changes, base } = await fixture();
    const userRoot = join(base, 'home', 'skills');

    await catalog.load();
    expect(catalog.catalog.getSkill('hot-one')).toBeUndefined();

    await writeSkill(userRoot, 'hot-one');
    await waitFor(() => catalog.catalog.getSkill('hot-one') !== undefined, 'hot-one appears');

    await writeSkill(userRoot, 'hot-one', 'updated description');
    await waitFor(
      () => catalog.catalog.getSkill('hot-one')?.description === 'updated description',
      'hot-one description updates',
    );

    await rm(join(userRoot, 'hot-one'), { recursive: true, force: true });
    await waitFor(() => catalog.catalog.getSkill('hot-one') === undefined, 'hot-one disappears');

    expect(changes.filter((id) => id === 'user').length).toBeGreaterThanOrEqual(3);
  }, 30000);

  it('watches a user generic root that does not exist at load time', async () => {
    const { catalog, base } = await fixture();
    const genericRoot = join(base, 'os-home', '.agents', 'skills');

    await catalog.load();
    await wait(400);
    expect(catalog.catalog.getSkill('generic-one')).toBeUndefined();

    await writeSkill(genericRoot, 'generic-one');
    await waitFor(() => catalog.catalog.getSkill('generic-one') !== undefined, 'generic-one appears');
  }, 30000);

  it('a burst of writes collapses into a bounded number of catalog reloads', async () => {
    const { catalog, changes, base } = await fixture();
    const userRoot = join(base, 'home', 'skills');

    await catalog.load();
    await wait(400);
    changes.length = 0;

    for (let i = 0; i < 4; i += 1) {
      await writeSkill(userRoot, `burst-${i}`);
    }
    await waitFor(() => catalog.catalog.getSkill('burst-3') !== undefined, 'burst skills appear');
    await wait(600);

    expect(catalog.catalog.getSkill('burst-0')).toBeDefined();
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.length).toBeLessThanOrEqual(2);
  }, 30000);

  it('reloads the workspace source for both project brand and generic roots', async () => {
    const { catalog, changes, base } = await fixture();
    const projectDir = join(base, 'project');
    await mkdir(join(projectDir, '.git'), { recursive: true });
    const brandRoot = join(projectDir, '.kimi-code', 'skills');

    await catalog.load();
    await wait(400);

    await writeSkill(brandRoot, 'workspace-one');
    await waitFor(() => catalog.catalog.getSkill('workspace-one') !== undefined, 'workspace-one appears');

    await rm(join(brandRoot, 'workspace-one'), { recursive: true, force: true });
    await waitFor(() => catalog.catalog.getSkill('workspace-one') === undefined, 'workspace-one disappears');

    await writeSkill(join(projectDir, '.agents', 'skills'), 'workspace-generic');
    await waitFor(
      () => catalog.catalog.getSkill('workspace-generic') !== undefined,
      'workspace-generic appears',
    );

    expect(changes).toContain('workspace');
  }, 30000);

  it('reloads the extra source under a configured directory created after load', async () => {
    const probe = await makeBase();
    tmpdirs.push(probe);
    const extraDir = join(probe, 'extra-skills');
    const { catalog, changes } = await fixture({ extraSkillDirs: [extraDir] });

    await catalog.load();
    await wait(400);
    expect(catalog.catalog.getSkill('extra-one')).toBeUndefined();

    await writeSkill(extraDir, 'extra-one');
    await waitFor(() => catalog.catalog.getSkill('extra-one') !== undefined, 'extra-one appears');

    expect(changes).toContain('extra');
  }, 30000);

  it('reloads the explicit source and keeps default user discovery replaced', async () => {
    const probe = await makeBase();
    tmpdirs.push(probe);
    const explicitDir = join(probe, 'explicit-skills');
    const { catalog, base } = await fixture({ explicitDirs: [explicitDir] });

    await writeSkill(join(base, 'home', 'skills'), 'user-hidden');
    await catalog.load();
    await wait(400);
    expect(catalog.catalog.getSkill('user-hidden')).toBeUndefined();

    await writeSkill(explicitDir, 'explicit-one');
    await waitFor(() => catalog.catalog.getSkill('explicit-one') !== undefined, 'explicit-one appears');
  }, 30000);

  it('two independent containers on the same roots each see the change', async () => {
    const base = await makeBase();
    tmpdirs.push(base);
    const first = makeHost(base);
    const second = makeHost(base);
    fixtures.push(first, second);

    await first.catalog.load();
    await second.catalog.load();
    await wait(400);

    await writeSkill(join(base, 'home', 'skills'), 'shared-hot');
    await waitFor(() => first.catalog.catalog.getSkill('shared-hot') !== undefined, 'first sees shared-hot');
    await waitFor(() => second.catalog.catalog.getSkill('shared-hot') !== undefined, 'second sees shared-hot');

    expect(first.catalog.catalog.getSkill('shared-hot')).toBeDefined();
    expect(second.catalog.catalog.getSkill('shared-hot')).toBeDefined();
  }, 30000);

  it('session dispose stops its watchers', async () => {
    const { catalog, session, changes, base } = await fixture();
    await catalog.load();
    await wait(400);

    session.dispose();
    const firedBeforeWrites = changes.length;

    await writeSkill(join(base, 'home', 'skills'), 'after-dispose');
    await writeSkill(join(base, 'project', '.kimi-code', 'skills'), 'after-dispose-ws');
    await wait(1500);

    expect(changes.length).toBe(firedBeforeWrites);
    expect(catalog.catalog.getSkill('after-dispose')).toBeUndefined();
  }, 30000);
});
