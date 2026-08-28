import { join } from 'pathe';

import { IInstantiationService, type ServicesAccessor } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { type CollectionView } from '#/_base/di/collection';
import { Emitter } from '#/_base/event';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Error2, ErrorCodes } from '#/errors';
import { LifecycleScope } from '#/app/scopes';
import {
  registerScopedService,
  ScopeActivation,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ISessionEventBus } from '#/app/event/eventBus';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/features/permissionMode/configSection';
import { AgentPermissionMode } from '#/features/permissionMode/permissionModeAgentRuntime';
import { toContractMode } from '#/features/permissionMode/internal/modeMapping';
import { ISessionPermissionModeService } from '#/session/permissionMode/sessionPermissionMode';
import type { PermissionMode } from '#/features/toolExecutor/permissionTypes';
import { TOWER_WORKER_PROFILE } from '#/features/tower/tower';
import { AgentProfile } from '#/features/profile/profileAgentRuntime';
import { ISessionPlanService } from '#/features/plan/sessionPlanService';
import { ISessionStaleGuardService } from '#/features/staleGuard/sessionStaleGuardService';
import { ISessionSwarmAgentService } from '#/features/swarm/session/sessionSwarmAgentService';
import { ISessionAgentExternalHooksService } from '#/features/externalHooks/session/sessionAgentExternalHooksService';
import { ISessionTaskService } from '#/agent/task/sessionTaskService';
import { ISessionActivityViewService } from '#/agent/activityView/sessionActivityViewService';
import { ISessionToolApprovalService } from '#/agent/toolApproval/sessionToolApprovalService';
import { ISessionUserToolService } from '#/agent/userTool/sessionUserToolService';
import { ISessionPluginCommandService } from '#/agent/pluginCommand/sessionPluginCommandService';
import { ISessionShellCommandService } from '#/agent/shellCommand/sessionShellCommandService';
import { ISessionCommandService } from '#/agent/command/sessionCommandService';
import { ISessionPluginService } from '#/agent/plugin/sessionPluginService';
import { ISessionAgentsMdReminderService } from '#/agent/agentsMdReminder/sessionAgentsMdReminderService';
import { ISessionCacheProbeService } from '#/agent/usage/sessionCacheProbeService';
import { ISessionToolResultTruncationService } from '#/agent/toolResultTruncation/sessionToolResultTruncationService';
import { ISessionInterruptionReminderService } from '#/agent/interruptionReminder/sessionInterruptionReminderService';
import { ISessionMediaService } from '#/agent/media/sessionMediaService';
import { ISessionTowerService } from '#/features/tower/sessionTowerService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentHostService } from '#/agent/host/agentHost';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentLoop } from '#/features/loop/loop';
import { getLoopControl } from '#/features/loop/internal/access';
import { abortError } from '#/_base/utils/abort';
import { AgentContextMemory } from '#/features/contextMemory/contextMemoryAgentRuntime';
import { closeTrailingOpenToolExchange } from '#/features/contextMemory/openToolExchange';
import { AgentFullCompaction } from '#/features/fullCompaction/fullCompactionAgentRuntime';
import { AgentPrompt } from '#/features/prompt/promptAgentRuntime';
import {
  AgentRuntimeContributionPoint,
  AgentRuntimeOverrideContributionPoint,
  type AgentRuntimeContribution,
  type AgentRuntimeDefinition,
  type AgentRuntimeDefinitionRecord,
  type AgentRuntimeSnapshot,
  getAgentRuntimeDefinitionId,
  type RuntimeOf,
} from '#/agent/runtime/agentRuntime';
import type { AgentContext } from '#/agent/agentContext/agentContext';

