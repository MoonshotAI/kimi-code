import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { EnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclarationService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { ILogService } from '#/_base/log/log';
import {
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { UNKNOWN_CAPABILITY } from '#/llm-adapter/contract/capability';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { stubHostProcess } from '../../os/stubs';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { EnvironmentBinding, EnvironmentLease } from '#/environment/environment';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { collectGitContext } from '#/session/agentLifecycle/profile/gitContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  SECONDARY_MODEL_SECTION,
  stripSubagentEnvironmentParameter,
} from '#/session/subagent/configSection';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import {
  FORK_CONTEXT_NOTICE,
  FORK_WITH_ENVIRONMENT_UNAVAILABLE,
  forkIncompatibility,
  type SpawnedSubagent,
  type SpawnSubagentOptions,
  type SubagentSpawnPlan,
  type SubagentSpawnPlanInput,
} from '#/session/subagent/spawn';
import { SubagentToolInputSchema } from '#/agent/tools/agent/agent';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { EnvironmentRegistry, EnvironmentError } from '#/environment/environmentRegistry';
import { ENVIRONMENTS_SECTION } from '#/environment/configSection';
import { fakeEnvironment } from '../../environment/stubs';

import { stubLog } from '../../_base/log/stubs';
import { stubFlag } from '../../app/flag/stubs';
import { StubConfigService } from '../../stubs';
import { stubAgentContext } from '../../agent/agentContext/stubs';

const CALLER_ID = 'main';

describe('SessionSubagentService planSpawn and spawn', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let callerData: ProfileData;
  let profiles: AgentProfile[];
  let modelIds: Set<string>;
  let modelMeta: Map<string, Partial<Model>>;
  let caller: IAgentScopeHandle;
  let createdHandles: Map<string, IAgentScopeHandle>;
  let createAgent: ReturnType<typeof vi.fn>;
  let forkAgent: ReturnType<typeof vi.fn>;
  let acquireEnvironment: ReturnType<typeof vi.fn>;
  let callerPermissionMode: { mode: string; setMode: ReturnType<typeof vi.fn> };
  let createdPermissionMode: { mode: string; setMode: ReturnType<typeof vi.fn> };
  let callerUserTools: IAgentUserToolService;
  let createdUserTools: IAgentUserToolService;
  let createdReminder: { notify: ReturnType<typeof vi.fn> };
  let lease: EnvironmentLease;
  let callerBinding: EnvironmentBinding;

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
          if (serviceId === IAgentReminderService) return createdReminder;
          return undefined;
        },
      } as IAgentScopeHandle['accessor'],
      dispose: () => {},
    };
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFlagService, stubFlag(true));
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
    modelMeta = new Map();
    callerPermissionMode = { mode: 'auto', setMode: vi.fn() };
    createdPermissionMode = { mode: 'manual', setMode: vi.fn() };
    callerUserTools = userToolsStub();
    createdUserTools = userToolsStub();
    createdReminder = { notify: vi.fn() };
    lease = {
      environment: new FakeEnvironment({ workspaceId: 'w1', environmentId: 'acp:s1', generation: 'g1' }),
      track: (resource) => resource,
      dispose: vi.fn(),
    };
    acquireEnvironment = vi.fn(() => lease);
    callerBinding = { workspaceId: 'w1', environmentId: 'acp:s1' };
    caller = {
      id: CALLER_ID,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (serviceId: unknown) => {
          if (serviceId === IAgentProfileService) return profileServiceStub(callerData);
          if (serviceId === IAgentPermissionModeService) return callerPermissionMode;
          if (serviceId === IAgentUserToolService) return callerUserTools;
          if (serviceId === IAgentEnvironmentService) {
            return {
              _serviceBrand: undefined,
              acquire: acquireEnvironment,
            };
          }
          if (serviceId === IAgentEnvironmentBindingService) {
            return {
              _serviceBrand: undefined,
              current: callerBinding,
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
    createdHandles = new Map();
    createAgent = vi.fn(async (input: { readonly agentId?: string } = {}) => {
      const agentId = input.agentId ?? 'agent-child';
      createdHandles.set(agentId, createdHandle(agentId));
      return stubAgentContext(agentId, 1);
    });
    forkAgent = vi.fn(async () => {
      createdHandles.set('agent-fork', createdHandle('agent-fork'));
      return stubAgentContext('agent-fork', 1);
    });
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      onDidCreate: Event.None,
      onDidCreateScope: Event.None,
      onWillClose: Event.None,
      onDidClose: Event.None,
      create: createAgent,
      fork: forkAgent,
      get: (agentId: string) => (agentId === CALLER_ID ? stubAgentContext(CALLER_ID, 1) : undefined),
      handleOf: (agentId: string) =>
        agentId === CALLER_ID ? caller : createdHandles.get(agentId),
      list: () => [stubAgentContext(CALLER_ID, 1)],
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
        return { id: alias, ...modelMeta.get(alias) } as Model;
      },
    } as unknown as IModelCatalog);
    ix.stub(ISessionContext, { _serviceBrand: undefined, cwd: '/repo', workspaceId: 'w1' } as unknown as ISessionContext);
    ix.stub(ILogService, stubLog());
    ix.stub(IWorkspaceInstanceManager, {
      _serviceBrand: undefined,
      get: () => undefined,
    } as unknown as IWorkspaceInstanceManager);
    ix.stub(IHostFileSystem, {} as IHostFileSystem);
    ix.stub(IAtomicDocumentStore, {
      _serviceBrand: undefined,
      get: async () => undefined,
    } as unknown as IAtomicDocumentStore);
    ix.stub(IAppendLogStore, {
      _serviceBrand: undefined,
      read: async function* () {},
    } as unknown as IAppendLogStore);
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      scope: (name: string) => name,
    } as unknown as IBootstrapService);
  });

  afterEach(() => {
    disposables.dispose();
  });

  function service(configValues: Record<string, unknown> = {}): ISessionSubagentService {
    ix.stub(IConfigService, new StubConfigService(configValues));
    ix.set(IEnvironmentDeclarationService, new SyncDescriptor(EnvironmentDeclarationService));
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
      plan: { profileName: 'coder', model: 'provider/fast', modelSource: 'secondary_pool', thinking: 'low', fork: false },
      labels: { parentAgentId: 'main' },
      prompt: 'Review the file',
    });
  }

  function spawnForkChild(svc: ISessionSubagentService): Promise<SpawnedSubagent> {
    return svc.spawn({
      callerAgentId: CALLER_ID,
      plan: { profileName: 'orchestrator', model: 'main-model', modelSource: 'inherited', thinking: 'high', fork: true },
      labels: { parentAgentId: 'main' },
      prompt: 'Continue the analysis',
    });
  }

  function spawnCoderOnEnvironment(svc: ISessionSubagentService, environment: string): Promise<SpawnedSubagent> {
    return svc.spawn({
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/fast', modelSource: 'secondary_pool', thinking: 'low', fork: false },
      labels: { parentAgentId: 'main' },
      prompt: 'Review the file',
      environment,
    });
  }

  function stubWorkspaceManager(registry: EnvironmentRegistry): void {
    ix.stub(IWorkspaceInstanceManager, {
      _serviceBrand: undefined,
      get: (workspaceId: string) => (workspaceId === 'w1' ? { environments: registry, root: '/repo' } : undefined),
    } as unknown as IWorkspaceInstanceManager);
  }

  function gitProcessForRepo(repoCwd: string): { process: IHostProcessService; gitCwds: string[] } {
    const gitCwds: string[] = [];
    const script: Record<string, { stdout?: string; exitCode?: number; stderr?: string }> = {
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'remote get-url origin': { stdout: 'git@github.com:owner/repo-only-there.git' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'status --porcelain': { stdout: '' },
      'log -3 --format=%h %s': { stdout: 'abc123 a commit' },
    };
    const spawn = vi.fn(async (_command: string, args: readonly string[]) => {
      const cwd = args[1]!;
      gitCwds.push(cwd);
      if (cwd !== repoCwd) {
        return stubHostProcess('', 128, 'fatal: not a git repository (or any of the parent directories): .git');
      }
      const out = script[args.slice(2).join(' ')];
      if (out === undefined) return stubHostProcess('', 1);
      return stubHostProcess(out.stdout ?? '', out.exitCode ?? 0, out.stderr ?? '');
    });
    return { process: { _serviceBrand: undefined, spawn } as IHostProcessService, gitCwds };
  }

  function spawnExploreWithGitContext(
    svc: ISessionSubagentService,
    git: { process: IHostProcessService; gitCwds: string[] },
  ): Promise<SpawnedSubagent> {
    const environment = Object.assign(
      new FakeEnvironment({ workspaceId: 'w1', environmentId: 'acp:s1', generation: 'g1' }),
      { process: git.process },
    );
    lease = { environment, track: (resource) => resource, dispose: vi.fn() };
    profiles = [
      normalizeAgentProfile({
        name: 'explore',
        description: 'Explorer',
        systemPrompt: () => 'explore',
        promptPrefix: async ({ cwd, process, log }) => {
          try {
            return await collectGitContext(process, cwd, log);
          } catch {
            return '';
          }
        },
      }),
    ];
    return svc.spawn({
      callerAgentId: CALLER_ID,
      plan: { profileName: 'explore', model: 'provider/fast', modelSource: 'secondary_pool', thinking: 'low', fork: false },
      labels: { parentAgentId: 'main' },
      prompt: 'Survey the repo',
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
    );

    const error = await planSpawnError(svc, { callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(error.code).toBe(ErrorCodes.CONFIG_INVALID);
    expect(error.message).toContain('Model "provider/bad" is not configured in config.toml.');
    expect(error.message).toContain('comes from [secondary_model.models]');
  });

  it('passes [secondary_model].default_effort as the explicit subagent thinking', async () => {
    modelIds.add('provider/fast');
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast model' },
          defaultEffort: 'max',
        },
        thinking: { enabled: false },
      },
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan).toEqual({
      profileName: 'coder',
      model: 'provider/fast',
      modelSource: 'secondary_pool',
      thinking: 'max',
      fork: false,
    });
  });

  it('prefers [secondary_model].default_effort over the bound model default_effort', async () => {
    modelIds.add('provider/fast');
    modelMeta.set('provider/fast', {
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    });
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast model' },
          defaultEffort: 'max',
        },
      },
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan.thinking).toBe('max');
  });

  it('falls back to the bound model default_effort when the section declares none', async () => {
    modelIds.add('provider/fast');
    modelMeta.set('provider/fast', {
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    });
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast model' },
        },
      },
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan.thinking).toBe('max');
  });

  it('leaves thinking unset for global resolution when thinking is disabled', async () => {
    modelIds.add('provider/fast');
    modelMeta.set('provider/fast', {
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    });
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast model' },
        },
        thinking: { enabled: false },
      },
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan.thinking).toBeUndefined();
  });

  it('leaves the subagent thinking unset when the bound model declares no valid default_effort', async () => {
    modelIds.add('provider/fast');
    modelMeta.set('provider/fast', {
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
      supportEfforts: ['low', 'high'],
      defaultEffort: 'max',
    });
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast model' },
        },
      },
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan.thinking).toBeUndefined();
  });

  it('passes [secondary_model].default_effort with the forced model', async () => {
    modelIds.add('provider/fast');
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          force: true,
          defaultModel: 'provider/fast',
          defaultEffort: 'max',
        },
      },
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan).toEqual({
      profileName: 'coder',
      model: 'provider/fast',
      modelSource: 'forced',
      thinking: 'max',
      fork: false,
    });
  });

  it('inherits the caller model and thinking when no pool is configured', async () => {
    const svc = service({});

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan).toEqual({
      profileName: 'coder',
      model: 'main-model',
      modelSource: 'inherited',
      thinking: 'high',
      fork: false,
    });
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
      modelSource: 'inherited',
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

  it('creates the child on the acquired environment lease', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ environmentId: 'acp:s1' }));
  });

  it('binds the child to the requested environment with the declaration defaultCwd', async () => {
    const registry = new EnvironmentRegistry('w1');
    const stats: string[] = [];
    registry.register(Object.assign(
      new FakeEnvironment(
        { workspaceId: 'w1', environmentId: 'staging', generation: 'staging-one' },
        { status: 'ready', capabilities: ['fs', 'process'] },
      ),
      {
        fs: {
          stat: async (path: string) => {
            stats.push(path);
            return { isDirectory: true };
          },
        },
        process: {},
      },
    ));
    stubWorkspaceManager(registry);
    const svc = service({ [ENVIRONMENTS_SECTION]: { staging: { type: 'ssh', host: 'staging', defaultCwd: '/srv/app' } } });

    await spawnCoderOnEnvironment(svc, 'staging');

    expect(stats).toContain('/srv/app');
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'staging', environmentCwd: '/srv/app' }),
    );
  });

  it('inherits the caller binding when the requested environment matches the current one', async () => {
    callerBinding = { workspaceId: 'w1', environmentId: 'acp:s1', cwd: '/remote/repo' };
    const svc = service();

    await spawnCoderOnEnvironment(svc, 'acp:s1');

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'acp:s1', environmentCwd: '/remote/repo' }),
    );
  });

  it('binds the child to local without a cwd when local is requested', async () => {
    const registry = new EnvironmentRegistry('w1');
    registry.register(fakeEnvironment('local', 'local-one', { workspaceId: 'w1' }));
    stubWorkspaceManager(registry);
    const svc = service();

    await spawnCoderOnEnvironment(svc, 'local');

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'local', environmentCwd: undefined }),
    );
  });

  it('rejects an unknown environment and lists the available ids', async () => {
    const registry = new EnvironmentRegistry('w1');
    registry.register(fakeEnvironment('local', 'local-one', { workspaceId: 'w1' }));
    registry.register(fakeEnvironment('staging', 'staging-one', { workspaceId: 'w1' }));
    stubWorkspaceManager(registry);
    const svc = service();

    const error = await spawnCoderOnEnvironment(svc, 'ghost').then(
      () => {
        throw new Error('spawn did not throw');
      },
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(EnvironmentError);
    expect((error as EnvironmentError).code).toBe('environment.not_found');
    expect((error as EnvironmentError).message).toContain('local, staging');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('binds the child to the environment host cwd when the contract carries one', async () => {
    const registry = new EnvironmentRegistry('w1');
    registry.register(fakeEnvironment('ephemeral-box', 'ephemeral-one', {
      workspaceId: 'w1',
      host: { homeDir: '/home/remote', cwd: '/srv/box' },
    }));
    registry.register(fakeEnvironment('ephemeral-home', 'ephemeral-two', {
      workspaceId: 'w1',
      host: { homeDir: '/home/remote' },
    }));
    stubWorkspaceManager(registry);
    const svc = service();

    await spawnCoderOnEnvironment(svc, 'ephemeral-box');

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'ephemeral-box', environmentCwd: '/srv/box' }),
    );

    await spawnCoderOnEnvironment(svc, 'ephemeral-home');

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'ephemeral-home', environmentCwd: '/home/remote' }),
    );
  });

  it('connects a disconnected requested environment before binding', async () => {
    const registry = new EnvironmentRegistry('w1');
    const connectCalls: string[] = [];
    const staging = new FakeEnvironment(
      { workspaceId: 'w1', environmentId: 'staging', generation: 'staging-pending' },
      { status: 'disconnected', capabilities: ['fs', 'process'] },
    );
    Object.assign(staging, {
      connect: async () => {
        connectCalls.push('connect');
        staging.setStatus('ready');
      },
      fs: {
        stat: async () => ({ isDirectory: true }),
      },
      process: {},
    });
    registry.register(staging);
    stubWorkspaceManager(registry);
    const svc = service();

    await spawnCoderOnEnvironment(svc, 'staging');

    expect(connectCalls).toEqual(['connect']);
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ environmentId: 'staging' }));
  });

  it('binds the host of the replaced view after connect swaps the registry generation', async () => {
    const registry = new EnvironmentRegistry('w1');
    const pending = new FakeEnvironment(
      { workspaceId: 'w1', environmentId: 'staging', generation: 'staging-pending' },
      { status: 'disconnected', capabilities: ['fs', 'process'], host: { homeDir: '/' } },
    );
    Object.assign(pending, { fs: {}, process: {} });
    const registration = registry.register(pending);
    const connected = new FakeEnvironment(
      { workspaceId: 'w1', environmentId: 'staging', generation: 'staging-connected' },
      { status: 'ready', capabilities: ['fs', 'process'], host: { homeDir: '/home/remote' } },
    );
    Object.assign(connected, { fs: {}, process: {} });
    Object.assign(pending, {
      connect: async () => {
        await registration.replace(connected);
      },
    });
    stubWorkspaceManager(registry);
    const svc = service();

    await spawnCoderOnEnvironment(svc, 'staging');

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'staging', environmentCwd: '/home/remote' }),
    );
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
      modelSource: 'secondary_pool',
      promptText: 'FIXED-PREFIX\n\nReview the file',
    });
  });

  it('collects the explore git context at the inherited binding cwd on the bound environment', async () => {
    callerBinding = { workspaceId: 'w1', environmentId: 'acp:s1', cwd: '/remote/repo' };
    const git = gitProcessForRepo('/remote/repo');
    const svc = service();

    const spawned = await spawnExploreWithGitContext(svc, git);

    expect(git.gitCwds.length).toBeGreaterThan(0);
    expect(git.gitCwds.every((cwd) => cwd === '/remote/repo')).toBe(true);
    expect(spawned.promptText).toContain('Working directory: /remote/repo');
    expect(spawned.promptText).toContain('Project: owner/repo-only-there');
    expect(spawned.promptText).toContain('Survey the repo');

    callerBinding = { workspaceId: 'w1', environmentId: 'acp:s1' };
    const sessionGit = gitProcessForRepo('/repo');

    const sessionSpawned = await spawnExploreWithGitContext(svc, sessionGit);

    expect(sessionGit.gitCwds.length).toBeGreaterThan(0);
    expect(sessionGit.gitCwds.every((cwd) => cwd === '/repo')).toBe(true);
    expect(sessionSpawned.promptText).toContain('Working directory: /repo');
    expect(sessionSpawned.promptText).toContain('Project: owner/repo-only-there');
  });

  it('collects the prompt prefix git context on the requested environment instead of the caller one', async () => {
    const git = gitProcessForRepo('/srv/app');
    const registry = new EnvironmentRegistry('w1');
    registry.register(Object.assign(
      new FakeEnvironment(
        { workspaceId: 'w1', environmentId: 'staging', generation: 'staging-one' },
        { status: 'ready', capabilities: ['fs', 'process'] },
      ),
      {
        fs: { stat: async () => ({ isDirectory: true }) },
        process: git.process,
      },
    ));
    stubWorkspaceManager(registry);
    profiles = [
      normalizeAgentProfile({
        name: 'explore',
        description: 'Explorer',
        systemPrompt: () => 'explore',
        promptPrefix: async ({ cwd, process, log }) => {
          try {
            return await collectGitContext(process, cwd, log);
          } catch {
            return '';
          }
        },
      }),
    ];
    const svc = service({ [ENVIRONMENTS_SECTION]: { staging: { type: 'ssh', host: 'staging', defaultCwd: '/srv/app' } } });

    const spawned = await svc.spawn({
      callerAgentId: CALLER_ID,
      plan: { profileName: 'explore', model: 'provider/fast', modelSource: 'secondary_pool', thinking: 'low', fork: false },
      labels: { parentAgentId: 'main' },
      prompt: 'Survey the repo',
      environment: 'staging',
    });

    expect(acquireEnvironment).not.toHaveBeenCalled();
    expect(git.gitCwds.length).toBeGreaterThan(0);
    expect(git.gitCwds.every((cwd) => cwd === '/srv/app')).toBe(true);
    expect(spawned.promptText).toContain('Working directory: /srv/app');
    expect(spawned.promptText).toContain('Project: owner/repo-only-there');
  });

  it('releases the environment lease after spawn', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(lease.dispose).toHaveBeenCalled();
  });

  it('delegates to manager.fork with the caller labels when the plan is a fork', async () => {
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

  it('delivers the fork notice as a reminder injection when the plan is a fork', async () => {
    const svc = service();

    const spawned = await spawnForkChild(svc);

    expect(spawned).toEqual({
      agentId: 'agent-fork',
      profileName: 'orchestrator',
      model: 'main-model',
      modelSource: 'inherited',
      promptText: 'Continue the analysis',
    });
    expect(createdReminder.notify).toHaveBeenCalledWith(FORK_CONTEXT_NOTICE, {
      variant: 'fork_context',
    });
  });

  it('does not require the process capability when forking', async () => {
    acquireEnvironment.mockImplementation(() => {
      throw new Error('process capability is no longer available');
    });
    const svc = service();

    await expect(spawnForkChild(svc)).resolves.toMatchObject({ agentId: 'agent-fork' });

    expect(acquireEnvironment).not.toHaveBeenCalled();
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
      plan: { profileName: 'coder', model: 'provider/bad', modelSource: 'secondary_pool', thinking: 'low', fork: false },
      prompt: 'Review the file',
    });

    expect(error.code).toBe(ErrorCodes.CONFIG_INVALID);
    expect(error.message).toContain('Model "provider/bad" is not configured in config.toml.');
    expect(error.message).toContain('comes from [secondary_model.models]');
  });

  it('spawn throws before creating anything when the caller environment lease fails', async () => {
    acquireEnvironment.mockImplementation(() => {
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

describe('subagent environment parameter', () => {
  it('accepts an environment id in the Agent tool input schema', () => {
    const parsed = SubagentToolInputSchema.parse({
      prompt: 'Review the file',
      description: 'review file',
      environment: 'staging',
    });
    expect(parsed.environment).toBe('staging');
  });

  it('strips the environment property from the tool parameters', () => {
    const parameters = toInputJsonSchema(SubagentToolInputSchema);
    expect(parameters['properties']).toHaveProperty('environment');

    const stripped = stripSubagentEnvironmentParameter(parameters);

    expect(stripped['properties']).not.toHaveProperty('environment');
    expect(stripped['properties']).toHaveProperty('prompt');
    expect(parameters['properties']).toHaveProperty('environment');
  });

  it('rejects environment with fork since a fork inherits the caller binding', () => {
    expect(
      forkIncompatibility({ environment: 'staging' }, { profileName: 'coder', modelAlias: 'main-model' }),
    ).toBe(FORK_WITH_ENVIRONMENT_UNAVAILABLE);
    expect(
      forkIncompatibility({ environment: '  ' }, { profileName: 'coder', modelAlias: 'main-model' }),
    ).toBeUndefined();
    expect(forkIncompatibility({}, { profileName: 'coder', modelAlias: 'main-model' })).toBeUndefined();
  });
});
