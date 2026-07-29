/**
 * Scenario: workspace agent-profile catalog — file-source discovery, priority
 * merge, explicit fatal semantics, and config-driven reload. Exercises the
 * real Workspace-scoped catalog and source services against real temp
 * directories. Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceAgentProfileCatalog/agentProfileCatalog.test.ts`.
 */

import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter, Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  IAgentProfileCatalogService,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { AgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalogService';
import { IAgentCatalogRuntimeOptions } from '#/app/agentFileCatalog/agentCatalogRuntimeOptions';
import { EXTRA_AGENT_DIRS_SECTION } from '#/app/agentFileCatalog/configSection';
import {
  IUserFileAgentSource,
  UserFileAgentSource,
} from '#/app/agentFileCatalog/userFileAgentSource';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import '#/index';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService, type HostFsChange, type IHostFsWatchHandle } from '#/os/interface/hostFsWatch';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  ExplicitFileAgentSource,
  IExplicitFileAgentSource,
} from '#/workspace/workspaceAgentProfileCatalog/explicitFileAgentSource';
import {
  ExtraFileAgentSource,
  IExtraFileAgentSource,
} from '#/workspace/workspaceAgentProfileCatalog/extraFileAgentSource';
import {
  IProjectFileAgentSource,
  ProjectFileAgentSource,
} from '#/workspace/workspaceAgentProfileCatalog/projectFileAgentSource';
import { IWorkspaceAgentProfileCatalog } from '#/workspace/workspaceAgentProfileCatalog/workspaceAgentProfileCatalog';
import { WorkspaceAgentProfileCatalogService } from '#/workspace/workspaceAgentProfileCatalog/workspaceAgentProfileCatalogService';

import { stubBootstrap } from '../../app/bootstrap/stubs';

function configStub(): IConfigService & {
  setExtraAgentDirs(dirs: readonly string[]): void;
  fireSectionChange(domain: string): void;
} {
  let extraAgentDirs: readonly string[] = [];
  const sectionChangeListeners: Array<(event: unknown) => void> = [];
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: (listener: (event: unknown) => void) => {
      sectionChangeListeners.push(listener);
      return { dispose: () => {} };
    },
    get: (domain: string) =>
      domain === EXTRA_AGENT_DIRS_SECTION ? [...extraAgentDirs] : undefined,
    inspect: () => ({
      value: undefined,
      defaultValue: undefined,
      userValue: undefined,
      memoryValue: undefined,
    }),
    getAll: () => ({}),
    set: async () => {},
    replace: async () => {},
    reload: async () => {},
    diagnostics: () => [],
    setExtraAgentDirs: (dirs: readonly string[]) => {
      extraAgentDirs = [...dirs];
    },
    fireSectionChange: (domain: string) => {
      for (const listener of sectionChangeListeners) {
        listener({ domain, source: 'set', value: undefined, previousValue: undefined });
      }
    },
  } as unknown as IConfigService & {
    setExtraAgentDirs(dirs: readonly string[]): void;
    fireSectionChange(domain: string): void;
  };
}

function workspaceContextStub(workDir: string): IWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workspaceId: 'wd_test',
    cwd: workDir,
    source: 'local',
    meta: { id: 'wd_test', root: workDir, name: 'test', createdAt: 0, lastOpenedAt: 0 },
    persistenceScope: 'sessions/wd_test',
    osBackendId: 'local',
    persistenceBackendId: 'local',
  };
}

function fsWatchStub(): IHostFsWatchService {
  return {
    _serviceBrand: undefined,
    watch: (): IHostFsWatchHandle => ({
      onDidChange: Event.None as Event<HostFsChange>,
      dispose: () => {},
    }),
  };
}

function agentMd(name: string, description: string, override = false): string {
  const overrideLine = override ? 'override: true\n' : '';
  return `---\nname: ${name}\ndescription: ${description}\n${overrideLine}---\n\nYou are ${name}.\n`;
}

