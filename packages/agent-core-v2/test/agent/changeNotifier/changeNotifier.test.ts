import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, basename, dirname } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import type { WatchChange } from '#human/utils/watch';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import type { SkillCatalog } from '#/features/skill/catalog/types';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { SecondaryModelConfig } from '#/session/subagent/configSection';
import { IAgentChangeNotifierService } from '#/agent/changeNotifier/changeNotifier';
import { AgentChangeNotifierService } from '#/agent/changeNotifier/changeNotifierService';
import { event2FromRecord } from '#/app/event/event2';
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
  readonly instructionsChange: Emitter<readonly WatchChange[]>;
  readonly skillCatalogChange: Emitter<string>;
  readonly agentCatalogChange: Emitter<string>;
  readonly skillListing: { value: string };
  readonly profileNames: { value: readonly string[] };
  readonly profileMeta: {
    value: Readonly<
      Record<
        string,
        {
          readonly description?: string;
          readonly whenToUse?: string;
          readonly subagents?: readonly string[];
        }
      >
    >;
  };
  readonly sessionDisabledTools: { value: readonly string[] };
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
  readonly skillReady?: Promise<void>;
}): Harness {
  const reminders: CapturedReminder[] = [];
  const instructionsChange = disposables.add(new Emitter<readonly WatchChange[]>());
  const skillCatalogChange = disposables.add(new Emitter<string>());
  const agentCatalogChange = disposables.add(new Emitter<string>());
  const skillListing = { value: '' };
  const profileNames = { value: ['default'] as readonly string[] };
  const profileMeta = {
    value: {} as Readonly<
      Record<
        string,
        {
          readonly description?: string;
          readonly whenToUse?: string;
          readonly subagents?: readonly string[];
        }
      >
    >,
  };
  const sessionDisabledTools = { value: [] as readonly string[] };
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
      reg.defineInstance(ISessionInstructionsProvider, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        agentsMd: undefined,
        agentsMdWarning: undefined,
        agentsMdPaths: undefined,
        onDidChange: instructionsChange.event,
      } satisfies ISessionInstructionsProvider);
      reg.defineInstance(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        ready: options.skillReady ?? Promise.resolve(),
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
        get: (name: string) => ({ name, ...profileMeta.value[name] }) as unknown as AgentProfile,
        getDefault: () => ({ name: 'default' }) as unknown as AgentProfile,
        inspect: () => undefined,
        list: () =>
          profileNames.value.map(
            (name) => ({ name, ...profileMeta.value[name] }) as unknown as AgentProfile,
          ),
      } as unknown as ISessionAgentProfileCatalog);
      reg.defineInstance(
        IAgentReminderService,
        createReminderStub({
          notify: (content, notification) => {
            reminders.push({ content, variant: notification.variant });
          },
        }),
      );
      reg.defineInstance(ISessionToolPolicy, {
        _serviceBrand: undefined,
        disabledTools: () => sessionDisabledTools.value,
      } as unknown as ISessionToolPolicy);
      reg.defineInstance(ISessionToolPolicyGate, {
        _serviceBrand: undefined,
        disabledTools: [],
      } as unknown as ISessionToolPolicyGate);
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
              agentsMdFiles: event.agentsMdFiles ?? undefined,
              skillsHash: event.skillsHash ?? undefined,
              subagentNames: event.subagentNames ?? undefined,
              modelPool: event.modelPool ?? undefined,
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
    instructionsChange,
    skillCatalogChange,
    agentCatalogChange,
    skillListing,
    profileNames,
    profileMeta,
    sessionDisabledTools,
    secondaryModel,
  };
}

function agentsMdPrompt(path: string, content: string): string {
  return `intro\n\n<!-- From: ${path} -->\n${content}\n\noutro`;
}

