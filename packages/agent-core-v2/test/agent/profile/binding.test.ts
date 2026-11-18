import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'pathe';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { TOOLS_SECTION } from '#/agent/toolPolicy/configSection';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { BuiltinAgentProfileLoaderService } from '#/app/agentProfileCatalog/builtinAgentProfileLoaderService';
import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';
import type { ToolCall } from '#human/message';
import {
  IAgentProfileService,
  type ProfileBindingSnapshot,
  type ResolvedAgentProfile,
} from '#/agent/profile/profile';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { WatchChange } from '#human/utils/watch';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { IAgentChangeNotifierService } from '#/agent/changeNotifier/changeNotifier';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { executeLegacyTool } from '../toolExecutor/execute';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { IAtomicDocumentStore, type IAtomicDocumentStore as AtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { IWireService } from '#/wire/wire';
import type { ExecutableTool, ToolExecution, ToolResult, ToolSource } from '#/tool/toolContract';

import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';

import { deferredAgentIdentityStub } from '../../app/agentIdentity/stubs';
import {
  InMemoryWireRecordPersistence,
  agentService,
  appService,
  createTestAgent,
  hostEnvironmentServices,
  sessionService,
  type TestAgentContext,
} from '../../harness';

const MOCK_MODEL = 'mock-model';

function profileServices(ctx: TestAgentContext): {
  profile: IAgentLoopService;
  defaultProfile: IAgentProfileService;
  toolPolicy: IAgentToolPolicyService;
} {
  return {
    profile: ctx.get(IAgentLoopService),
    defaultProfile: ctx.get(IAgentProfileService),
    toolPolicy: ctx.get(IAgentToolPolicyService),
  };
}

function createAtomicDocumentStore(): AtomicDocumentStore {
  const documents = new Map<string, unknown>();
  const documentKey = (scope: string, key: string): string => `${scope}/${key}`;
  return {
    _serviceBrand: undefined,
    get: async <T>(scope: string, key: string) => documents.get(documentKey(scope, key)) as T | undefined,
    set: async <T>(scope: string, key: string, value: T) => {
      documents.set(documentKey(scope, key), structuredClone(value));
    },
    delete: async (scope: string, key: string) => {
      documents.delete(documentKey(scope, key));
    },
    list: async (scope: string, prefix = '') =>
      [...documents.keys()]
        .filter((key) => key.startsWith(`${scope}/${prefix}`))
        .map((key) => key.slice(scope.length + 1)),
    acquire: () => ({ dispose: () => {} }),
  };
}

describe('AgentProfileService.bind', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeAll(() => {
    registerAgentProfile({
      name: 'delegates-explore',
      subagents: ['explore'],
      systemPrompt: () => 'delegate test',
    });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-bind-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function buildContext(): { ctx: TestAgentContext; profile: IAgentLoopService } {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    return { ctx, profile: ctx.get(IAgentLoopService) };
  }

  it('binds a profile + model atomically and becomes runnable', async () => {
    const { profile: svc } = buildContext();

    const container = new InstantiationService(new ServiceCollection(), true);
    const catalog = new BuiltinAgentProfileLoaderService(container);
    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeDefined();
    catalog.dispose();
    container.dispose();

    expect(svc.isRunnable()).toBe(false);

    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
    expect(svc.getActiveToolNames()?.length).toBeGreaterThan(0);
    expect(svc.getSystemPrompt()).toContain('Kimi Code CLI');
  });

  it('unions discovered agent profiles into the bound subagents for the main agent', async () => {
    const { profile: svc } = buildContext();
    ctx.get(IAgentProfileRegistry).register({
      sourceId: 'workspace',
      priority: 30,
      contribution: {
        profiles: [
          normalizeAgentProfile({
            name: 'code-reviewer',
            description: 'Reviews code',
            tools: ['Read'],
            systemPrompt: () => 'reviewer',
          }),
        ],
      },
    });

    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(svc.data().subagents).toEqual(['coder', 'explore', 'plan', 'code-reviewer']);
  });

  it('recomputes the bound subagent allowlist when the catalog gains a profile after bind', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      {
        persistence,
        autoConfigure: false,
        initialConfig: {
          providers: {
            kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' },
          },
          models: {
            [MOCK_MODEL]: {
              provider: 'kimi',
              model: MOCK_MODEL,
              maxContextSize: 1_000_000,
              capabilities: ['always_thinking'],
              supportEfforts: ['low', 'high'],
              defaultEffort: 'high',
            },
          },
        },
      },
      hostEnvironmentServices(homeDir),
    );
    const svc = ctx.get(IAgentLoopService);

    await svc.bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    await svc.applyBindingSnapshot({ ...svc.bindingSnapshot(), thinkingLevel: 'off' });
    expect(svc.data().subagents).toEqual(['coder', 'explore', 'plan']);
    expect(svc.bindingSnapshot().thinkingLevel).toBe('off');
    expect(svc.getEffectiveThinkingLevel()).toBe('high');

    ctx.get(IAgentProfileRegistry).register({
      sourceId: 'workspace',
      priority: 30,
      contribution: {
        profiles: [
          normalizeAgentProfile({
            name: 'code-reviewer',
            description: 'Reviews code',
            tools: ['Read'],
            systemPrompt: () => 'reviewer',
          }),
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.get(IWireService).flush();

    expect(svc.data().subagents).toEqual(['coder', 'explore', 'plan', 'code-reviewer']);
    expect(svc.bindingSnapshot().thinkingLevel).toBe('off');
    expect(svc.getEffectiveThinkingLevel()).toBe('high');

    const bindCount = persistence.records.filter((record) => record.type === 'profile.bind').length;
    await ctx.get(ISessionAgentProfileCatalog).reload();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.get(IWireService).flush();
    expect(persistence.records.filter((record) => record.type === 'profile.bind')).toHaveLength(
      bindCount,
    );
  });

  it('honors the explicit subagents of a discovered profile bound as main', async () => {
    const { profile: svc } = buildContext();
    ctx.get(IAgentProfileRegistry).register({
      sourceId: 'workspace',
      priority: 30,
      contribution: {
        profiles: [
          normalizeAgentProfile({
            name: 'custom-main',
            description: 'Custom main agent',
            subagents: ['coder'],
            systemPrompt: () => 'custom main',
          }),
        ],
      },
    });

    await ctx.get(IAgentLoopService).bindProfile({ profile: 'custom-main', model: MOCK_MODEL });

    expect(svc.data().subagents).toEqual(['coder']);
  });

  it('preserves an explicit wildcard subagents on a profile bound as main', async () => {
    const { profile: svc } = buildContext();
    ctx.get(IAgentProfileRegistry).register({
      sourceId: 'workspace',
      priority: 30,
      contribution: {
        profiles: [
          normalizeAgentProfile({
            name: 'wild-main',
            description: 'Wildcard main agent',
            subagents: ['*'],
            systemPrompt: () => 'wild main',
          }),
        ],
      },
    });

    await ctx.get(IAgentLoopService).bindProfile({ profile: 'wild-main', model: MOCK_MODEL });

    expect(svc.data().subagents).toEqual(['*']);
  });

  it('waits for the identity freeze instead of racing it', async () => {
    const deferred = deferredAgentIdentityStub();
    ctx = createTestAgent(
      appService(IAgentIdentity, deferred.identity),
      hostEnvironmentServices(homeDir),
    );
    const svc = ctx.get(IAgentLoopService);

    const bound = ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    setTimeout(() => deferred.freeze(), 20);
    await bound;

    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
  });

  it('binds an environment disclosure snapshot with only the session cwd', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    const svc = ctx.get(IAgentLoopService);

    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(svc.getSystemPrompt()).not.toContain('2026-07-29');
    expect(svc.data().environmentDisclosure).toEqual({ cwd: ctx.get(ISessionContext).cwd });
  });

  it('persists the complete binding in one journal record', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      {
        persistence,
        autoConfigure: false,
        initialConfig: {
          thinking: { enabled: true, effort: 'low' },
        },
      },
      hostEnvironmentServices(homeDir),
    );
    const svc = ctx.get(IAgentLoopService);
    svc.remind({ role: 'system', content: [{ type: 'text', text: 'before loop start' }] });
    svc.flushReminders();
    expect(svc.history()).toHaveLength(0);
    await svc.start();
    svc.flushReminders();
    expect(svc.history()).toContainEqual(expect.objectContaining({
      role: 'system',
      content: [{ type: 'text', text: 'before loop start' }],
    }));
    ctx.configure({
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        maxContextSize: 1_000_000,
      },
    });
    await ctx.get(IWireService).flush();
    const start = persistence.records.length;

    await ctx.get(IAgentLoopService).bindProfile({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
      thinking: 'low',
    });
    await ctx.get(IWireService).flush();

    const records = persistence.records.slice(start).filter(
      (record) => record.type === 'profile.bind' && record['thinkingEffort'] === 'on',
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'profile.bind',
      profileName: DEFAULT_AGENT_PROFILE_NAME,
      modelAlias: MOCK_MODEL,
      thinkingEffort: 'on',
      systemPrompt: expect.stringContaining('Kimi Code CLI'),
      activeToolNames: expect.arrayContaining(['Read', 'Write', 'Bash']),
      disallowedTools: [],
    });
  });

  it('restores the subagent allowlist from the binding record without catalog resolution', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir));

    await ctx.get(IAgentLoopService).bindProfile({
      profile: 'delegates-explore',
      model: MOCK_MODEL,
    });
    await ctx.get(IWireService).flush();

    const bindingRecord = persistence.records.findLast((record) => record.type === 'profile.bind');
    expect(bindingRecord).toMatchObject({
      profileName: 'delegates-explore',
      subagents: ['explore'],
    });

    await ctx.dispose();
    const emptyCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None,
      get: () => undefined,
      getDefault: () => ({
        name: DEFAULT_AGENT_PROFILE_NAME,
        tools: undefined,
        systemPrompt: () => '',
      }),
      list: () => [],
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      { persistence },
      hostEnvironmentServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, emptyCatalog),
    );

    await ctx.restorePersisted();

    expect(ctx.get(IAgentLoopService).data()).toMatchObject({
      profileName: 'delegates-explore',
      subagents: ['explore'],
    });
    expect(ctx.get(IAgentLoopService).data().agentsMdPaths).toEqual(
      bindingRecord?.['agentsMdPaths'],
    );
  });

  it('restores a binding recorded with EnterPlanMode with its prompt and rejects the removed tool', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir));
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    await ctx.get(IWireService).flush();
    await ctx.dispose();

    const legacyPrompt = 'Legacy system prompt recorded while EnterPlanMode existed.';
    const legacyRecords = persistence.records.map((record) =>
      record.type === 'profile.bind'
        ? {
            ...record,
            systemPrompt: legacyPrompt,
            activeToolNames: [
              ...((record['activeToolNames'] as readonly string[] | undefined) ?? []),
              'EnterPlanMode',
            ],
          }
        : record,
    );
    ctx = createTestAgent(
      { persistence: new InMemoryWireRecordPersistence(legacyRecords), autoConfigure: false },
      hostEnvironmentServices(homeDir),
    );
    await ctx.restorePersisted();

    const { profile, toolPolicy } = profileServices(ctx);
    expect(profile.getSystemPrompt()).toBe(legacyPrompt);
    expect(profile.getActiveToolNames()).toContain('EnterPlanMode');
    expect(toolPolicy.isToolActive('ExitPlanMode')).toBe(true);
    expect(await executeDirectToolCall(ctx, 'EnterPlanMode')).toMatchObject({
      isError: true,
      output: 'Tool "EnterPlanMode" not found',
    });
  });

  it('keeps the system prompt frozen after a default bind when AGENTS.md changes', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-bind-work-'));
    try {
      await writeFile(join(workDir, 'AGENTS.md'), 'v1 instructions', 'utf-8');
      ctx = createTestAgent(hostEnvironmentServices(homeDir), { cwd: workDir });
      const svc = ctx.get(IAgentLoopService);
      await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
      const bound = svc.getSystemPrompt();
      expect(bound).toContain('v1 instructions');

      await writeFile(join(workDir, 'AGENTS.md'), 'v2 instructions', 'utf-8');

      expect(svc.getSystemPrompt()).toBe(bound);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('freezes the system prompt when the session instructions change', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const emitter = new Emitter<readonly WatchChange[]>();
    let agentsMd = 'v1 instructions';
    ctx = createTestAgent(
      { persistence },
      hostEnvironmentServices(homeDir),
      sessionService(ISessionInstructionsProvider, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        get agentsMd() {
          return agentsMd;
        },
        agentsMdWarning: undefined,
        agentsMdPaths: [],
        onDidChange: emitter.event,
      } satisfies ISessionInstructionsProvider),
    );
    const svc = ctx.get(IAgentLoopService);
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const before = svc.getSystemPrompt();
    expect(before).toContain('v1 instructions');
    await ctx.get(IWireService).flush();
    const configUpdates = () =>
      persistence.records.filter(
        (record) => record.type === 'config.update' && 'systemPrompt' in record,
      );
    const configUpdateCount = configUpdates().length;

    agentsMd = 'v2 instructions';
    emitter.fire([{ path: '/repo/AGENTS.md', action: 'modified', kind: 'file' }]);
    await ctx.get(IWireService).flush();

    expect(svc.getSystemPrompt()).toBe(before);
    expect(configUpdates()).toHaveLength(configUpdateCount);
  });

  it('setModel applies the default profile when none is bound yet', async () => {
    const { profile: svc } = buildContext();

    expect(svc.data().profileName).toBeUndefined();

    await ctx.get(IAgentLoopService).setModel(MOCK_MODEL);

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
  });

  it('setModel keeps the existing profile when one is already bound', async () => {
    const { profile: svc } = buildContext();

    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    await ctx.get(IAgentLoopService).setModel(MOCK_MODEL);

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('rejects binding a different profile once bound', async () => {
    const { profile: svc } = buildContext();

    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    await expect(ctx.get(IAgentLoopService).bindProfile({ profile: 'coder', model: MOCK_MODEL })).rejects.toThrow(
      /already bound/,
    );
    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('rejects an unsupported thinking effort atomically before first bind', async () => {
    ctx = createTestAgent(
      {
        autoConfigure: false,
        initialConfig: {
          providers: {
            kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' },
          },
          models: {
            'kimi-code/kimi-for-coding': {
              provider: 'kimi',
              model: 'kimi-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['thinking'],
              supportEfforts: ['low', 'high'],
            },
          },
        },
      },
      hostEnvironmentServices(homeDir),
    );
    const svc = ctx.get(IAgentLoopService);

    await expect(
      ctx.get(IAgentLoopService).bindProfile({
        profile: DEFAULT_AGENT_PROFILE_NAME,
        model: 'kimi-code/kimi-for-coding',
        thinking: 'ultra',
        strictThinking: true,
      }),
    ).rejects.toThrow(/not supported by model/);

    expect(svc.data().profileName).toBeUndefined();
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'kimi-code/kimi-for-coding' });
    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('clamps an inherited unsupported thinking effort instead of rejecting the bind', async () => {
    ctx = createTestAgent(
      {
        initialConfig: {
          providers: {
            kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' },
          },
          models: {
            'kimi-code/kimi-for-coding': {
              provider: 'kimi',
              model: 'kimi-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['thinking'],
              supportEfforts: ['low', 'high'],
            },
          },
        },
      },
      hostEnvironmentServices(homeDir),
    );
    const svc = ctx.get(IAgentLoopService);

    await ctx.get(IAgentLoopService).bindProfile({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: 'kimi-code/kimi-for-coding',
      thinking: 'ultra',
    });

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().thinkingLevel).toBe('high');
  });

  it('keeps the persisted thinking effort on a same-name rebind', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    ctx.configure({
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        maxContextSize: 1_000_000,
      },
    });
    const svc = ctx.get(IAgentLoopService);
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL, thinking: 'off' });
    expect(svc.data().thinkingLevel).toBe('off');

    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(svc.data().thinkingLevel).toBe('off');
  });
});

