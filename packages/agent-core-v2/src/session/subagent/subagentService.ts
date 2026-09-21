import { Service } from '#/_base/di/service';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { Error2, ErrorCodes } from '#/errors';
import { LifecycleScope } from '#/app/scopes';
import {
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import {
  rootDelegationExtras,
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
  withoutDelegatingTargets,
} from '#/app/agentProfileCatalog/profile-shared';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import type { Environment, EnvironmentBinding, EnvironmentLease } from '#/environment/environment';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { ILogService } from '#/_base/log/log';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import {
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
  type RunAgentOptions,
} from './subagent';
import { runAgentTurn } from './runAgentTurn';
import {
  resolveSubagentBinding,
  resolveSubagentThinking,
  wrapSubagentModelError,
} from './configSection';
import {
  DEFAULT_PROFILE_NAME,
  FORK_CONTEXT_NOTICE,
  type SpawnSubagentOptions,
  type SpawnedSubagent,
  type SubagentSpawnPlan,
  type SubagentSpawnPlanInput,
} from './spawn';

export class SessionSubagentService extends Service implements ISessionSubagentService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);
  private readonly onDidStopAgentTaskEmitter = this._register(
    new Emitter<AgentTaskStopHookContext>(),
  );

  get onDidStopAgentTask() {
    return this.onDidStopAgentTaskEmitter.event;
  }

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IConfigService private readonly configService: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ILogService private readonly log: ILogService,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @IEnvironmentDeclarationService private readonly environmentDeclarations: IEnvironmentDeclarationService,
  ) {
    super();
  }

  run(agent: AgentContext, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle> {
    const handle = this.agentLifecycle.handleOf(agent.agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agent.agentId}" does not exist`, {
        details: { agentId: agent.agentId },
      });
    }
    return runAgentTurn(handle, request, { signal: opts.signal, onReady: opts.onReady });
  }

  async planSpawn(input: SubagentSpawnPlanInput): Promise<SubagentSpawnPlan> {
    const caller = this.requireCaller(input.callerAgentId);
    const fork = input.fork === true;
    await this.catalog.ready;
    const own = caller.accessor.get(IAgentProfileService).data();
    const requested = input.profileName !== undefined && input.profileName.length > 0
      ? input.profileName
      : undefined;
    const requestedProfileName =
      requested ?? (fork ? (own.profileName ?? DEFAULT_PROFILE_NAME) : DEFAULT_PROFILE_NAME);
    const extras =
      input.callerAgentId === MAIN_AGENT_ID
        ? rootDelegationExtras(this.catalog, own, this.catalog.list())
        : undefined;
    let allowlist = subagentAllowlistFor(this.catalog, own, extras);
    if (allowlist !== undefined && own.subagents === undefined) {
      allowlist = withoutDelegatingTargets(this.catalog, allowlist);
    }
    if (!fork && allowlist !== undefined && !allowlist.includes(requestedProfileName)) {
      throw new Error2(
        ErrorCodes.AGENT_TYPE_NOT_ALLOWED,
        subagentTypeNotAllowedMessage(requestedProfileName, allowlist),
        { details: { profileName: requestedProfileName, allowlist } },
      );
    }
    const profile = this.catalog.get(requestedProfileName);
    if (!fork && profile === undefined) {
      throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${requestedProfileName}"`, {
        details: { profileName: requestedProfileName },
      });
    }
    if (own.modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
        details: { agentId: input.callerAgentId },
      });
    }
    const binding = fork
      ? { model: own.modelAlias, thinking: own.thinkingLevel, modelSource: 'inherited' as const }
      : resolveSubagentBinding(
          this.configService,
          { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
          input.model,
        );
    let model: Model;
    try {
      model = this.modelCatalog.get(binding.model);
    } catch (error) {
      throw wrapSubagentModelError(error, binding.model, own.modelAlias);
    }
    return {
      profileName: profile?.name ?? requestedProfileName,
      model: binding.model,
      modelSource: binding.modelSource,
      thinking: resolveSubagentThinking(this.configService, model, binding.thinking),
      fork,
    };
  }

  async spawn(opts: SpawnSubagentOptions): Promise<SpawnedSubagent> {
    const caller = this.requireCaller(opts.callerAgentId);
    const { plan } = opts;
    const callerBinding = caller.accessor.get(IAgentEnvironmentBindingService).current;
    const spawnBinding = await this.resolveSpawnBinding(callerBinding, opts.environment);
    const lease = plan.fork
      ? undefined
      : this.acquirePromptEnvironment(caller, callerBinding, spawnBinding);
    try {
      let created: IAgentScopeHandle;
      try {
        if (plan.fork) {
          const forked = await this.agentLifecycle.fork(agentContextOf(caller), {
            labels: opts.labels,
          });
          created = this.agentLifecycle.handleOf(forked.agentId)!;
          created.accessor
            .get(IAgentReminderService)
            .notify(FORK_CONTEXT_NOTICE, { variant: 'fork_context' });
        } else {
          const createdContext = await this.agentLifecycle.create({
            binding: {
              profile: plan.profileName,
              model: plan.model,
              thinking: plan.thinking,
            },
            labels: opts.labels,
            environmentId: spawnBinding.environmentId,
            environmentCwd: spawnBinding.cwd,
          });
          created = this.agentLifecycle.handleOf(createdContext.agentId)!;
        }
      } catch (error) {
        throw wrapSubagentModelError(
          error,
          plan.model,
          caller.accessor.get(IAgentProfileService).data().modelAlias,
        );
      }
      created.accessor
        .get(IAgentPermissionModeService)
        .setMode(caller.accessor.get(IAgentPermissionModeService).mode);
      const createdUserTools = created.accessor.get(IAgentUserToolService);
      const callerUserTools = caller.accessor.get(IAgentUserToolService);
      if (plan.fork) {
        const activeToolNames = created.accessor.get(IAgentProfileService).getActiveToolNames();
        createdUserTools.inheritUserTools(callerUserTools, activeToolNames);
      } else {
        createdUserTools.inheritUserTools(callerUserTools);
      }
      const promptText = plan.fork
        ? opts.prompt
        : await this.applyPromptPrefix(plan.profileName, opts.prompt, lease!.environment, spawnBinding.cwd);
      return {
        agentId: created.id,
        profileName: plan.profileName,
        model: plan.model,
        modelSource: plan.modelSource,
        promptText,
      };
    } finally {
      lease?.dispose();
    }
  }

  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void {
    this.onDidStopAgentTaskEmitter.fire(context);
  }

  private async applyPromptPrefix(
    profileName: string,
    prompt: string,
    environment: Environment,
    cwd: string | undefined,
  ): Promise<string> {
    const profile = this.catalog.get(profileName);
    if (profile?.promptPrefix === undefined) return prompt;
    const view = new EnvironmentWorkspaceView(environment, {
      workDir: cwd ?? this.sessionContext.cwd,
    });
    return applyProfilePromptPrefix(profile, prompt, {
      cwd: view.workDir,
      process: environment.process!,
      log: this.log,
    });
  }

  private acquirePromptEnvironment(
    caller: IAgentScopeHandle,
    callerBinding: EnvironmentBinding,
    spawnBinding: EnvironmentBinding,
  ): EnvironmentLease {
    if (spawnBinding.environmentId === callerBinding.environmentId) {
      return caller.accessor.get(IAgentEnvironmentService).acquire(['process']);
    }
    const workspace = this.workspaces.get(this.sessionContext.workspaceId);
    if (workspace === undefined) {
      throw new EnvironmentError('environment.not_found', `workspace ${this.sessionContext.workspaceId} is not materialized`);
    }
    return workspace.environments.acquire(spawnBinding, ['process']);
  }

  private async resolveSpawnBinding(
    callerBinding: EnvironmentBinding,
    requested: string | undefined,
  ): Promise<EnvironmentBinding> {
    const environmentId = requested?.trim();
    if (environmentId === undefined || environmentId.length === 0 || environmentId === callerBinding.environmentId) {
      return callerBinding;
    }
    if (environmentId === LOCAL_ENVIRONMENT_ID) {
      return { workspaceId: callerBinding.workspaceId, environmentId: LOCAL_ENVIRONMENT_ID };
    }
    const workspace = this.workspaces.get(this.sessionContext.workspaceId);
    const environment = workspace?.environments.current(environmentId);
    if (workspace === undefined || environment === undefined) {
      const available =
        workspace?.environments.list().map((entry) => entry.identity.environmentId).join(', ') ?? '';
      throw new EnvironmentError(
        'environment.not_found',
        `environment "${environmentId}" does not exist in this workspace. Available environments: ${available}.`,
      );
    }
    const connected = (await this.environmentDeclarations.ensureConnected(this.sessionContext.workspaceId, environmentId))!;
    const declaredDefaultCwd = await this.environmentDeclarations.declaredDefaultCwd(environmentId);
    if (declaredDefaultCwd !== undefined) {
      if (connected.fs !== undefined) {
        await this.environmentDeclarations.assertCwdUsable(this.sessionContext.workspaceId, environmentId, declaredDefaultCwd);
      }
      return { workspaceId: callerBinding.workspaceId, environmentId, cwd: declaredDefaultCwd };
    }
    return {
      workspaceId: callerBinding.workspaceId,
      environmentId,
      cwd: connected.host.cwd ?? connected.host.homeDir,
    };
  }

  private requireCaller(agentId: string): IAgentScopeHandle {
    const handle = this.agentLifecycle.handleOf(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Caller agent "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    return handle;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentService,
  SessionSubagentService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
