import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, basename, dirname } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { RuntimeLease } from '#/runtime/runtime';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { createReminderStub } from '../../features/reminder/stubs';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import type { SkillCatalog } from '#/features/skill/catalog/types';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { SecondaryModelConfig } from '#/session/subagent/configSection';
import { IAgentChangeNotifierService } from '#/agent/changeNotifier/changeNotifier';
import { AgentChangeNotifierService } from '#/agent/changeNotifier/changeNotifierService';
import {
  ChangeNotifierSnapshotEvent,
  changeNotifierSnapshotKey,
} from '#/agent/changeNotifier/changeNotifierOps';
import { registerLogServices } from '../../_base/log/stubs';
import { stubAgentContext } from '../agentContext/stubs';

let disposables: DisposableStore;
let homeDir: string;
let workDir: string;

beforeEach(async () => {
  disposables = new DisposableStore();
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-notifier-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-notifier-work-'));
  await mkdir(join(workDir, '.git'));
});

afterEach(async () => {
  disposables.dispose();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

interface CapturedReminder {
  readonly content: string;
  readonly variant: string;
}

interface Harness {
  readonly ix: TestInstantiationService;
  readonly notifier: IAgentChangeNotifierService;
  readonly reminders: CapturedReminder[];
  readonly skillCatalogChange: Emitter<string>;
  readonly agentCatalogChange: Emitter<string>;
  readonly skillListing: { value: string };
  readonly profileNames: { value: readonly string[] };
  readonly secondaryModel: { value: SecondaryModelConfig | undefined };
}

function makeProfileData(overrides: Partial<ProfileData>): ProfileData {
  return {
    modelAlias: 'test-model',
    modelCapabilities: {},
    thinkingLevel: 'off',
    systemPrompt: '',
    disallowedTools: [],
    ...overrides,
  } as unknown as ProfileData;
}

function createHarness(options: {
  readonly agentId?: string;
  readonly profile: ProfileData;
}): Harness {
  const reminders: CapturedReminder[] = [];
  const skillCatalogChange = disposables.add(new Emitter<string>());
  const agentCatalogChange = disposables.add(new Emitter<string>());
  const skillListing = { value: '' };
  const profileNames = { value: ['default'] as readonly string[] };
  const secondaryModel = { value: undefined as SecondaryModelConfig | undefined };
  const hostFs = new HostFileSystem();
  const hostEnvironment = {
    _serviceBrand: undefined,
    homeDir,
    pathClass: 'posix',
  } as unknown as IHostEnvironment;
  const agentState = new AgentStateService();
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      registerLogServices(reg);
      reg.defineInstance(IAgentScopeContext, {
        _serviceBrand: undefined,
        agentId: options.agentId ?? 'main',
        agentContext: stubAgentContext(options.agentId ?? 'main', 0),
        scope: (sub?: string): string => (sub ? `agents/main/${sub}` : 'agents/main'),
      } satisfies IAgentScopeContext);
      reg.defineInstance(IAgentProfileService, {
        data: () => options.profile,
      } as unknown as IAgentProfileService);
      reg.defineInstance(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        onDidChange: skillCatalogChange.event,
        load: async () => {},
        reload: async () => {},
        list: async () => [],
        catalog: {
          getModelSkillListing: () => skillListing.value,
        } as unknown as SkillCatalog,
      } satisfies ISessionSkillCatalog);
      reg.defineInstance(ISessionAgentProfileCatalog, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        onDidChange: agentCatalogChange.event,
        load: async () => {},
        reload: async () => {},
        get: () => undefined,
        getDefault: () => ({ name: 'default' }) as unknown as AgentProfile,
        inspect: () => undefined,
        list: () => profileNames.value.map((name) => ({ name }) as unknown as AgentProfile),
      } as unknown as ISessionAgentProfileCatalog);
      reg.defineInstance(
        IAgentReminderService,
        createReminderStub({
          notify: (content, notification) => {
            reminders.push({ content, variant: notification.variant });
          },
        }),
      );
      reg.defineInstance(IAgentStateService, agentState);
      reg.defineInstance(IConfigService, {
        get: (domain: string) =>
          domain === 'secondaryModel' ? secondaryModel.value : undefined,
      } as unknown as IConfigService);
      reg.defineInstance(ISessionContext, {
        _serviceBrand: undefined,
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        sessionDir: workDir,
        metaScope: 'sessions/workspace-1/session-1',
        cwd: workDir,
        scope: (sub?: string): string =>
          sub ? `sessions/workspace-1/session-1/${sub}` : 'sessions/workspace-1/session-1',
      } satisfies ISessionContext);
      reg.defineInstance(IBootstrapService, {
        homeDir,
        getEnv: () => undefined,
      } as unknown as IBootstrapService);
      reg.defineInstance(IHostFileSystem, hostFs);
      reg.defineInstance(IHostEnvironment, hostEnvironment);
      reg.defineInstance(IAgentRuntimeService, {
        _serviceBrand: undefined,
        onDidChange: () => ({ dispose: () => {} }),
        isAvailable: () => true,
        inspect() {
          return this.acquire().runtime;
        },
        acquire: (): RuntimeLease => ({
          runtime: {
            identity: { workspaceId: 'workspace-1', runtimeId: 'local', generation: 'test' },
            capabilities: new Set(['fs', 'process', 'terminal']),
            environment: hostEnvironment,
            path: {
              separator: '/',
              delimiter: ':',
              isAbsolute: (path: string) => path.startsWith('/'),
              join,
              relative: (from: string, to: string) =>
                normalize(to).replace(`${normalize(from)}/`, ''),
              resolve: (...paths: readonly string[]) => normalize(join(...paths)),
              basename: (path: string) => basename(path),
              dirname: (path: string) => dirname(path),
            },
            workspace: { mapRoots: (roots) => roots },
            fs: hostFs,
            status: 'ready',
            onDidChangeStatus: () => ({ dispose: () => {} }),
            dispose: () => {},
          },
          track: (resource) => resource,
          dispose: () => {},
        }),
      } satisfies IAgentRuntimeService);
      reg.defineInstance(IEventDispatcher, {
        _serviceBrand: undefined,
        hooks: { onDidRestore: new OrderedHookSlot() },
        dispatch: async (event: unknown) => {
          if (event instanceof ChangeNotifierSnapshotEvent) {
            agentState.set(changeNotifierSnapshotKey, {
              agentsMdHash: event.agentsMdHash ?? undefined,
              skillsHash: event.skillsHash ?? undefined,
              subagentNames: event.subagentNames ?? undefined,
              modelPoolAliases: event.modelPoolAliases ?? undefined,
            });
          }
        },
      } as unknown as IEventDispatcher);
      reg.define(IAgentChangeNotifierService, AgentChangeNotifierService);
    },
    strict: true,
  });
  const notifier = ix.get(IAgentChangeNotifierService);
  return {
    ix,
    notifier,
    reminders,
    skillCatalogChange,
    agentCatalogChange,
    skillListing,
    profileNames,
    secondaryModel,
  };
}