describe('AgentToolPolicyService tool denylist', () => {
  beforeAll(() => {
    registerAgentProfile({
      name: 'deny-builtin',
      disallowedTools: ['Bash'],
      systemPrompt: () => 'deny test',
    });
    registerAgentProfile({
      name: 'deny-over-allow',
      tools: ['Read', 'Bash'],
      disallowedTools: ['Bash'],
      systemPrompt: () => 'deny test',
    });
    registerAgentProfile({
      name: 'deny-mcp',
      disallowedTools: ['mcp__github__*'],
      systemPrompt: () => 'deny test',
    });
  });

  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-deny-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  async function bindProfile(name: string): Promise<IAgentToolPolicyService> {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentLoopService).bindProfile({ profile: name, model: MOCK_MODEL });
    return ctx.get(IAgentToolPolicyService);
  }

  it('blocks a denied builtin tool while others stay active', async () => {
    const svc = await bindProfile('deny-builtin');
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('denylist wins over the allowlist', async () => {
    const svc = await bindProfile('deny-over-allow');
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Write')).toBe(false);
  });

  it('matches denied mcp tools by glob', async () => {
    const svc = await bindProfile('deny-mcp');
    expect(svc.isToolActive('mcp__github__create_pr', 'mcp')).toBe(false);
    expect(svc.isToolActive('mcp__other__ping', 'mcp')).toBe(true);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('distinguishes explicit denies from allowlist misses via isToolDenied', async () => {
    const svc = await bindProfile('deny-over-allow');
    expect(svc.isToolDenied('Bash')).toBe(true);
    expect(svc.isToolDenied('Write')).toBe(false);
    expect(svc.isToolDenied('Read')).toBe(false);
  });

  it('matches unregistered mcp names against deny globs via isToolDenied', async () => {
    const svc = await bindProfile('deny-mcp');
    expect(svc.isToolDenied('mcp__github__get_issue')).toBe(true);
    expect(svc.isToolDenied('mcp__other__ping')).toBe(false);
    expect(svc.isToolDenied('Read')).toBe(false);
  });

  it('lists available profiles when binding an unknown profile', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await expect(
      ctx.get(IAgentLoopService).bindProfile({ profile: 'does-not-exist', model: MOCK_MODEL }),
    ).rejects.toThrow(/Available profiles: .*agent/);
  });

  it('persists the denylist in the bind records', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir));

    await ctx.get(IAgentLoopService).bindProfile({ profile: 'deny-builtin', model: MOCK_MODEL });
    await ctx.get(IWireService).flush();

    const record = persistence.records.findLast((candidate) => candidate.type === 'profile.bind');
    expect(record).toMatchObject({ profileName: 'deny-builtin', disallowedTools: ['Bash'] });
  });

  it('persists an unrestricted tool policy when the profile has no allowlist', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir));
    const { profile, toolPolicy } = profileServices(ctx);

    await ctx.get(IAgentLoopService).bindProfile({ profile: 'deny-builtin', model: MOCK_MODEL });
    await ctx.get(IWireService).flush();

    expect(persistence.records.findLast((record) => record.type === 'profile.bind')).toMatchObject({
      activeToolNames: undefined,
    });
    expect(toolPolicy.isToolActive('Read')).toBe(true);
    expect(toolPolicy.isToolActive('Bash')).toBe(false);
  });

  it('restores the denylist from persisted records on resume without catalog resolution', async () => {
    const defaultSnapshot: ProfileBindingSnapshot = {
      modelAlias: 'default-model',
      profileName: 'default-profile',
      thinkingLevel: 'off',
      systemPrompt: 'default-SP',
      activeToolNames: ['Bash'],
      disallowedTools: [],
    };
    const effective: ProfileBindingSnapshot = {
      modelAlias: 'legacy-effective-model',
      profileName: 'deny-builtin',
      thinkingLevel: 'low',
      systemPrompt: 'effective-SP',
      activeToolNames: ['Read'],
      disallowedTools: ['Bash'],
      subagents: ['coder'],
      environmentDisclosure: { cwd: '/effective-work' },
    };
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir));
    const initial = profileServices(ctx);
    initial.defaultProfile.applyBindingSnapshot(defaultSnapshot);
    await ctx.get(IWireService).flush();
    expect(persistence.records.filter((record) => record.type === 'profile.bind')).toHaveLength(1);

    await initial.profile.setProfile(effective);
    await initial.profile.setModel(MOCK_MODEL);
    initial.profile.setThinking('off');
    initial.profile.update({
      systemPrompt: 'persisted-effective-SP',
      environmentDisclosure: effective.environmentDisclosure,
    });
    initial.profile.update({ activeToolNames: ['Grep'] });
    await ctx.get(IWireService).flush();
    expect(persistence.records.filter((record) => record.type === 'profile.bind')).toHaveLength(2);
    await ctx.dispose();

    const emptyCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None,
      get: () => undefined,
      getDefault: () => ({
        name: DEFAULT_AGENT_PROFILE_NAME,
        tools: undefined,
        systemPrompt: () => '',
      }),
      list: () => [],
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      { persistence },
      hostEnvironmentServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, emptyCatalog),
    );
    const defaults = ctx.get(IAgentProfileService);
    defaults.applyBindingSnapshot(defaultSnapshot);
    const beforeOpen = persistence.records.filter((record) => record.type === 'profile.bind').length;
    await ctx.restorePersisted();
    const resumed = profileServices(ctx);

    expect(resumed.profile.data()).toMatchObject({
      modelAlias: MOCK_MODEL,
      profileName: 'deny-builtin',
      thinkingLevel: 'off',
      systemPrompt: 'persisted-effective-SP',
      activeToolNames: ['Grep'],
      disallowedTools: ['Bash'],
      subagents: ['coder'],
      environmentDisclosure: { cwd: '/effective-work' },
    });
    expect(resumed.profile.resolveModelContext()).toMatchObject({
      modelAlias: MOCK_MODEL,
      thinkingLevel: 'off',
    });
    expect(resumed.defaultProfile.data()).toMatchObject(defaultSnapshot);
    expect(persistence.records.filter((record) => record.type === 'profile.bind')).toHaveLength(beforeOpen);
    expect(resumed.toolPolicy.isToolActive('Bash')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Grep')).toBe(true);
    expect(resumed.toolPolicy.isToolActive('Read')).toBe(false);

    const lifecycle = ctx.get(IAgentLifecycleService);
    const forked = await lifecycle.fork(lifecycle.get('main')!);
    expect(lifecycle.handleOf(forked.agentId)!.accessor.get(IAgentLoopService).data()).toMatchObject({
      modelAlias: MOCK_MODEL,
      thinkingLevel: 'off',
      systemPrompt: 'persisted-effective-SP',
      activeToolNames: ['Grep'],
    });

    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput().input.systemPrompt).toBe('persisted-effective-SP');
    await ctx.get(IAgentConversationUndoService).undo(1);
    expect(resumed.profile.data()).toMatchObject({
      modelAlias: MOCK_MODEL,
      thinkingLevel: 'off',
      systemPrompt: 'persisted-effective-SP',
      activeToolNames: ['Grep'],
    });
    expect(resumed.defaultProfile.data()).toMatchObject(defaultSnapshot);
    await ctx.dispose();

    const legacy = new InMemoryWireRecordPersistence([{
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: 'legacy' }] },
    }]);
    ctx = createTestAgent({ persistence: legacy }, hostEnvironmentServices(homeDir));
    await ctx.restorePersisted();
    expect(legacy.records.filter((record) => record.type === 'profile.bind')).toHaveLength(0);
  });
});