async function flushWatch(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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

  it('reminds when content is deleted from the end of an injected AGENTS.md', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'line one\nline two\nline three');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'line one\nline two\nline three'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(0);

    await writeFile(agentsMdPath, 'line one\nline two');
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('agents_md_change');
    expect(h.reminders[0]?.content).toContain(agentsMdPath);
  });

  it('detects an AGENTS.md truncated before the first check of a legacy session', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'line one\nline two');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'line one\nline two\nline three'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('agents_md_change');
    expect(h.reminders[0]?.content).toContain(agentsMdPath);
  });

  it('detects an AGENTS.md emptied before the first check of a legacy session', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, '');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'v1 content'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain(agentsMdPath);
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

  it('reports (deleted) when a previously announced new file is removed', async () => {
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

    await rm(agentsMdPath, { force: true });
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(2);
    expect(h.reminders[1]?.content).toContain(`${agentsMdPath} (deleted)`);
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

  it('fires through the watch channel on an instructions change', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'v1 content');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'v1 content'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await writeFile(agentsMdPath, 'v2 content');
    h.instructionsChange.fire([{ path: agentsMdPath, action: 'modified', kind: 'file' }]);
    await vi.waitFor(() => {
      expect(h.reminders).toHaveLength(1);
    });
    expect(h.reminders[0]?.variant).toBe('agents_md_change');
    expect(h.reminders[0]?.content).toContain(agentsMdPath);
  });

  it('does not repeat a notification the watch channel already delivered before reload', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'v1 content');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'v1 content'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await writeFile(agentsMdPath, 'v2 content');
    h.instructionsChange.fire([{ path: agentsMdPath, action: 'modified', kind: 'file' }]);
    await vi.waitFor(() => {
      expect(h.reminders).toHaveLength(1);
    });

    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
  });

  it('does not repeat a reload notification when the watch channel fires afterwards', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'v1 content');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'v1 content'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await writeFile(agentsMdPath, 'v2 content');
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);

    h.instructionsChange.fire([{ path: agentsMdPath, action: 'modified', kind: 'file' }]);
    await flushWatch();
    expect(h.reminders).toHaveLength(1);
  });

  it('stays silent on a watch event when the profile is not bound yet', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'v1 content');
    const h = createHarness({
      profile: makeProfileData({ profileName: undefined }),
    });

    h.instructionsChange.fire([{ path: agentsMdPath, action: 'modified', kind: 'file' }]);
    await flushWatch();
    expect(h.reminders).toHaveLength(0);
  });
});

describe('seedBeliefs', () => {
  it('detects a trailing deletion on the first evaluation after seeding', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'line one\nline two\nline three');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'line one\nline two\nline three'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await h.notifier.seedBeliefs({ agentsMd: agentsMdPrompt(agentsMdPath, 'line one\nline two\nline three'), agentsMdPaths: [agentsMdPath], skillsListing: LISTING_A });

    await writeFile(agentsMdPath, 'line one\nline two');
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('agents_md_change');
    expect(h.reminders[0]?.content).toContain(agentsMdPath);
  });

  it('anchors the skill listing so an unchanged catalog stays silent without prompt coverage', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default', systemPrompt: 'no listing here' }),
    });
    h.skillListing.value = LISTING_A;

    await h.notifier.seedBeliefs({ agentsMd: '', agentsMdPaths: [], skillsListing: LISTING_A });
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(0);

    h.skillListing.value = LISTING_AB;
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('skills_change');
  });

  it('anchors subagent names and the model pool at seed time', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    h.secondaryModel.value = { defaultModel: 'k1', models: { k1: '' } };

    await h.notifier.seedBeliefs({ agentsMd: '', agentsMdPaths: [], skillsListing: '' });

    h.profileNames.value = ['default', 'deploy'];
    h.agentCatalogChange.fire('workspace');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Profiles added: deploy');

    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
  });

  it('re-detects content matching a stale overall hash after a reseed', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'content A');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'content A'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(0);

    await writeFile(agentsMdPath, 'content B');
    await h.notifier.seedBeliefs({ agentsMd: agentsMdPrompt(agentsMdPath, 'content B'), agentsMdPaths: [agentsMdPath], skillsListing: '' });

    await writeFile(agentsMdPath, 'content A');
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('agents_md_change');
  });

  it('anchors beliefs to the rendered snapshot rather than a reread of disk', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'disk version B');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: agentsMdPrompt(agentsMdPath, 'rendered version A'),
        agentsMdPaths: [agentsMdPath],
      }),
    });

    await h.notifier.seedBeliefs({
      agentsMd: agentsMdPrompt(agentsMdPath, 'rendered version A'),
      agentsMdPaths: [agentsMdPath],
      skillsListing: '',
    });

    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('agents_md_change');
    expect(h.reminders[0]?.content).toContain(agentsMdPath);
  });

  it('splits multi-file rendered content so only the changed file is reported', async () => {
    const globalPath = join(homeDir, 'AGENTS.md');
    const projectPath = join(workDir, 'AGENTS.md');
    await writeFile(globalPath, 'global rules');
    await writeFile(projectPath, 'project rules');
    const rendered = `<!-- From: ${globalPath} -->\nglobal rules\n\n<!-- From: ${projectPath} -->\nproject rules`;
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: `intro\n\n${rendered}\n\noutro`,
        agentsMdPaths: [globalPath, projectPath],
      }),
    });

    await h.notifier.seedBeliefs({
      agentsMd: rendered,
      agentsMdPaths: [globalPath, projectPath],
      skillsListing: '',
    });

    await writeFile(projectPath, 'project rules v2');
    await h.notifier.notifyAgentsMdChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain(projectPath);
    expect(h.reminders[0]?.content).not.toContain(globalPath);
  });
});

