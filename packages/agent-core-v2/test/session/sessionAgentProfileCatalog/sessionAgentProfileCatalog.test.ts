/**
 * Scenario: session agent-profile catalog — file-source discovery, priority
 * merge, explicit fatal semantics, and config-driven reload. Exercises the
 * real scoped catalog and source services against real temp directories.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog.test.ts`.
 */

import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { describe, expect, it, vi } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { LifecycleScope } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentCatalogRuntimeOptions } from '#/app/agentFileCatalog/agentCatalogRuntimeOptions';
import { EXTRA_AGENT_DIRS_SECTION } from '#/app/agentFileCatalog/configSection';
import { IUserFileAgentSource } from '#/app/agentFileCatalog/userFileAgentSource';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import '#/index';
import { IExplicitFileAgentSource } from '#/session/sessionAgentProfileCatalog/explicitFileAgentSource';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

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

function makeSession(
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
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(ISessionWorkspaceContext, workspaceStub(fixture.workDir)),
    stubPair(ILogService, logStub(opts?.logWarnings)),
    ...(opts?.explicitSource ? [stubPair(IExplicitFileAgentSource, opts.explicitSource)] : []),
  ]);
  return { host, session, config };
}

function waitForEvent(event: Event<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const disposable = event(() => {
      disposable.dispose();
      resolve();
    });
  });
}

describe('SessionAgentProfileCatalogService', () => {
  it('lists builtin profiles when no agent directories exist', async () => {
    await withFixture(async (fixture) => {
      const { host, session } = makeSession(fixture);
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture);
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture, {
        extraAgentDirs: [fixture.extraDir],
        explicitFiles: [explicitFile],
      });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture, { explicitFiles: [bad] });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);

      await expect(catalog.load()).rejects.toThrow(/description/i);
      host.dispose();
    });
  });

  it('fails ready when an explicit agent file does not exist', async () => {
    await withFixture(async (fixture) => {
      const { host, session } = makeSession(fixture, {
        explicitFiles: [join(fixture.workDir, 'missing.md')],
      });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);

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
      const { host, session } = makeSession(fixture, { explicitFiles: [bad] });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await expect(catalog.load()).rejects.toThrow(/description/i);

      await writeFile(bad, agentMd('fixed', 'fixed agent'));
      await catalog.reload();

      await expect(catalog.load()).resolves.toBeUndefined();
      expect(catalog.get('fixed')?.description).toBe('fixed agent');
      host.dispose();
    });
  });

  it('resolves relative explicit files against the session workDir', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.workDir, 'agents'),
        'solo.md',
        agentMd('solo', 'relative explicit'),
      );
      const { host, session } = makeSession(fixture, { explicitFiles: ['agents/solo.md'] });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await catalog.load();

      expect(catalog.get('solo')?.description).toBe('relative explicit');
      host.dispose();
    });
  });

  it('reloads the extra source when extraAgentDirs changes', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(fixture.extraDir, 'from-extra.md', agentMd('from-extra', 'extra agent'));
      const { host, session, config } = makeSession(fixture);
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture);
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture);
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture);
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture);
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture, {
        logWarnings,
        userSource: failingUserSource,
      });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);

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
      const { host, session } = makeSession(fixture, { logWarnings, userSource });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture, { logWarnings, explicitSource });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture);
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture);
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture);
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
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
      const { host, session } = makeSession(fixture, { explicitFiles: [explicitFile] });
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await catalog.load();

      expect(catalog.getDefault().description).toBe('explicit default override');
      expect(catalog.getDefault().systemPrompt({})).not.toContain('system md prompt');
      host.dispose();
    });
  });
});