describe('AgentToolPolicyService global [tools] config', () => {
  beforeAll(() => {
    registerAgentProfile({
      name: 'config-intersect',
      tools: ['Read', 'Bash'],
      disallowedTools: ['Bash'],
      systemPrompt: () => 'config intersect test',
    });
  });

  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-tools-config-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  async function bindWithToolsConfig(
    tools: Record<string, readonly string[]>,
    profile: string = DEFAULT_AGENT_PROFILE_NAME,
  ): Promise<IAgentToolPolicyService> {
    ctx = createTestAgent({ initialConfig: { tools } }, hostEnvironmentServices(homeDir));
    await ctx.get(IAgentLoopService).bindProfile({ profile, model: MOCK_MODEL });
    return ctx.get(IAgentToolPolicyService);
  }

  it('treats a non-empty enabled list as a global allowlist', async () => {
    const svc = await bindWithToolsConfig({ enabled: ['Read'] });
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Bash')).toBe(false);
  });

  it('treats an empty enabled list as unconstrained', async () => {
    const svc = await bindWithToolsConfig({ enabled: [] });
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Bash')).toBe(true);
  });

  it('applies disabled as a global denylist', async () => {
    const svc = await bindWithToolsConfig({ disabled: ['Bash'] });
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('fingerprints live global allowlist and denylist changes', async () => {
    const svc = await bindWithToolsConfig({});
    const initial = svc.getPolicyFingerprint();
    await ctx.get(IConfigService).replace(TOOLS_SECTION, { enabled: ['Read'] }, ConfigTarget.Memory);
    const allowed = svc.getPolicyFingerprint();
    expect(allowed).not.toBe(initial);
    await ctx.get(IConfigService).replace(
      TOOLS_SECTION, { enabled: ['Read'], disabled: ['UnregisteredTool'] }, ConfigTarget.Memory,
    );
    expect(svc.getPolicyFingerprint()).not.toBe(allowed);
  });

  it('matches globally disabled mcp tools by glob', async () => {
    const svc = await bindWithToolsConfig({ disabled: ['mcp__github__*'] });
    expect(svc.isToolActive('mcp__github__create_pr', 'mcp')).toBe(false);
    expect(svc.isToolActive('mcp__other__ping', 'mcp')).toBe(true);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('marks globally disabled names as denied via isToolDenied', async () => {
    const svc = await bindWithToolsConfig({ disabled: ['Bash', 'mcp__github__*'] });
    expect(svc.isToolDenied('Bash')).toBe(true);
    expect(svc.isToolDenied('mcp__github__create_pr')).toBe(true);
    expect(svc.isToolDenied('mcp__other__ping')).toBe(false);
    expect(svc.isToolDenied('Read')).toBe(false);
  });

  it('intersects the global config with the profile policy instead of overriding it', async () => {
    const svc = await bindWithToolsConfig({ enabled: ['Read', 'Bash'] }, 'config-intersect');
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Write')).toBe(false);
  });
});

describe('AgentToolPolicyService.setSessionDisabledTools', () => {
  beforeAll(() => {
    registerAgentProfile({
      name: 'session-deny',
      disallowedTools: ['Write'],
      systemPrompt: () => 'session deny test',
    });
  });

  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-session-deny-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  async function bind(profile: string): Promise<IAgentToolPolicyService> {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentLoopService).bindProfile({ profile, model: MOCK_MODEL });
    return ctx.get(IAgentToolPolicyService);
  }

  it('rejects when no profile is bound yet', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    const toolPolicy = ctx.get(IAgentToolPolicyService);

    await expect(toolPolicy.setSessionDisabledTools(['Bash'])).rejects.toThrow(/not bound/);
    expect(toolPolicy.isToolActive('Bash')).toBe(true);
  });

  it('replaces the client-managed denylist on every call', async () => {
    const svc = await bind(DEFAULT_AGENT_PROFILE_NAME);

    await svc.setSessionDisabledTools(['Bash']);
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);

    await svc.setSessionDisabledTools(['Edit']);
    expect(svc.isToolActive('Bash')).toBe(true);
    expect(svc.isToolActive('Edit')).toBe(false);
  });

  it('marks session-disabled names as denied via isToolDenied', async () => {
    const svc = await bind(DEFAULT_AGENT_PROFILE_NAME);

    expect(svc.isToolDenied('Automation')).toBe(false);
    await svc.setSessionDisabledTools(['Automation']);
    expect(svc.isToolDenied('Automation')).toBe(true);
    await svc.setSessionDisabledTools([]);
    expect(svc.isToolDenied('Automation')).toBe(false);
  });

  it('fingerprints policy changes but ignores name ordering and duplicates', async () => {
    const svc = await bind(DEFAULT_AGENT_PROFILE_NAME);
    const initial = svc.getPolicyFingerprint();
    await svc.setSessionDisabledTools(['UnregisteredTool', 'AnotherTool']);
    const disabled = svc.getPolicyFingerprint();
    expect(disabled).not.toBe(initial);
    await svc.setSessionDisabledTools(['AnotherTool', 'UnregisteredTool', 'AnotherTool']);
    expect(svc.getPolicyFingerprint()).toBe(disabled);
    await svc.setSessionDisabledTools([]);
    expect(svc.getPolicyFingerprint()).toBe(initial);

    ctx.get(IAgentLoopService).update({ disallowedTools: ['UnregisteredTool'] });
    const profileDenied = svc.getPolicyFingerprint();
    expect(profileDenied).not.toBe(initial);
    ctx.get(IAgentLoopService).update({ activeToolNames: ['Read'] });
    expect(svc.getPolicyFingerprint()).not.toBe(profileDenied);
  });

  it('keeps the profile own denylist across replacement calls', async () => {
    const svc = await bind('session-deny');

    await svc.setSessionDisabledTools(['Bash']);
    expect(svc.isToolActive('Write')).toBe(false);
    expect(svc.isToolActive('Bash')).toBe(false);

    await svc.setSessionDisabledTools([]);
    expect(svc.isToolActive('Write')).toBe(false);
    expect(svc.isToolActive('Bash')).toBe(true);
  });

  it('persists the session denylist across a resume', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const atomicDocuments = createAtomicDocumentStore();
    const documentServices = appService(IAtomicDocumentStore, atomicDocuments);
    ctx = createTestAgent(
      { persistence },
      documentServices,
      hostEnvironmentServices(homeDir),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await ctx.get(IAgentLoopService).bindProfile({ profile: 'session-deny', model: MOCK_MODEL });
    await toolPolicy.setSessionDisabledTools(['Bash']);
    await ctx.get(IWireService).flush();
    await ctx.dispose();

    const emptyCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None,
      get: () => undefined,
      getDefault: () => ({
        name: DEFAULT_AGENT_PROFILE_NAME,
        tools: undefined,
        systemPrompt: () => '',
      }),
      list: () => [],
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      { persistence },
      documentServices,
      hostEnvironmentServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, emptyCatalog),
    );
    await ctx.restorePersisted();
    await ctx.get(ISessionToolPolicy).ready;
    const resumed = profileServices(ctx);

    expect(resumed.toolPolicy.isToolActive('Bash')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Write')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Read')).toBe(true);

    await resumed.toolPolicy.setSessionDisabledTools(['Edit']);
    expect(resumed.toolPolicy.isToolActive('Bash')).toBe(true);
    expect(resumed.toolPolicy.isToolActive('Edit')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Write')).toBe(false);
  });

  it('retries persistence after a failed session denylist replacement', async () => {
    const atomicDocuments = createAtomicDocumentStore();
    const persist = atomicDocuments.set.bind(atomicDocuments);
    let attempts = 0;
    atomicDocuments.set = async (...args) => {
      if (args[0].endsWith('/tool-policy')) {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
      }
      await persist(...args);
    };
    ctx = createTestAgent(
      appService(IAtomicDocumentStore, atomicDocuments),
      hostEnvironmentServices(homeDir),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    await expect(toolPolicy.setSessionDisabledTools(['Bash'])).rejects.toThrow('disk full');
    expect(toolPolicy.isToolActive('Bash')).toBe(true);
    await toolPolicy.setSessionDisabledTools(['Bash']);

    expect(attempts).toBe(2);
    expect(toolPolicy.isToolActive('Bash')).toBe(false);
  });

  it('keeps the skill listing frozen when the session disables Skill', async () => {
    const skillMarker = 'session-policy-skill-marker';
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir),
      sessionService(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        catalog: { getModelSkillListing: () => skillMarker } as never,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
        list: async () => [],
      }),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const before = profile.getSystemPrompt();
    expect(before).toContain(skillMarker);

    await toolPolicy.setSessionDisabledTools(['Skill']);

    expect(toolPolicy.isToolActive('Skill')).toBe(false);
    expect(profile.getSystemPrompt()).toBe(before);
  });

  it('keeps the skill listing when global tools disable Skill', async () => {
    const skillMarker = 'global-policy-skill-marker';
    ctx = createTestAgent(
      { initialConfig: { tools: { disabled: ['Skill'] } } },
      hostEnvironmentServices(homeDir),
      sessionService(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        catalog: { getModelSkillListing: () => skillMarker } as never,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
        list: async () => [],
      }),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(toolPolicy.isToolActive('Skill')).toBe(false);
    expect(profile.getSystemPrompt()).toContain(skillMarker);
  });

  it('keeps the skill listing frozen when global tool policy changes at runtime', async () => {
    const skillMarker = 'live-global-policy-skill-marker';
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir),
      sessionService(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        catalog: { getModelSkillListing: () => skillMarker } as never,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
        list: async () => [],
      }),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const before = profile.getSystemPrompt();
    expect(before).toContain(skillMarker);

    await ctx
      .get(IConfigService)
      .replace(TOOLS_SECTION, { disabled: ['Skill'] }, ConfigTarget.Memory);

    expect(toolPolicy.isToolActive('Skill')).toBe(false);
    expect(profile.getSystemPrompt()).toBe(before);
  });
});

