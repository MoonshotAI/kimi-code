import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ILogService } from '#/_base/log/log';
import {
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import type { RuntimeLease } from '#/runtime/runtime';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { SECONDARY_MODEL_SECTION } from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import {
  FORK_CONTEXT_NOTICE,
  type SpawnedSubagent,
  type SpawnSubagentOptions,
  type SubagentSpawnPlan,
  type SubagentSpawnPlanInput,
} from '#/session/subagent/spawn';

import { stubLog } from '../../_base/log/stubs';
import { stubFlag } from '../../app/flag/stubs';
import { StubConfigService } from '../../kosong/stubs';
import { stubAgentContext } from '../../agent/agentContext/stubs';

const CALLER_ID = 'main';

describe('SessionSubagentService planSpawn and spawn', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let callerData: ProfileData;
  let profiles: AgentProfile[];
  let modelIds: Set<string>;
  let caller: IAgentScopeHandle;
  let createAgent: ReturnType<typeof vi.fn>;
  let forkAgent: ReturnType<typeof vi.fn>;
  let acquireRuntime: ReturnType<typeof vi.fn>;
  let callerPermissionMode: { mode: string; setMode: ReturnType<typeof vi.fn> };
  let createdPermissionMode: { mode: string; setMode: ReturnType<typeof vi.fn> };
  let callerUserTools: IAgentUserToolService;
  let createdUserTools: IAgentUserToolService;
  let lease: RuntimeLease;

  function userToolsStub(): IAgentUserToolService {
    return {
      _serviceBrand: undefined,
      list: () => [],
      inheritUserTools: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    } as unknown as IAgentUserToolService;
  }

  function profileServiceStub(data: ProfileData): IAgentProfileService {
    return {
      _serviceBrand: undefined,
      data: () => data,
      getActiveToolNames: () => data.activeToolNames,
    } as unknown as IAgentProfileService;
  }

  function createdHandle(agentId: string): IAgentScopeHandle {
    return {
      id: agentId,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (serviceId: unknown) => {
          if (serviceId === IAgentProfileService) {
            return profileServiceStub({ ...callerData, modelCapabilities: {} as never });
          }
          if (serviceId === IAgentPermissionModeService) return createdPermissionMode;
          if (serviceId === IAgentUserToolService) return createdUserTools;
          return undefined;
        },
      } as IAgentScopeHandle['accessor'],
      dispose: () => {},
    };
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    callerData = {
      profileName: 'orchestrator',
      modelAlias: 'main-model',
      thinkingLevel: 'high',
      systemPrompt: 'caller prompt',
      modelCapabilities: {} as never,
    };
    profiles = [
      normalizeAgentProfile({
        name: 'coder',
        description: 'Coder',
        systemPrompt: () => 'coder',
      }),
      normalizeAgentProfile({
        name: 'explore',
        description: 'Explorer',
        systemPrompt: () => 'explore',
      }),
    ];
    modelIds = new Set(['main-model']);
    callerPermissionMode = { mode: 'auto', setMode: vi.fn() };
    createdPermissionMode = { mode: 'manual', setMode: vi.fn() };
    callerUserTools = userToolsStub();
    createdUserTools = userToolsStub();
    lease = {
      runtime: new FakeRuntime({ workspaceId: 'w1', runtimeId: 'acp:s1', generation: 'g1' }),
      track: (resource) => resource,
      dispose: vi.fn(),
    };
    acquireRuntime = vi.fn(() => lease);
    caller = {
      id: CALLER_ID,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (serviceId: unknown) => {
          if (serviceId === IAgentProfileService) return profileServiceStub(callerData);
          if (serviceId === IAgentPermissionModeService) return callerPermissionMode;
          if (serviceId === IAgentUserToolService) return callerUserTools;
          if (serviceId === IAgentRuntimeService) {
            return {
              _serviceBrand: undefined,
              acquire: acquireRuntime,
            };
          }
          if (serviceId === IAgentScopeContext) {
            return {
              _serviceBrand: undefined,
              agentId: CALLER_ID,
              agentContext: stubAgentContext(CALLER_ID, 1),
              scope: () => '',
            };
          }
          return undefined;
        },
      } as IAgentScopeHandle['accessor'],
      dispose: () => {},
    };
    createAgent = vi.fn(async (input: { readonly agentId?: string } = {}) =>
      createdHandle(input.agentId ?? 'agent-child'),
    );
    forkAgent = vi.fn(async () => createdHandle('agent-fork'));
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      onDidCreate: Event.None,
      onDidDispose: Event.None,
      create: createAgent,
      fork: forkAgent,
      get: (agentId: string) => (agentId === CALLER_ID ? caller : undefined),
      findAgentHandle: (agentId: string) => (agentId === CALLER_ID ? caller : undefined),
      list: () => [caller],
      remove: async () => {},
      broadcastPermissionMode: () => {},
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None,
      get: (name: string) => profiles.find((profile) => profile.name === name),
      getDefault: () => profiles[0]!,
      list: () => profiles,
      inspect: (name: string) =>
        profiles.some((profile) => profile.name === name) ? { sourceId: 'builtin' } : undefined,
    } as unknown as ISessionAgentProfileCatalog);
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: (alias: string) => {
        if (!modelIds.has(alias)) {
          throw new Error2(
            ErrorCodes.CONFIG_INVALID,
            `Model "${alias}" is not configured in config.toml.`,
            { details: { model: alias } },
          );
        }
        return { id: alias } as Model;
      },
    } as unknown as IModelCatalog);
    ix.stub(ISessionContext, { _serviceBrand: undefined, cwd: '/repo' } as unknown as ISessionContext);
    ix.stub(ILogService, stubLog());
  });

  afterEach(() => {
    disposables.dispose();
  });

  function service(
    configValues: Record<string, unknown> = {},
    secondaryModelEnabled = false,
  ): ISessionSubagentService {
    ix.stub(IConfigService, new StubConfigService(configValues));
    ix.stub(
      IFlagService,
      stubFlag((id) => secondaryModelEnabled && id === SECONDARY_MODEL_FLAG_ID),
    );
    ix.set(ISessionSubagentService, new SyncDescriptor(SessionSubagentService));
    return ix.get(ISessionSubagentService);
  }

  async function planSpawnError(
    svc: ISessionSubagentService,
    input: SubagentSpawnPlanInput,
  ): Promise<Error2> {
    try {
      await svc.planSpawn(input);
    } catch (error) {
      if (!isError2(error)) throw error;
      return error;
    }
    throw new Error('planSpawn did not throw');
  }

  async function spawnError(
    svc: ISessionSubagentService,
    options: SpawnSubagentOptions,
  ): Promise<Error2> {
    try {
      await svc.spawn(options);
    } catch (error) {
      if (!isError2(error)) throw error;
      return error;
    }
    throw new Error('spawn did not throw');
  }

  function spawnNonForkChild(svc: ISessionSubagentService): Promise<SpawnedSubagent> {
    return svc.spawn({
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
      labels: { parentAgentId: 'main' },
      prompt: 'Review the file',
    });
  }

  function spawnForkChild(svc: ISessionSubagentService): Promise<SpawnedSubagent> {
    return svc.spawn({
      callerAgentId: CALLER_ID,
      plan: { profileName: 'orchestrator', model: 'main-model', thinking: 'high', fork: true },
      labels: { parentAgentId: 'main' },
      prompt: 'Continue the analysis',
    });
  }

  it('rejects an unknown subagent type', async () => {
    const svc = service();

    const error = await planSpawnError(svc, { callerAgentId: CALLER_ID, profileName: 'ghost' });

    expect(error.code).toBe(ErrorCodes.PROFILE_UNKNOWN);
    expect(error.message).toBe('Unknown agent type: "ghost"');
  });

  it('rejects a subagent type outside the caller allowlist', async () => {
    callerData = { ...callerData, subagents: ['explore'] };
    const svc = service();

    const error = await planSpawnError(svc, { callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(error.code).toBe(ErrorCodes.AGENT_TYPE_NOT_ALLOWED);
    expect(error.message).toBe(
      'Subagent type "coder" is not allowed for this agent. Allowed subagent types: explore.',
    );
  });

  it('rejects when the caller agent has no model bound', async () => {
    callerData = { ...callerData, modelAlias: undefined };
    const svc = service();

    const error = await planSpawnError(svc, { callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(error.code).toBe(ErrorCodes.MODEL_NOT_CONFIGURED);
    expect(error.message).toBe('Caller agent has no model bound');
  });

  it('wraps an unresolvable pool model with the secondary-model config hint', async () => {
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/bad',
          models: { 'provider/bad': 'broken' },
        },
      },
      true,
    );

    const error = await planSpawnError(svc, { callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(error.code).toBe(ErrorCodes.CONFIG_INVALID);
    expect(error.message).toContain('Model "provider/bad" is not configured in config.toml.');
    expect(error.message).toContain('comes from [secondary_model.models]');
  });

  it('skips the allowlist check when forking', async () => {
    callerData = { ...callerData, profileName: 'coder', subagents: ['explore'] };
    const svc = service();

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, fork: true });

    expect(plan.profileName).toBe('coder');
  });

  it('skips the unknown-profile check when forking', async () => {
    callerData = { ...callerData, profileName: 'ghost' };
    const svc = service();

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, fork: true });

    expect(plan.profileName).toBe('ghost');
  });

  it('returns the caller binding when forking', async () => {
    const svc = service();

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, fork: true });

    expect(plan).toEqual({
      profileName: 'orchestrator',
      model: 'main-model',
      thinking: 'high',
      fork: true,
    });
  });

  it('creates the child with the plan binding when the plan is not a fork', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: { profile: 'coder', model: 'provider/fast', thinking: 'low' },
      }),
    );
    expect(forkAgent).not.toHaveBeenCalled();
  });

  it('creates the child with the task labels when the plan is not a fork', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ labels: { parentAgentId: 'main' } }),
    );
  });

  it('creates the child on the acquired runtime lease', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: 'acp:s1' }));
  });

  it('inherits the caller permission mode and user tools', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(createdPermissionMode.setMode).toHaveBeenCalledWith('auto');
    expect(createdUserTools.inheritUserTools).toHaveBeenCalledWith(callerUserTools);
  });

  it('applies the profile prompt prefix to the spawned prompt', async () => {
    profiles = [
      normalizeAgentProfile({
        name: 'coder',
        description: 'Coder',
        promptPrefix: async () => 'FIXED-PREFIX',
        systemPrompt: () => 'coder',
      }),
    ];
    const svc = service();

    const spawned = await spawnNonForkChild(svc);

    expect(spawned).toEqual({
      agentId: 'agent-child',
      profileName: 'coder',
      model: 'provider/fast',
      promptText: 'FIXED-PREFIX\n\nReview the file',
    });
  });

  it('releases the runtime lease after spawn', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(lease.dispose).toHaveBeenCalled();
  });

  it('delegates to lifecycle.fork with the caller labels when the plan is a fork', async () => {
    const svc = service();

    await spawnForkChild(svc);

    expect(forkAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'main' }),
      { labels: { parentAgentId: 'main' } },
    );
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('preserves the fork snapshot active tool names when inheriting user tools', async () => {
    callerData = { ...callerData, activeToolNames: ['Agent', 'Read'] };
    const svc = service();

    await spawnForkChild(svc);

    expect(createdUserTools.inheritUserTools).toHaveBeenCalledWith(callerUserTools, [
      'Agent',
      'Read',
    ]);
  });

  it('prefixes the prompt with the fork notice when the plan is a fork', async () => {
    const svc = service();

    const spawned = await spawnForkChild(svc);

    expect(spawned).toEqual({
      agentId: 'agent-fork',
      profileName: 'orchestrator',
      model: 'main-model',
      promptText: `${FORK_CONTEXT_NOTICE}\n\nContinue the analysis`,
    });
  });

  it('does not require the process capability when forking', async () => {
    acquireRuntime.mockImplementation(() => {
      throw new Error('process capability is no longer available');
    });
    const svc = service();

    await expect(spawnForkChild(svc)).resolves.toMatchObject({ agentId: 'agent-fork' });

    expect(acquireRuntime).not.toHaveBeenCalled();
    expect(forkAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'main' }),
      { labels: { parentAgentId: 'main' } },
    );
  });

  it('wraps a create rejection with the secondary-model config hint', async () => {
    createAgent.mockRejectedValueOnce(
      new Error2(
        ErrorCodes.CONFIG_INVALID,
        'Model "provider/bad" is not configured in config.toml.',
        { details: { model: 'provider/bad' } },
      ),
    );
    const svc = service();

    const error = await spawnError(svc, {
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/bad', thinking: 'low', fork: false },
      prompt: 'Review the file',
    });

    expect(error.code).toBe(ErrorCodes.CONFIG_INVALID);
    expect(error.message).toContain('Model "provider/bad" is not configured in config.toml.');
    expect(error.message).toContain('comes from [secondary_model.models]');
  });

  it('spawn throws before creating anything when the caller runtime lease fails', async () => {
    acquireRuntime.mockImplementation(() => {
      throw new Error('process capability is no longer available');
    });
    const svc = service();
    const plan: SubagentSpawnPlan = {
      profileName: 'coder',
      model: 'main-model',
      thinking: 'high',
      fork: false,
    };

    await expect(
      svc.spawn({ callerAgentId: CALLER_ID, plan, prompt: 'Review the file' }),
    ).rejects.toThrow('process capability is no longer available');

    expect(createAgent).not.toHaveBeenCalled();
    expect(forkAgent).not.toHaveBeenCalled();
  });
});