interface Fixture {
  readonly homeDir: string;
  readonly osHomeDir: string;
  readonly workDir: string;
  readonly extraDir: string;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-profile-catalog-'));
  try {
    const make = async (dir: string): Promise<string> => {
      const p = join(root, dir);
      await mkdir(p, { recursive: true });
      return realpath(p);
    };
    const [homeDir, osHomeDir, workDir, extraDir] = await Promise.all([
      make('kimi-home'),
      make('os-home'),
      make('work'),
      make('extra-agents'),
    ]);
    await run({ homeDir, osHomeDir, workDir, extraDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeAgent(dir: string, fileName: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await writeFile(filePath, content);
  return filePath;
}

function logStub(warnings?: string[]): ILogService {
  return {
    _serviceBrand: undefined,
    warn: (message: unknown) => {
      warnings?.push(String(message));
    },
    info: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    setLevel: () => {},
  } as unknown as ILogService;
}

function makeWorkspace(
  fixture: Fixture,
  opts?: {
    readonly extraAgentDirs?: readonly string[];
    readonly explicitFiles?: readonly string[];
    readonly logWarnings?: string[];
    readonly userSource?: IUserFileAgentSource;
    readonly explicitSource?: IExplicitFileAgentSource;
  },
) {
  const config = configStub();
  if (opts?.extraAgentDirs !== undefined) config.setExtraAgentDirs(opts.extraAgentDirs);
  const runtimeOptions = {
    _serviceBrand: undefined,
    explicitFiles: opts?.explicitFiles,
  } as unknown as IAgentCatalogRuntimeOptions;
  const host = createScopedTestHost([
    stubPair(IBootstrapService, {
      ...stubBootstrap(fixture.homeDir),
      osHomeDir: fixture.osHomeDir,
    }),
    stubPair(IConfigService, config),
    stubPair(IAgentCatalogRuntimeOptions, runtimeOptions),
    stubPair(ILogService, logStub()),
    ...(opts?.userSource ? [stubPair(IUserFileAgentSource, opts.userSource)] : []),
  ]);
  const workspace = host.child(LifecycleScope.Workspace, 'w1', [
    stubPair(IWorkspaceContext, workspaceContextStub(fixture.workDir)),
    stubPair(ILogService, logStub(opts?.logWarnings)),
    stubPair(IHostFsWatchService, fsWatchStub()),
    ...(opts?.explicitSource ? [stubPair(IExplicitFileAgentSource, opts.explicitSource)] : []),
  ]);
  return { host, workspace, config };
}

function waitForEvent(event: Event<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const disposable = event(() => {
      disposable.dispose();
      resolve();
    });
  });
}

describe('WorkspaceAgentProfileCatalogService', () => {
  beforeEach(() => {
    // `import '#/index'` fills the registry with the whole product graph,
    // including OnScopeCreated services with unstubbed dependencies, so clear
    // it and re-register only the real services this suite constructs; their
    // other dependencies are seeded as stubs by `makeWorkspace`. Builtin agent
    // profile contributions accumulate in a separate module-level list at
    // import time and are unaffected by the clear.
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IAgentProfileCatalogService,
      AgentProfileCatalogService,
    );
    registerScopedService(LifecycleScope.App, IUserFileAgentSource, UserFileAgentSource);
    registerScopedService(LifecycleScope.App, IHostFileSystem, HostFileSystem);
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceAgentProfileCatalog,
      WorkspaceAgentProfileCatalogService,
    );
    registerScopedService(
      LifecycleScope.Workspace,
      IExplicitFileAgentSource,
      ExplicitFileAgentSource,
    );
    registerScopedService(LifecycleScope.Workspace, IExtraFileAgentSource, ExtraFileAgentSource);
    registerScopedService(
      LifecycleScope.Workspace,
      IProjectFileAgentSource,
      ProjectFileAgentSource,
    );
  });

  it('lists builtin profiles when no agent directories exist', async () => {
    await withFixture(async (fixture) => {
      const { host, workspace } = makeWorkspace(fixture);
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeDefined();
      expect(catalog.getDefault().name).toBe(DEFAULT_AGENT_PROFILE_NAME);
      expect(catalog.list().length).toBeGreaterThan(0);
      host.dispose();
    });
  });

  it('merges user and project agents; project wins on name collision', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(join(fixture.homeDir, 'agents'), 'shared.md', agentMd('shared', 'from user'));
      await writeAgent(join(fixture.homeDir, 'agents'), 'user-only.md', agentMd('user-only', 'user agent'));
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
        'shared.md',
        agentMd('shared', 'from project'),
      );
      const { host, workspace } = makeWorkspace(fixture);
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.get('shared')?.description).toBe('from project');
      expect(catalog.get('user-only')?.description).toBe('user agent');
      host.dispose();
    });
  });

  it('orders sources user < extra < project < explicit', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(join(fixture.homeDir, 'agents'), 'shared.md', agentMd('shared', 'from user'));
      await writeAgent(join(fixture.homeDir, 'agents'), 'user-extra.md', agentMd('user-extra', 'from user'));
      await writeAgent(fixture.extraDir, 'shared.md', agentMd('shared', 'from extra'));
      await writeAgent(fixture.extraDir, 'user-extra.md', agentMd('user-extra', 'from extra'));
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
        'shared.md',
        agentMd('shared', 'from project'),
      );
      const explicitFile = await writeAgent(
        fixture.workDir,
        'explicit.md',
        agentMd('shared', 'from explicit'),
      );
      const { host, workspace } = makeWorkspace(fixture, {
        extraAgentDirs: [fixture.extraDir],
        explicitFiles: [explicitFile],
      });
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.get('shared')?.description).toBe('from explicit');
      expect(catalog.get('user-extra')?.description).toBe('from extra');
      host.dispose();
    });
  });

  it('fails ready when an explicit agent file is invalid', async () => {
    await withFixture(async (fixture) => {
      const bad = await writeAgent(
        fixture.workDir,
        'bad.md',
        '---\nname: bad\n---\n\nbody\n',
      );
      const { host, workspace } = makeWorkspace(fixture, { explicitFiles: [bad] });
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);

      await expect(catalog.load()).rejects.toThrow(/description/i);
      host.dispose();
    });
  });

  it('fails ready when an explicit agent file does not exist', async () => {
    await withFixture(async (fixture) => {
      const { host, workspace } = makeWorkspace(fixture, {
        explicitFiles: [join(fixture.workDir, 'missing.md')],
      });
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);

      await expect(catalog.load()).rejects.toMatchObject({ code: 'os.fs.not_found' });
      host.dispose();
    });
  });

  it('recovers ready after a reload fixes a previously fatal explicit file', async () => {
    await withFixture(async (fixture) => {
      const bad = await writeAgent(
        fixture.workDir,
        'bad.md',
        '---\nname: bad\n---\n\nbody\n',
      );
      const { host, workspace } = makeWorkspace(fixture, { explicitFiles: [bad] });
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await expect(catalog.load()).rejects.toThrow(/description/i);

      await writeFile(bad, agentMd('fixed', 'fixed agent'));
      await catalog.reload();

      await expect(catalog.load()).resolves.toBeUndefined();
      expect(catalog.get('fixed')?.description).toBe('fixed agent');
      host.dispose();
    });
  });

  it('resolves relative explicit files against the workspace root', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.workDir, 'agents'),
        'solo.md',
        agentMd('solo', 'relative explicit'),
      );
      const { host, workspace } = makeWorkspace(fixture, { explicitFiles: ['agents/solo.md'] });
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.get('solo')?.description).toBe('relative explicit');
      host.dispose();
    });
  });

  it('reloads the extra source when extraAgentDirs changes', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(fixture.extraDir, 'from-extra.md', agentMd('from-extra', 'extra agent'));
      const { host, workspace, config } = makeWorkspace(fixture);
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();
      expect(catalog.get('from-extra')).toBeUndefined();

      config.setExtraAgentDirs([fixture.extraDir]);
      const changed = waitForEvent(catalog.onDidChange);
      config.fireSectionChange(EXTRA_AGENT_DIRS_SECTION);
      await changed;

      expect(catalog.get('from-extra')?.description).toBe('extra agent');
      host.dispose();
    });
  });

  it('skips invalid project files and still loads valid ones', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
        'bad.md',
        '---\nname: bad\n---\n\nbody\n',
      );
      await writeAgent(join(fixture.workDir, '.kimi-code', 'agents'), 'good.md', agentMd('good', 'valid'));
      const { host, workspace } = makeWorkspace(fixture);
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.get('good')?.description).toBe('valid');
      host.dispose();
    });
  });

  it('keeps the builtin default when a same-name file does not opt in to override', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
        'agent.md',
        agentMd('agent', 'project default override'),
      );
      const { host, workspace } = makeWorkspace(fixture);
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.getDefault().description).not.toBe('project default override');
      host.dispose();
    });
  });

  it('lets a file profile explicitly override the builtin default', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
        'agent.md',
        agentMd('agent', 'project default override', true),
      );
      const { host, workspace } = makeWorkspace(fixture);
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.getDefault().description).toBe('project default override');
      host.dispose();
    });
  });

  it('falls back to a valid lower-priority builtin override', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.homeDir, 'agents'),
        'agent.md',
        agentMd('agent', 'user default override', true),
      );
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
        'agent.md',
        agentMd('agent', 'project default without override'),
      );
      const { host, workspace } = makeWorkspace(fixture);
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.getDefault().description).toBe('user default override');
      expect(catalog.getDefault().description).not.toBe('project default without override');
      host.dispose();
    });
  });

  it('keeps builtin profiles and warns when a non-fatal source fails to load', async () => {
    await withFixture(async (fixture) => {
      const logWarnings: string[] = [];
      const failingUserSource = {
        _serviceBrand: undefined,
        id: 'user',
        priority: 10,
        load: () => Promise.reject(new Error('disk gone')),
      } as unknown as IUserFileAgentSource;
      const { host, workspace } = makeWorkspace(fixture, {
        logWarnings,
        userSource: failingUserSource,
      });
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);

      await catalog.load();

      expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeDefined();
      expect(logWarnings.some((w) => w.includes('"user"'))).toBe(true);
      host.dispose();
    });
  });

  it('keeps the previous contribution when a source reload fails', async () => {
    await withFixture(async (fixture) => {
      const logWarnings: string[] = [];
      const emitter = new Emitter<void>();
      let fail = false;
      const fileProfile = {
        name: 'file-agent',
        description: 'from file',
        systemPrompt: () => 'x',
      };
      const userSource = {
        _serviceBrand: undefined,
        id: 'user',
        priority: 10,
        onDidChange: emitter.event,
        load: () =>
          fail
            ? Promise.reject(new Error('disk gone'))
            : Promise.resolve({ profiles: [fileProfile] }),
      } as unknown as IUserFileAgentSource;
      const { host, workspace } = makeWorkspace(fixture, { logWarnings, userSource });
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();
      expect(catalog.get('file-agent')?.description).toBe('from file');

      fail = true;
      emitter.fire();
      await vi.waitFor(() => {
        expect(logWarnings.some((w) => w.includes('load failed'))).toBe(true);
      });

      expect(catalog.get('file-agent')?.description).toBe('from file');
      host.dispose();
    });
  });

  it('warns and keeps stale data when a fatal source reload fails', async () => {
    await withFixture(async (fixture) => {
      const logWarnings: string[] = [];
      const emitter = new Emitter<void>();
      let fail = false;
      const explicitProfile = {
        name: 'exp-agent',
        description: 'explicit',
        systemPrompt: () => 'x',
      };
      const explicitSource = {
        _serviceBrand: undefined,
        id: 'explicit',
        priority: 40,
        fatal: true,
        onDidChange: emitter.event,
        load: () =>
          fail
            ? Promise.reject(new Error('file deleted mid-session'))
            : Promise.resolve({ profiles: [explicitProfile] }),
      } as unknown as IExplicitFileAgentSource;
      const { host, workspace } = makeWorkspace(fixture, { logWarnings, explicitSource });
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();
      expect(catalog.get('exp-agent')?.description).toBe('explicit');

      fail = true;
      emitter.fire();
      await vi.waitFor(() => {
        expect(logWarnings.some((w) => w.includes('reload failed'))).toBe(true);
      });

      expect(catalog.get('exp-agent')?.description).toBe('explicit');
      host.dispose();
    });
  });

  it('replaces the builtin default system prompt with user-level SYSTEM.md', async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        join(fixture.homeDir, 'SYSTEM.md'),
        'You are a custom main agent. cwd=${cwd} unknown=${nope}',
      );
      const { host, workspace } = makeWorkspace(fixture);
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      const prompt = catalog.getDefault().systemPrompt({ cwd: '/work/dir' });
      expect(prompt).toContain('You are a custom main agent.');
      expect(prompt).toContain('cwd=/work/dir');
      expect(prompt).toContain('unknown=${nope}');
      host.dispose();
    });
  });

  it('lets SYSTEM.md win over a same-name scanned user agent file', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.homeDir, 'agents'),
        'agent.md',
        agentMd('agent', 'user agents dir default', true),
      );
      await writeFile(join(fixture.homeDir, 'SYSTEM.md'), 'system md prompt');
      const { host, workspace } = makeWorkspace(fixture);
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.getDefault().systemPrompt({})).toContain('system md prompt');
      host.dispose();
    });
  });

  it('lets a same-name project agent file win over user-level SYSTEM.md', async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.homeDir, 'SYSTEM.md'), 'system md prompt');
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
        'agent.md',
        agentMd('agent', 'project default override', true),
      );
      const { host, workspace } = makeWorkspace(fixture);
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.getDefault().description).toBe('project default override');
      expect(catalog.getDefault().systemPrompt({})).not.toContain('system md prompt');
      host.dispose();
    });
  });

  it('lets an explicit agent file win over user-level SYSTEM.md', async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.homeDir, 'SYSTEM.md'), 'system md prompt');
      const explicitFile = await writeAgent(
        fixture.workDir,
        'explicit.md',
        agentMd('agent', 'explicit default override', true),
      );
      const { host, workspace } = makeWorkspace(fixture, { explicitFiles: [explicitFile] });
      const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
      await catalog.load();

      expect(catalog.getDefault().description).toBe('explicit default override');
      expect(catalog.getDefault().systemPrompt({})).not.toContain('system md prompt');
      host.dispose();
    });
  });
  it('rescans the project source when a project agent file changes on disk', async () => {
    await withFixture(async (fixture) => {
      const host = createScopedTestHost([
        stubPair(IBootstrapService, {
          ...stubBootstrap(fixture.homeDir),
          osHomeDir: fixture.osHomeDir,
        }),
        stubPair(IConfigService, configStub()),
        stubPair(IAgentCatalogRuntimeOptions, {
          _serviceBrand: undefined,
        } as unknown as IAgentCatalogRuntimeOptions),
        stubPair(ILogService, logStub()),
        stubPair(IHostFsWatchService, new HostFsWatchService()),
      ]);
      const workspace = host.child(LifecycleScope.Workspace, 'w1', [
        stubPair(IWorkspaceContext, workspaceContextStub(fixture.workDir)),
      ]);

      try {
        const catalog = workspace.accessor.get(IWorkspaceAgentProfileCatalog);
        await catalog.load();
        expect(catalog.get('watched-agent')).toBeUndefined();

        const refreshed = new Promise<string>((resolvePromise) => {
          const d = catalog.onDidChange((sourceId) => {
            d.dispose();
            resolvePromise(sourceId);
          });
        });
        const timedOut = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('watch-driven refresh timed out')), 10000);
        });
        await writeAgent(
          join(fixture.workDir, '.kimi-code', 'agents'),
          'watched-agent.md',
          agentMd('watched-agent', 'from watch'),
        );

        await expect(Promise.race([refreshed, timedOut])).resolves.toBe('project');
        expect(catalog.get('watched-agent')?.description).toBe('from watch');
      } finally {
        host.dispose();
      }
    });
  }, 15000);
});