describe('AgentToolPolicyService executor enforcement', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeAll(() => {
    registerAgentProfile({
      name: 'executor-deny-builtin',
      disallowedTools: ['PolicyProbe'],
      systemPrompt: () => 'executor policy test',
    });
    registerAgentProfile({
      name: 'executor-deny-mcp',
      disallowedTools: ['mcp__blocked__*'],
      systemPrompt: () => 'executor policy test',
    });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-executor-policy-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: 'profile denylist',
      options: {},
      profile: 'executor-deny-builtin',
      disable: undefined,
    },
    {
      name: 'global tools config',
      options: { initialConfig: { tools: { disabled: ['PolicyProbe'] } } },
      profile: DEFAULT_AGENT_PROFILE_NAME,
      disable: undefined,
    },
    {
      name: 'session denylist',
      options: {},
      profile: DEFAULT_AGENT_PROFILE_NAME,
      disable: ['PolicyProbe'],
    },
  ])('blocks a direct builtin call through $name', async ({ options, profile, disable }) => {
    ctx = createTestAgent(options, hostEnvironmentServices(homeDir));
    const profileService = ctx.get(IAgentLoopService);
    await ctx.get(IAgentLoopService).bindProfile({ profile, model: MOCK_MODEL });
    if (disable !== undefined) {
      await ctx.get(IAgentToolPolicyService).setSessionDisabledTools(disable);
    }
    const probe = new PolicyProbeTool('PolicyProbe');
    ctx.get(IAgentToolRegistryService).register(probe);

    const result = await executeDirectToolCall(ctx, 'PolicyProbe');

    expect(result).toMatchObject({
      isError: true,
      output: 'Tool "PolicyProbe" is disabled by the active tool policy',
    });
    expect(probe.calls).toBe(0);
  });

  it('blocks a direct MCP call by glob before execution', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentLoopService).bindProfile({ profile: 'executor-deny-mcp', model: MOCK_MODEL });
    const probe = new PolicyProbeTool('mcp__blocked__write');
    ctx.get(IAgentToolRegistryService).register(probe, { source: 'mcp' });

    const result = await executeDirectToolCall(ctx, probe.name);

    expect(result).toMatchObject({
      isError: true,
      output: `Tool "${probe.name}" is disabled by the active tool policy`,
    });
    expect(probe.calls).toBe(0);
  });

  it('blocks a direct builtin call through the workspace tool-policy gate', async () => {
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir),
      sessionService(ISessionToolPolicyGate, {
        _serviceBrand: undefined,
        disabledTools: ['PolicyProbe'],
        onDidChange: Event.None as Event<void>,
      } satisfies ISessionToolPolicyGate),
    );
    await ctx.get(IAgentLoopService).bindProfile({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
    });
    const probe = new PolicyProbeTool('PolicyProbe');
    ctx.get(IAgentToolRegistryService).register(probe);

    const result = await executeDirectToolCall(ctx, 'PolicyProbe');

    expect(result).toMatchObject({
      isError: true,
      output: 'Tool "PolicyProbe" is disabled by the active tool policy',
    });
    expect(probe.calls).toBe(0);
  });

  it('fingerprints workspace tool-policy changes for unregistered names', async () => {
    const gate = {
      _serviceBrand: undefined,
      disabledTools: [] as string[],
      onDidChange: Event.None as Event<void>,
    } satisfies ISessionToolPolicyGate;
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir),
      sessionService(ISessionToolPolicyGate, gate),
    );
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const svc = ctx.get(IAgentToolPolicyService);
    const initial = svc.getPolicyFingerprint();
    gate.disabledTools = ['UnregisteredTool'];
    expect(svc.getPolicyFingerprint()).not.toBe(initial);
    expect(svc.isToolDenied('UnregisteredTool')).toBe(true);
  });

  it('applies the workspace gate in the prompt projection (skillActive)', async () => {
    registerAgentProfile({
      name: 'gate-skill-active',
      tools: ['Read', 'Skill'],
      systemPrompt: (context) => `skill-active:${String(context.skillActive)}`,
    });
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir),
      sessionService(ISessionToolPolicyGate, {
        _serviceBrand: undefined,
        disabledTools: ['Skill'],
        onDidChange: Event.None as Event<void>,
      } satisfies ISessionToolPolicyGate),
    );
    const profileService = ctx.get(IAgentLoopService);
    await ctx.get(IAgentLoopService).bindProfile({ profile: 'gate-skill-active', model: MOCK_MODEL });

    expect(profileService.data().systemPrompt).toBe('skill-active:false');
  });

  it('does not reject select_tools, the policy-gated disclosure loading entry', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    const result = await executeDirectToolCall(ctx, SELECT_TOOLS_TOOL_NAME);

    expect(result).toMatchObject({
      output: 'Invalid args for tool "select_tools": must have required property \'names\'',
    });
    expect(result.output).not.toContain('disabled by the active tool policy');
  });

  it.each([
    {
      name: 'global denylist',
      options: { initialConfig: { tools: { disabled: [SELECT_TOOLS_TOOL_NAME] } } },
      disable: undefined,
    },
    {
      name: 'global allowlist',
      options: { initialConfig: { tools: { enabled: ['Read'] } } },
      disable: undefined,
    },
    {
      name: 'session denylist',
      options: {},
      disable: [SELECT_TOOLS_TOOL_NAME],
    },
  ])('blocks select_tools through an explicit $name', async ({ options, disable }) => {
    ctx = createTestAgent(options, hostEnvironmentServices(homeDir));
    await ctx.get(IAgentLoopService).bindProfile({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
    });
    if (disable !== undefined) {
      await ctx.get(IAgentToolPolicyService).setSessionDisabledTools(disable);
    }
    ctx.get(IAgentToolRegistryService).unregister(SELECT_TOOLS_TOOL_NAME);
    const probe = new PolicyProbeTool(SELECT_TOOLS_TOOL_NAME);
    ctx.get(IAgentToolRegistryService).register(probe);

    const result = await executeDirectToolCall(ctx, SELECT_TOOLS_TOOL_NAME);

    expect(result).toMatchObject({
      isError: true,
      output: `Tool "${SELECT_TOOLS_TOOL_NAME}" is disabled by the active tool policy`,
    });
    expect(probe.calls).toBe(0);
  });

});

