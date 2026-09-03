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
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime } from '#/runtime/runtime';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { ILogService } from '#/_base/log/log';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { defineState } from '#/state/state';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { IAgentReminderService } from '#/features/reminder/reminderService';

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
  PRIMARY_SUBAGENT_MODEL_CHOICE,
  resolveSubagentBinding,
  resolveSubagentModelPool,
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

export const sessionSecondaryModelKey = defineState<string | undefined>(
  'sessionSubagent.secondaryModel',
  () => undefined,
);

const SECONDARY_MODEL_DOC_KEY = 'secondary-model.json';

export class SessionSubagentService extends Service implements ISessionSubagentService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);
  private readonly onDidStopAgentTaskEmitter = this._register(
    new Emitter<AgentTaskStopHookContext>(),
  );
  readonly ready: Promise<void>;

  private secondaryModelSeeded = false;
  private secondaryModelSeed: string | undefined;

  get onDidStopAgentTask() {
    return this.onDidStopAgentTaskEmitter.event;
  }

  get secondaryModel(): string | undefined {
    const persisted = this.states.get(sessionSecondaryModelKey);
    if (persisted !== undefined) return persisted;
    if (!this.secondaryModelSeeded) {
      this.secondaryModelSeeded = true;
      this.secondaryModelSeed = resolveSubagentModelPool(this.configService)?.defaultModel;
    }
    return this.secondaryModelSeed;
  }

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IConfigService private readonly configService: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ILogService private readonly log: ILogService,
    @ISessionStateService private readonly states: ISessionStateService,
    @IAtomicDocumentStore private readonly documentStore: IAtomicDocumentStore,
  ) {
    super();
    this.states.contributeState(sessionSecondaryModelKey);
    this.ready = this.loadSecondaryModel();
  }

  async getSecondaryModel(): Promise<string | undefined> {
    await this.ready;
    return this.secondaryModel;
  }

  async setSecondaryModel(model: string): Promise<void> {
    await this.ready;
    if (model === PRIMARY_SUBAGENT_MODEL_CHOICE) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Subagent model "${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved: it always binds the caller's own model and cannot be the session default.`,
        { details: { model } },
      );
    }
    try {
      this.modelCatalog.get(model);
    } catch (error) {
      throw wrapSubagentModelError(error, model, undefined);
    }
    this.states.set(sessionSecondaryModelKey, model);
    await this.documentStore.set(this.sessionContext.metaScope, SECONDARY_MODEL_DOC_KEY, {
      model,
    });
  }

  private async loadSecondaryModel(): Promise<void> {
    try {
      const doc = await this.documentStore.get<{ model?: unknown }>(
        this.sessionContext.metaScope,
        SECONDARY_MODEL_DOC_KEY,
      );
      if (typeof doc?.model === 'string' && doc.model.length > 0) {
        this.states.set(sessionSecondaryModelKey, doc.model);
      }
    } catch (error) {
      this.log.warn('failed to load the session secondary model', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    await this.ready;
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
          this.flags,
          { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
          input.model,
          this.secondaryModel,
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
    const lease = plan.fork
      ? undefined
      : caller.accessor.get(IAgentRuntimeService).acquire(['process']);
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
            runtimeId: lease!.runtime.identity.runtimeId,
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
        : await this.applyPromptPrefix(plan.profileName, opts.prompt, lease!.runtime);
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