function agentsMdPrompt(path: string, content: string): string {
  return `intro\n\n<!-- From: ${path} -->\n${content}\n\noutro`;
}

describe('notifyAgentsMdChanges', () => {
  it('does not remind when the prompt copy is current, then reminds on modification once', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'v1 content');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'v1 content'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(0);

    await writeFile(agentsMdPath, 'v2 content');
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('agents_md_change');
    expect(h.reminders[0]?.content).toContain(agentsMdPath);
    expect(h.reminders[0]?.content).not.toContain('(deleted)');

    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);

    await writeFile(agentsMdPath, 'v3 content');
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(2);
  });

  it('reminds with (deleted) when an injected file is removed', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'v1 content');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'v1 content'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await h.notifier.notifyAgentsMdChanges();
    await rm(agentsMdPath, { force: true });
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain(`${agentsMdPath} (deleted)`);
  });

  it('reminds about newly appeared files that were never injected', async () => {
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: 'no instructions here',
        agentsMdPaths: [],
      }),
    });

    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(0);

    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'brand new rules');
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain(agentsMdPath);
    expect(h.reminders[0]?.content).toContain('were not included in your system prompt');
  });

  it('ignores non-main agents', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'v1 content');
    const h = createHarness({
      agentId: 'sub-1',
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: 'different prompt',
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await writeFile(agentsMdPath, 'v2 content');
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(0);
  });
});

