import { Service } from '#/_base/di/service';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { Error2, ErrorCodes } from '#/errors';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import {
  rootDelegationExtras,
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
  withoutDelegatingTargets,
} from '#/app/agentProfileCatalog/profile-shared';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { AgentProfile } from '#/features/profile/profileAgentRuntime';
import { ISessionPermissionModeService } from '#/session/permissionMode/sessionPermissionMode';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { ISessionUserToolService } from '#/agent/userTool/sessionUserToolService';
import type { Runtime } from '#/runtime/runtime';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { ILogService } from '#/_base/log/log';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { createHooks } from '#/hooks';
import { IAgentHostService } from '#/agent/host/agentHost';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

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
    @IAgentHostService private readonly hosts: IAgentHostService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IConfigService private readonly configService: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ILogService private readonly log: ILogService,
    @ISessionUserToolService private readonly userTools: ISessionUserToolService,
    @ISessionPermissionModeService private readonly permissionModes: ISessionPermissionModeService,
    @ISessionUsageService private readonly usage?: ISessionUsageService,
  ) {
    super();
  }

  run(agent: AgentContext, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle> {
    const target = this.requireCaller(agent.agentId);
    return runAgentTurn({ agentLifecycle: this.agentLifecycle, usage: this.usage }, target, request, {
      summaryPolicy: opts.summaryPolicy ?? this.summaryPolicyFor(target),
      signal: opts.signal,
      onReady: opts.onReady,
    });
  }

  async planSpawn(input: SubagentSpawnPlanInput): Promise<SubagentSpawnPlan> {
    const caller = this.requireCaller(input.callerAgentId);
    const fork = input.fork === true;
    await this.catalog.ready;
    const own = this.agentLifecycle.resolve(caller, AgentProfile).data();
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
      ? { model: own.modelAlias, thinking: own.thinkingLevel }
      : resolveSubagentBinding(
          this.configService,
          this.flags,
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
      thinking: resolveSubagentThinking(this.configService, model, binding.thinking),
      fork,
    };
  }

  async spawn(opts: SpawnSubagentOptions): Promise<SpawnedSubagent> {
    const caller = this.requireCaller(opts.callerAgentId);
    const { plan } = opts;
    const lease = plan.fork
      ? undefined
      : this.hosts.of(caller).agentRuntime.acquire(['process']);
    try {
      let created: AgentContext;
      try {
        if (plan.fork) {
          created = await this.agentLifecycle.fork(caller, {
            labels: opts.labels,
          });
        } else {
          created = await this.agentLifecycle.create({
            binding: {
              profile: plan.profileName,
              model: plan.model,
              thinking: plan.thinking,
            },
            labels: opts.labels,
            runtimeId: lease!.runtime.identity.runtimeId,
          });
        }
      } catch (error) {
        throw wrapSubagentModelError(
          error,
          plan.model,
          this.agentLifecycle.resolve(caller, AgentProfile).data().modelAlias,
        );
      }
      const permissionModes = this.permissionModes;
      permissionModes.setMode(
        created,
        permissionModes.mode(caller),
      );
      const createdUserTools = this.userTools.of(created);
      const callerUserTools = this.userTools.of(caller);
      if (plan.fork) {
        const activeToolNames = this.agentLifecycle
          .resolve(created, AgentProfile)
          .activeTools();
        createdUserTools.inheritUserTools(callerUserTools, activeToolNames);
      } else {
        createdUserTools.inheritUserTools(callerUserTools);
      }
      const promptText = plan.fork
        ? `${FORK_CONTEXT_NOTICE}\n\n${opts.prompt}`
        : await this.applyPromptPrefix(plan.profileName, opts.prompt, lease!.runtime);
      return {
        agentId: created.agentId,
        profileName: plan.profileName,
        model: plan.model,
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
    runtime: Runtime,
  ): Promise<string> {
    const profile = this.catalog.get(profileName);
    if (profile?.promptPrefix === undefined) return prompt;
    const view = new RuntimeWorkspaceView(runtime, {
      workDir: this.sessionContext.cwd,
    });
    return applyProfilePromptPrefix(profile, prompt, {
      cwd: view.workDir,
      process: runtime.process!,
      log: this.log,
    });
  }

  private requireCaller(agentId: string): AgentContext {
    const caller = this.agentLifecycle.get(agentId);
    if (caller === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Caller agent "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    return caller;
  }

  private summaryPolicyFor(agent: AgentContext): AgentProfileSummaryPolicy | undefined {
    const profileName = this.agentLifecycle
      .resolve(agent, AgentProfile)
      .data().profileName;
    if (profileName === undefined) return undefined;
    return this.catalog.get(profileName)?.summaryPolicy;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentService,
  SessionSubagentService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