import { ManagedAgent } from './managedAgent';
import {
  type AgentListFilter,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
} from './agentLifecycle';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly roster = new Map<string, ManagedAgent>();
  private readonly creating = new Map<string, Promise<AgentContext>>();
  private nextLifecycleGeneration = 0;
  private readonly records = new Map<string, AgentRuntimeDefinitionRecord>();
  private readonly recordGenerations = new Map<string, number>();
  private readonly contributions = new Map<AgentRuntimeContribution, AgentRuntimeDefinitionRecord>();
  private readonly hostAccessor: ServicesAccessor;
  private readonly onDidCreateEmitter = this._register(new Emitter<AgentContext>());
  private readonly onWillCloseEmitter = this._register(new Emitter<AgentContext>());
  private readonly onDidCloseEmitter = this._register(new Emitter<AgentContext>());

  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onWillClose() {
    return this.onWillCloseEmitter.event;
  }
  get onDidClose() {
    return this.onDidCloseEmitter.event;
  }

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IAgentHostService private readonly hosts: IAgentHostService,
    @AgentRuntimeContributionPoint contributionView: CollectionView<AgentRuntimeContribution>,
    @AgentRuntimeOverrideContributionPoint overrideView: CollectionView<AgentRuntimeContribution>,
  ) {
    super();
    this.hostAccessor = {
      get: (id) => this.instantiation.invokeFunction((accessor) => accessor.get(id)),
    };
    for (const contribution of contributionView.items) this.registerContribution(contribution, false);
    for (const contribution of overrideView.items) this.registerContribution(contribution, true);
    this._register(
      contributionView.onDidChange(({ added, removed }) => {
        for (const contribution of added) this.registerContribution(contribution, false);
        for (const contribution of removed) this.withdrawContribution(contribution);
      }),
    );
    this._register(
      overrideView.onDidChange(({ added, removed }) => {
        for (const contribution of added) this.registerContribution(contribution, true);
        for (const contribution of removed) this.withdrawContribution(contribution);
      }),
    );
    this._register(
      toDisposable(() => {
        for (const managed of this.roster.values()) {
          void managed.runtimeSet.close().catch((error: unknown) => onUnexpectedError(error));
        }
        this.roster.clear();
      }),
    );
  }

  private registerContribution(contribution: AgentRuntimeContribution, override: boolean): void {
    if (this.contributions.has(contribution)) return;
    const definition = contribution.contract;
    const id = getAgentRuntimeDefinitionId(definition);
    const generation = (this.recordGenerations.get(id) ?? 0) + 1;
    this.recordGenerations.set(id, generation);
    const record: AgentRuntimeDefinitionRecord = {
      definition,
      provider: contribution,
      generation,
      providerGeneration: generation,
      active: true,
    };
    this.contributions.set(contribution, record);
    const current = this.records.get(id);
    if (current !== undefined && !override) return;
    this.records.set(id, record);
    for (const managed of this.roster.values()) {
      if (!managed.closing) managed.runtimeSet.apply(record);
    }
  }

  private withdrawContribution(contribution: AgentRuntimeContribution): void {
    const record = this.contributions.get(contribution);
    if (record === undefined) return;
    this.contributions.delete(contribution);
    record.active = false;
    const id = getAgentRuntimeDefinitionId(record.definition);
    if (this.records.get(id) === record) {
      const fallback = [...this.contributions.values()]
        .filter((candidate) => candidate.active && getAgentRuntimeDefinitionId(candidate.definition) === id)
        .sort((left, right) => (right.providerGeneration ?? right.generation) - (left.providerGeneration ?? left.generation))[0];
      if (fallback !== undefined) this.records.set(id, fallback);
      else this.records.delete(id);
    }
    for (const managed of this.roster.values()) {
      managed.runtimeSet.retireDefinition(record);
      const fallback = this.records.get(id);
      if (fallback !== undefined && fallback !== record && !managed.closing) managed.runtimeSet.apply(fallback);
    }
  }

  private activeRecords(): readonly AgentRuntimeDefinitionRecord[] {
    return [...this.records.values()];
  }

  async create(opts: CreateAgentOptions = {}): Promise<AgentContext> {
    if (opts.agentId !== undefined) {
      const inflight = this.creating.get(opts.agentId);
      if (inflight !== undefined) return inflight;
      const existing = this.roster.get(opts.agentId);
      if (existing !== undefined && !existing.closing) return existing.context;
    }
    const agentId = opts.agentId ?? (await this.nextAvailableAgentId());
    const promise = this.doCreate(agentId, opts);
    this.creating.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(agentId);
    }
  }

  private async nextAvailableAgentId(): Promise<string> {
    let maxSuffix = -1;
    const consider = (id: string): void => {
      const match = /^agent-(\d+)$/.exec(id);
      if (match !== null) maxSuffix = Math.max(maxSuffix, Number(match[1]));
    };
    for (const id of this.roster.keys()) consider(id);
    const persisted = (await this.sessionMetadata.read()).agents ?? {};
    for (const id of Object.keys(persisted)) consider(id);
    const candidate = Math.max(maxSuffix + 1, nextAgentId);
    nextAgentId = candidate + 1;
    return `agent-${String(candidate)}`;
  }

  private async doCreate(agentId: string, opts: CreateAgentOptions): Promise<AgentContext> {
    const agentScope = this.ctx.scope(`agents/${agentId}`);
    const agentHomedir = join(this.bootstrap.homeDir, agentScope);
    const generation = ++this.nextLifecycleGeneration;
    const scopeContext = makeAgentScopeContext({
      agentId,
      agentScope,
      forkedFrom: opts.forkedFrom,
      generation,
    });
    const agent = scopeContext.agentContext;
    const eventBus = this.instantiation.invokeFunction((accessor) =>
      accessor.get(ISessionEventBus) as ISessionEventBus | undefined,
    );
    eventBus?.activateAgent(agent);
    let managed: ManagedAgent | undefined;
    let didCreate = false;
    try {
      const host = this.hosts.create({
        scopeContext,
        binding: { workspaceId: this.ctx.workspaceId, runtimeId: opts.runtimeId ?? 'local' },
      });
      managed = new ManagedAgent(agent, host, this.hostAccessor, this.activeRecords());
      this.roster.set(agentId, managed);
      managed.runtimeSet.resolve(AgentLoop);
      this.attachSessionAgentServices(agent);
      managed.active = true;
      await host.wire.seal();
      managed.attachDurableRuntimes();
      await this.sessionMetadata.registerAgent(agentId, {
        homedir: agentHomedir,
        type: agentId === 'main' ? 'main' : 'sub',
        parentAgentId: agentId === 'main' ? undefined : 'main',
        forkedFrom: opts.forkedFrom,
        labels: opts.labels,
      });
      this.onDidCreateEmitter.fire(agent);
      didCreate = true;
      await host.dispatcher.restore();
      await managed.runtimeSet.restore();
      await this.bindBootstrap(agent, opts);
      return agent;
    } catch (error) {
      if (managed !== undefined) {
        managed.closing = true;
        if (this.roster.get(agentId) === managed) this.roster.delete(agentId);
        await managed.runtimeSet.close().catch(() => undefined);
        try {
          await managed.host.dispose();
        } catch { }
        if (didCreate) this.onDidCloseEmitter.fire(agent);
      }
      eventBus?.deactivateAgent(agent);
      throw error;
    }
  }

  private async bindBootstrap(
    agent: AgentContext,
    opts: CreateAgentOptions,
  ): Promise<void> {
    if (opts.binding !== undefined) {
      await this.resolve(agent, AgentProfile).bind(opts.binding);
    }
    const permissionMode = this.config.get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
    const bridge = this.instantiation.invokeFunction((accessor) =>
      accessor.get(ISessionPermissionModeService),
    );
    if (permissionMode !== undefined && !bridge.configured(agent)) {
      bridge.setMode(agent, permissionMode);
    }
  }

  async fork(sourceContext: AgentContext, opts?: ForkAgentOptions): Promise<AgentContext> {
    const sourceManaged = this.managedFor(sourceContext);
    if (sourceManaged === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `Source agent "${sourceContext.agentId}" does not exist`,
        { details: { agentId: sourceContext.agentId } },
      );
    }
    if (opts?.agentId !== undefined && this.get(opts.agentId) !== undefined) {
      throw new Error2(ErrorCodes.AGENT_ALREADY_EXISTS, `Agent "${opts.agentId}" already exists`, {
        details: { agentId: opts.agentId },
      });
    }
    const childContext = await this.create({
      agentId: opts?.agentId,
      runtimeId: sourceManaged.host.runtimeBinding.current.runtimeId,
      forkedFrom: sourceContext.agentId,
      labels: opts?.labels,
    });

    const sourceData = this.resolve(sourceManaged.context, AgentProfile).data();
    const childProfile = this.resolve(childContext, AgentProfile);
    const override = opts?.binding;
    if (override?.profile !== undefined) {
      await childProfile.bind({
        profile: override.profile,
        model: override.model ?? sourceData.modelAlias,
        thinking: override?.thinking ?? sourceData.thinkingLevel,
      });
    } else {
      childProfile.applyData(sourceData);
      if (override?.model !== undefined) await childProfile.setModel(override.model);
      if (override?.thinking !== undefined) childProfile.setThinking(override.thinking);
    }

    const sourceMessages = this.resolve(sourceManaged.context, AgentContextMemory).get();
    if (sourceMessages.length > 0) {
      void this.resolve(childContext, AgentContextMemory).append(
        ...closeTrailingOpenToolExchange(sourceMessages),
      );
    }
    return childContext;
  }

  get(agentId: string): AgentContext | undefined {
    const managed = this.roster.get(agentId);
    if (managed === undefined || managed.closing || !managed.active) return undefined;
    return managed.context;
  }

  list(filter?: AgentListFilter): readonly AgentContext[] {
    const all = [...this.roster.values()]
      .filter((managed) => managed.active && !managed.closing)
      .map((managed) => managed.context);
    const prefix = filter?.prefix;
    if (prefix === undefined) return all;
    return all.filter((context) => context.agentId.startsWith(prefix));
  }

  resolve<Definition extends AgentRuntimeDefinition<any, any>>(
    agent: AgentContext,
    definition: Definition,
  ): RuntimeOf<Definition> {
    return this.requireManaged(agent).runtimeSet.resolve(definition);
  }

  restoreRuntimes(agent: AgentContext): Promise<void> {
    return this.requireManaged(agent).runtimeSet.restore();
  }

  inspect(agent: AgentContext): AgentRuntimeSnapshot {
    const managed = this.requireManaged(agent);
    return {
      identity: { agentId: agent.agentId, generation: agent.generation },
      contributions: managed.runtimeSet.inspect(),
    };
  }

  broadcastPermissionMode(mode: PermissionMode): void {
    for (const managed of this.roster.values()) {
      if (managed.closing || !managed.active) continue;
      if (
        this.resolve(managed.context, AgentProfile).data().profileName === TOWER_WORKER_PROFILE
      ) {
        continue;
      }
      void this.resolve(managed.context, AgentPermissionMode).changeMode(toContractMode(mode));
    }
  }

  attachRuntimes(agent: AgentContext): void {
    let managed = this.roster.get(agent.agentId);
    if (managed === undefined) {
      const host = this.hosts.of(agent);
      managed = new ManagedAgent(agent, host, this.hostAccessor, this.activeRecords());
      this.roster.set(agent.agentId, managed);
    }
    managed.runtimeSet.resolve(AgentLoop);
    this.attachSessionAgentServices(agent);
    managed.attachDurableRuntimes();
    if (!managed.active) {
      managed.active = true;
      this.onDidCreateEmitter.fire(agent);
    }
  }

  private attachSessionAgentServices(agent: AgentContext): void {
    this.instantiation.invokeFunction((accessor) => {
      (accessor.get(ISessionTaskService) as ISessionTaskService | undefined)?.attach(agent);
      (accessor.get(ISessionActivityViewService) as ISessionActivityViewService | undefined)?.attach(agent);
      (accessor.get(ISessionToolApprovalService) as ISessionToolApprovalService | undefined)?.attach(agent);
      (accessor.get(ISessionUserToolService) as ISessionUserToolService | undefined)?.attach(agent);
      (accessor.get(ISessionPluginCommandService) as ISessionPluginCommandService | undefined)?.attach(agent);
      (accessor.get(ISessionShellCommandService) as ISessionShellCommandService | undefined)?.attach(agent);
      (accessor.get(ISessionCommandService) as ISessionCommandService | undefined)?.attach(agent);
      (accessor.get(ISessionPluginService) as ISessionPluginService | undefined)?.attach(agent);
      (accessor.get(ISessionAgentsMdReminderService) as ISessionAgentsMdReminderService | undefined)?.attach(agent);
      (accessor.get(ISessionCacheProbeService) as ISessionCacheProbeService | undefined)?.attach(agent);
      (accessor.get(ISessionToolResultTruncationService) as ISessionToolResultTruncationService | undefined)?.attach(agent);
      (accessor.get(ISessionInterruptionReminderService) as ISessionInterruptionReminderService | undefined)?.attach(agent);
      (accessor.get(ISessionMediaService) as ISessionMediaService | undefined)?.attach(agent);
      (accessor.get(ISessionTowerService) as ISessionTowerService | undefined)?.attach(agent);
      (accessor.get(ISessionSwarmAgentService) as ISessionSwarmAgentService | undefined)?.attach(agent);
      (accessor.get(ISessionStaleGuardService) as ISessionStaleGuardService | undefined)?.attach(agent);
      (accessor.get(ISessionPlanService) as ISessionPlanService | undefined)?.attach(agent);
      (accessor.get(ISessionAgentExternalHooksService) as ISessionAgentExternalHooksService | undefined)?.attach(agent);
    });
  }

  async remove(agent: AgentContext): Promise<void> {
    const managed = this.roster.get(agent.agentId);
    if (managed === undefined || managed.context !== agent || managed.closing) return;
    managed.closing = true;
    this.onWillCloseEmitter.fire(agent);
    const tasks = this.instantiation.invokeFunction((accessor) =>
      accessor.get(ISessionTaskService),
    );
    await tasks.of(agent).stopAllOnExit('Session closed');
    const loop = getLoopControl(agent);
    const compaction = managed.runtimeSet.resolve(AgentFullCompaction);
    const reason = abortError('Agent removed');
    const prompt = managed.runtimeSet.resolve(AgentPrompt);
    for (const turnId of loop.status().pendingTurnIds) {
      loop.cancel(turnId, reason);
    }
    loop.cancel(undefined, reason);
    await Promise.all([loop.settled(), compaction.cancel(), prompt.drain(reason)]);
    await managed.runtimeSet.close();
    await managed.host.dispose();
    if (this.roster.get(agent.agentId) === managed) this.roster.delete(agent.agentId);
    this.onDidCloseEmitter.fire(agent);
    const eventBus = this.instantiation.invokeFunction((accessor) =>
      accessor.get(ISessionEventBus) as ISessionEventBus | undefined,
    );
    eventBus?.deactivateAgent(agent);
  }

  private managedFor(agent: AgentContext): ManagedAgent | undefined {
    const managed = this.roster.get(agent.agentId);
    if (managed === undefined || managed.context !== agent || managed.closing) return undefined;
    return managed;
  }

  private requireManaged(agent: AgentContext): ManagedAgent {
    const managed = this.managedFor(agent);
    if (managed === undefined) {
      throw new Error(
        `Agent ${agent.agentId}:${String(agent.generation)} is not a lifecycle-issued context`,
      );
    }
    return managed;
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentLifecycleService,
  AgentLifecycleService,
  ScopeActivation.OnScopeCreated,
  'agentLifecycle',
);