describe('AgentProfileService tool-pattern warnings', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-tool-pattern-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function toolPatternWarnings(): readonly { code?: string; message?: string }[] {
    const events = ctx.newEvents() as readonly {
      event: string;
      args?: { code?: string; message?: string };
    }[];
    return events
      .filter((entry) => entry.event === 'warning')
      .map((entry) => entry.args ?? {})
      .filter((args) => args.code === 'tool-pattern-no-match');
  }

  const fileProfile: ResolvedAgentProfile = normalizeAgentProfile({
    name: 'bad-patterns',
    tools: ['Bashh', 'mcp__github'],
    disallowedTools: ['*'],
    systemPrompt: () => 'tool pattern warning test',
  });

  it('warns about profile entries that can never activate anything', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentLoopService).applyProfile(fileProfile);

    const messages = toolPatternWarnings().map((warning) => warning.message ?? '');
    expect(
      messages.some((m) => m.includes('"Bashh"') && m.includes('profile "bad-patterns"')),
    ).toBe(true);
    expect(messages.some((m) => m.includes('"mcp__github"') && m.includes('mcp__github__*'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('"*"') && m.includes('disallowedTools'))).toBe(true);
  });

  it('warns once per pattern across repeated applications of the same profile', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    const svc = ctx.get(IAgentLoopService);
    await svc.applyProfile(fileProfile);
    await svc.applyProfile(fileProfile);

    const messages = toolPatternWarnings().map((warning) => warning.message ?? '');
    expect(messages.filter((m) => m.includes('"Bashh"'))).toHaveLength(1);
  });

  it('warns about global [tools] config entries that can never activate anything', async () => {
    ctx = createTestAgent(
      { initialConfig: { tools: { enabled: ['*'] } } },
      hostEnvironmentServices(homeDir),
    );
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    const messages = toolPatternWarnings().map((warning) => warning.message ?? '');
    expect(
      messages.some(
        (m) =>
          m.includes('"*"') && m.includes('the global [tools] config') && m.includes('enabled'),
      ),
    ).toBe(true);
  });

  it('stays silent for the default profile and an empty [tools] config', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(toolPatternWarnings()).toEqual([]);
  });

  it('bind also publishes the warnings', async () => {
    registerAgentProfile({
      name: 'bind-bad-patterns',
      tools: ['mcp__github'],
      disallowedTools: ['*'],
      systemPrompt: () => 'bind warning test',
    });
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentLoopService).bindProfile({ profile: 'bind-bad-patterns', model: MOCK_MODEL });

    const messages = toolPatternWarnings().map((warning) => warning.message ?? '');
    expect(messages.some((m) => m.includes('"mcp__github"') && m.includes('mcp__github__*'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('"*"') && m.includes('disallowedTools'))).toBe(true);
  });

});