const LISTING_A = 'DISREGARD any earlier skill listings. Current available skills:\n- skill-a: does A';
const LISTING_AB = `${LISTING_A}\n- skill-b: does B`;

describe('notifySkillChanges', () => {

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

  it('reminds again when the listing returns to the prompt copy after a delivered reminder', async () => {
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

    h.skillListing.value = LISTING_A;
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(2);
    expect(h.reminders[1]?.variant).toBe('skills_change');
  });

  it('advances beliefs without reminding while the Skill tool is disabled', async () => {
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: `header\n\n${LISTING_A}\n\nfooter`,
      }),
    });
    h.skillListing.value = LISTING_A;
    await h.notifier.notifySkillChanges();

    h.sessionDisabledTools.value = ['Skill'];
    h.skillListing.value = LISTING_AB;
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(0);

    h.sessionDisabledTools.value = [];
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(0);

    h.skillListing.value = LISTING_A;
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('skill-a');
  });

  it('gates the skill reminder with the persisted binding policy', async () => {
    const profileData = makeProfileData({ profileName: 'default', activeToolNames: ['Read'] });
    const h = createHarness({ profile: profileData });
    h.skillListing.value = LISTING_A;
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(0);

    (profileData as { activeToolNames?: readonly string[] }).activeToolNames = ['Skill'];
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(0);

    h.skillListing.value = LISTING_AB;
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('skills_change');
  });

  it('detects a truncated skill listing before the first check of a legacy session', async () => {
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: `header\n\n${LISTING_AB}\n\nfooter`,
      }),
    });
    h.skillListing.value = LISTING_A;

    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('skills_change');
    expect(h.reminders[0]?.content).toContain('skill-a');
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

    await h.notifier.notifySubagentChanges({ previousModelPool: null });
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Models added: k1, k2');
  });

  it('diffs the pool against persisted beliefs when the pre-reload capture is already current', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    h.secondaryModel.value = { defaultModel: 'k1', models: { k1: '' } };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);

    h.secondaryModel.value = { defaultModel: 'k2', models: { k2: '' } };
    await h.notifier.notifySubagentChanges({
      previousModelPool: { defaultModel: 'k2', models: { k2: '' } },
    });
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Models added: k2');
    expect(h.reminders[0]?.content).toContain('Models removed: k1');
    expect(h.reminders[0]?.content).toContain('Default model changed: k1 → k2');
  });

  it('diffs profiles against persisted beliefs when the pre-reload capture is already current', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);

    h.profileNames.value = ['default', 'deploy'];
    await h.notifier.notifySubagentChanges({ previousSubagentNames: ['default', 'deploy'] });
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Profiles added: deploy');
  });

  it('inlines description and whenToUse for added profiles when available', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    await h.notifier.notifySubagentChanges();

    h.profileNames.value = ['default', 'deploy', 'reviewer', 'silent'];
    h.profileMeta.value = {
      deploy: { description: '部署服务', whenToUse: '发布到生产环境时' },
      reviewer: { description: '只做代码评审' },
    };
    h.agentCatalogChange.fire('workspace');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain(
      'Profiles added: deploy (部署服务; 发布到生产环境时), reviewer (只做代码评审), silent',
    );
  });

  it('reports model description updates in the pool', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    h.secondaryModel.value = {
      defaultModel: 'k1',
      models: { k1: 'fast', k2: '' },
    };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);

    h.secondaryModel.value = {
      defaultModel: 'k1',
      models: { k1: 'fastest', k2: '' },
    };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Model descriptions updated: k1');
  });

  it('reports default model changes in the pool', async () => {
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
      defaultModel: 'k2',
      models: { k1: '', k2: '' },
    };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Default model changed: k1 → k2');
  });

  it('stays silent when the pool is identical including descriptions and default', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    h.secondaryModel.value = {
      defaultModel: 'k1',
      models: { k1: 'fast', k2: '' },
    };
    await h.notifier.notifySubagentChanges();
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);
  });

  it('reports default model set and cleared', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    h.secondaryModel.value = { models: { k1: '', k2: '' } };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);

    h.secondaryModel.value = { defaultModel: 'k2', models: { k1: '', k2: '' } };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Default model set: k2');

    h.secondaryModel.value = { models: { k1: '', k2: '' } };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(2);
    expect(h.reminders[1]?.content).toContain('Default model cleared (was k2)');
  });

  it('combines alias, description, and default changes in one reminder', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    h.secondaryModel.value = {
      defaultModel: 'k1',
      models: { k1: 'fast', k2: 'old' },
    };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);

    h.secondaryModel.value = {
      defaultModel: 'k2',
      models: { k2: 'new', k3: '' },
    };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Models added: k3');
    expect(h.reminders[0]?.content).toContain('Models removed: k1');
    expect(h.reminders[0]?.content).toContain('Model descriptions updated: k2');
    expect(h.reminders[0]?.content).toContain('Default model changed: k1 → k2');
  });

  it('reports a pool appearing after a seeded no-pool baseline without previous input', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });

    await h.notifier.seedBeliefs({ agentsMd: '', agentsMdPaths: [], skillsListing: '' });
    expect(h.reminders).toHaveLength(0);

    h.secondaryModel.value = { defaultModel: 'k1', models: { k1: '' } };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Models added: k1');
  });

  it('reports the pool returning after it was removed past the seeded baseline', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    h.secondaryModel.value = { defaultModel: 'k1', models: { k1: '' } };

    await h.notifier.seedBeliefs({ agentsMd: '', agentsMdPaths: [], skillsListing: '' });
    h.secondaryModel.value = undefined;
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Models removed: k1');

    h.secondaryModel.value = { defaultModel: 'k2', models: { k2: '' } };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(2);
    expect(h.reminders[1]?.content).toContain('Models added: k2');
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

  it('advances beliefs without reminding while the Agent tool is disabled', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    await h.notifier.notifySubagentChanges();

    h.sessionDisabledTools.value = ['Agent', 'AgentSwarm'];
    h.profileNames.value = ['default', 'deploy'];
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);

    h.sessionDisabledTools.value = [];
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);

    h.profileNames.value = ['default', 'deploy', 'reviewer'];
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Profiles added: reviewer');
  });

  it('still reminds when only AgentSwarm remains available', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    await h.notifier.notifySubagentChanges();

    h.sessionDisabledTools.value = ['Agent'];
    h.profileNames.value = ['default', 'deploy'];
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Profiles added: deploy');
  });

  it('filters reminders through the bound explicit subagent allowlist', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'custom-main', subagents: ['coder'] }),
    });
    h.profileNames.value = ['default', 'custom-main'];
    await h.notifier.notifySubagentChanges();

    h.profileNames.value = ['default', 'custom-main', 'coder', 'deploy'];
    h.agentCatalogChange.fire('workspace');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Profiles added: coder');
    expect(h.reminders[0]?.content).not.toContain('deploy');
  });

  it('diffs the first watch profile change against the startup baseline of a legacy session', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    h.profileNames.value = ['default', 'deploy'];
    h.agentCatalogChange.fire('workspace');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Profiles added: deploy');
  });

  it('diffs the first watch pool change against the startup baseline of a legacy session', async () => {
    const h = createHarness({
      profile: makeProfileData({ profileName: 'default' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    h.secondaryModel.value = { defaultModel: 'k1', models: { k1: '' } };
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.content).toContain('Models added: k1');
  });
});

describe('mute', () => {
  it('suppresses every notification channel after mute', async () => {
    const agentsMdPath = join(workDir, 'AGENTS.md');
    await writeFile(agentsMdPath, 'v1 content');
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: `${agentsMdPrompt(agentsMdPath, 'v1 content')}\n\n${LISTING_A}`,
        agentsMdPaths: [agentsMdPath],
      }),
    });
    h.skillListing.value = LISTING_A;

    await h.notifier.notifyAgentsMdChanges();
    await h.notifier.notifySkillChanges();
    await h.notifier.notifySubagentChanges();
    expect(h.reminders).toHaveLength(0);

    h.notifier.mute();

    await writeFile(agentsMdPath, 'v2 content');
    h.skillListing.value = LISTING_AB;
    h.profileNames.value = ['default', 'deploy'];
    await h.notifier.notifyAgentsMdChanges();
    await h.notifier.notifySkillChanges();
    await h.notifier.notifySubagentChanges();
    h.instructionsChange.fire([{ path: agentsMdPath, action: 'modified', kind: 'file' }]);
    h.skillCatalogChange.fire('user');
    h.agentCatalogChange.fire('workspace');
    await flushWatch();
    expect(h.reminders).toHaveLength(0);
  });

  it('resumes notifications after unmute', async () => {
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: `header\n\n${LISTING_A}\n\nfooter`,
      }),
    });
    h.skillListing.value = LISTING_A;
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(0);

    h.notifier.mute();
    h.skillListing.value = LISTING_AB;
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(0);

    h.notifier.unmute();
    await h.notifier.notifySkillChanges();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.variant).toBe('skills_change');
  });

  it('suppresses an in-flight notification that started before mute', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = createHarness({
      profile: makeProfileData({
        profileName: 'default',
        systemPrompt: `header\n\n${LISTING_A}\n\nfooter`,
      }),
      skillReady: gate,
    });
    h.skillListing.value = LISTING_AB;

    const pending = h.notifier.notifySkillChanges();
    h.notifier.mute();
    release();
    await pending;

    expect(h.reminders).toHaveLength(0);
  });
});

describe('snapshot schema evolution', () => {
  it('parses a legacy record that predates the belief fields', () => {
    const legacy = {
      type: 'changeNotifier.snapshot',
      agentId: 'main',
      agentsMdHash: 'legacy-hash',
      skillsHash: 'legacy-skills-hash',
      subagentNames: ['default'],
      modelPoolAliases: ['k1', 'k2'],
      time: 123,
    };

    const event = event2FromRecord(ChangeNotifierSnapshotEvent, legacy);
    expect(event).toBeDefined();
    const payload = event as unknown as ChangeNotifierSnapshotEvent;
    expect(payload.agentsMdHash).toBe('legacy-hash');
    expect(payload.skillsHash).toBe('legacy-skills-hash');
    expect(payload.subagentNames).toEqual(['default']);
    expect(payload.agentsMdFiles).toBeUndefined();
    expect(payload.modelPool).toBeUndefined();
  });
});