describe('notifySkillChanges', () => {
  const LISTING_A = 'DISREGARD any earlier skill listings. Current available skills:\n- skill-a: does A';
  const LISTING_AB = `${LISTING_A}\n- skill-b: does B`;

  it('does not remind when the prompt listing is current, reminds with the fresh listing on change, then dedups', async () => {
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: `header\n\n${LISTING_A}\n\nfooter`,
      }),
    });
    h.skillListing.value = LISTING_A;

    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(0);

    h.skillListing.value = LISTING_AB;
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('skills_change');
    expect(h.reminders[0]?.content).toContain('skill-b');

    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(1);
  });

  it('reminds when the catalog becomes empty after the prompt had a listing', async () => {
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: `header\n\n${LISTING_A}\n\nfooter`,
      }),
    });
    h.skillListing.value = LISTING_A;
    await h.notifier.notifySkillChanges();

    h.skillListing.value = '';
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('no skills are currently available');
  });

  it('stays silent for a fresh agent whose prompt already covers the empty catalog', async () => {
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: 'no skills section',
      }),
    });
    h.skillListing.value = '';
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(0);
  });

  it('fires through the watch channel on catalog change', async () => {
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: `header\n\n${LISTING_A}\n\nfooter`,
      }),
    });
    h.skillListing.value = LISTING_A;
    await h.notifier.notifySkillChanges();

    h.skillListing.value = LISTING_AB;
    h.skillCatalogChange.fire('user');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('skills_change');
  });
});

describe('notifySubagentChanges', () => {
  it('diffs profile additions through the watch channel and dedups', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });

    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);

    h.profileNames.value = ['default', 'deploy'];
    h.agentCatalogChange.fire('workspace');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('subagents_change');
    expect(h.reminders[0]?.content).toContain('Profiles added: deploy');

    h.agentCatalogChange.fire('workspace');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.reminders).toHaveLength(1);
  });

  it('diffs against the pre-reload input on the reload channel', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    h.profileNames.value = ['default', 'deploy'];

    await h.notifier.notifySubagentChanges({ previousSubagentNames: ['default'] });
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Profiles added: deploy');
  });

  it('does not repeat a notification the watch channel already delivered before reload', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });

    await h.notifier.notifySubagentChanges();
    h.profileNames.value = ['default', 'deploy'];
    h.agentCatalogChange.fire('workspace');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.reminders).toHaveLength(1);

    await h.notifier.notifySubagentChanges({ previousSubagentNames: ['default'] });
    expect(h.reminders).toHaveLength(1);
  });

  it('diffs secondary-model pool changes', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    h.secondaryModel.value = {
      defaultModel: 'k1',
      models: { k1: '', k2: '' },
    };

    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);

    h.secondaryModel.value = {
      defaultModel: 'k1',
      models: { k1: '', k3: '' },
    };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Models added: k3');
    expect(h.reminders[0]?.content).toContain('Models removed: k2');

    h.secondaryModel.value = undefined;
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(2);
    expect(h.reminders[1]?.content).toContain('Models removed: k1, k3');
  });

  it('reports a pool that appeared between the pre-reload capture and the resume', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    h.secondaryModel.value = {
      defaultModel: 'k1',
      models: { k1: '', k2: '' },
    };

    await h.notifier.notifySubagentChanges({ previousModelPoolAliases: [] });
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Models added: k1, k2');
  });

  it('ignores non-main agents and unbound profiles', async () => {
    const sub = createHarness({
      agentId: 'sub-1',
      profile: makeProfileData({ profileName: 'default' }),
    });
    sub.profileNames.value = ['default', 'deploy'];
    await sub.notifier.notifySubagentChanges({ previousSubagentNames: ['default'] });
    expect(sub.reminders).toHaveLength(0);

    const unbound = createHarness({
      profile: makeProfileData({ profileName: undefined }),
    });
    unbound.profileNames.value = ['default', 'deploy'];
    await unbound.notifier.notifySubagentChanges({ previousSubagentNames: ['default'] });
    expect(unbound.reminders).toHaveLength(0);
  });
});