async function executeDirectToolCall(ctx: TestAgentContext, name: string): Promise<ToolResult> {
  const call: ToolCall = {
    type: 'function',
    id: `call_${name}`,
    name,
    arguments: '{}',
  };
  const [result] = await executeLegacyTool(ctx.get(IAgentToolExecutorService), [call], {
    signal: new AbortController().signal,
    turnId: 1,
  });
  if (result === undefined) throw new Error(`No result for tool ${name}`);
  return result.result;
}

class PolicyProbeTool implements ExecutableTool<Record<string, never>> {
  readonly description = 'Policy enforcement probe.';
  readonly parameters = { type: 'object', additionalProperties: false };
  calls = 0;

  constructor(
    readonly name: string,
    readonly source?: ToolSource,
  ) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { isError: false, output: 'executed' };
      },
    };
  }
}

describe('agentsMdReminder seeding', () => {
  let ctx: TestAgentContext;
  let homeDir: string;
  let workDir: string;

  beforeAll(() => {
    registerAgentProfile({
      name: 'throws-on-prompt',
      systemPrompt: () => {
        throw new Error('prompt build boom');
      },
    });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-seed-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-seed-work-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  function buildSeededContext(
    seedInjected: IAgentAgentsMdReminderService['seedInjected'],
  ): IAgentLoopService {
    ctx = createTestAgent(
      { cwd: workDir },
      hostEnvironmentServices(homeDir),
      agentService(IAgentAgentsMdReminderService, {
        _serviceBrand: undefined,
        seedInjected,
      }),
    );
    return ctx.get(IAgentLoopService);
  }

  it('seeds the known-set with the injected paths after a successful bind', async () => {
    const seedInjected = vi.fn<(paths: readonly string[], cwd: string) => void>();
    const profile = buildSeededContext(seedInjected);
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    seedInjected.mockClear();
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(seedInjected).toHaveBeenCalledWith([normalize(join(workDir, 'AGENTS.md'))], workDir);
    expect(profile.data().agentsMdPaths).toEqual([normalize(join(workDir, 'AGENTS.md'))]);
  });

  it('keeps declared tools separate from the live overlay until an explicit snapshot bind', async () => {
    const seedInjected = vi.fn<IAgentAgentsMdReminderService['seedInjected']>();
    const loop = buildSeededContext(seedInjected);
    const agentsMd = join(workDir, 'AGENTS.md');
    const systemPrompt = `<!-- From: ${agentsMd} -->\nproject instructions`;
    await loop.applyBindingSnapshot({ systemPrompt, thinkingLevel: 'off', activeToolNames: ['Read'] });
    loop.addActiveTool('InheritedTool');

    const declared = loop.bindingSnapshot();
    expect(declared.activeToolNames).toEqual(['Read']);
    expect(loop.getActiveToolNames()).toEqual(['Read', 'InheritedTool']);
    await loop.setProfile({ ...declared, subagents: ['explore'] });
    expect(loop.getActiveToolNames()).toEqual(['Read', 'InheritedTool']);

    seedInjected.mockClear();
    await loop.applyBindingSnapshot({ systemPrompt, thinkingLevel: 'off' });
    expect(loop.getActiveToolNames()).toBeUndefined();
    expect(loop.bindingSnapshot().agentsMdPaths).toEqual([normalize(agentsMd)]);
    expect(seedInjected).toHaveBeenCalledExactlyOnceWith([normalize(agentsMd)], workDir);
  });

  it('does not seed when the prompt build fails before the bind commits', async () => {
    const seedInjected = vi.fn<(paths: readonly string[], cwd: string) => void>();
    const profile = buildSeededContext(seedInjected);

    seedInjected.mockClear();
    await expect(ctx.get(IAgentLoopService).bindProfile({ profile: 'throws-on-prompt', model: MOCK_MODEL })).rejects.toThrow(
      'prompt build boom',
    );

    expect(seedInjected).not.toHaveBeenCalled();
  });
});

describe('change-notifier belief seeding', () => {
  let ctx: TestAgentContext;
  let homeDir: string;
  let workDir: string;

  beforeAll(() => {
    registerAgentProfile({
      name: 'belief-throws-on-prompt',
      systemPrompt: () => {
        throw new Error('prompt build boom');
      },
    });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-belief-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-belief-work-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  function buildNotifierContext(
    seedBeliefs: IAgentChangeNotifierService['seedBeliefs'],
  ): IAgentLoopService {
    ctx = createTestAgent(
      { cwd: workDir },
      hostEnvironmentServices(homeDir),
      agentService(IAgentChangeNotifierService, {
        _serviceBrand: undefined,
        notifyAgentsMdChanges: async () => {},
        notifySkillChanges: async () => {},
        notifySubagentChanges: async () => {},
        notifyWorkspaceDirsChanges: async () => {},
        seedBeliefs,
        mute: () => {},
        unmute: () => {},
      }),
    );
    return ctx.get(IAgentLoopService);
  }

  it('seeds beliefs from the rendered prompt after a successful bind', async () => {
    const seedBeliefs = vi.fn<IAgentChangeNotifierService['seedBeliefs']>();
    const profile = buildNotifierContext(seedBeliefs);
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(seedBeliefs).toHaveBeenCalledTimes(1);
    const seed = seedBeliefs.mock.calls[0]?.[0];
    expect(seed?.agentsMdPaths).toEqual([normalize(join(workDir, 'AGENTS.md'))]);
    expect(seed?.agentsMd).toContain('project instructions');
    expect(seed?.skillsListing).toEqual(expect.any(String));
  });

  it('does not seed when the prompt build fails before the bind commits', async () => {
    const seedBeliefs = vi.fn<IAgentChangeNotifierService['seedBeliefs']>();
    const profile = buildNotifierContext(seedBeliefs);

    await expect(
      ctx.get(IAgentLoopService).bindProfile({ profile: 'belief-throws-on-prompt', model: MOCK_MODEL }),
    ).rejects.toThrow('prompt build boom');

    expect(seedBeliefs).not.toHaveBeenCalled();
  });

  it('does not reseed beliefs on binding snapshot restore', async () => {
    const seedBeliefs = vi.fn<IAgentChangeNotifierService['seedBeliefs']>();
    const profile = buildNotifierContext(seedBeliefs);
    await ctx.get(IAgentLoopService).bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    seedBeliefs.mockClear();

    await ctx.get(IAgentLoopService).applyBindingSnapshot({
      profileName: DEFAULT_AGENT_PROFILE_NAME,
      thinkingLevel: 'off',
      systemPrompt: 'restored prompt',
    });

    expect(seedBeliefs).not.toHaveBeenCalled();
  });
});
